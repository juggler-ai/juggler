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
