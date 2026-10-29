//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A server the user connected to by typing its address comes back next launch,
// like a project window does. A window the app was told to open with --url does
// not: that address is usually a local server's port for this run only.

func TestAConnectedServerIsPartOfTheRestoredWorkspace(t *testing.T) {
	a := newTestAppState(t)
	a.reg(func(st *regState) {
		st.windows["w1"] = &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/tmp/one"}}
		st.windows["w2"] = &winEntry{id: "w2", role: roleMain, spec: windowSpec{url: "http://127.0.0.1:52011"}}
		st.windows["w3"] = &winEntry{id: "w3", role: roleMain, spec: windowSpec{url: "http://devbox:8080", connected: true}}
	})

	var specs []windowSpec
	a.reg(func(st *regState) { specs = restorableSpecs(st) })

	if len(specs) != 2 || specs[0].project != "/tmp/one" || specs[1] != (windowSpec{url: "http://devbox:8080", connected: true}) {
		t.Fatalf("the project window and the connected server come back, the --url window does not; got %v", specs)
	}
}

func TestAConnectedServerSurvivesTheWorkspaceFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workspace.json")
	entries := []workspaceEntry{
		windowSpec{project: "/tmp/one"}.entry(),
		windowSpec{url: "http://devbox:8080", connected: true}.entry(),
	}
	writeWorkspaceFile(path, workspaceFile{Windows: entries})

	got := (&workspaceStore{path: path}).load()

	if len(got) != 2 || got[1] != (windowSpec{url: "http://devbox:8080", connected: true}) {
		t.Fatalf("a connected server must load back as one, got %v", got)
	}
}

