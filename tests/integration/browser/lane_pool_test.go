//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package browser_test

// lanePool hands out the lanes of a set of pool subprocesses: one lane to an
// ordinary browser test, or every lane of one subprocess to a test that cannot
// share it (needsExclusiveRun).
//
// Exclusivity is per subprocess because everything an exclusive test contends
// on is: the fixture root (each subprocess is given its own), the origin its
// localStorage lives in (each listens on its own port), its settings.json (its
// own JUGGLER_CONFIG_DIR), and focus (one window per subprocess, and a window
// has one focused frame). So an exclusive test holds one window while every
// other window goes on running tests.
//
// Where it holds one is the pool's solo windows when it has any: subprocesses
// of a single lane, kept for exclusive tests alone. A one-lane window has no
// sibling to exclude, so nothing drains for it and no lane stands idle while
// it runs. A pool without solo windows gives an exclusive test a whole
// ordinary window instead, reserved and drained (acquireServer).
//
// The exclusive tests are known before any test starts, and they are a small
// share of the work, so the solo windows run out of them early. A pool told how
// many there are (expectExclusive) hands its solo windows to the ordinary tests
// once the last has finished, rather than leave them idle for the rest of the
// run; nothing exclusive can arrive after that to want one back.
//
// One goroutine (run) owns the accounting; every method is a request to it.
type lanePool struct {
	reqs chan poolReq
}

// poolServer is one subprocess's lanes as the pool accounts for them.
type poolServer struct {
	entry testServerEntry
	lanes int
	free  int
	// solo marks a window kept for exclusive tests: no ordinary test is given
	// a lane on it.
	solo bool
	// reserved is set for a test that has claimed the whole subprocess: no new
	// lane is handed out on it, so the lanes still in flight drain and the
	// claim cannot be starved by a stream of ordinary tests.
	reserved bool
	// exclusive is set while an exclusive test (acquireServer) holds it, so
	// its release counts toward expectExclusive.
	exclusive bool
}

type poolOp int

const (
	opAdd poolOp = iota
	opAcquire
	opRelease
	opAcquireServer
	opReleaseServer
	opAcquireAll
	opEntries
	opExpectExclusive
)

type poolReq struct {
	op    poolOp
	entry testServerEntry
	lanes int
	solo  bool
	reply chan poolReply
}

type poolReply struct {
	entry   testServerEntry
	entries []testServerEntry
	lanes   int
}

// poolWaiter is an acquire, acquireServer or acquireAll the pool cannot grant
// yet.
type poolWaiter struct {
	op poolOp
	// held is what a whole-server or all-server waiter has reserved so far.
	held  []*poolServer
	reply chan poolReply
}

func newLanePool() *lanePool {
	p := &lanePool{reqs: make(chan poolReq)}
	go p.run()
	return p
}

func (p *lanePool) call(r poolReq) poolReply {
	r.reply = make(chan poolReply, 1)
	p.reqs <- r
	return <-r.reply
}

// add registers a started subprocess and its lanes, all free.
func (p *lanePool) add(e testServerEntry, lanes int) {
	p.call(poolReq{op: opAdd, entry: e, lanes: lanes})
}

// addSolo registers a started single-lane subprocess kept for exclusive tests.
func (p *lanePool) addSolo(e testServerEntry) {
	p.call(poolReq{op: opAdd, entry: e, lanes: 1, solo: true})
}

// acquire blocks until a lane is free on an ordinary subprocess nobody has
// reserved, and takes it, preferring the subprocess with the most lanes free.
func (p *lanePool) acquire() testServerEntry { return p.call(poolReq{op: opAcquire}).entry }

// release returns a lane taken by acquire.
func (p *lanePool) release(e testServerEntry) { p.call(poolReq{op: opRelease, entry: e}) }

// releaseAfter returns a lane taken by acquire once suiteEnded returns, for a
// test the harness gave up on: its lane may still be running the suite, and
// until it stops the lane is not free — a test put on it would queue behind
// the suite, and a drain that counted it would reset the fixture under it.
// It does not block.
func (p *lanePool) releaseAfter(e testServerEntry, suiteEnded func()) {
	go func() {
		suiteEnded()
		p.release(e)
	}()
}

// acquireServer blocks until it holds every lane of one subprocess. In a pool
// with solo windows that is the first solo window free. Otherwise it reserves
// the ordinary subprocess with the most lanes free — the one that drains
// soonest — then waits for the lanes still in flight there to come back.
func (p *lanePool) acquireServer() testServerEntry {
	return p.call(poolReq{op: opAcquireServer}).entry
}

// releaseServer returns a subprocess taken by acquireServer or acquireAll.
func (p *lanePool) releaseServer(e testServerEntry) {
	p.call(poolReq{op: opReleaseServer, entry: e})
}

// releaseServerAfter is releaseAfter for a subprocess taken by acquireServer.
func (p *lanePool) releaseServerAfter(e testServerEntry, suiteEnded func()) {
	go func() {
		suiteEnded()
		p.releaseServer(e)
	}()
}

