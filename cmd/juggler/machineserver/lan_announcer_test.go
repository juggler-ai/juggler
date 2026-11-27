//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/tunnel"
	"juggler/internal/lanfind"
	"juggler/internal/userpaths/userpathstest"
)

// fakeAnnouncer announces nothing: it keeps its host for a test to read, and
// runs until it is told to stop, then for fakeAnnouncerLinger longer, as a
// real one does while it withdraws.
type fakeAnnouncer struct {
	host tunnel.LANAnnounceHost
	done chan struct{}
}

// fakeAnnouncerLinger is how long a fake announcer's run goes on once told to
// stop.
var fakeAnnouncerLinger atomic.Int64

var (
	// announcersMade counts the fake LAN announcers made, one per run.
	announcersMade atomic.Int32
	// lastAnnouncer is the most recent one.
	lastAnnouncer atomic.Pointer[fakeAnnouncer]
)

func newFakeAnnouncer(h tunnel.LANAnnounceHost) tunnel.LANAnnouncer {
	a := &fakeAnnouncer{host: h, done: make(chan struct{})}
	lastAnnouncer.Store(a)
	announcersMade.Add(1)
	return a
}

func (a *fakeAnnouncer) Run(ctx context.Context) error {
	<-ctx.Done()
	time.Sleep(time.Duration(fakeAnnouncerLinger.Load()))
	close(a.done)
	return nil
}

// findableJSON is the findable switch as GET/PUT /api/server/lan names it.
type findableJSON struct {
	Enabled      bool           `json:"enabled"`
	Label        string         `json:"label"`
	LabelMessage map[string]any `json:"labelMessage"`
	Description  string         `json:"description"`
}

// lanFindable reads the findable switch out of a /api/server/lan answer.
func lanFindable(t *testing.T, body string) *findableJSON {
	t.Helper()
	var got struct {
		Findable *findableJSON `json:"findable"`
	}
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("decoding %s: %v", body, err)
	}
	return got.Findable
}

// awaitEnded waits for a's run to end, which is the server ending its context.
func awaitEnded(t *testing.T, a *fakeAnnouncer, why string) {
	t.Helper()
	select {
	case <-a.done:
	case <-t.Context().Done():
		t.Fatalf("%s: the LAN announcer is still running", why)
	}
}

// savedFindable is connectivity.lanFindable as the settings file holds it.
func savedFindable(t *testing.T) bool {
	t.Helper()
	gs, err := core.LoadGlobalSettings()
	if err != nil {
		t.Fatal(err)
	}
	return gs.Connectivity.LANFindable
}

// TestTheLANAnnouncerRunsExactlyWhileLANAccessAndFindableAreOn: the registered
// announcer runs while LAN access is on and the server is findable, one run per
// stretch of both, and neither alone starts it. The switch is saved, shown with
// the spec's copy, and set from this machine only. The announcer is handed this
// machine's name and the addresses LAN access shows.
func TestTheLANAnnouncerRunsExactlyWhileLANAccessAndFindableAreOn(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1), addr: "127.0.0.1:3941"}
	local := httptest.NewServer(s.routes())
	defer local.Close()
	remote := httptest.NewServer(asCaller("192.168.1.20:54321", s.routes()))
	defer remote.Close()
	made := announcersMade.Load()
	runs := func() int32 { return announcersMade.Load() - made }

	_, body := lanCall(t, "GET", local.URL+"/api/server/lan", "")
	f := lanFindable(t, body)
	if f == nil || f.Enabled || f.Label != "Fake findable" || f.LabelMessage["key"] != "Fake findable" || f.Description == "" {
		t.Fatalf("GET lan at the start: %s; want the switch, off, with the spec's copy", body)
	}

	code, body := lanCall(t, "PUT", local.URL+"/api/server/lan", `{"findable":true}`)
	if f := lanFindable(t, body); code != http.StatusOK || f == nil || !f.Enabled || !savedFindable(t) {
		t.Fatalf("PUT findable on: %d %s, saved=%v; want 200, on, saved", code, body, savedFindable(t))
	}
	if s.lan.Load() || runs() != 0 {
		t.Fatalf("findable with LAN access off: lan=%v, %d runs; want LAN off and nothing running", s.lan.Load(), runs())
	}

	s.setLAN(true)
	s.setLAN(true)
	if runs() != 1 {
		t.Fatalf("LAN access on, twice, while findable: %d runs, want 1", runs())
	}
	first := lastAnnouncer.Load()
	a := first.host.Announcement()
	var urls []string
	for _, u := range s.lanState("").URLs {
		urls = append(urls, u.URL)
	}
	if a.Name != lanfind.MachineName() || !slices.Equal(a.URLs, urls) || a.Port != 3941 || a.Version != core.Version {
		t.Errorf("announcement %+v; want name %q, URLs %q, port 3941, version %q", a, lanfind.MachineName(), urls, core.Version)
	}

	if code, _ := lanCall(t, "PUT", remote.URL+"/api/server/lan", `{"findable":false}`); code != http.StatusForbidden {
		t.Errorf("PUT findable from the LAN: status %d, want 403", code)
	}
	if !savedFindable(t) || runs() != 1 {
		t.Fatalf("a LAN caller changed the switch: saved=%v, %d runs", savedFindable(t), runs())
	}

	if code, body := lanCall(t, "PUT", local.URL+"/api/server/lan", `{"findable":false}`); code != http.StatusOK || savedFindable(t) {
		t.Fatalf("PUT findable off: %d %s, saved=%v; want 200, saved off", code, body, savedFindable(t))
	}
	awaitEnded(t, first, "findable switched off")
	if !s.lan.Load() {
		t.Error("switching findable off switched LAN access off")
	}

	lanCall(t, "PUT", local.URL+"/api/server/lan", `{"findable":true}`)
	if runs() != 2 {
		t.Fatalf("findable on again with LAN access on: %d runs, want 2", runs())
	}
	second := lastAnnouncer.Load()
	s.setLAN(false)
	awaitEnded(t, second, "LAN access switched off")
	if !savedFindable(t) {
		t.Error("switching LAN access off unsaved findable")
	}
	if code, _ := lanCall(t, "PUT", local.URL+"/api/server/lan", `{"findable":"yes"}`); code != http.StatusBadRequest {
		t.Errorf("PUT lan with a findable that says nothing: status %d, want 400", code)
	}
}

