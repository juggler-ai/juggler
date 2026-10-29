//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"errors"
	"fmt"
	"testing"
)

// A second launch hands the running app its whole argv, and only --url and
// --project say which window it wants. Every other flag, known or not, must be
// stepped over rather than end the parse: a server in dev mode opens its window
// with `--dev --url …`, and a parse that stopped at --dev read that as a bare
// relaunch and raised some other window.
func TestParseLaunchArgs(t *testing.T) {
	cases := []struct {
		name         string
		args         []string
		url, project string
	}{
		{"nothing", []string{"juggler-app"}, "", ""},
		{"no argv at all", nil, "", ""},
		{"url", []string{"juggler-app", "--url", "http://127.0.0.1:3000"}, "http://127.0.0.1:3000", ""},
		{"project with =", []string{"juggler-app", "--project=/p"}, "", "/p"},
		{"single dash", []string{"juggler-app", "-project", "/p"}, "", "/p"},
		{"trimmed", []string{"juggler-app", "--url", "  http://h  ", "--project", " /p "}, "http://h", "/p"},
		{"after --dev", []string{"juggler-app", "--dev", "--url", "http://h"}, "http://h", ""},
		{"after --verbose", []string{"juggler-app", "--verbose", "--project", "/p"}, "", "/p"},
		{"after an unknown flag", []string{"juggler-app", "-psn_0_4242", "--project", "/p"}, "", "/p"},
		{"between unknown flags", []string{"juggler-app", "--x", "--url", "http://h", "--y"}, "http://h", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			url, project := parseLaunchArgs(c.args)
			if url != c.url || project != c.project {
				t.Errorf("parseLaunchArgs(%q) = (%q, %q), want (%q, %q)", c.args, url, project, c.url, c.project)
			}
		})
	}
}

// An explicit --url or --project opens exactly that window; with neither, the
// saved workspace comes back, and with nothing saved, one empty window.
func TestStartupSpecs(t *testing.T) {
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))

	if got := a.startupSpecs("", ""); len(got) != 1 || got[0] != (windowSpec{}) {
		t.Errorf("nothing saved: %+v, want one empty window", got)
	}
	if got := a.startupSpecs(" 127.0.0.1:3000 ", "/ignored"); len(got) != 1 || got[0] != (windowSpec{url: "http://127.0.0.1:3000"}) {
		t.Errorf("--url: %+v", got)
	}
	if got := a.startupSpecs("", "/p"); len(got) != 1 || got[0] != (windowSpec{project: "/p"}) {
		t.Errorf("--project: %+v", got)
	}

	a.workspace.flush([]workspaceEntry{{Project: "/a"}, {Project: "/b"}})
	if got := a.startupSpecs("", ""); len(got) != 2 || got[0].project != "/a" || got[1].project != "/b" {
		t.Errorf("restore: %+v, want /a then /b", got)
	}
}

// A new window is nudged down-right off any open window whose corner it would
// sit exactly on, and no further than it has to be.
func TestCascadeStepsOffTakenCorners(t *testing.T) {
	taken := map[[2]int]bool{{100, 100}: true, {130, 130}: true, {400, 50}: true}
	cases := []struct{ x, y, wantX, wantY int }{
		{10, 10, 10, 10},
		{100, 100, 160, 160},
		{130, 130, 160, 160},
		{400, 50, 430, 80},
	}
	for _, c := range cases {
		if x, y := cascade(c.x, c.y, taken); x != c.wantX || y != c.wantY {
			t.Errorf("cascade(%d, %d) = (%d, %d), want (%d, %d)", c.x, c.y, x, y, c.wantX, c.wantY)
		}
	}
}

// However crowded the corners, the nudging stops, rather than marching the
// window off the screen.
func TestCascadeIsBounded(t *testing.T) {
	taken := map[[2]int]bool{}
	for i := 0; i < 100; i++ {
		taken[[2]int{i * cascadeStep, i * cascadeStep}] = true
	}
	if x, y := cascade(0, 0, taken); x != 10*cascadeStep || y != 10*cascadeStep {
		t.Errorf("cascade stopped at (%d, %d), want (%d, %d)", x, y, 10*cascadeStep, 10*cascadeStep)
	}
}

// A version mismatch is recognised however many layers of context an error
// picks up on the way back, so it still opens its page instead of a failed
// start's.
func TestAVersionMismatchIsRecognisedThroughWrapping(t *testing.T) {
	mismatch := &versionMismatchError{server: "v0.0.1"}
	if si := standInFor(fmt.Errorf("resolve: %w", mismatch)); si.kind != standInMismatch {
		t.Errorf("a wrapped version mismatch stands in as %q", si.kind)
	}
	if si := standInFor(errors.New("the Juggler server did not start")); si.kind != standInFailed {
		t.Errorf("an unrelated error stands in as %q", si.kind)
	}
}

// The theme a window shows is written by the page's reports, which arrive on
// HTTP goroutines, and read to paint the window's chrome on the main thread. The
// read goes through the registry that owns the write, so the two never race —
// which -race checks here, alongside the value.
func TestAWindowsThemeIsReadThroughTheRegistry(t *testing.T) {
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	e := registerTestWindow(a, "w1")

	if got := a.chromeTheme(e); got != "dark" {
		t.Errorf("a window no page has reported for paints %q, want dark", got)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 200; i++ {
			a.setWindowTheme(e, []string{"light", "dark"}[i%2])
		}
		a.setWindowTheme(e, "light")
	}()
	for i := 0; i < 200; i++ {
		if got := a.chromeTheme(e); got != "light" && got != "dark" {
			t.Fatalf("read theme %q", got)
		}
	}
	<-done
	// Let the theme saves land before the test's directory goes.
	a.workspace.flush(nil)
	if got := a.chromeTheme(e); got != "light" {
		t.Errorf("chromeTheme = %q after the page reported light", got)
	}
}
