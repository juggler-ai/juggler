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
	"juggler/internal/jlog"
)

// laneTrace is the server's record of how far each lane of its test pool got:
// when the pool page was served, when each lane's page was served, when each
// lane's page last said it was still booting, and when each lane last asked
// for work.
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
	// now and after are the clock and timers; a test supplies its own.
	now   func() time.Time
	after func(time.Duration) <-chan time.Time
}

type laneTraceState struct {
	poolPage traceMark
	lanes    map[string]*laneMarks
	// waiters are waitPolling calls still waiting for their count of lanes.
	waiters []laneWaiter
	// load counts the waitPolling calls that have given up, after each of which
	// its caller loads the pool window again. A lane whose page was last served
	// in an earlier load belongs to the load being replaced (pending). It is a
	// count, not a time: a coarse clock (Windows') stamps a give-up and the page
	// served straight after it with the same instant.
	load int
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

// laneMarks is one lane's progress: its page served, its page saying it is
// still booting, then its polls.
type laneMarks struct {
	page, boot, poll traceMark
	// load is the state's load its page was last served in.
	load int
	// refused counts the polls answered with no work because the lane belongs
	// to a load being replaced.
	refused int
}

func newLaneTrace() *laneTrace {
	lt := &laneTrace{started: time.Now(), state: make(chan *laneTraceState, 1), now: time.Now, after: time.After}
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
	lt.with(func(s *laneTraceState) { s.poolPage.hit(lt.now()) })
}

func (lt *laneTrace) servedLanePage(id string) {
	lt.with(func(s *laneTraceState) {
		m := s.lane(id)
		m.page.hit(lt.now())
		m.load = s.load
	})
}

// booting notes a lane's page asking /api/test/booting: its script is running
// and its poll loop has not started yet, which is the whole of a module graph's
// load.
func (lt *laneTrace) booting(id string) {
	lt.with(func(s *laneTraceState) { s.lane(id).boot.hit(lt.now()) })
}

// pending returns h, the queue's destructive next-entry read, behind the lane's
// poll mark and the fence a given-up wait puts up. A lane whose page has not
// been served since the give-up is one of the load its caller is replacing, so
// work handed to it would be destroyed with its page; it is answered as an
// empty queue. A poll that passes the fence was marked in the same hold, so a
// wait deciding after it sees it and does not give up.
func (lt *laneTrace) pending(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("lane")
		fenced, first := false, false
		lt.with(func(s *laneTraceState) {
			m := s.lane(id)
			m.poll.hit(lt.now())
			if m.poll.count == 1 {
				s.release()
			}
			if fenced = m.load < s.load; fenced {
				m.refused++
				first = m.refused == 1
			}
		})
		if fenced {
			if first {
				jlog.Info("[test-pool] lane %q asked for work from the load being replaced; it gets none until its page is served again", id)
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}

// lastMark is when the pool last got any further: its page or a lane's served,
// a lane's page booting, or a lane asking for work.
func (s *laneTraceState) lastMark() time.Time {
	last := s.poolPage.last
	for _, m := range s.lanes {
		for _, t := range []time.Time{m.page.last, m.boot.last, m.poll.last} {
			if t.After(last) {
				last = t
			}
		}
	}
	return last
}

// waitPolling reports whether n distinct lanes have asked for work before the
// pool went quiet for the whole of quiet, returning as soon as they have.
// Quiet is counted from the call or the pool's last mark, whichever is later,
// so a load that is slow but getting further is waited for and only one that
// has stopped is given up on.
//
// Giving up is for a caller that then loads the pool again, so it fences the
// queue off from every lane of the load being replaced (pending). The last look
// at the marks and the fence are one hold, so no lane is handed work between
// them.
func (lt *laneTrace) waitPolling(n int, quiet time.Duration) bool {
	w := laneWaiter{n: n, ch: make(chan struct{})}
	lt.with(func(s *laneTraceState) {
		s.waiters = append(s.waiters, w)
		s.release()
	})
	since := lt.now()
	for {
		var left time.Duration
		released := false
		lt.with(func(s *laneTraceState) {
			if last := s.lastMark(); last.After(since) {
				since = last
			}
			if left = quiet - lt.now().Sub(since); left > 0 {
				return
			}
			if !s.dropWaiter(w.ch) {
				released = true // closed between the timer and this
				return
			}
			s.load++
		})
		if left <= 0 {
			return released
		}
		select {
		case <-w.ch:
			return true
		case <-lt.after(left):
		}
	}
}

// dropWaiter removes the waiter on ch, reporting whether it was still waiting.
func (s *laneTraceState) dropWaiter(ch chan struct{}) bool {
	for i, x := range s.waiters {
		if x.ch == ch {
			s.waiters = append(s.waiters[:i], s.waiters[i+1:]...)
			return true
		}
	}
	return false
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
	Booting    LaneMark `json:"booting"`
	Polled     LaneMark `json:"polled"`
	// Refused counts the polls answered with no work because the lane was one
	// of a load being replaced.
	Refused int `json:"refused"`
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
		now := lt.now()
		out = LaneTraceReport{
			UptimeMs:   now.Sub(lt.started).Milliseconds(),
			PoolServed: s.poolPage.wire(now),
			Lanes:      []LaneReport{},
		}
		for id, m := range s.lanes {
			out.Lanes = append(out.Lanes, LaneReport{Lane: id, PageServed: m.page.wire(now), Booting: m.boot.wire(now), Polled: m.poll.wire(now), Refused: m.refused})
		}
	})
	sort.Slice(out.Lanes, func(i, j int) bool { return out.Lanes[i].Lane < out.Lanes[j].Lane })
	return out
}

func (lt *laneTrace) handleReport(w http.ResponseWriter, r *http.Request) {
	handlers.WriteJSON(w, r, 0, lt.report())
}