// TestNoLANAnnouncerMeansNoFindableSwitch: a build that registers no announcer
// shows no switch and refuses to set one.
func TestNoLANAnnouncerMeansNoFindableSwitch(t *testing.T) {
	userpathstest.Isolate(t)
	saved := findLANAnnouncer
	findLANAnnouncer = func() (tunnel.LANAnnouncerSpec, bool) { return tunnel.LANAnnouncerSpec{}, false }
	t.Cleanup(func() { findLANAnnouncer = saved })
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1)}
	local := httptest.NewServer(s.routes())
	defer local.Close()

	if _, body := lanCall(t, "GET", local.URL+"/api/server/lan", ""); strings.Contains(body, "findable") {
		t.Errorf("GET lan with no announcer: %s; want no findable switch", body)
	}
	if code, _ := lanCall(t, "PUT", local.URL+"/api/server/lan", `{"findable":true}`); code != http.StatusBadRequest || savedFindable(t) {
		t.Errorf("PUT findable with no announcer: status %d, saved=%v; want 400, nothing saved", code, savedFindable(t))
	}
}

// TestAStoppingServerWaitsForTheLANAnnouncer: once the server's lifetime ends,
// shutdown waits for the announcer's run to return, so its last word (a
// withdrawal) leaves before the process does.
func TestAStoppingServerWaitsForTheLANAnnouncer(t *testing.T) {
	userpathstest.Isolate(t)
	fakeAnnouncerLinger.Store(int64(50 * time.Millisecond))
	t.Cleanup(func() { fakeAnnouncerLinger.Store(0) })
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1), addr: "127.0.0.1:3941"}
	s.findable.Store(true)
	s.setLAN(true)
	run := lastAnnouncer.Load()

	s.endLifetime()
	s.awaitLANAnnouncer()
	select {
	case <-run.done:
	default:
		t.Fatal("shutdown went on while the LAN announcer was still stopping")
	}
}

// TestATestHarnessServerIsNeverAnnounced: a server under --test (unlisted)
// runs no announcer, findable or not, as it announces nothing over mDNS.
func TestATestHarnessServerIsNeverAnnounced(t *testing.T) {
	userpathstest.Isolate(t)
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1), addr: "127.0.0.1:3941", unlisted: true}
	made := announcersMade.Load()
	s.findable.Store(true)
	s.setLAN(true)
	defer s.setLAN(false)
	if n := announcersMade.Load() - made; n != 0 {
		t.Fatalf("a test harness's server ran %d LAN announcers; want none", n)
	}
	if f := s.findableState(); f == nil || !f.Enabled {
		t.Errorf("findable state %+v; want the switch shown, on", f)
	}
}
