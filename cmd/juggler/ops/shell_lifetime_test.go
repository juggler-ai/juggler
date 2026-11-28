//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"testing"
)

// startListedTask starts a background task with params added to a long sleep,
// and returns it as the inventory lists it.
func startListedTask(t *testing.T, params map[string]any) ProcessInfo {
	t.Helper()
	root := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(root, nil))
	params["command"] = "sleep 30"
	res, err := shellOps.startBackground(params)
	if err != nil {
		t.Fatalf("startBackground failed: %v", err)
	}
	id, _ := res.(map[string]any)["task_id"].(string)
	t.Cleanup(func() { KillTask(id) })
	for _, p := range waitForProcess(t, root, hasProcess(id)) {
		if p.ID == id {
			return p
		}
	}
	panic("unreachable")
}

// The label and lifetime a starter gives are what the inventory lists, since
// the session's activity report — and from it the quit prompt and retirement —
// read them there and nowhere else.
func TestStartBackground_ListsItsLabelAndLifetime(t *testing.T) {
	requirePOSIXShell(t)

	viewed := startListedTask(t, map[string]any{"label": "808 Cmajor patch server", "lifetime": LifetimeViewed})
	if viewed.Label != "808 Cmajor patch server" || viewed.Lifetime != LifetimeViewed || viewed.HoldsSession() {
		t.Fatalf("viewed task listed as %+v (holds=%v)", viewed, viewed.HoldsSession())
	}
	if got := viewed.Name(80); got != "808 Cmajor patch server" {
		t.Fatalf("viewed task named %q", got)
	}

	held := startListedTask(t, map[string]any{})
	if held.Lifetime != LifetimeHeld || !held.HoldsSession() {
		t.Fatalf("a task naming no lifetime listed as %+v (holds=%v); want held", held, held.HoldsSession())
	}
	if got := held.Name(80); got != "sleep 30" {
		t.Fatalf("unlabelled task named %q, want its command", got)
	}
}

// A lifetime nobody defined is refused rather than read as the default, which
// would hold a session up for a task its starter meant to hold nothing.
func TestStartBackground_RefusesAnUnknownLifetime(t *testing.T) {
	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	if _, err := shellOps.startBackground(map[string]any{"command": "true", "lifetime": "forever"}); err == nil {
		t.Fatal("startBackground accepted lifetime \"forever\"")
	}
}
