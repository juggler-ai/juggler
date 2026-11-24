//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestWaitForTestLanesWaitsForEveryLaneToPoll: the wait the pool window's
// startup takes returns as soon as the given number of distinct lanes have
// asked for work, and not before — a lane polling twice is still one lane.
func TestWaitForTestLanesWaitsForEveryLaneToPoll(t *testing.T) {
	s, _ := ownershipGuardServer(t)
	get := func(path string) {
		t.Helper()
		s.router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	}
	if s.WaitForTestLanes(2, 10*time.Millisecond) {
		t.Fatal("the wait returned true with no lane polling")
	}
	get("/api/test/pending?lane=0")
	get("/api/test/pending?lane=0")
	if s.WaitForTestLanes(2, 10*time.Millisecond) {
		t.Fatal("one lane polling twice counted as two lanes")
	}
	done := make(chan bool, 1)
	go func() { done <- s.WaitForTestLanes(2, time.Minute) }()
	get("/api/test/pending?lane=1")
	if !<-done {
		t.Fatal("the wait did not return true once both lanes had polled")
	}
}

// TestWaitForTestLanesIsBoundedByQuietNotByAge: the pool window reloads a first
// load that has stopped, not one that is slow. So the wait gives up only once
// the pool has gone its whole span with no page served and no lane polling; a
// page served late in the span starts the span again. The clock and timers are
// the test's, so the steps are exact.
func TestWaitForTestLanesIsBoundedByQuietNotByAge(t *testing.T) {
	lt := newLaneTrace()
	now := time.Unix(1000, 0)
	lt.now = func() time.Time { return now }
	type armed struct {
		d    time.Duration
		fire chan time.Time
	}
	timers := make(chan armed)
	lt.after = func(d time.Duration) <-chan time.Time {
		a := armed{d: d, fire: make(chan time.Time, 1)}
		timers <- a
		return a.fire
	}
	const span = 30 * time.Second

	done := make(chan bool, 1)
	go func() { done <- lt.waitPolling(2, span) }()

	first := <-timers
	if first.d != span {
		t.Fatalf("first timer armed for %v, want the whole span %v", first.d, span)
	}
	now = now.Add(20 * time.Second)
	lt.servedLanePage("0")
	now = now.Add(10 * time.Second)
	first.fire <- now

	select {
	case got := <-done:
		t.Fatalf("the wait returned %v %v after it began, though a lane's page was served 10s before", got, span)
	case second := <-timers:
		if want := 20 * time.Second; second.d != want {
			t.Fatalf("re-armed for %v, want the %v left of the span since the page was served", second.d, want)
		}
		now = now.Add(20 * time.Second)
		second.fire <- now
	}
	if <-done {
		t.Fatal("the wait returned true with no lane polling after a quiet span")
	}
}

// TestWaitForTestLanesCountsABootingLaneAsProgress: a lane page's module graph
// can take longer than the span to load, with nothing served or polled the
// while. Its page says it is running by asking /api/test/booting until its poll
// loop starts, and the wait counts each ask as the pool getting further — so a
// slow load is waited for, and only a page whose script never runs is given up
// on.
func TestWaitForTestLanesCountsABootingLaneAsProgress(t *testing.T) {
	s, _ := ownershipGuardServer(t)
	lt := newLaneTrace()
	now := time.Unix(1000, 0)
	lt.now = func() time.Time { return now }
	fire := make(chan chan time.Time)
	lt.after = func(time.Duration) <-chan time.Time {
		c := make(chan time.Time, 1)
		fire <- c
		return c
	}
	const span = 30 * time.Second
	done := make(chan bool, 1)
	go func() { done <- lt.waitPolling(1, span) }()

	first := <-fire
	now = now.Add(25 * time.Second)
	lt.booting("0")
	now = now.Add(5 * time.Second)
	first <- now
	select {
	case got := <-done:
		t.Fatalf("the wait returned %v a span after it began, though the lane said it was booting 5s before", got)
	case second := <-fire:
		now = now.Add(span)
		second <- now
	}
	if <-done {
		t.Fatal("the wait returned true with no lane polling after a quiet span")
	}

	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/test/booting?lane=0", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("GET /api/test/booting = %d, want 204", rec.Code)
	}
	rec = httptest.NewRecorder()
	s.router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/test/lanes", nil))
	var rep LaneTraceReport
	if err := json.Unmarshal(rec.Body.Bytes(), &rep); err != nil {
		t.Fatalf("undecodable report: %v (%s)", err, rec.Body.String())
	}
	if len(rep.Lanes) != 1 || rep.Lanes[0].Booting.Count != 1 {
		t.Fatalf("lanes = %+v, want lane 0 booting once", rep.Lanes)
	}
}

// TestAGivenUpPoolHandsNoWorkToTheLanesBeingReloaded: once the wait gives up,
// the pool window is loaded again, and a lane of the old load may still ask for
// work before the new one replaces it. The queue's read is destructive, so work
// handed to it then would be destroyed with its page. A lane is handed work
// again only once its page has been served since the give-up.
func TestAGivenUpPoolHandsNoWorkToTheLanesBeingReloaded(t *testing.T) {
	s, _ := ownershipGuardServer(t)
	serve := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		return rec
	}
	serve(http.MethodGet, "/headless-test?lane=0", "")
	serve(http.MethodPost, "/api/test/run", `{"name":"unit:x"}`)
	if s.WaitForTestLanes(2, 10*time.Millisecond) {
		t.Fatal("the wait returned true with no lane polling")
	}
	if rec := serve(http.MethodGet, "/api/test/pending?lane=0", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("a lane of the given-up load was handed work: %d %s", rec.Code, rec.Body.String())
	}
	serve(http.MethodGet, "/headless-test?lane=0", "")
	rec := serve(http.MethodGet, "/api/test/pending?lane=0", "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"unit:x"`) {
		t.Fatalf("the reloaded lane was not handed the queued work: %d %s", rec.Code, rec.Body.String())
	}
}

