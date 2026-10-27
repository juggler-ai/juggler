//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

// Package atomicio holds filesystem primitives that must behave identically
// across platforms. RobustRename publishes a temp file (or directory) over its
// final name; on POSIX that is a single atomic syscall with no failure window,
// so this build is a direct os.Rename. RobustReadFile reads a file that a
// concurrent RobustRename may be replacing, and RobustRemoveAll removes a tree
// another handle may hold part of; POSIX has no sharing-violation window, so
// they too are direct calls.
package atomicio

import "os"

// RobustRename renames oldpath to newpath. On POSIX the rename atomically
// replaces the destination, so there is nothing to retry.
func RobustRename(oldpath, newpath string) error {
	return os.Rename(oldpath, newpath)
}

// RobustReadFile reads path. On POSIX a concurrent rename-replace of path never
// makes the open fail, so this is a direct os.ReadFile.
func RobustReadFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

// RobustRemoveAll removes path and everything under it. POSIX unlinks a file
// another process holds open, so there is nothing to retry.
func RobustRemoveAll(path string) error {
	return os.RemoveAll(path)
}
