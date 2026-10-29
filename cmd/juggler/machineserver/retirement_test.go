package machineserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"juggler/internal/apipaths"
)

// slowRetireAnswer is longer than a poll interval: a child whose workers take
// this long to settle is slow, not refusing.
const slowRetireAnswer = activityPollInterval + time.Second

// A child that takes longer than a poll interval to settle its workers, then
// commits, is retiring: its session goes, and an open that arrived meanwhile
// gets a fresh child, not the one shutting down under it.
func TestSlowRetirementCommitIsNotTakenForRefusal(t *testing.T) {
	c := spawnHelperChildren(t, 1)[0]
	childAddr := c.addr
	entered := make(chan struct{})
	var once sync.Once
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != apipaths.HealthRetire {
			_ = json.NewEncoder(w).Encode(map[string]any{"active": false})
			return
		}
		once.Do(func() { close(entered) })
		// As a real child's: the decision runs to its end whether or not its
		// caller stays, and a commit shuts the child down.
		select {
		case <-time.After(slowRetireAnswer):
		case <-r.Context().Done():
		}
		w.WriteHeader(http.StatusAccepted)
		w.(http.Flusher).Flush()
		if resp, err := http.Get("http://" + childAddr + "/exit/0"); err == nil { //nolint:noctx // the stand-in's own exit route
			_ = resp.Body.Close()
		}
	}))
	t.Cleanup(backend.Close)
	c.addr = strings.TrimPrefix(backend.URL, "http://")
	s := &Server{reg: newRegistry(), restart: sleepless}
	project := t.TempDir()
	sess, cl, err := s.reg.open(s.lifetime(), project, &s.work)
	if err != nil || cl == nil || !s.reg.setRunning(sess.ID, c, c.cmd.Process.Pid) {
		t.Fatalf("register stand-in: claim=%v err=%v", cl, err)
	}
	s.reg.do(func(m map[string]*sessionEntry) { m[sess.ID].unviewedSince = time.Now().Add(-sessionViewerGrace) })
	s.startSupervising(sess.ID, c, cl)
	polled := make(chan struct{})
	go func() {
		s.pollActivity(sess.ID, c, time.Millisecond)
		close(polled)
	}()
	t.Cleanup(func() {
		s.stopAllChildren()
		<-polled
	})
	retirementRaceWait(t, entered, "retirement request")

	got := s.openSession(t.Context(), project, false)
	if got.sess.ID == sess.ID {
		t.Fatalf("an open during a committing retirement was handed the retiring session (status %d)", got.status)
	}
	if got.status != http.StatusCreated {
		t.Fatalf("open after the retirement = %d, want a fresh child (201)", got.status)
	}
	if _, ok := s.reg.get(sess.ID); ok {
		t.Fatal("the retired session is still listed")
	}
}

func TestSessionRetirementRequiresChildCommit(t *testing.T) {
	for _, code := range []int{http.StatusAccepted, http.StatusConflict, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(code), func(t *testing.T) {
			var called atomic.Bool
			backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called.Store(true)
				if r.Method != http.MethodPost || r.URL.Path != apipaths.HealthRetire || r.Header.Get(TokenHeader) != "child-token" {
					t.Errorf("retirement request: %s %s token=%q", r.Method, r.URL.Path, r.Header.Get(TokenHeader))
				}
				w.WriteHeader(code)
			}))
			defer backend.Close()
			c := &child{addr: strings.TrimPrefix(backend.URL, "http://"), apiToken: "child-token"}
			if got := requestRetirement(c); (got == retireAccepted) != (code == http.StatusAccepted) || got == retireExited {
				t.Fatalf("status %d: outcome %v", code, got)
			}
			if !called.Load() {
				t.Fatal("retirement must consult the child's admission gate, not an earlier idle sample")
			}
		})
	}
}

// An idle sample is deliberately stale: the child has admitted a turn by the
// time retirement reaches it. Refusal must restore proxy admission, not kill it.
func TestSessionRetirementRefusalRestoresRunning(t *testing.T) {
	var retirements atomic.Int64
	resumed := make(chan struct{}, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == apipaths.HealthRetire {
			retirements.Add(1)
			w.WriteHeader(http.StatusConflict)
			return
		}
		if retirements.Load() > 0 {
			select {
			case resumed <- struct{}{}:
			default:
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"active": false})
	}))
	defer backend.Close()
	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	c := &child{addr: strings.TrimPrefix(backend.URL, "http://"), exited: make(chan struct{})}
	s.reg.setRunning(sess.ID, c, 1)
	s.reg.do(func(m map[string]*sessionEntry) { m[sess.ID].unviewedSince = time.Now().Add(-sessionViewerGrace) })
	done := make(chan struct{})
	go func() { s.pollActivity(sess.ID, c, time.Millisecond); close(done) }()
	defer func() { close(c.exited); <-done }()
	select {
	case <-resumed:
	case <-time.After(5 * time.Second):
		t.Fatal("poller did not resume after retirement refusal")
	}
	// Pause expiry without inventing another viewer: acquiring a viewer is also
	// evidence that the refused retirement reopened admission.
	var release func()
	for release == nil {
		var ok bool
		release, ok = s.reg.holdViewer(sess.ID)
		if ok {
			break
		}
		if decision := s.reg.whenStopped(sess.ID); decision != nil {
			<-decision
		}
	}
	defer release()
	if cur, _ := s.reg.get(sess.ID); cur.State != SessionRunning {
		t.Fatalf("refused retirement left state %s", cur.State)
	}
}

func TestSessionRetirementDecisionWakesWaiters(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		r := newRegistry()
		sess, _ := r.reserve("/p")
		c := &child{}
		r.setRunning(sess.ID, c, 1)
		if !r.retireUnviewed(sess.ID, c, time.Now().Add(sessionViewerGrace)) {
			t.Fatal("retirement not claimed")
		}
		decision, stopped := r.retirementDecision(sess.ID, c), r.whenStopped(sess.ID)
		if decision == nil || stopped == nil {
			t.Fatal("a claimed retirement has no decision or teardown wait")
		}
		if accepted {
			r.remove(sess.ID)
		} else {
			r.retirementRefused(sess.ID, c)
			if cur, _ := r.get(sess.ID); cur.State != SessionRunning {
				t.Fatalf("refusal left %s", cur.State)
			}
		}
		for name, done := range map[string]<-chan struct{}{"supervisor": decision, "stop/open callers": stopped} {
			select {
			case <-done:
			default:
				t.Fatalf("%s not woken", name)
			}
		}
	}
}
