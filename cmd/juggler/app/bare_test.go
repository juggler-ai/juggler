//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"strings"
	"testing"
)

// TestOnlyMarkedLaunchesServeOneProjectInProcess: a launch serves its project
// in this process only when something marks it as more than a person's bare
// juggler — a machine server's child, the test harness, the desktop app, a
// developer flag, or --standalone. Everything else is bare juggler, which
// rides the machine server, whatever else it was given.
func TestOnlyMarkedLaunchesServeOneProjectInProcess(t *testing.T) {
	for _, c := range []struct {
		name  string
		flags appFlags
		want  bool
	}{
		{"bare", appFlags{}, false},
		{"bare with a project, port and terminal", appFlags{project: "/p", projectSet: true, port: 3939, portSet: true, hasTerminal: true}, false},
		{"session child", appFlags{sessionChild: true}, true},
		{"test harness", appFlags{testMode: true}, true},
		{"desktop app's server", appFlags{exitWithParent: true}, true},
		{"dev", appFlags{dev: true}, true},
		{"assets from disk", appFlags{assetsFromDisk: true}, true},
		{"standalone", appFlags{standalone: true}, true},
	} {
		if got := c.flags.standaloneLaunch(); got != c.want {
			t.Errorf("%s: standaloneLaunch() = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestRetiredFlagsAreRefusedWithAReason: the per-project exposure flags and
// --kill-existing are refused on every launch, saying why; --window only on a
// bare launch, since the test harness still opens its debug lane with it. A
// launch with none of them is refused nothing.
func TestRetiredFlagsAreRefusedWithAReason(t *testing.T) {
	for _, c := range []struct {
		name  string
		flags appFlags
		want  string // "" is not refused
	}{
		{"nothing retired", appFlags{project: "/p", projectSet: true}, ""},
		{"--public", appFlags{retired: []string{"public"}}, "--public"},
		{"--public, standalone", appFlags{retired: []string{"public"}, standalone: true}, "--public"},
		{"a WAN flag", appFlags{retired: []string{"p2p"}}, "--p2p"},
		{"--kill-existing", appFlags{retired: []string{"kill-existing"}}, "--kill-existing"},
		{"--window, bare", appFlags{window: true}, "--window"},
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
