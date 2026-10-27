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
