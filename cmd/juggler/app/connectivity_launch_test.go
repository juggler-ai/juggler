//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"testing"

	"juggler/cmd/juggler/server"
)

// TestLANOnLaunch pins the LAN-at-launch decision: only a GUI launch consults
// the saved preference, and any other launch stays localhost-only regardless
// of the saved value.
func TestLANOnLaunch(t *testing.T) {
	cases := []struct {
		name  string
		gui   bool
		saved bool
		want  bool
	}{
		{"gui launch honours saved-on", true, true, true},
		{"gui launch honours saved-off", true, false, false},
		{"other launch ignores saved-on", false, true, false},
	}
	for _, c := range cases {
		if got := lanOnLaunch(c.gui, c.saved); got != c.want {
			t.Errorf("%s: lanOnLaunch(%v,%v) = %v, want %v", c.name, c.gui, c.saved, got, c.want)
		}
	}
}

// TestSavedWANModeToStart pins the saved-WAN-mode decision: it fires only on a
// GUI launch, only for a non-empty preference, and only when the mode is both
// registered and currently available; every other case is skipped.
func TestSavedWANModeToStart(t *testing.T) {
	specs := []server.TunnelModeSpec{
		{Mode: "p2p"},
		{Mode: "cloudflared", Available: func() bool { return false }},
	}

	if spec, ok := savedWANModeToStart(true, "p2p", specs); !ok || spec.Mode != "p2p" {
		t.Fatalf("available saved mode: got %q ok=%v, want p2p true", spec.Mode, ok)
	}
	if _, ok := savedWANModeToStart(false, "p2p", specs); ok {
		t.Fatal("terminal launch must not start a saved WAN mode")
	}
	if _, ok := savedWANModeToStart(true, "", specs); ok {
		t.Fatal("empty saved mode must not start anything")
	}
	if _, ok := savedWANModeToStart(true, "cloudflared", specs); ok {
		t.Fatal("registered-but-unavailable saved mode must be skipped")
	}
	if _, ok := savedWANModeToStart(true, "ghost", specs); ok {
		t.Fatal("unregistered saved mode must be skipped")
	}
}

// TestIsGUILaunch pins that only a no-terminal, non-test launch counts as a GUI
// launch — the only launch that applies the saved connectivity preferences. A
// machine-server session child has no terminal either, but it is not a desktop
// launch: applying "Start LAN/WAN on launch" there would expose a project the
// user only ever meant to reach through the machine server.
func TestIsGUILaunch(t *testing.T) {
	cases := []struct {
		hasTerminal, testMode, sessionChild, want bool
	}{
		{false, false, false, true}, // icon/desktop-app launch
		{true, false, false, false}, // terminal launch
		{false, true, false, false}, // test harness
		{true, true, false, false},
		{false, false, true, false}, // machine-server session child
	}
	for _, c := range cases {
		a := &App{flags: appFlags{hasTerminal: c.hasTerminal, testMode: c.testMode, sessionChild: c.sessionChild}}
		if got := a.isGUILaunch(); got != c.want {
			t.Errorf("isGUILaunch(hasTerminal=%v,testMode=%v,sessionChild=%v) = %v, want %v",
				c.hasTerminal, c.testMode, c.sessionChild, got, c.want)
		}
	}
}
