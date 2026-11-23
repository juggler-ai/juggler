//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitcmd

import (
	"errors"
	"testing"
	"time"
)

// Without git on PATH, every way of running a command here fails with
// ErrMissing before anything is started — a raw "executable file not found"
// reaching the user, or (on macOS) the stub's install dialog opening on every
// poll, is what this is for. Not parallel: it changes PATH.
func TestNoGitIsErrMissing(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", t.TempDir())

	if err := Available(); !errors.Is(err, ErrMissing) {
		t.Fatalf("Available() = %v, want ErrMissing", err)
	}
	if _, err := Capture(t.Context(), dir, time.Minute, 1024, "status"); !errors.Is(err, ErrMissing) {
		t.Errorf("Capture = %v, want ErrMissing", err)
	}
	if _, err := Exec(t.Context(), Request{Dir: dir, Args: []string{"commit", "-m", "x"}}); !errors.Is(err, ErrMissing) {
		t.Errorf("Exec = %v, want ErrMissing", err)
	}
	if _, err := Command(t.Context(), dir, Read, "rev-parse", "HEAD").Output(); !errors.Is(err, ErrMissing) {
		t.Errorf("Command(...).Output() = %v, want ErrMissing", err)
	}
}
