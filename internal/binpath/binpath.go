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
// Contents/MacOS, and the server is the executable of its own bundle in
// Contents/Helpers (see bundleDirs).
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
// across Juggler.app when dir is in it. The desktop app is Juggler.app's
// executable, in Contents/MacOS. The server is the executable of a bundle of
// its own, ServerBundle in Contents/Helpers, with an identity of its own,
// which the app launches through LaunchServices as a launch of its own
// (machineserver.DetachedStarter). A server in Contents/MacOS, or loose in
// Contents/Helpers, has no bundle to launch: it is started as the app's child
// and filed under the app's launch, so a click on the app's Dock icon can reach
// the server instead, and opening the app while one runs can bring the server
// forward instead of launching it.
//
// Contents/Helpers/juggler is a link into ServerBundle, for links made to that
// path, and in an older bundle the server itself; the app looks there last, so
// it finds the server's real path, which is what gives it a bundle to launch.
func bundleDirs(dir string) []string {
	dirs := []string{dir}
	contents := filepath.Dir(dir)
	if filepath.Base(contents) != "Contents" {
		return dirs
	}
	switch filepath.Base(dir) {
	case "MacOS":
		bundle := filepath.Dir(contents)
		if helpers := filepath.Dir(bundle); filepath.Base(bundle) == ServerBundle && filepath.Base(helpers) == "Helpers" {
			// The server, in its bundle: the app is in the enclosing bundle.
			return append(dirs, filepath.Join(filepath.Dir(helpers), "MacOS"))
		}
		dirs = append(dirs,
			filepath.Join(contents, "Helpers", ServerBundle, "Contents", "MacOS"),
			filepath.Join(contents, "Helpers"))
	case "Helpers":
		dirs = append(dirs, filepath.Join(contents, "MacOS"))
	}
	return dirs
}

// ServerBundle is the macOS bundle of its own that the server is the executable
// of, in Juggler.app's Contents/Helpers.
const ServerBundle = "JugglerServer.app"

func fileIn(dirs []string, name string) (string, bool) {
	for _, dir := range dirs {
		cand := filepath.Join(dir, name)
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			return cand, true
		}
	}
	return "", false
}
