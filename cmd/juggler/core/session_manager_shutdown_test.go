//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Shutdown is documented as a barrier: once it returns, no goroutine of this
// manager writes into the project directory again. The project switch releases
// the project's lock the moment it returns, so a straggler writes into a
// directory whose next owner is already there.
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
		t.Fatal("Shutdown never returned after the trash step finished")
	}

	leftovers, _ := filepath.Glob(filepath.Join(dir, ".juggler", "trash.emptying-*"))
	if len(leftovers) != 0 {
		t.Fatalf("staging dirs still under .juggler after Shutdown: %v", leftovers)
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
		t.Fatal("Shutdown never returned after the trash step finished")
	}
}
