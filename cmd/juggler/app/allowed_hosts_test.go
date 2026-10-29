//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"slices"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

func saveAllowedHostsSetting(t *testing.T, names ...string) {
	t.Helper()
	userpathstest.Isolate(t)
	if _, err := core.UpdateGlobalSettings(func(gs *core.GlobalSettings) bool {
		gs.Connectivity.AllowedHosts = names
		return true
	}); err != nil {
		t.Fatalf("UpdateGlobalSettings: %v", err)
	}
}

// TestResolveAllowedHostsReadsTheSettingOnEveryLaunch: unlike the on-launch
// LAN/WAN toggles, the saved allowed hosts apply to a terminal launch too, and
// --allow-host adds to them.
func TestResolveAllowedHostsReadsTheSettingOnEveryLaunch(t *testing.T) {
	saveAllowedHostsSetting(t, "box.tailnet.ts.net")
	for _, hasTerminal := range []bool{true, false} {
		a := &App{flags: appFlags{hasTerminal: hasTerminal, allowHosts: []string{"juggler.example.com"}}}
		allowed, err := a.resolveAllowedHosts()
		if err != nil {
			t.Fatalf("hasTerminal=%v: %v", hasTerminal, err)
		}
		if got, want := allowed.Names(), []string{"box.tailnet.ts.net", "juggler.example.com"}; !slices.Equal(got, want) {
			t.Errorf("hasTerminal=%v: Names() = %q, want %q", hasTerminal, got, want)
		}
	}
}

// TestResolveAllowedHostsIgnoresTheSettingInTestMode: the test harness must
// never pick up a developer's real settings.json.
func TestResolveAllowedHostsIgnoresTheSettingInTestMode(t *testing.T) {
	saveAllowedHostsSetting(t, "box.tailnet.ts.net")
	a := &App{flags: appFlags{testMode: true}}
	allowed, err := a.resolveAllowedHosts()
	if err != nil || len(allowed.Names()) != 0 {
		t.Fatalf("test mode: Names() = %q, err %v; want none", allowed.Names(), err)
	}
}

// TestResolveAllowedHostsLeavesSessionChildrenToTheirSupervisor: a session
// child is reached only through its machine server, which holds the list and
// vouches for proxied callers itself. The child ignores the setting, and
// refuses the flag rather than accept a list that could never apply.
func TestResolveAllowedHostsLeavesSessionChildrenToTheirSupervisor(t *testing.T) {
	saveAllowedHostsSetting(t, "box.tailnet.ts.net")
	a := &App{flags: appFlags{sessionChild: true}}
	allowed, err := a.resolveAllowedHosts()
	if err != nil || len(allowed.Names()) != 0 {
		t.Fatalf("session child: Names() = %q, err %v; want none", allowed.Names(), err)
	}
	a = &App{flags: appFlags{sessionChild: true, allowHosts: []string{"box.tailnet.ts.net"}}}
	if _, err := a.resolveAllowedHosts(); err == nil {
		t.Fatal("session child accepted --allow-host")
	}
}

// TestResolveAllowedHostsRefusesABadFlag: the error reaches the user.
func TestResolveAllowedHostsRefusesABadFlag(t *testing.T) {
	userpathstest.Isolate(t)
	a := &App{flags: appFlags{allowHosts: []string{"https://box.tailnet.ts.net"}}}
	if _, err := a.resolveAllowedHosts(); err == nil {
		t.Fatal("accepted --allow-host https://box.tailnet.ts.net")
	}
}
