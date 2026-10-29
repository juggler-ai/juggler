//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"os"

	"juggler/cmd/juggler/core"
)

// BuildOf is which build the juggler binary at bin is, as a client compares it
// with the server it finds: a client uses a server only of its own build. A
// release is its version. A build from source is its version and when its
// binary was made, since every build of one source tree reports the same
// version, and a server left running by an earlier build is a stale one. The
// time is the binary's, not stamped in at link time, so a build with nothing
// changed still reuses its cached link. A binary that cannot be read is its
// version alone.
func BuildOf(bin string) string {
	if !core.IsDevVersion(core.Version) {
		return core.Version
	}
	st, err := os.Stat(bin)
	if err != nil {
		return core.Version
	}
	return core.Version + " (built " + st.ModTime().Format("2006-01-02 15:04:05") + ")"
}

// ownBuild is the build of this process's own binary (BuildOf).
func ownBuild() string {
	exe, err := os.Executable()
	if err != nil {
		return core.Version
	}
	return BuildOf(exe)
}
