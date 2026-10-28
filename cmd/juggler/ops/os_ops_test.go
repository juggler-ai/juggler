//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestOSResolvePath covers the resolve+exist gate the open/reveal commands run
// before launching anything.
func TestOSResolvePath(t *testing.T) {
	dir := t.TempDir()
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", dir, err)
	}
	fileName := "note.txt"
	abs := filepath.Join(realDir, fileName)
	if err := os.WriteFile(abs, []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	o := NewOSOperations(NewPathScope(realDir, nil))

	t.Run("relative path resolves against workingDir", func(t *testing.T) {
		got, err := o.resolvePath(map[string]any{"path": fileName})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != abs {
			t.Fatalf("got %q, want %q", got, abs)
		}
	})

	t.Run("absolute path passes through", func(t *testing.T) {
		got, err := o.resolvePath(map[string]any{"path": abs})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != abs {
			t.Fatalf("got %q, want %q", got, abs)
		}
	})

	t.Run("missing path param errors", func(t *testing.T) {
		if _, err := o.resolvePath(map[string]any{}); err == nil {
			t.Fatal("expected error for missing path")
		}
	})

	t.Run("nonexistent path errors", func(t *testing.T) {
		if _, err := o.resolvePath(map[string]any{"path": "does-not-exist.txt"}); err == nil {
			t.Fatal("expected error for nonexistent path")
		}
	})

	t.Run("unknown operation errors", func(t *testing.T) {
		if _, err := o.Execute(context.Background(), "frobnicate", map[string]any{"path": abs}); err == nil {
			t.Fatal("expected error for unknown operation")
		}
	})
}

// The whole point of waiting for the launcher: a refusal has to come back as an
// error. Without this the op answers {"opened": true} however the launch went,
// the client has nothing to report, and a user whose file type has no handler
// sees a button that does nothing at all.
func TestSettleLaunchReportsARefusal(t *testing.T) {
	err := settleLaunch(posixShellCommand(t, "echo 'no application knows how' >&2; exit 3"), false)
	if err == nil {
		t.Fatal("a launcher that exited non-zero must be reported, not swallowed")
	}
	// The launcher's own words are the only account of why it refused, so they
	// have to survive into the message the user is shown.
	if !strings.Contains(err.Error(), "no application knows how") {
		t.Fatalf("the launcher's stderr must survive: %v", err)
	}
}

// A launcher that did its job says nothing.
func TestSettleLaunchIsQuietOnSuccess(t *testing.T) {
	if err := settleLaunch(posixShellCommand(t, "exit 0"), false); err != nil {
		t.Fatalf("a launcher that succeeded must report nothing: %v", err)
	}
}

// A binary that is not installed is the Linux failure this whole path exists
// for: no xdg-utils, no window, and — before this — no error either.
func TestSettleLaunchReportsAMissingLauncher(t *testing.T) {
	err := settleLaunch(exec.Command("juggler-no-such-launcher"), false)
	if err == nil {
		t.Fatal("a launcher that is not installed must be reported")
	}
}

// Once the launcher has been running a while it has been accepted, and what it
// does afterwards is the application's business. The op must not sit on the
// request waiting for a window to be closed.
func TestSettleLaunchDoesNotWaitForTheApplication(t *testing.T) {
	restore := launchSettle
	launchSettle = 50 * time.Millisecond
	t.Cleanup(func() { launchSettle = restore })

	cmd := posixShellCommand(t, "sleep 30")
	started := time.Now()
	if err := settleLaunch(cmd, false); err != nil {
		t.Fatalf("a launcher still running has not failed: %v", err)
	}
	if waited := time.Since(started); waited > 2*time.Second {
		t.Fatalf("the op waited %v on a launcher that had already been accepted", waited)
	}
	_ = cmd.Process.Kill()
}

// The op turns a refusal into an error rather than reporting {"opened": true},
// which is what lets the client say something.
func TestOpenReportsALaunchFailure(t *testing.T) {
	dir := t.TempDir()
	abs := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(abs, []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	refused := errors.New("open: no application to open the file")
	o := NewOSOperations(NewPathScope(dir, nil))
	o.run = func(_ *exec.Cmd, _ bool) error { return refused }

	if _, err := o.Execute(context.Background(), "open", map[string]any{"path": abs}); err == nil {
		t.Fatal("a refused launch must surface as an error from the op")
	}

	o.run = func(_ *exec.Cmd, _ bool) error { return nil }
	got, err := o.Execute(context.Background(), "reveal", map[string]any{"path": abs})
	if err != nil {
		t.Fatalf("a launch that worked must not error: %v", err)
	}
	if result, ok := got.(map[string]any); !ok || result["reveal"] != true {
		t.Fatalf("reveal must report itself as one: %#v", got)
	}
}

// A platform may have more than one way to reveal a file, and the first is not
// always available. The op works down them, so a Linux desktop with no file
// manager listening on the freedesktop interface still gets its folder opened.
func TestRevealFallsBackToTheNextWay(t *testing.T) {
	dir := t.TempDir()
	abs := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(abs, []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if len(newRevealCmds(abs)) < 2 {
		t.Skip("this platform has one file manager and one way to ask it")
	}

	attempts := 0
	o := NewOSOperations(NewPathScope(dir, nil))
	o.run = func(_ *exec.Cmd, _ bool) error {
		attempts++
		if attempts == 1 {
			return errors.New("no file manager is listening")
		}
		return nil
	}

	if _, err := o.Execute(context.Background(), "reveal", map[string]any{"path": abs}); err != nil {
		t.Fatalf("a way that failed must be followed by the next: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("tried %d ways, expected to stop at the one that worked", attempts)
	}
}

// When nothing works the user hears about it, in the words of the plainest way
// that was tried — the fallback's, not the exotic first attempt's.
func TestRevealReportsWhenNothingWorks(t *testing.T) {
	dir := t.TempDir()
	abs := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(abs, []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	o := NewOSOperations(NewPathScope(dir, nil))
	attempts := 0
	o.run = func(_ *exec.Cmd, _ bool) error {
		attempts++
		return fmt.Errorf("way %d said no", attempts)
	}

	_, err := o.Execute(context.Background(), "reveal", map[string]any{"path": abs})
	if err == nil {
		t.Fatal("a reveal nothing could do must be reported")
	}
	if attempts != len(newRevealCmds(abs)) {
		t.Fatalf("every way must be tried before giving up, got %d", attempts)
	}
	if want := fmt.Sprintf("way %d said no", attempts); err.Error() != want {
		t.Fatalf("got %q, want the last way's complaint %q", err.Error(), want)
	}
}
