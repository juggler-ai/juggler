//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package atomicio

import (
	"os"
	"path/filepath"
	"testing"
)

// A tree with a file another handle holds open cannot be removed on Windows
// (os.Open shares no delete access). RobustRemoveAll must outlast that hold:
// the handle is let go only once a real removal attempt has failed on it, so
// the test proves both that the hold was real and that the removal survived it.
func TestRobustRemoveAll_OutlastsAHandleInTheTree(t *testing.T) {
	root := filepath.Join(t.TempDir(), "fixture")
	held := filepath.Join(root, "sub", "held.txt")
	if err := os.MkdirAll(filepath.Dir(held), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(held, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	handle, err := os.Open(held)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()

	var firstFailure error
	removeAll = func(path string) error {
		err := os.RemoveAll(path)
		if err != nil && firstFailure == nil {
			firstFailure = err
			_ = handle.Close()
		}
		return err
	}
	t.Cleanup(func() { removeAll = os.RemoveAll })

	if err := RobustRemoveAll(root); err != nil {
		t.Fatalf("RobustRemoveAll: %v (first failure: %v)", err, firstFailure)
	}
	if firstFailure == nil {
		t.Fatal("the first removal succeeded with a handle open in the tree, so nothing was held")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("tree still there after RobustRemoveAll: stat err %v", err)
	}
}

// A file another handle is reading cannot be removed on Windows: a store's
// sweep dropping a blob that an HTTP handler is serving at that moment. That
// sweep runs once per save, so a removal lost to the read is never made
// again. RobustRemove must outlast the read, proved as above: the handle is
// let go only once a real removal attempt has failed on it.
func TestRobustRemove_OutlastsAReader(t *testing.T) {
	held := filepath.Join(t.TempDir(), "held.json")
	if err := os.WriteFile(held, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	handle, err := os.Open(held)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()

	var firstFailure error
	remove = func(path string) error {
		err := os.Remove(path)
		if err != nil && firstFailure == nil {
			firstFailure = err
			_ = handle.Close()
		}
		return err
	}
	t.Cleanup(func() { remove = os.Remove })

	if err := RobustRemove(held); err != nil {
		t.Fatalf("RobustRemove: %v (first failure: %v)", err, firstFailure)
	}
	if firstFailure == nil {
		t.Fatal("the first removal succeeded with a reader open on the file, so nothing was held")
	}
	if _, err := os.Stat(held); !os.IsNotExist(err) {
		t.Fatalf("file still there after RobustRemove: stat err %v", err)
	}
}

// A file that is not there is no transient: RobustRemove reports it at once,
// as os.Remove does, for the caller to treat as already gone.
func TestRobustRemove_MissingIsNotRetried(t *testing.T) {
	calls := 0
	remove = func(path string) error {
		calls++
		return os.Remove(path)
	}
	t.Cleanup(func() { remove = os.Remove })
	if err := RobustRemove(filepath.Join(t.TempDir(), "absent")); !os.IsNotExist(err) {
		t.Fatalf("RobustRemove of a missing file: err=%v, want not-exist", err)
	}
	if calls != 1 {
		t.Fatalf("a missing file was tried %d times, want 1", calls)
	}
}