// TestAPoolHandsNoWorkToAPageWithoutALane: a pool server's lanes are the
// iframes of its /test-pool page, each polling as lane=N. A page polling with no
// lane on such a server is a window a test opened — WebView2 gives window.open
// a real top-level window — whose app page the test-mode module turns into a
// slot. Work handed to it runs unaccounted beside the pool's lanes, and from the
// top level, where a unit suite resets the shared fixture under them. It gets
// none, and the lane still does. A lone test window, on a server that serves no
// pool, polls unlabelled and is handed work.
func TestAPoolHandsNoWorkToAPageWithoutALane(t *testing.T) {
	serveOn := func(s *Server) func(method, path, body string) *httptest.ResponseRecorder {
		return func(method, path, body string) *httptest.ResponseRecorder {
			t.Helper()
			rec := httptest.NewRecorder()
			s.router.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
			return rec
		}
	}

	pool, _ := ownershipGuardServer(t)
	serve := serveOn(pool)
	serve(http.MethodGet, "/test-pool?n=1", "")
	serve(http.MethodGet, "/headless-test?lane=0", "")
	serve(http.MethodPost, "/api/test/run", `{"name":"unit:x"}`)
	if rec := serve(http.MethodGet, "/api/test/pending", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("a page polling with no lane on a pool server was handed work: %d %s", rec.Code, rec.Body.String())
	}
	if rec := serve(http.MethodGet, "/api/test/pending?lane=0", ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"unit:x"`) {
		t.Fatalf("the pool's lane was not handed the queued work: %d %s", rec.Code, rec.Body.String())
	}

	lone, _ := ownershipGuardServer(t)
	serve = serveOn(lone)
	serve(http.MethodPost, "/api/test/run", `{"name":"unit:y"}`)
	if rec := serve(http.MethodGet, "/api/test/pending", ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"unit:y"`) {
		t.Fatalf("the lone test window was not handed the queued work: %d %s", rec.Code, rec.Body.String())
	}
}

// TestALanePageServedOnTheGiveUpsClockTickIsOfTheNewLoad: which load a lane
// belongs to is decided by order, not by the clock. A clock as coarse as
// Windows' stamps the give-up and the page served straight after it with the
// same instant; that page is still of the new load, and its lane is handed work.
func TestALanePageServedOnTheGiveUpsClockTickIsOfTheNewLoad(t *testing.T) {
	lt := newLaneTrace()
	now := time.Unix(1000, 0)
	lt.now = func() time.Time { return now }
	lt.after = func(d time.Duration) <-chan time.Time {
		now = now.Add(d)
		c := make(chan time.Time, 1)
		c <- now
		return c
	}
	handed := 0
	pending := lt.pending(func(http.ResponseWriter, *http.Request) { handed++ })
	poll := func() {
		pending(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/test/pending?lane=0", nil))
	}

	lt.servedLanePage("0")
	if lt.waitPolling(2, time.Second) {
		t.Fatal("the wait returned true with one lane polling")
	}
	poll()
	if handed != 0 {
		t.Fatal("a lane of the given-up load was handed work")
	}
	lt.servedLanePage("0") // the clock has not moved since the give-up
	poll()
	if handed != 1 {
		t.Fatal("the lane whose page was served after the give-up was not handed work")
	}
}

// TestLaneTraceReportsHowFarEachLaneGot: the pool page, each lane's page and
// each lane's polls are counted as a test server serves them, and
// GET /api/test/lanes reports them per lane — with a lane whose page was
// served but which never polled shown as exactly that.
func TestLaneTraceReportsHowFarEachLaneGot(t *testing.T) {
	s, _ := ownershipGuardServer(t)
	get := func(path string) {
		t.Helper()
		s.router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	}

	get("/test-pool?n=2")
	get("/headless-test?lane=0")
	get("/headless-test?lane=1")
	get("/api/test/pending?lane=0")
	get("/api/test/pending?lane=0")

	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/test/lanes", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/test/lanes = %d: %s", rec.Code, rec.Body.String())
	}
	var rep LaneTraceReport
	if err := json.Unmarshal(rec.Body.Bytes(), &rep); err != nil {
		t.Fatalf("undecodable report: %v (%s)", err, rec.Body.String())
	}
	if rep.PoolServed.Count != 1 || rep.PoolServed.AgoMs < 0 {
		t.Errorf("pool page = %+v, want served once", rep.PoolServed)
	}
	want := map[string][2]int{"0": {1, 2}, "1": {1, 0}}
	if len(rep.Lanes) != len(want) {
		t.Fatalf("lanes = %+v, want exactly lanes 0 and 1", rep.Lanes)
	}
	for _, l := range rep.Lanes {
		w, ok := want[l.Lane]
		if !ok {
			t.Fatalf("unexpected lane %q in %+v", l.Lane, rep.Lanes)
		}
		if l.PageServed.Count != w[0] || l.Polled.Count != w[1] {
			t.Errorf("lane %s: page served %d, polled %d; want %d and %d",
				l.Lane, l.PageServed.Count, l.Polled.Count, w[0], w[1])
		}
		if (l.Polled.Count == 0) != (l.Polled.AgoMs < 0) {
			t.Errorf("lane %s: polled %d time(s) but last-poll age %dms", l.Lane, l.Polled.Count, l.Polled.AgoMs)
		}
	}
}
