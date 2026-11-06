//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/attention"
	"juggler/internal/userpaths/userpathstest"
)

var attentionT0 = time.Date(2026, 11, 6, 9, 30, 0, 0, time.UTC)

func conv(id string, state attention.State, minutes int) attention.Conversation {
	c := attention.Conversation{ID: id, Name: "Conversation " + id, Entry: attention.Entry{State: state, Since: attentionT0.Add(time.Duration(minutes) * time.Minute)}}
	if state == attention.Waiting {
		c.Wait, c.Excerpt = attention.Approval, "bash: make"
	}
	return c
}

// The poller fetches a child's attention report when its revision moves, and
// only then, and the session record carries the counts and the conversations
// that need the user. The child's last change of attention is the session's
// last activity.
func TestAttentionGatheredFromTheChild(t *testing.T) {
	sc := newStubChild(t)
	waiting, working, failed := conv("c1", attention.Waiting, 0), conv("c2", attention.Working, 1), conv("c3", attention.Failed, 2)
	lastActive := attentionT0.Add(3 * time.Minute)
	sc.report.Store(&attention.Report{Rev: 1, LastActive: lastActive, Conversations: []attention.Conversation{waiting, working, failed}})
	r, id, _ := runningSession(t, sc)

	sc.waitPolls(t, 3)
	s, _ := r.get(id)
	want := &SessionAttention{Waiting: 1, Working: 1, Failed: 1, Items: []attention.Conversation{waiting, failed}, WorkingOn: working.Name}
	if !reflect.DeepEqual(s.Attention, want) {
		t.Fatalf("attention = %+v, want %+v", s.Attention, want)
	}
	if s.LastActive == nil || !s.LastActive.Equal(lastActive) {
		t.Fatalf("lastActive = %v, want the child's %v", s.LastActive, lastActive)
	}
	if n := sc.fetches.Load(); n != 1 {
		t.Fatalf("an unmoved revision was fetched %d times, want once", n)
	}

	sc.report.Store(&attention.Report{Rev: 2, LastActive: lastActive.Add(time.Minute), Conversations: []attention.Conversation{failed}})
	sc.waitPolls(t, 3)
	s, _ = r.get(id)
	want = &SessionAttention{Failed: 1, Items: []attention.Conversation{failed}}
	if !reflect.DeepEqual(s.Attention, want) || sc.fetches.Load() != 2 {
		t.Fatalf("after the revision moved: attention = %+v (%d fetches), want %+v after 2", s.Attention, sc.fetches.Load(), want)
	}
}

// Attention is recorded only against the entry that still owns the reporting
// child. A crash keeps what outlives the child — waiting and failed — and
// drops what does not.
func TestRegistryAttentionBelongsToItsChild(t *testing.T) {
	r := newRegistry()
	c := &child{addr: "127.0.0.1:1", exited: make(chan struct{})}
	s, _ := r.reserve("/p")
	r.setRunning(s.ID, c, 1)
	report := attention.Report{Rev: 1, Conversations: []attention.Conversation{conv("c1", attention.Waiting, 0), conv("c2", attention.Working, 1)}}

	r.setAttention(s.ID, &child{addr: "127.0.0.1:2"}, report)
	if cur, _ := r.get(s.ID); cur.Attention != nil {
		t.Fatalf("attention from another child was recorded: %+v", cur.Attention)
	}
	r.setAttention(s.ID, c, report)
	if cur, _ := r.get(s.ID); cur.Attention == nil || cur.Attention.Waiting != 1 || cur.Attention.Working != 1 {
		t.Fatalf("attention from the owning child: %+v", cur.Attention)
	}

	r.setRestarting(s.ID, c, "crashed", time.Now().Add(time.Second))
	cur, _ := r.get(s.ID)
	want := &SessionAttention{Waiting: 1, Items: []attention.Conversation{conv("c1", attention.Waiting, 0)}}
	if !reflect.DeepEqual(cur.Attention, want) {
		t.Fatalf("after a crash: attention = %+v, want %+v", cur.Attention, want)
	}
}

// A recent project's saved summary says how many of its conversations were
// waiting when its session ended.
func TestRecentsCarryWaitingCounts(t *testing.T) {
	home := userpathstest.Isolate(t)
	store, err := core.NewRecentsStore()
	if err != nil {
		t.Fatal(err)
	}
	waits, quiet := filepath.Join(home, "waits"), filepath.Join(home, "quiet")
	for _, p := range []string{waits, quiet} {
		if err := os.Mkdir(p, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := store.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if err := attention.Write(waits, map[string]attention.Entry{
		"c1": {State: attention.Waiting, Wait: attention.Question},
		"c2": {State: attention.Waiting, Wait: attention.Approval},
		"c3": {State: attention.Failed},
	}); err != nil {
		t.Fatal(err)
	}
	s := &Server{reg: newRegistry(), token: testToken, recents: store}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	var recents recentsResponse
	getJSON(t, front.URL+"/api/server/recents", &recents)
	if want := map[string]int{waits: 2}; !reflect.DeepEqual(recents.Waiting, want) {
		t.Fatalf("waiting = %v, want %v", recents.Waiting, want)
	}
}

// The record names the oldest working conversation, which the switcher's
// status line says it is working on, and nothing when none works.
func TestAttentionNamesTheWorkingConversation(t *testing.T) {
	older, newer := conv("c2", attention.Working, 1), conv("c3", attention.Working, 2)
	if got := newSessionAttention([]attention.Conversation{conv("c1", attention.Waiting, 0), older, newer}).WorkingOn; got != older.Name {
		t.Fatalf("workingOn = %q, want the oldest working %q", got, older.Name)
	}
	if got := newSessionAttention([]attention.Conversation{conv("c1", attention.Waiting, 0)}).WorkingOn; got != "" {
		t.Fatalf("workingOn with none working = %q", got)
	}
}

// A session leaving the registry — stopped, retired, dismissed — puts its
// project at the front of the recents with the time it left, which /recents
// serves as when it was used.
func TestASessionLeavingTouchesItsRecent(t *testing.T) {
	home := userpathstest.Isolate(t)
	store, err := core.NewRecentsStore()
	if err != nil {
		t.Fatal(err)
	}
	left, other := filepath.Join(home, "left"), filepath.Join(home, "other")
	for _, p := range []string{left, other} {
		if err := os.Mkdir(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	s := &Server{reg: newRegistry(), recents: store}
	s.rememberLeaving()
	sess, _ := s.reg.reserve(left)
	if err := store.Add(other); err != nil {
		t.Fatal(err)
	}
	before := time.Now()
	s.reg.remove(sess.ID)
	deadline := time.Now().Add(5 * time.Second)
	for {
		now := s.recentsNow()
		at, ok := now.Used[left]
		if len(now.Paths) > 0 && now.Paths[0] == left && ok {
			if at.Before(before) {
				t.Fatalf("used[%s] = %s, want a time at or after %s", left, at, before)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("recents = %+v, want %s first with a time", now, left)
		}
		select {
		case <-s.reg.changes():
		case <-time.After(10 * time.Millisecond):
		}
	}
}
