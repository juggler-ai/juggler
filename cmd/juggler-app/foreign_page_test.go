//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"juggler/internal/userpaths/userpathstest"
	"juggler/web"
)

// A fallback bar is answered only while it holds its window's latest token:
// not with another, not with none, and not once a later load has been offered
// a bar of its own.
func TestForeignPageBarAnswersOnlyItsWindowsLatestToken(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	e := registerWindow(a, &winEntry{id: "w1", role: roleMain})

	if a.foreignPageAction(e, foreignPageMessage{Token: "", Action: "minimise"}) {
		t.Fatal("a press was answered before any bar was offered")
	}
	a.offerForeignPageBar(e)
	var first string
	a.reg(func(*regState) { first = e.foreignToken })
	if first == "" {
		t.Fatal("offering a bar minted no token")
	}
	if a.foreignPageAction(e, foreignPageMessage{Token: "not-it", Action: "minimise"}) {
		t.Error("a press with the wrong token was answered")
	}
	if !a.foreignPageAction(e, foreignPageMessage{Token: first, Action: "minimise"}) {
		t.Error("a press with the window's token was refused")
	}
	if a.foreignPageAction(e, foreignPageMessage{Token: first, Action: "navigate"}) {
		t.Error("a press of a button the bar has none of was answered")
	}
	a.offerForeignPageBar(e)
	if a.foreignPageAction(e, foreignPageMessage{Token: first, Action: "minimise"}) {
		t.Error("an earlier page's bar was answered after a later load was offered one")
	}
	a.workspace.flush(nil)
}

// Back to Juggler loads again the page the window was showing — a session the
// user followed a link out of — unless that page is itself the foreign one,
// when a window on a server by URL goes to the server's own page.
func TestForeignPageBackReturnsToJuggler(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	const server = "http://devbox:3939"
	spec := windowSpec{url: server + "/stale/path", connected: true, remoteProject: "/home/me/proj"}
	e := registerWindow(a, &winEntry{id: "w1", role: roleMain, view: windowView{spec: spec, serverURL: server + "/p/proj-0123abcd", secret: "s0"}})

	press := func(page string) windowView {
		t.Helper()
		a.offerForeignPageBar(e)
		var token string
		a.reg(func(*regState) { token = e.foreignToken })
		if !a.foreignPageAction(e, foreignPageMessage{Token: token, Action: "back", URL: page}) {
			t.Fatalf("Back from %s was refused", page)
		}
		return a.viewOf(e)
	}

	before := a.viewOf(e)
	v := press(server + "/p/proj-0123abcd/some/link")
	if v.serverURL != before.serverURL || v.spec != before.spec || v.secret == before.secret {
		t.Fatalf("Back from a link out of the session shows %+v; want the session's page loaded again", v)
	}

	v = press(server + "/p/proj-0123abcd/?window=1&nativeCtl=x")
	want := windowSpec{url: spec.url, connected: true}
	if v.serverURL != server || v.spec != want {
		t.Fatalf("Back from the window's own page, foreign, shows %+v; want the server's page at %s", v, server)
	}
	a.workspace.flush(nil)
}

// A board has no Back to Juggler, and a close from any bar skips the close
// gate, which a page that is not Juggler's would never answer.
func TestForeignPageBarOnABoardAndClosing(t *testing.T) {
	userpathstest.Isolate(t)
	a := newTestAppState(t)
	a.workspace = newWorkspaceStoreAt(workspacePath(t))
	board := registerWindow(a, &winEntry{id: "b1", role: rolePinboardFor("pin-1"), view: windowView{serverURL: "http://127.0.0.1:3939/p/p-0123abcd", secret: "s0"}})
	a.offerForeignPageBar(board)
	var token string
	a.reg(func(*regState) { token = board.foreignToken })
	if a.foreignPageAction(board, foreignPageMessage{Token: token, Action: "back"}) {
		t.Error("a board's bar went Back to Juggler")
	}
	if a.closeReady(board) {
		t.Fatal("the window was ready to close before its bar's close")
	}
	if !a.foreignPageAction(board, foreignPageMessage{Token: token, Action: "close"}) {
		t.Fatal("a board's bar could not close it")
	}
	if !a.closeReady(board) {
		t.Error("a close from the bar still waits on the close gate")
	}
	a.workspace.flush(nil)
}

