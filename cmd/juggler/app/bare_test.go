//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"strings"
	"testing"
)

// TestOnlyChildrenAndTheHarnessServeOneProjectInProcess: a launch serves its
// project in this process only as a machine server's session child or as the
// test harness. Everything else is bare juggler, which rides the machine
// server, whatever else it was given: the developer flags go to the server it
// starts, which passes them to its children.
func TestOnlyChildrenAndTheHarnessServeOneProjectInProcess(t *testing.T) {
	for _, c := range []struct {
		name  string
		flags appFlags
		want  bool
	}{
		{"bare", appFlags{}, false},
		{"bare with a project, port and terminal", appFlags{project: "/p", projectSet: true, port: 3939, portSet: true, hasTerminal: true}, false},
		{"session child", appFlags{sessionChild: true}, true},
		{"session child that dies with its parent", appFlags{sessionChild: true, exitWithParent: true}, true},
		{"test harness", appFlags{testMode: true}, true},
		{"exit with parent alone", appFlags{exitWithParent: true}, false},
		{"dev", appFlags{dev: true}, false},
		{"assets from disk", appFlags{assetsFromDisk: true}, false},
	} {
		if got := c.flags.standaloneLaunch(); got != c.want {
			t.Errorf("%s: standaloneLaunch() = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestWindowIsRefusedOnABareLaunch: --window is refused on a bare launch,
// saying why, since bare juggler has no server of its own to open a window on,
// and on a session child, whose windows are the desktop app's to open; the test
// harness still opens its debug lane with it. A launch without it is refused
// nothing.
func TestWindowIsRefusedOnABareLaunch(t *testing.T) {
	for _, c := range []struct {
		name  string
		flags appFlags
		want  string // "" is not refused
	}{
		{"nothing retired", appFlags{project: "/p", projectSet: true}, ""},
		{"--window, bare", appFlags{window: true}, "--window"},
		{"--window, session child", appFlags{window: true, sessionChild: true}, "--window"},
		{"--window, test harness", appFlags{window: true, testMode: true}, ""},
	} {
		got := c.flags.refusal()
		if c.want == "" {
			if got != "" {
				t.Errorf("%s: refused with %q, want nothing refused", c.name, got)
			}
			continue
		}
		if !strings.Contains(got, c.want) {
			t.Errorf("%s: refusal %q, want one naming %s", c.name, got, c.want)
		}
	}
}
