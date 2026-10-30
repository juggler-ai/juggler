//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package core

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A permanent delete removes the folder while the conversation's worker is
// still stopping (the manager acks the removal before the stop), and on Windows
// any handle still open inside the folder — the worker's last write, a handler
// serving one of its files — refuses the removal. The delete must outlast that
// hold rather than fail: a failed delete keeps the conversation.
//
// The handle is let go only once a removal attempt has run (the unheld sibling
// is gone), so the delete sees the hold for real.
func TestDeleteConversationPermanentOutlastsAHandleInTheFolder(t *testing.T) {
	store, _ := newStoreForTest(t)
	id, _, _, err := store.CreateConversationFolder("Held", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	dir, ok := store.ConvDir(id)
	if !ok {
		t.Fatalf("no folder for %s", id)
	}
	held := filepath.Join(dir, "held.bin")
	sibling := filepath.Join(dir, "sibling.bin")
	for _, p := range []string{held, sibling} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	handle, err := os.Open(held)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()

	released := make(chan struct{})
	go func() {
		defer close(released)
		for {
			if _, err := os.Stat(sibling); os.IsNotExist(err) {
				_ = handle.Close()
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()

	if err := store.removeConversationFiles(id, true); err != nil {
		t.Fatalf("permanent delete with a handle open in the folder: %v", err)
	}
	<-released
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("folder still there after the delete: stat err %v", err)
	}
	if _, ok := store.ConvDir(id); ok {
		t.Fatalf("%s still indexed after the delete", id)
	}
}
