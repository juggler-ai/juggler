//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package browser_test

import (
	"testing"
	"time"
)

// twoServerPool is a pool of two three-lane servers, "a" and "b".
func twoServerPool() *lanePool {
	p := newLanePool()
	p.add(testServerEntry{addr: "a"}, 3)
	p.add(testServerEntry{addr: "b"}, 3)
	return p
}

// within runs f and returns what it returned, or fails the test when it has not
// returned in time.
func within(t *testing.T, what string, f func() testServerEntry) testServerEntry {
	t.Helper()
	got := make(chan testServerEntry, 1)
	go func() { got <- f() }()
	select {
	case e := <-got:
		return e
	case <-time.After(5 * time.Second):
		t.Fatalf("%s did not return", what)
		return testServerEntry{}
	}
}

// stillBlocked fails the test if the channel delivers within a short window.
func stillBlocked(t *testing.T, what string, ch <-chan testServerEntry) {
	t.Helper()
	select {
	case e := <-ch:
		t.Fatalf("%s returned %q while lanes were still in flight", what, e.addr)
	case <-time.After(50 * time.Millisecond):
	}
}

// An exclusive test gets a whole server only once the lanes in flight there have
// come back, and meanwhile no new test is put on it — the other server takes
// them — so the drain finishes however many ordinary tests are queued.
func TestLanePoolExclusiveDrainsItsServer(t *testing.T) {
	p := twoServerPool()
	var held []testServerEntry
	for range 4 {
		held = append(held, p.acquire()) // a, b, a, b: one lane free on each
	}

	excl := make(chan testServerEntry, 1)
	go func() { excl <- p.acquireServer() }()
	stillBlocked(t, "acquireServer", excl)

	// The reserved server is "a" (the tie goes to the first); a new ordinary
	// test must land on "b" even though "a" still has a lane free.
	if e := within(t, "acquire", p.acquire); e.addr != "b" {
		t.Fatalf("an ordinary test was put on %q, which an exclusive test has reserved", e.addr)
	}

	for _, e := range held {
		if e.addr == "a" {
			stillBlocked(t, "acquireServer", excl)
			p.release(e)
		}
	}
	select {
	case e := <-excl:
		if e.addr != "a" {
			t.Fatalf("acquireServer returned %q, want the server it reserved", e.addr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("acquireServer did not return once its server drained")
	}

	// "b" is full and "a" is held whole: an ordinary test now waits until the
	// exclusive one hands its server back.
	next := make(chan testServerEntry, 1)
	go func() { next <- p.acquire() }()
	stillBlocked(t, "acquire", next)
	p.releaseServer(testServerEntry{addr: "a"})
	if e := <-next; e.addr != "a" {
		t.Fatalf("acquire returned %q after the exclusive server was released", e.addr)
	}
}

// In a pool with solo windows an exclusive test runs in one of those, however
// free the ordinary windows are, and an ordinary test is never put in one.
func TestLanePoolSoloWindowsAreForExclusiveTests(t *testing.T) {
	p := twoServerPool()
	p.addSolo(testServerEntry{addr: "solo"})

	for range 6 {
		if e := within(t, "acquire", p.acquire); e.addr == "solo" {
			t.Fatal("an ordinary test was given the solo window")
		}
	}
	// Every ordinary lane is now taken; the solo window is still free.
	excl := within(t, "acquireServer", p.acquireServer)
	if excl.addr != "solo" {
		t.Fatalf("an exclusive test was given %q, want the solo window", excl.addr)
	}

	// A second exclusive test waits for the solo window rather than draining
	// an ordinary one.
	second := make(chan testServerEntry, 1)
	go func() { second <- p.acquireServer() }()
	stillBlocked(t, "second acquireServer", second)
	p.releaseServer(excl)
	if e := <-second; e.addr != "solo" {
		t.Fatalf("second acquireServer got %q, want the solo window", e.addr)
	}
	p.releaseServer(testServerEntry{addr: "solo"})

	// acquireAll waits for every window, solo included.
	all := make(chan []testServerEntry, 1)
	go func() { all <- p.acquireAll() }()
	select {
	case es := <-all:
		t.Fatalf("acquireAll returned %d windows while ordinary lanes were in flight", len(es))
	case <-time.After(50 * time.Millisecond):
	}
	for _, addr := range []string{"a", "b"} {
		for range 3 {
			p.release(testServerEntry{addr: addr})
		}
	}
	select {
	case es := <-all:
		if len(es) != 3 {
			t.Fatalf("acquireAll returned %d windows, want 3", len(es))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("acquireAll did not return once every window drained")
	}
}

// A pool told how many exclusive tests to expect keeps its solo window for them
// until the last has been released, then gives it to ordinary tests.
func TestLanePoolHandsSoloWindowsOnWhenExclusivesAreDone(t *testing.T) {
	p := twoServerPool()
	p.addSolo(testServerEntry{addr: "solo"})
	p.expectExclusive(2)

	for range 6 {
		within(t, "acquire", p.acquire) // every ordinary lane taken
	}
	next := make(chan testServerEntry, 1)
	go func() { next <- p.acquire() }()
	stillBlocked(t, "acquire while exclusives are outstanding", next)

	p.releaseServer(within(t, "first acquireServer", p.acquireServer))
	stillBlocked(t, "acquire with one exclusive still to come", next)

	p.releaseServer(within(t, "second acquireServer", p.acquireServer))
	select {
	case e := <-next:
		if e.addr != "solo" {
			t.Fatalf("acquire got %q once the exclusives were done, want the solo window", e.addr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the solo window was not handed to ordinary tests after the last exclusive one")
	}
}

// A pool expecting no exclusive tests at all hands its solo windows over at
// once — a -run that selects none of them leaves nothing to keep them for.
func TestLanePoolWithNoExclusivesUsesSoloWindowsAtOnce(t *testing.T) {
	p := twoServerPool()
	p.addSolo(testServerEntry{addr: "solo"})
	p.expectExclusive(0)
	got := map[string]int{}
	for range 7 {
		got[within(t, "acquire", p.acquire).addr]++
	}
	if got["solo"] != 1 {
		t.Fatalf("the solo window was not used, lanes taken: %v", got)
	}
}

// Two exclusive tests hold two different servers at once, and a third waits for
// one of them.
func TestLanePoolExclusivesTakeDistinctServers(t *testing.T) {
	p := twoServerPool()
	first := within(t, "first acquireServer", p.acquireServer)
	second := within(t, "second acquireServer", p.acquireServer)
	if first.addr == second.addr {
		t.Fatalf("both exclusive tests were given %q", first.addr)
	}

	third := make(chan testServerEntry, 1)
	go func() { third <- p.acquireServer() }()
	stillBlocked(t, "third acquireServer", third)
	p.releaseServer(second)
	if e := <-third; e.addr != second.addr {
		t.Fatalf("third acquireServer got %q, want the released %q", e.addr, second.addr)
	}
}

// A lane the harness gave up on may still be running its suite: it stays taken
// until that suite has ended, so no test is put on it and no exclusive test or
// fixture reset counts its server drained in the meantime.
func TestLanePoolAbandonedLaneStaysTakenUntilItsSuiteEnds(t *testing.T) {
	p := twoServerPool()
	for range 6 {
		within(t, "acquire", p.acquire)
	}
	suiteEnded := make(chan struct{})
	p.releaseAfter(testServerEntry{addr: "a"}, func() { <-suiteEnded })

	next := make(chan testServerEntry, 1)
	go func() { next <- p.acquire() }()
	stillBlocked(t, "acquire while the abandoned suite runs", next)

	close(suiteEnded)
	select {
	case e := <-next:
		if e.addr != "a" {
			t.Fatalf("acquire got %q once the abandoned suite ended, want its lane on \"a\"", e.addr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the abandoned lane did not come back once its suite ended")
	}
}

// The same for an exclusive test's server: it is handed back whole only once
// the suite it gave up on has ended.
func TestLanePoolAbandonedServerStaysHeldUntilItsSuiteEnds(t *testing.T) {
	p := twoServerPool()
	excl := within(t, "acquireServer", p.acquireServer)
	suiteEnded := make(chan struct{})
	p.releaseServerAfter(excl, func() { <-suiteEnded })

	all := make(chan []testServerEntry, 1)
	go func() { all <- p.acquireAll() }()
	select {
	case es := <-all:
		t.Fatalf("acquireAll returned %d windows while an abandoned suite was running", len(es))
	case <-time.After(50 * time.Millisecond):
	}
	close(suiteEnded)
	select {
	case es := <-all:
		if len(es) != 2 {
			t.Fatalf("acquireAll returned %d windows, want 2", len(es))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the abandoned server did not come back once its suite ended")
	}
}
