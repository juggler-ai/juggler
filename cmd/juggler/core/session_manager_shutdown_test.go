//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// stillRunning returns every goroutine's stack.
//
// Shutdown waits on one WaitGroup covering the actor, the bin-size monitor, the
// orphan sweep and any deferred background step, and reports nothing about
// which of them is outstanding. Both deadlines below therefore used to fail
// with the same sentence whatever had happened — and because a run that misses
// the deadline spends all of it, three sightings came in at 10.26s to the
// millisecond, which reads like a fixed wait somewhere and is not: it is this
// test's own bound, plus the 250ms it spends proving Shutdown blocks. That
// coincidence cost three sessions. The stacks are what distinguishes a straggler
// from a deadlock.
func stillRunning() string {
	buf := make([]byte, 1<<20)
	return string(buf[:runtime.Stack(buf, true)])
}

// Shutdown is documented as a barrier: once it returns, no goroutine of this
// manager writes into the project directory again. The server releases the
// project's lock the moment it returns, so a straggler writes into a directory
// whose next owner may already be there.
//
// EmptyBin defers the OS-trash of the moved-aside staging directory to a
// background goroutine, which puts it on the wrong side of that promise unless
// the manager waits for it too.
func TestShutdownWaitsForTheBinsBackgroundTrashStep(t *testing.T) {
	store, dir := newStoreForTest(t)
	id, _, _, err := store.CreateConversationFolder("Doomed", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	if err := store.BinConversation(id); err != nil {
		t.Fatalf("BinConversation: %v", err)
	}

	// Hold the trash step open so "did Shutdown wait?" is a question about the
	// barrier rather than about which goroutine won a race.
	started := make(chan struct{})
	release := make(chan struct{})
	previous := backgroundTrash
	backgroundTrash = func(path string) error {
		close(started)
		<-release
		return os.RemoveAll(path)
	}
	t.Cleanup(func() { backgroundTrash = previous })

	mgr, err := NewSessionManagerForPath(dir)
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	if _, err := mgr.EmptyBin(); err != nil {
		t.Fatalf("EmptyBin: %v", err)
	}
	<-started

	returned := make(chan struct{})
	go func() {
		mgr.Shutdown()
		close(returned)
	}()

	// Negative assertion, so a short flat wait is the right instrument: proving
	// something has not happened must stay cheap.
	select {
	case <-returned:
		t.Fatal("Shutdown returned while the bin's trash step was still writing into the project")
	case <-time.After(250 * time.Millisecond):
	}

	close(release)
	select {
	case <-returned:
	case <-time.After(10 * time.Second):
		t.Fatalf("Shutdown never returned after the trash step finished; still running:\n%s", stillRunning())
	}

	leftovers, _ := filepath.Glob(filepath.Join(dir, ".juggler", "trash.emptying-*"))
	if len(leftovers) != 0 {
		t.Fatalf("staging dirs still under .juggler after Shutdown: %v", leftovers)
	}
}

// The startup sweep is the second writer of the same staging directories as
// EmptyBin's own deferred step, so it goes through the same seam. A test that
// holds one open while the other still reaches the real OS trash proves nothing
// about the barrier and quietly sends a directory to the machine's Trash while
// doing it — which, under a four-way concurrent test run, is a real thing to
// have done.
func TestTheStartupSweepTrashesThroughTheSameSeamAsEmptyBin(t *testing.T) {
	_, dir := newStoreForTest(t)
	orphan := filepath.Join(dir, ".juggler", "trash.emptying-leftover")
	if err := os.MkdirAll(orphan, 0o755); err != nil {
		t.Fatalf("seed orphan: %v", err)
	}

	// Unsynchronised on purpose: the sweep is the only writer and it is counted
	// in the WaitGroup Shutdown waits on, so Shutdown returning is the
	// happens-before edge between its last write and this read.
	var swept []string
	previous := backgroundTrash
	backgroundTrash = func(path string) error {
		swept = append(swept, path)
		return os.RemoveAll(path)
	}
	t.Cleanup(func() { backgroundTrash = previous })

	mgr, err := NewSessionManagerForPath(dir)
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	mgr.Shutdown()

	if len(swept) != 1 || swept[0] != orphan {
		t.Fatalf("the startup sweep must trash the orphan through backgroundTrash; it reported %v", swept)
	}
}

// The same barrier holds for the aged-out variant, which splits its work the
// same way.
func TestShutdownWaitsForAnAgedOutEmptysTrashStep(t *testing.T) {
	store, dir := newStoreForTest(t)
	binConvAged(t, store, "Ancient", 400*24*time.Hour)

	started := make(chan struct{})
	release := make(chan struct{})
	previous := backgroundTrash
	backgroundTrash = func(path string) error {
		close(started)
		<-release
		return os.RemoveAll(path)
	}
	t.Cleanup(func() { backgroundTrash = previous })

	mgr, err := NewSessionManagerForPath(dir)
	if err != nil {
		t.Fatalf("NewSessionManagerForPath: %v", err)
	}
	if _, err := mgr.EmptyBinOlderThan(30); err != nil {
		t.Fatalf("EmptyBinOlderThan: %v", err)
	}
	<-started

	returned := make(chan struct{})
	go func() {
		mgr.Shutdown()
		close(returned)
	}()

	select {
	case <-returned:
		t.Fatal("Shutdown returned while the aged-out empty's trash step was still writing into the project")
	case <-time.After(250 * time.Millisecond):
	}

	close(release)
	select {
	case <-returned:
	case <-time.After(10 * time.Second):
		t.Fatalf("Shutdown never returned after the aged-out empty's trash step finished; still running:\n%s", stillRunning())
	}
}
