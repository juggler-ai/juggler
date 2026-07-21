//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// prefixRemap redirects any path under real into wt (a stand-in for a
// conversation's worktree), mirroring what core.ConvWorktrees.Remap does for a
// single repo without needing git in this unit test.
func prefixRemap(real, wt string) func(string) string {
	real = filepath.Clean(real)
	return func(abs string) string {
		abs = filepath.Clean(abs)
		if abs == real {
			return wt
		}
		if rel, err := filepath.Rel(real, abs); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return filepath.Join(wt, rel)
		}
		return abs
	}
}

// TestRemap_WriteReadGrepStayInWorktree verifies the redirect end to end: a
// write lands in the worktree (not the real project), a read sees it, and grep
// reports it with a project-relative path so a follow-up read redirects back to
// the same worktree file.
func TestRemap_WriteReadGrepStayInWorktree(t *testing.T) {
	real := t.TempDir()
	wt := t.TempDir()
	scope := NewPathScope(real, nil).WithRemap(prefixRemap(real, wt))
	fops := NewFileOperations(scope)
	ctx := context.Background()

	// Write a file by its project-relative path.
	if _, err := fops.Execute(ctx, "writeFile", map[string]any{
		"path": "notes/todo.md", "content": "find me: needle\n",
	}); err != nil {
		t.Fatalf("writeFile: %v", err)
	}

	// It must exist in the worktree, and NOT in the real project.
	if _, err := os.Stat(filepath.Join(wt, "notes", "todo.md")); err != nil {
		t.Errorf("write did not land in the worktree: %v", err)
	}
	if _, err := os.Stat(filepath.Join(real, "notes", "todo.md")); !os.IsNotExist(err) {
		t.Errorf("write leaked into the real project (isolation broken): %v", err)
	}

	// A read of the same project-relative path sees the worktree content.
	res, err := fops.Execute(ctx, "loadFile", map[string]any{"path": "notes/todo.md"})
	if err != nil {
		t.Fatalf("loadFile: %v", err)
	}
	if m, _ := res.(map[string]any); m["content"] != "find me: needle\n" {
		t.Errorf("read did not see the worktree write: %v", m["content"])
	}

	// grep finds it and reports the project-relative path (so the agent's next
	// read of that path redirects back into the worktree).
	sops := NewSearchOperations(scope)
	gres, err := sops.Execute(ctx, "grep", map[string]any{"pattern": "needle"})
	if err != nil {
		t.Fatalf("grep: %v", err)
	}
	matches, _ := gres.(map[string]any)["matches"].([]map[string]any)
	if len(matches) == 0 {
		t.Fatal("grep found nothing in the worktree")
	}
	if got := matches[0]["file"]; got != "notes/todo.md" {
		t.Errorf("grep reported %q, want project-relative notes/todo.md", got)
	}
}

// TestRemap_InProjectWriteNeedsNoApproval guards the security ordering: because
// AuthorizeOutOfScopeWrite validates the REAL preimage, an ordinary in-project
// write succeeds without the out-of-root approval flag even though Sanitize
// redirects the path into a worktree outside the project root.
func TestRemap_InProjectWriteNeedsNoApproval(t *testing.T) {
	real := t.TempDir()
	wt := t.TempDir()
	scope := NewPathScope(real, nil).WithRemap(prefixRemap(real, wt))

	// In-project path: allowed without approval.
	if err := scope.AuthorizeOutOfScopeWrite(filepath.Join(wt, "a.txt"), "a.txt", "write", false); err != nil {
		t.Errorf("in-project write wrongly rejected: %v", err)
	}

	// Genuinely out-of-project path: still requires approval.
	outside := filepath.Join(t.TempDir(), "evil.txt")
	if err := scope.AuthorizeOutOfScopeWrite(outside, outside, "write", false); err == nil {
		t.Error("out-of-project write was allowed without approval")
	}
	if err := scope.AuthorizeOutOfScopeWrite(outside, outside, "write", true); err != nil {
		t.Errorf("approved out-of-project write rejected: %v", err)
	}
}
