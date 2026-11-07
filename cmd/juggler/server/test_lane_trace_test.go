//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