// An address written under the "url" key is what a --url window is filed as,
// and is never restored, whichever build wrote it.
func TestAURLEntryInTheWorkspaceFileIsNotRestored(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workspace.json")
	if err := os.WriteFile(path, []byte(`{"windows":[{"url":"http://127.0.0.1:52011"},{"project":"/tmp/one"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	got := (&workspaceStore{path: path}).load()

	if len(got) != 1 || got[0].project != "/tmp/one" {
		t.Fatalf("only the project window should load, got %v", got)
	}
}

// A second launch with --url onto a server that is already open in a connected
// window raises that window rather than opening another one.
func TestAConnectedWindowIsTheSameViewAsAURLWindowOnTheSameServer(t *testing.T) {
	if !(windowSpec{url: "http://devbox:8080", connected: true}).sameView(windowSpec{url: "http://devbox:8080"}) {
		t.Error("a --url launch should find the connected window on the same server")
	}
	if (windowSpec{url: "http://devbox:8080"}).sameView(windowSpec{url: "http://devbox:9090"}) {
		t.Error("two servers are two views")
	}
	if (windowSpec{project: "/tmp/one"}).sameView(windowSpec{}) {
		t.Error("a project window is not an empty one")
	}
}

func TestNormaliseServerURL(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"devbox:8080", "http://devbox:8080"},
		{"  http://devbox:8080/  ", "http://devbox:8080"},
		{"https://juggler.example.com/some/page?x=1#y", "https://juggler.example.com"},
		{"HTTP://DevBox:8080", "http://devbox:8080"},
		{"192.168.1.20:7000", "http://192.168.1.20:7000"},
		{"http://[fe80::1]:7000", "http://[fe80::1]:7000"},
		{"", ""},
		{"   ", ""},
		{"ftp://devbox", ""},
		{"file:///etc/passwd", ""},
		{"javascript:alert(1)", ""},
		{"http://", ""},
		{"http://user:pw@devbox:8080", ""},
		{"devbox:notaport", ""},
	}
	for _, c := range cases {
		if got, ok := normaliseServerURL(c.in); got != c.want || ok != (c.want != "") {
			t.Errorf("normaliseServerURL(%q) = %q, %v; want %q", c.in, got, ok, c.want)
		}
	}
}

// What a page can ask the app to connect to is bounded by which page asks. A
// window on a server by URL is showing a page that server sent; if it could
// name another host, every server ever connected to could put windows onto
// anywhere, with a place in the workspace set.
func TestAWindowOnAServerByURLCannotConnectToAnother(t *testing.T) {
	for _, spec := range []windowSpec{{url: "http://devbox:8080"}, {url: "http://devbox:8080", connected: true}} {
		a := newTestAppState(t)
		registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: spec, serverURL: spec.url})

		rec := controlRequest(a, http.MethodPost, "/win/w1/connect?url=http%3A%2F%2Felsewhere%3A1")

		if rec.Code != http.StatusForbidden {
			t.Fatalf("%+v: status = %d, want %d", spec, rec.Code, http.StatusForbidden)
		}
		var body struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || !strings.Contains(body.Error, "new window") {
			t.Fatalf("%+v: the refusal should say where to connect from instead, got %q (%v)", spec, rec.Body.String(), err)
		}
	}
}

func TestConnectRefusesAnAddressThatIsNotAServer(t *testing.T) {
	a := newTestAppState(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{}, serverURL: "http://127.0.0.1:4000"})

	rec := controlRequest(a, http.MethodPost, "/win/w1/connect?url=file%3A%2F%2F%2Fetc")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error == "" {
		t.Fatalf("the refusal should say what was wrong with the address, got %q (%v)", rec.Body.String(), err)
	}
}

// The recovery actions belong to the unreachable-server page, and only to it: a
// working window cannot be made to replace itself.
func TestOnlyAnUnreachableServerWindowTakesItsRecoveryActions(t *testing.T) {
	a := newTestAppState(t)
	registerWindow(a, &winEntry{id: "w1", role: roleMain, spec: windowSpec{project: "/p"}, serverURL: "http://127.0.0.1:4000/s/x"})

	for _, action := range []string{"retry-server", "open-local"} {
		rec := controlRequest(a, http.MethodPost, "/win/w1/"+action)
		if rec.Code != http.StatusConflict {
			t.Errorf("%s on a window showing its server: status = %d, want %d", action, rec.Code, http.StatusConflict)
		}
	}
}

// Opening a window onto a server by URL waits a bounded time for it to answer.
// A freshly spawned local server needs the retries; a remote one is either
// listening or it is not, and a host that never answers must not hold the
// window back for the length of every retry's own timeout.
func TestReadWindowStateGivesUpOnAServerThatNeverAnswers(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	// Accepts, and never says anything.
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			defer c.Close()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, _, reached := readWindowState(ctx, "http://"+ln.Addr().String(), roleMain)

	if reached {
		t.Fatal("a server that never answered was reported reached")
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("gave up after %v; the budget was 300ms", took)
	}
}

func TestReadWindowStateReportsARefusedServerUnreached(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, _, reached := readWindowState(ctx, "http://"+addr, roleMain); reached {
		t.Fatal("a refused connection was reported reached")
	}
}

func TestReadWindowStateReportsAnAnsweringServerReached(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"windowState":{"width":900,"height":700},"hasState":true}`))
	}))
	defer srv.Close()

	ws, has, reached := readWindowState(context.Background(), srv.URL, roleMain)
	if !reached || !has || ws.Width != 900 {
		t.Fatalf("got %+v has=%v reached=%v", ws, has, reached)
	}
}

// A stand-in's page has no server behind it, so its buttons post straight to
// this app's control endpoint for the window showing it.
func TestUnreachableServerPagePostsToItsWindow(t *testing.T) {
	base := "http://127.0.0.1:5000/secret/win/w7"
	page := standInPage(standInPageText{
		title:   "Can't reach the server",
		message: `Juggler could not connect to http://dev<box>:8080.`,
		buttons: []standInPageButton{
			{label: "Try again", action: "retry-server", busy: "Trying…", primary: true},
			{label: "Open a local window instead", action: "open-local"},
		},
		controlBase: base,
	})

	const prefix = "data:text/html;charset=utf-8;base64,"
	if !strings.HasPrefix(page, prefix) {
		t.Fatalf("not a base64 data URL: %.60s", page)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(page, prefix))
	if err != nil {
		t.Fatal(err)
	}
	doc := string(raw)
	for _, want := range []string{
		`action="` + base + `/retry-server"`,
		`action="` + base + `/open-local"`,
		`method="post"`,
		"dev&lt;box&gt;",
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("page is missing %q:\n%s", want, doc)
		}
	}
	if strings.Contains(doc, "dev<box>") {
		t.Error("the address is shown unescaped")
	}
}
