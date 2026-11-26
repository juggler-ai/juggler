//go:build darwin

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"juggler/internal/jlog"
)

// trashOrRemove moves path to the Trash through the Finder, so the user can
// Put Back what they deleted, falling back to permanent removal.
func trashOrRemove(path string) error {
	if err := moveToOSTrash(path); err == nil {
		return nil
	}
	// No Finder, or it refused (e.g. a network volume): permanent delete.
	return os.RemoveAll(path)
}

// moveToOSTrash is trashOrRemove's trip to the Trash (DisableOSTrash).
var moveToOSTrash = moveToFinderTrash

// finderDeleteScript has the Finder delete the file its one argument names.
// The path is an argument, never spliced into the source, so no name can end
// the string early.
var finderDeleteScript = []string{
	"-e", "on run argv",
	"-e", "set f to POSIX file (item 1 of argv)",
	"-e", `tell application "Finder" to delete f`,
	"-e", "end run",
}

// finderDeleteTries is how many times a delete the Finder answered with an
// error is asked again: it sometimes fails one at random ("Handler can't handle
// objects of this class", -10010), and the next ask succeeds.
const finderDeleteTries = 3

// trashPoll is how often a delete the Finder has not answered looks for the
// item having left its path.
const trashPoll = 50 * time.Millisecond

func moveToFinderTrash(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(abs); err != nil {
		return err
	}
	// A Finder that is not running is not started for this: a login with no
	// desktop (ssh) has none to start.
	if exec.Command("/usr/bin/pgrep", "-xq", "Finder").Run() != nil {
		return errNoOSTrash
	}
	for try := 1; ; try++ {
		err := finderDelete(abs)
		if err == nil || try == finderDeleteTries {
			return err
		}
	}
}

// finderDelete asks the Finder once to delete abs. The wait follows the
// delete's progress, not the Finder's reply: a Finder can move the item to the
// Trash and never answer, which left every such osascript waiting for good, so
// once abs has left its path the move is done and the script is stopped. A
// Finder that neither moves the item nor answers is waited on while it does.
func finderDelete(abs string) error {
	cmd := exec.Command("/usr/bin/osascript", append(finderDeleteScript, abs)...) //nolint:gosec // fixed script; the path is its argument
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	poll := time.NewTicker(trashPoll)
	defer poll.Stop()
	for {
		select {
		case err := <-done:
			if err != nil {
				return fmt.Errorf("the Finder did not delete %s: %w: %s", abs, err, bytes.TrimSpace(out.Bytes()))
			}
			if _, statErr := os.Lstat(abs); statErr == nil {
				return errors.New("the Finder answered but " + abs + " is still there")
			}
			return nil
		case <-poll.C:
			if _, err := os.Lstat(abs); !errors.Is(err, os.ErrNotExist) {
				continue
			}
			select {
			case <-done: // the reply came with the move
			default:
				_ = cmd.Process.Kill()
				<-done
				jlog.Info("[trash] %s reached the Trash before the Finder replied; stopped waiting for the reply", abs)
			}
			return nil
		}
	}
}