// expectExclusive tells the pool how many exclusive tests this run will put
// through acquireServer. Once that many have been released its solo windows
// take ordinary tests too.
func (p *lanePool) expectExclusive(n int) {
	p.call(poolReq{op: opExpectExclusive, lanes: n})
}

// entries is every subprocess in the pool, in the order they were added.
func (p *lanePool) entries() []testServerEntry { return p.call(poolReq{op: opEntries}).entries }

// lanes is the pool's total lane count.
func (p *lanePool) lanes() int { return p.call(poolReq{op: opEntries}).lanes }

// acquireAll takes every subprocess whole, solo windows included, for the
// passes that must run with no test in flight anywhere in the pool. Callers
// return them with releaseAll.
func (p *lanePool) acquireAll() []testServerEntry {
	return p.call(poolReq{op: opAcquireAll}).entries
}

// releaseAll returns what acquireAll took.
func (p *lanePool) releaseAll(es []testServerEntry) {
	for _, e := range es {
		p.releaseServer(e)
	}
}

// run owns the pool's accounting for the life of the process: it applies each
// request, then grants whatever waiters the new state allows.
func (p *lanePool) run() {
	var servers []*poolServer
	var waiting []*poolWaiter
	// exclusiveLeft counts the exclusive tests still to finish; -1 until
	// expectExclusive says how many there are.
	exclusiveLeft := -1
	find := func(e testServerEntry) *poolServer {
		for _, s := range servers {
			if s.entry.addr == e.addr {
				return s
			}
		}
		panic("lanePool: " + e.addr + " is not a server of this pool")
	}
	handOver := func() {
		if exclusiveLeft != 0 {
			return
		}
		for _, s := range servers {
			s.solo = false
		}
	}
	for r := range p.reqs {
		switch r.op {
		case opAdd:
			servers = append(servers, &poolServer{entry: r.entry, lanes: r.lanes, free: r.lanes, solo: r.solo})
			r.reply <- poolReply{}
		case opAcquire, opAcquireServer, opAcquireAll:
			waiting = append(waiting, &poolWaiter{op: r.op, reply: r.reply})
		case opRelease:
			find(r.entry).free++
			r.reply <- poolReply{}
		case opReleaseServer:
			s := find(r.entry)
			s.free, s.reserved = s.lanes, false
			if s.exclusive {
				s.exclusive = false
				if exclusiveLeft > 0 {
					exclusiveLeft--
				}
				handOver()
			}
			r.reply <- poolReply{}
		case opExpectExclusive:
			exclusiveLeft = r.lanes
			handOver()
			r.reply <- poolReply{}
		case opEntries:
			out := poolReply{entries: make([]testServerEntry, len(servers))}
			for i, s := range servers {
				out.entries[i] = s.entry
				out.lanes += s.lanes
			}
			r.reply <- out
		}
		waiting = grant(servers, waiting)
	}
}

// grant satisfies every waiter the servers' state allows and returns the rest,
// in their original order.
//
//   - acquire takes a lane on the unreserved ordinary subprocess with the most
//     free.
//   - acquireServer reserves a subprocess — a solo window if the pool has any,
//     otherwise the unreserved ordinary one with the most lanes free — and is
//     granted it once its lanes have all come back.
//   - acquireAll reserves every subprocess as each comes unreserved, and is
//     granted them once it holds them all and all have drained.
func grant(servers []*poolServer, waiting []*poolWaiter) []*poolWaiter {
	hasSolo := false
	for _, s := range servers {
		hasSolo = hasSolo || s.solo
	}
	mostFree := func(solo, needFree bool) *poolServer {
		var best *poolServer
		for _, s := range servers {
			if s.reserved || s.solo != solo || (needFree && s.free == 0) {
				continue
			}
			if best == nil || s.free > best.free {
				best = s
			}
		}
		return best
	}
	drained := func(held []*poolServer) bool {
		for _, s := range held {
			if s.free < s.lanes {
				return false
			}
		}
		return true
	}
	take := func(held []*poolServer) []testServerEntry {
		out := make([]testServerEntry, len(held))
		for i, s := range held {
			s.free = 0
			out[i] = s.entry
		}
		return out
	}
	rest := waiting[:0]
	for _, w := range waiting {
		switch w.op {
		case opAcquireServer:
			if len(w.held) == 0 {
				if s := mostFree(hasSolo, false); s != nil {
					s.reserved = true
					w.held = []*poolServer{s}
				}
			}
			if len(w.held) == 1 && drained(w.held) {
				w.held[0].exclusive = true
				w.reply <- poolReply{entry: take(w.held)[0]}
				continue
			}
		case opAcquireAll:
			for _, s := range servers {
				if !s.reserved {
					s.reserved = true
					w.held = append(w.held, s)
				}
			}
			if len(w.held) == len(servers) && drained(w.held) {
				w.reply <- poolReply{entries: take(w.held)}
				continue
			}
		default:
			if s := mostFree(false, true); s != nil {
				s.free--
				w.reply <- poolReply{entry: s.entry}
				continue
			}
		}
		rest = append(rest, w)
	}
	return rest
}
