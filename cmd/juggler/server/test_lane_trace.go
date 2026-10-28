//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package server

import (
	"net/http"
	"sort"
	"time"

	"juggler/cmd/juggler/server/handlers"
)

// laneTrace is the server's record of how far each lane of its test pool got:
// when the pool page was served, when each lane's page was served, and when
// each lane last asked for work.
//
// A lane that never takes work leaves nothing anywhere else. Its page cannot
// report a load it never finished, and an empty poll of the queue records
// nothing in the queue audit, so a pool that never ran a lane and one whose
// lanes are polling but late read the same from outside. Only the server sees
// every one of these requests, so it keeps the account, and the harness reads
// it when a wait on the pool gives up (GET /api/test/lanes).
//
// Safe for concurrent use: its state sits in a one-slot channel and is owned
// by whoever has taken it out (with).
type laneTrace struct {
	started time.Time
	state   chan *laneTraceState
}

type laneTraceState struct {
	poolPage traceMark
	lanes    map[string]*laneMarks
	// waiters are waitPolling calls still waiting for their count of lanes.
	waiters []laneWaiter
}

// laneWaiter is a wait for n distinct lanes to have polled, released by
// closing ch.
type laneWaiter struct {
	n  int
	ch chan struct{}
}

// pollingLanes is how many distinct lanes have asked for work.
func (s *laneTraceState) pollingLanes() int {
	n := 0
	for _, m := range s.lanes {
		if m.poll.count > 0 {
			n++
		}
	}
	return n
}

// release closes and drops every waiter whose count has been reached.
func (s *laneTraceState) release() {
	have := s.pollingLanes()
	kept := s.waiters[:0]
	for _, w := range s.waiters {
		if have >= w.n {
			close(w.ch)
		} else {
			kept = append(kept, w)
		}
	}
	s.waiters = kept
}

// with runs fn as the state's only owner.
func (lt *laneTrace) with(fn func(s *laneTraceState)) {
	s := <-lt.state
	defer func() { lt.state <- s }()
	fn(s)
}

// traceMark counts one kind of request and remembers when the last came.
type traceMark struct {
	count int
	last  time.Time
}

func (m *traceMark) hit(now time.Time) {
	m.count++
	m.last = now
}

// laneMarks is one lane's progress: its page served, then its polls.
type laneMarks struct {
	page, poll traceMark
}

func newLaneTrace() *laneTrace {
	lt := &laneTrace{started: time.Now(), state: make(chan *laneTraceState, 1)}
	lt.state <- &laneTraceState{lanes: map[string]*laneMarks{}}
	return lt
}

// lane returns the marks for a lane id, creating them on first use. An
// unlabelled request is filed under "?".
func (s *laneTraceState) lane(id string) *laneMarks {
	if id == "" {
		id = "?"
	}
	m, ok := s.lanes[id]
	if !ok {
		m = &laneMarks{}
		s.lanes[id] = m
	}
	return m
}

func (lt *laneTrace) servedPool() {
	lt.with(func(s *laneTraceState) { s.poolPage.hit(time.Now()) })
}

func (lt *laneTrace) servedLanePage(id string) {
	lt.with(func(s *laneTraceState) { s.lane(id).page.hit(time.Now()) })
}

func (lt *laneTrace) polled(id string) {
	lt.with(func(s *laneTraceState) {
		m := s.lane(id)
		m.poll.hit(time.Now())
		if m.poll.count == 1 {
			s.release()
		}
	})
}

// waitPolling reports whether n distinct lanes have asked for work within
// timeout, returning as soon as they have.
func (lt *laneTrace) waitPolling(n int, timeout time.Duration) bool {
	w := laneWaiter{n: n, ch: make(chan struct{})}
	lt.with(func(s *laneTraceState) {
		s.waiters = append(s.waiters, w)
		s.release()
	})
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-w.ch:
		return true
	case <-timer.C:
	}
	released := false
	lt.with(func(s *laneTraceState) {
		for i, x := range s.waiters {
			if x.ch == w.ch {
				s.waiters = append(s.waiters[:i], s.waiters[i+1:]...)
				return
			}
		}
		released = true // closed between the timer and this
	})
	return released
}

// wrap returns h preceded by note, called with the request's lane query
// parameter.
func (lt *laneTrace) wrap(note func(lane string), h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		note(r.URL.Query().Get("lane"))
		h(w, r)
	}
}

// LaneMark is the wire form of a traceMark: how many came and how long ago the
// last did, by the server's clock, -1 when none ever did.
type LaneMark struct {
	Count int   `json:"count"`
	AgoMs int64 `json:"agoMs"`
}

// LaneReport is the wire form of one lane's marks.
type LaneReport struct {
	Lane       string   `json:"lane"`
	PageServed LaneMark `json:"pageServed"`
	Polled     LaneMark `json:"polled"`
}

// LaneTraceReport is what GET /api/test/lanes returns.
type LaneTraceReport struct {
	UptimeMs   int64        `json:"uptimeMs"`
	PoolServed LaneMark     `json:"poolServed"`
	Lanes      []LaneReport `json:"lanes"`
}

func (m traceMark) wire(now time.Time) LaneMark {
	if m.count == 0 {
		return LaneMark{AgoMs: -1}
	}
	return LaneMark{Count: m.count, AgoMs: now.Sub(m.last).Milliseconds()}
}

func (lt *laneTrace) report() LaneTraceReport {
	var out LaneTraceReport
	lt.with(func(s *laneTraceState) {
		now := time.Now()
		out = LaneTraceReport{
			UptimeMs:   now.Sub(lt.started).Milliseconds(),
			PoolServed: s.poolPage.wire(now),
			Lanes:      []LaneReport{},
		}
		for id, m := range s.lanes {
			out.Lanes = append(out.Lanes, LaneReport{Lane: id, PageServed: m.page.wire(now), Polled: m.poll.wire(now)})
		}
	})
	sort.Slice(out.Lanes, func(i, j int) bool { return out.Lanes[i].Lane < out.Lanes[j].Lane })
	return out
}

func (lt *laneTrace) handleReport(w http.ResponseWriter, r *http.Request) {
	handlers.WriteJSON(w, r, 0, lt.report())
}
