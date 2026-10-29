//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package binpath finds one of Juggler's two binaries (juggler, juggler-app)
// installed next to the other.
package binpath

import (
	"os"
	"path/filepath"
)

// Sibling returns the regular file called name beside exe, and whether one
// exists. It looks in exe's own directory first, then — when exe is a symlink —
// in the directory of the file it resolves to. In a macOS app bundle "beside"
// spans the bundle: the desktop app is the bundle's executable, in
// Contents/MacOS, and the server sits in Contents/Helpers (see bundleDirs).
//
// The second look is what lets a lone link to juggler on PATH (a package
// manager's bin directory, pointing into Juggler.app) still find juggler-app:
// os.Executable reports the path the process was started through, which on
// macOS and Linux is the link, not the bundle. The link's own directory is
// tried first so a pair of links kept side by side (the dev layout's bin/)
// stays a pair.
func Sibling(exe, name string) (string, bool) {
	if cand, ok := fileIn(bundleDirs(filepath.Dir(exe)), name); ok {
		return cand, true
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil || filepath.Dir(resolved) == filepath.Dir(exe) {
		return "", false
	}
	return fileIn(bundleDirs(filepath.Dir(resolved)), name)
}

// bundleDirs is where a binary in dir looks for the other: dir itself, and
// when dir is a bundle's Contents/MacOS or Contents/Helpers, the other of the
// two. The server lives in Helpers because LaunchServices files every process
// run from Contents/MacOS under the bundle's identity: a server there would be
// taken for the desktop app, and opening the app while one ran would bring
// the server forward instead of launching it.
func bundleDirs(dir string) []string {
	dirs := []string{dir}
	contents := filepath.Dir(dir)
	if filepath.Base(contents) != "Contents" {
		return dirs
	}
	switch filepath.Base(dir) {
	case "MacOS":
		dirs = append(dirs, filepath.Join(contents, "Helpers"))
	case "Helpers":
		dirs = append(dirs, filepath.Join(contents, "MacOS"))
	}
	return dirs
}

func fileIn(dirs []string, name string) (string, bool) {
	for _, dir := range dirs {
		cand := filepath.Join(dir, name)
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			return cand, true
		}
	}
	return "", false
}
