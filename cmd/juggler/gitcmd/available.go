//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitcmd

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/msg"
)

// ErrMissing is the error of every command built here on a machine with no git
// that can run: none on PATH, or — on macOS — only the /usr/bin/git that stands
// in for the Xcode Command Line Tools until they are installed. Test for it with
// errors.Is.
var ErrMissing = errors.New("git is not installed")

// missingError is ErrMissing with what this machine is missing, for the log
// line or the detail a user reads.
type missingError struct{ detail string }

func (e *missingError) Error() string { return "git is not installed: " + e.detail }
func (e *missingError) Is(target error) bool {
	return target == ErrMissing
}

// recheckMissing is how long an answer of "no git" stands before it is asked
// again, so that installing git while the server runs is noticed without a
// restart. A git that was found is not asked about again while PATH stays
// what it was when it was found.
const recheckMissing = 30 * time.Second

// macStubGit is where macOS keeps the shim that runs the Command Line Tools'
// git when they are installed, and otherwise opens the system's dialog offering
// to install them and fails.
const macStubGit = "/usr/bin/git"

// gitAnswer is one answer Available gave, and the PATH it was given for: a
// different PATH is a different question.
type gitAnswer struct {
	path    string
	missing error
	checked time.Time
}

// lastAnswer is replaced whole, never changed. Two callers that find it stale
// at once both probe, and either answer is as good as the other.
var lastAnswer atomic.Pointer[gitAnswer]

// Available is nil when git can be run here, and an error matching ErrMissing
// when it cannot. It never runs git itself: on macOS the stub's dialog is what
// a probe of git would cost on exactly the machines it is asked about.
func Available() error {
	path := os.Getenv("PATH")
	if last := lastAnswer.Load(); last != nil && last.path == path {
		if last.missing == nil || time.Since(last.checked) < recheckMissing {
			return last.missing
		}
	}
	answer := &gitAnswer{path: path, missing: probeGit(), checked: time.Now()}
	lastAnswer.Store(answer)
	return answer.missing
}

// probeGit finds git on PATH and, where that is macOS's stub, asks
// xcode-select whether the tools it forwards to are there. xcode-select -p
// only prints the developer directory, and opens no dialog either way.
func probeGit() error {
	path, err := exec.LookPath("git")
	if err != nil {
		return &missingError{detail: "no git on PATH"}
	}
	if runtime.GOOS != "darwin" {
		return nil
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	if path != macStubGit {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "xcode-select", "-p").Run(); err != nil {
		return &missingError{detail: "the Xcode Command Line Tools are not installed"}
	}
	return nil
}

// MissingMessage says to the user that git is not installed and what to do
// about it, on the platform this server runs on.
func MissingMessage() msg.Message {
	return msg.New("Git isn't installed, so this project's repositories can't be read. "+
		"{platform, select, darwin {Install the Xcode Command Line Tools (run xcode-select --install in Terminal) or git from git-scm.com, then refresh.} "+
		"other {Install git from git-scm.com or your package manager, then refresh.}}",
		"platform", runtime.GOOS)
}
