//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"os"
	"path/filepath"
	"testing"
)

// A project with a repository on a machine without git: the review says so
// once, in words the user can act on, and still lists the repository it could
// not read — it never claims there is nothing here. Dropping a conversation's
// turn snapshot there is not a failure worth logging. Not parallel: it changes
// PATH.
func TestReviewWithoutGit(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())

	resp := Review(t.Context(), root, Scope{})
	if resp.GitMissing == nil {
		t.Fatalf("GitMissing unset; warnings %v, repos %+v", resp.Warnings, resp.Repos)
	}
	if resp.Complete {
		t.Error("Complete = true for a repository nothing could read")
	}
	if got := resp.paths(); len(got) != 1 || got[0] != "" {
		t.Fatalf("repositories = %v, want the root one listed", got)
	}
	if resp.Repos[0].Error == "" {
		t.Error("the unread repository carries no error")
	}

	if err := DropTurnSnapshot(t.Context(), root, "conv1"); err != nil {
		t.Errorf("DropTurnSnapshot = %v, want nil without git", err)
	}
}
