//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package atomicio

import (
	"errors"
	"os"
	"syscall"
	"time"
)

// Windows surfaces these as transient when another handle momentarily holds the
// destination: an antivirus scanner, the search indexer, or a racing writer.
// POSIX rename-replace has no such window.
const (
	errAccessDenied     = syscall.Errno(5)  // ERROR_ACCESS_DENIED
	errSharingViolation = syscall.Errno(32) // ERROR_SHARING_VIOLATION
)

// RobustRename renames oldpath to newpath, retrying for a bounded window on the
// transient sharing-violation / access-denied errors Windows raises when a
// scanner or racing handle briefly holds the destination open. This is the
// established Go-toolchain idiom (cmd/go's internal/robustio) — the only
// reliable way to make temp+rename atomic publishing work on Windows. The
// sleeps are an OS-transient backoff, not a synchronization stand-in: the
// non-Windows build retries nothing.
func RobustRename(oldpath, newpath string) error {
	const maxWait = time.Second
	start := time.Now()
	for {
		err := os.Rename(oldpath, newpath)
		if err == nil || !isTransient(err) || time.Since(start) >= maxWait {
			return err
		}
		time.Sleep(time.Millisecond)
	}
}

// RobustReadFile reads path, retrying for the same bounded window on the
// transient sharing-violation / access-denied errors Windows raises when a
// concurrent RobustRename is mid-replace of path. POSIX has no such open
// window, so its build reads directly.
func RobustReadFile(path string) ([]byte, error) {
	const maxWait = time.Second
	start := time.Now()
	for {
		data, err := os.ReadFile(path)
		if err == nil || !isTransient(err) || time.Since(start) >= maxWait {
			return data, err
		}
		time.Sleep(time.Millisecond)
	}
}

// removeAll is the removal RobustRemoveAll retries; a test substitutes it to
// act between attempts.
var removeAll = os.RemoveAll

// RobustRemoveAll removes path and everything under it, retrying on the same
// transient sharing-violation / access-denied errors, which Windows raises while
// another handle — a directory watcher, a scanner, a child process still
// exiting — briefly holds something inside the tree. The window is the one Go's
// own testing.TempDir cleanup gives the same two errors for the same reason
// (testing.removeAll); a tree is larger than one file, so it is longer than the
// rename's. POSIX unlinks an open file without complaint, so its build removes
// directly.
func RobustRemoveAll(path string) error {
	const maxWait = 2 * time.Second
	start := time.Now()
	for {
		err := removeAll(path)
		if err == nil || !isTransient(err) || time.Since(start) >= maxWait {
			return err
		}
		time.Sleep(time.Millisecond)
	}
}

// remove is the removal RobustRemove retries; a test substitutes it to act
// between attempts.
var remove = os.Remove

// RobustRemove removes one file, retrying for the rename's window on the same
// transient errors, which Windows raises while another handle has the file
// open — an HTTP handler serving the very blob a sweep is dropping, since Go
// opens files without delete sharing. A file that is not there is returned at
// once, as os.Remove returns it. POSIX unlinks an open file, so its build
// removes directly.
func RobustRemove(path string) error {
	const maxWait = time.Second
	start := time.Now()
	for {
		err := remove(path)
		if err == nil || !isTransient(err) || time.Since(start) >= maxWait {
			return err
		}
		time.Sleep(time.Millisecond)
	}
}

func isTransient(err error) bool {
	return errors.Is(err, errAccessDenied) || errors.Is(err, errSharingViolation)
}