// The script is handed its configuration as one JSON literal, whatever it
// holds, and wears the web UI's chrome in the window's theme: the theme's
// colours, the caption glyphs, and the traffic-light gutter and resize strip.
func TestForeignPageScriptCarriesTheWebUIsChrome(t *testing.T) {
	a := newTestAppState(t)
	js := a.foreignPageScript(`"tok</script>`, false, true, foreignBarLook{theme: "light", maximised: true})
	at := strings.LastIndex(js, "})(")
	if at < 0 || !strings.HasSuffix(js, ");") {
		t.Fatalf("the script does not end by calling itself with its configuration:\n%s", js)
	}
	var cfg foreignBarConfig
	if err := json.Unmarshal([]byte(js[at+3:len(js)-2]), &cfg); err != nil {
		t.Fatalf("the configuration is not one JSON literal: %v\n%s", err, js[at:])
	}
	if strings.Contains(js[at:], "</script>") {
		t.Error("the configuration carries </script> unescaped")
	}
	if cfg.Token != `"tok</script>` || cfg.CanGoBack || !cfg.Frameless || !cfg.Maximised || cfg.Fullscreen {
		t.Errorf("configuration = %+v; want the token, frameless and maximised, no Back", cfg)
	}
	if cfg.Colours != windowChrome.Themes["light"] {
		t.Errorf("colours = %+v; want the light theme's %+v", cfg.Colours, windowChrome.Themes["light"])
	}
	var glyphs bytes.Buffer
	if err := json.Compact(&glyphs, windowChrome.Glyphs); err != nil {
		t.Fatal(err)
	}
	if cfg.Gutter != windowChrome.Gutter || cfg.Strip != windowChrome.Strip || string(cfg.Glyphs) != glyphs.String() {
		t.Errorf("configuration = %+v; want the web UI's gutter, strip and glyphs", cfg)
	}
	if other := a.foreignPageScript("t", true, true, foreignBarLook{theme: "mauve"}); !strings.Contains(other, windowChrome.Themes["dark"].BG) {
		t.Error("a window with no theme does not wear the dark one")
	}
}

// The chrome the app paints is read from the web UI's own sources: every token
// is there, the glyphs are the caption controls', and the native window's
// background is each theme's --bg-primary.
func TestWindowChromeTokensRead(t *testing.T) {
	tokens, err := readChromeTokens(web.Shell)
	if err != nil {
		t.Fatal(err)
	}
	if tokens.Gutter != "80px" || tokens.Strip != "6px" || tokens.CloseHover == "" || tokens.CloseActive == "" {
		t.Errorf("geometry and close colours = %+v", tokens)
	}
	for _, theme := range []string{"dark", "light"} {
		tt := tokens.Themes[theme]
		for name, v := range map[string]string{"bg": tt.BG, "raised": tt.Raised, "border": tt.Border, "text": tt.Text, "textSecondary": tt.TextSecondary, "onAccent": tt.OnAccent} {
			if !strings.HasPrefix(v, "#") {
				t.Errorf("%s %s = %q, want a colour", theme, name, v)
			}
		}
		if got, want := themeColours[theme], mustHexColour(tt.BG); got != want {
			t.Errorf("the %s window background is %+v, want --bg-primary's %+v", theme, got, want)
		}
	}
	var glyphs map[string]json.RawMessage
	if err := json.Unmarshal(tokens.Glyphs, &glyphs); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"svg", "minimise", "maximise", "restore", "close"} {
		if _, ok := glyphs[name]; !ok {
			t.Errorf("the glyphs have no %s", name)
		}
	}
}

func TestSamePage(t *testing.T) {
	for _, tt := range []struct {
		a, b string
		want bool
	}{
		{"http://h:1/p/k/?window=1", "http://h:1/p/k", true},
		{"http://h:1/p/k/x", "http://h:1/p/k", false},
		{"http://other:1/p/k", "http://h:1/p/k", false},
		{"https://h:1/p/k", "http://h:1/p/k", false},
		{"%zz", "http://h:1/", true},
	} {
		if got := samePage(tt.a, tt.b); got != tt.want {
			t.Errorf("samePage(%q, %q) = %v, want %v", tt.a, tt.b, got, tt.want)
		}
	}
}
