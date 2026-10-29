//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"
	"juggler/internal/apipaths"
	"juggler/internal/ingress"
	"juggler/internal/srcroot"
	"juggler/tests/helpers"
)

// TestMachineServerSessionLifecycle drives one session through the control
// API: a first open spawns a child, a second open for the same project reuses
// it, the list shows it running, and a stop takes the child down and drops the
// record. It also checks the harness's isolation — the server's discovery file
// is under the temporary HOME, naming the address it printed.
func TestMachineServerSessionLifecycle(t *testing.T) {
	ms, stop := startMachineServer(t)
	defer stop()

	var info machineserver.ServerInfo
	raw, err := os.ReadFile(filepath.Join(ms.ConfigDir, "server.json"))
	if err != nil {
		t.Fatalf("server.json under the temporary HOME: %v", err)
	}
	if err := json.Unmarshal(raw, &info); err != nil {
		t.Fatalf("decode server.json %s: %v", raw, err)
	}
	if info.Addr != ms.Addr || info.PID != ms.cmd.Process.Pid {
		t.Fatalf("server.json = %+v, want addr %s pid %d", info, ms.Addr, ms.cmd.Process.Pid)
	}

	project := newProjectDir(t)
	first := ms.openSession(project, http.StatusCreated)
	if first.State != machineserver.SessionRunning || first.PID == 0 || first.Addr == "" {
		t.Fatalf("spawned session = %+v, want running with a pid and an address", first)
	}
	if first.Project != project {
		t.Fatalf("session project = %q, want %q", first.Project, project)
	}

	again := ms.openSession(project, http.StatusOK)
	if again.ID != first.ID || again.PID != first.PID {
		t.Fatalf("second open = %+v, want the running session %s (pid %d) reused", again, first.ID, first.PID)
	}

	list := ms.mustListSessions()
	if len(list) != 1 || list[0].ID != first.ID || list[0].State != machineserver.SessionRunning {
		t.Fatalf("sessions = %+v, want exactly %s running", list, first.ID)
	}

	resp, err := ms.do(http.MethodDelete, "/api/server/sessions/"+first.ID, nil)
	if err != nil {
		t.Fatalf("DELETE session: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE session: status %d, want 204", resp.StatusCode)
	}
	if list := ms.mustListSessions(); len(list) != 0 {
		t.Fatalf("sessions after stop = %+v, want none", list)
	}
	// The stop returns once the child has exited, so its port is closed now.
	if dialable(first.Addr) {
		t.Fatalf("stopped child at %s still accepts connections", first.Addr)
	}
	resp, err = ms.do(http.MethodGet, "/s/"+first.ID+"/api/health", nil)
	if err != nil {
		t.Fatalf("GET through a stopped session: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("proxy to a stopped session: status %d, want 404", resp.StatusCode)
	}
}

// TestMachineServerProxiesHTTP proves /s/<id>/ reaches the session's own
// child: the instance it answers for is that child's pid and project. A bare
// /s/<id> redirects to the prefixed root.
func TestMachineServerProxiesHTTP(t *testing.T) {
	ms, stop := startMachineServer(t)
	defer stop()

	project := newProjectDir(t)
	sess := ms.openSession(project, http.StatusCreated)

	code, body := sessionCall(t, http.MethodGet, ms.url("/s/"+sess.ID+apipaths.HealthInstance), ms.sessionPageToken("/s/"+sess.ID), nil)
	if code != http.StatusOK {
		t.Fatalf("proxied GET %s: status %d, body %s", apipaths.HealthInstance, code, body)
	}
	var inst struct {
		ProjectPath string `json:"projectPath"`
		PID         int    `json:"pid"`
	}
	if err := json.Unmarshal([]byte(body), &inst); err != nil {
		t.Fatalf("decode instance health %s: %v", body, err)
	}
	if inst.PID != sess.PID || inst.ProjectPath != project {
		t.Fatalf("proxied instance = pid %d project %q, want the session's child: pid %d project %q",
			inst.PID, inst.ProjectPath, sess.PID, project)
	}

	// The page tells its scripts where it is mounted, so they address the
	// child through the proxy rather than the machine server's own root.
	resp, err := ms.do(http.MethodGet, "/s/"+sess.ID+"/", nil)
	if err != nil {
		t.Fatalf("proxied GET index: %v", err)
	}
	page, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	m := pageBasePattern.FindSubmatch(page)
	if m == nil {
		t.Fatalf("proxied index.html does not set window.__jugglerBase")
	}
	if got := strings.ReplaceAll(string(m[1]), `\/`, "/"); got != "/s/"+sess.ID {
		t.Fatalf("proxied index.html base = %q, want /s/%s", got, sess.ID)
	}

	resp, err = ms.do(http.MethodGet, "/s/"+sess.ID, nil)
	if err != nil {
		t.Fatalf("GET bare session path: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusMovedPermanently || resp.Header.Get("Location") != "/s/"+sess.ID+"/" {
		t.Fatalf("bare /s/<id>: status %d location %q, want 301 to /s/%s/",
			resp.StatusCode, resp.Header.Get("Location"), sess.ID)
	}
}

// TestMachineServerServesTheUIUnderItsPrefix loads the UI's page through the
// proxy and then everything that page references by server path — scripts,
// stylesheets, the SDK import map, the asset prefix its modules load from —
// the way a browser there would. Each must be under /s/<id>/ and must load.
func TestMachineServerServesTheUIUnderItsPrefix(t *testing.T) {
	ms, stop := startMachineServer(t)
	defer stop()

	sess := ms.openSession(newProjectDir(t), http.StatusCreated)
	prefix := "/s/" + sess.ID + "/"

	resp, err := ms.do(http.MethodGet, prefix, nil)
	if err != nil {
		t.Fatalf("proxied GET index: %v", err)
	}
	page, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("proxied GET index: status %d", resp.StatusCode)
	}

	refs := pageRefPattern.FindAllStringSubmatch(string(page), -1)
	if len(refs) < 20 {
		t.Fatalf("found only %d server-relative references in the proxied index.html", len(refs))
	}
	seen := map[string]bool{}
	for _, m := range refs {
		// Groups: 1 src/href, 2 import-map entry, 3 the asset prefix — a
		// directory, so a module the app loads from it stands in for it.
		ref := m[1] + strings.ReplaceAll(m[2], `\/`, "/")
		if m[3] != "" {
			ref = strings.ReplaceAll(m[3], `\/`, "/") + "/js/app.js"
		}
		if seen[ref] {
			continue
		}
		seen[ref] = true
		if !strings.HasPrefix(ref, prefix) {
			t.Errorf("index.html references %q outside %s", ref, prefix)
			continue
		}
		resp, err := ms.do(http.MethodGet, ref, nil)
		if err != nil {
			t.Errorf("GET %s: %v", ref, err)
			continue
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("GET %s through the proxy: status %d", ref, resp.StatusCode)
		}
	}
}

// TestMachineServerDrivesASessionInABrowser is the UI-under-the-proxy exit
// test: a real browser test runs in a page the child's test window loads
// through the machine server at /s/<id>/, so every request it makes — the
// test runner's own, the app's /api calls, its WebSocket — has to find the
// session through the prefix. The machine server's own root serves none of
// them, so a URL that misses the prefix fails the test rather than reaching
// the child another way.
func TestMachineServerDrivesASessionInABrowser(t *testing.T) {
	ms, stop := startMachineServer(t, "--test")
	defer stop()

	root, err := srcroot.Find(".")
	if err != nil {
		t.Fatalf("find project root: %v", err)
	}
	fixture := newProjectDir(t)
	if err := helpers.CopyDir(filepath.Join(root, "tests", "benchmarks", "fixtures", "unit-test-fixture"), fixture); err != nil {
		t.Fatalf("copy fixture: %v", err)
	}
	sess := ms.openSession(fixture, http.StatusCreated)
	ms.holdSession(sess.ID)

	// The child's own test API, reached the way the page reaches it.
	prefix := "/s/" + sess.ID
	const name = "integration:read-file-single"
	if err := helpers.PostJSON(ms.Addr, prefix+"/api/test/run", map[string]any{
		"name":        name,
		"projectPath": fixture,
	}, nil); err != nil {
		t.Fatalf("POST %s/api/test/run: %v", prefix, err)
	}
	var result struct {
		Passed      bool     `json:"passed"`
		Details     string   `json:"details"`
		Errors      []string `json:"errors"`
		PostedUnder string   `json:"postedUnder"`
	}
	if err := helpers.PollJSON(ms.Addr, prefix+"/api/test/result?name="+name, 120*time.Second, &result, nil); err != nil {
		t.Fatalf("waiting for %s through the proxy: %v\n%s", name, err, ms.whereTheLaneStopped(prefix, name))
	}
	// The test queue is the child's own, so a lane that loaded the child
	// directly would run the test too. Only a lane served through the proxy
	// posts its result under the session's prefix.
	if result.PostedUnder != prefix {
		t.Fatalf("the lane posted its result under %q, want %q: it was not served through the proxy",
			result.PostedUnder, prefix)
	}
	if !result.Passed {
		for _, e := range result.Errors {
			t.Error(e)
		}
		if len(result.Errors) == 0 {
			t.Error(result.Details)
		}
	}
}

// TestMachineServerCLI drives a real machine server from the command line, the
// suite's binary run as `juggler open` and `juggler server …` under the same
// HOME, so it finds the server through server.json as a user's shell would.
func TestMachineServerCLI(t *testing.T) {
	ms, stop := startMachineServer(t)
	defer stop()
	project := newProjectDir(t)

	code, out, errOut := ms.cli("open", project)
	if code != 0 {
		t.Fatalf("juggler open: exit %d, stderr %q", code, errOut)
	}
	list := ms.mustListSessions()
	if len(list) != 1 || list[0].Project != project {
		t.Fatalf("sessions after juggler open = %+v, want one for %s", list, project)
	}
	ms.noteChild(list[0])
	if want := "http://" + ms.Addr + "/s/" + list[0].ID + "/"; strings.TrimSpace(out) != want {
		t.Fatalf("juggler open printed %q, want %q", out, want)
	}

	if code, out, _ := ms.cli("server", "status"); code != 0 || !strings.Contains(out, ms.Addr) || !strings.Contains(out, "1 session") {
		t.Errorf("juggler server status: exit %d, output %q", code, out)
	}
	if code, out, _ := ms.cli("server", "sessions"); code != 0 || !strings.Contains(out, list[0].ID) || !strings.Contains(out, project) {
		t.Errorf("juggler server sessions: exit %d, output %q", code, out)
	}
	if code, _, errOut := ms.cli("server", "stop", list[0].ID); code != 0 {
		t.Fatalf("juggler server stop %s: exit %d, stderr %q", list[0].ID, code, errOut)
	}
	if left := ms.mustListSessions(); len(left) != 0 {
		t.Fatalf("sessions after juggler server stop = %+v, want none", left)
	}

	if code, _, errOut := ms.cli("server", "stop"); code != 0 {
		t.Fatalf("juggler server stop: exit %d, stderr %q", code, errOut)
	}
	select {
	case <-ms.exited:
	case <-time.After(15 * time.Second):
		t.Fatal("the machine server did not exit after juggler server stop")
	}
	if code, _, errOut := ms.cli("server", "status"); code != 1 || !strings.Contains(errOut, "juggler serve") {
		t.Fatalf("juggler server status with no server: exit %d, stderr %q", code, errOut)
	}
}

// TestOpenNeedsARunningServer: open never creates a server whose lifetime
// would end as soon as the command returned.
func TestOpenNeedsARunningServer(t *testing.T) {
	iso := newIsolatedRun(t)
	ms := &machineServer{t: t, Home: iso.home, ConfigDir: configDirUnder(iso.home), Logs: iso.logs, iso: iso, children: map[int]string{}}
	project := newProjectDir(t)
	code, out, errOut := ms.cli("open", project)
	infoPath := filepath.Join(ms.ConfigDir, "server.json")
	if _, err := os.Stat(infoPath); err == nil {
		info := ms.readServerInfo()
		ms.Addr, ms.Token = info.Addr, info.Token
		t.Cleanup(func() { ms.stopDetached(infoPath, info.PID) })
		t.Error("juggler open started a machine server")
	}
	if code != 1 || out != "" || !strings.Contains(errOut, "run "+"`juggler`"+" in the project") {
		t.Fatalf("open without a server: exit %d, stdout %q, stderr %q; want refusal pointing at juggler in the project", code, out, errOut)
	}
}

// stopDetached shuts down a machine server the test did not start itself, so
// cannot wait on: it asks over the control API, then waits for the server to
// let go of server.json, and checks no session child it saw is still serving.
func (ms *machineServer) stopDetached(infoPath string, pid int) {
	t := ms.t
	if sessions, err := ms.listSessions(); err == nil {
		for _, s := range sessions {
			ms.noteChild(s)
		}
	}
	if resp, err := ms.do(http.MethodPost, "/api/server/shutdown", nil); err == nil {
		_ = resp.Body.Close()
	}
	deadline := time.Now().Add(machineServerStopTimeout)
	for {
		if _, err := os.Stat(infoPath); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Errorf("the machine server (pid %d) did not exit within %s of a shutdown request — killing it", pid, machineServerStopTimeout)
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Kill()
			}
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	for childPID, addr := range ms.children {
		if addr != "" && dialable(addr) {
			t.Errorf("session child pid %d at %s is still serving after the machine server exited", childPID, addr)
		}
		if p, err := os.FindProcess(childPID); err == nil {
			_ = p.Kill()
		}
	}
}

// machineConfigPattern finds the configuration the sessions page hands its
// script, which carries the control-API token.
var machineConfigPattern = regexp.MustCompile(`(?s)<script type="application/json" id="machine-config">(.*?)</script>`)

// TestMachineServerLaunchesTwoSessionsFromThePage is M2's exit test, run the
// way the sessions page runs it. The page is loaded with no credential, and the
// token comes from the page itself. With that token, and the Origin a browser on
// the page sends, two projects are opened and offered back as recents. Then a
// real browser test runs in each session at once, in one browser origin through
// the proxy, and each must report under its own session's prefix.
func TestMachineServerLaunchesTwoSessionsFromThePage(t *testing.T) {
	ms, stop := startMachineServer(t, "--test")
	defer stop()

	resp, err := http.Get("http://" + ms.Addr + "/") //nolint:noctx // test
	if err != nil {
		t.Fatalf("GET the sessions page: %v", err)
	}
	page, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	m := machineConfigPattern.FindSubmatch(page)
	if resp.StatusCode != http.StatusOK || m == nil {
		t.Fatalf("sessions page: status %d, machine-config found %v", resp.StatusCode, m != nil)
	}
	var cfg struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(m[1], &cfg); err != nil || cfg.Token != ms.Token {
		t.Fatalf("the page's token %q (%v) is not the server's", cfg.Token, err)
	}

	// pageCall is a request as the page's script makes it.
	pageCall := func(method, path string, body any, out any) int {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = strings.NewReader(string(b))
		}
		req, _ := http.NewRequest(method, "http://"+ms.Addr+path, rd) //nolint:noctx // test
		req.Header.Set(machineserver.TokenHeader, cfg.Token)
		req.Header.Set("Origin", "http://"+ms.Addr)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		if out != nil {
			_ = json.NewDecoder(resp.Body).Decode(out)
		}
		return resp.StatusCode
	}

	root, err := srcroot.Find(".")
	if err != nil {
		t.Fatalf("find project root: %v", err)
	}
	var sessions [2]machineserver.Session
	var fixtures [2]string
	for i := range sessions {
		fixtures[i] = newProjectDir(t)
		if err := helpers.CopyDir(filepath.Join(root, "tests", "benchmarks", "fixtures", "unit-test-fixture"), fixtures[i]); err != nil {
			t.Fatalf("copy fixture: %v", err)
		}
		if code := pageCall(http.MethodPost, "/api/server/sessions", map[string]string{"project": fixtures[i]}, &sessions[i]); code != http.StatusCreated {
			t.Fatalf("open %s from the page: status %d", fixtures[i], code)
		}
		ms.noteChild(sessions[i])
	}
	var recents struct {
		Paths []string `json:"paths"`
	}
	if code := pageCall(http.MethodGet, "/api/server/recents", nil, &recents); code != http.StatusOK ||
		len(recents.Paths) < 2 || recents.Paths[0] != fixtures[1] || recents.Paths[1] != fixtures[0] {
		t.Fatalf("recents after two opens: status %d, %v; want %s then %s", code, recents.Paths, fixtures[1], fixtures[0])
	}

	const name = "integration:read-file-single"
	type outcome struct {
		prefix string
		err    error
		result struct {
			Passed      bool     `json:"passed"`
			Details     string   `json:"details"`
			Errors      []string `json:"errors"`
			PostedUnder string   `json:"postedUnder"`
		}
	}
	done := make(chan *outcome, len(sessions))
	for i, sess := range sessions {
		go func() {
			o := &outcome{prefix: "/s/" + sess.ID}
			if o.err = helpers.PostJSON(ms.Addr, o.prefix+"/api/test/run", map[string]any{"name": name, "projectPath": fixtures[i]}, nil); o.err == nil {
				o.err = helpers.PollJSON(ms.Addr, o.prefix+"/api/test/result?name="+name, 120*time.Second, &o.result, nil)
			}
			done <- o
		}()
	}
	for range sessions {
		o := <-done
		if o.err != nil {
			t.Errorf("%s: %v\n%s", o.prefix, o.err, ms.whereTheLaneStopped(o.prefix, name))
			continue
		}
		if o.result.PostedUnder != o.prefix {
			t.Errorf("%s: the lane posted under %q: it was not served through its own session", o.prefix, o.result.PostedUnder)
		}
		if !o.result.Passed {
			t.Errorf("%s: %s %v", o.prefix, o.result.Details, o.result.Errors)
		}
	}
}

// pageRefPattern finds the server-relative URLs a page loads: src and href
// attributes, import-map entries, and the asset prefix. External and
// protocol-relative URLs don't match.
var pageRefPattern = regexp.MustCompile(
	`(?:src|href)="(/[^/"][^"]*)"` +
		`|"juggler/[^"]+":\s*"(\\?/[^/"][^"]*)"` +
		`|__assetPrefix = '([^']*)'`)

// pageBasePattern finds the base path a child templates into index.html. The
// page is rendered by html/template, which escapes '/' inside a JS string.
var pageBasePattern = regexp.MustCompile(`window\.__jugglerBase = '([^']*)';`)

// apiTokenPattern finds the per-instance token a child templates into index.html.
var apiTokenPattern = regexp.MustCompile(`window\.__jugglerToken = '([0-9a-f]+)'`)

// TestMachineServerProxiesWebSocket opens a viewer WebSocket through the proxy
// the way a browser on the machine server's origin would: token from the
// proxied index.html, Origin naming the machine server. The child only admits
// that upgrade when the proxy has preserved the client's Host, and its first
// frame is the session greeting.
func TestMachineServerProxiesWebSocket(t *testing.T) {
	ms, stop := startMachineServer(t)
	defer stop()

	sess := ms.openSession(newProjectDir(t), http.StatusCreated)
	prefix := "/s/" + sess.ID

	bootID, closed := ms.greetViewer(prefix, ms.sessionPageToken(prefix))
	if closed || bootID == "" {
		t.Fatalf("proxied viewer socket: closed=%v boot id %q, want the child's session greeting", closed, bootID)
	}
}

// sessionPageToken loads a session's page through the proxy, as a browser
// tab would, and returns the API token it carries.
func (ms *machineServer) sessionPageToken(prefix string) string {
	ms.t.Helper()
	resp, err := ms.do(http.MethodGet, prefix+"/", nil)
	if err != nil {
		ms.t.Fatalf("proxied GET index: %v", err)
	}
	page, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		ms.t.Fatalf("proxied GET index: status %d", resp.StatusCode)
	}
	m := apiTokenPattern.FindSubmatch(page)
	if m == nil {
		ms.t.Fatalf("proxied index.html carries no API token")
	}
	return string(m[1])
}

// greetViewer opens a viewer socket through the proxy with token, as a tab
// under prefix does, and reads what the child says first. It returns the boot
// id from the child's session greeting, or closed=true when the socket was
// upgraded and then closed without one — how a child refuses another
// process's token. Either answer lets the client tell a restarted child from
// a blip (web/js/services/websocket.js: _resolveReconnect, and the
// unidentified death in _onTransportClosed).
func (ms *machineServer) greetViewer(prefix, token string) (bootID string, closed bool) {
	ms.t.Helper()
	header := http.Header{"Origin": []string{"http://" + ms.Addr}}
	wsURL := "ws://" + ms.Addr + prefix + apipaths.WebSocket + "?role=viewer&token=" + token
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		ms.t.Fatalf("proxied WebSocket dial: %v (status %d)", err, status)
	}
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			ms.t.Fatalf("no first frame through the proxy within 10s")
		}
		return "", true
	}
	var greeting struct {
		Type   string `json:"type"`
		BootID string `json:"bootId"`
	}
	if err := json.Unmarshal(msg, &greeting); err != nil {
		ms.t.Fatalf("decode first frame %s: %v", msg, err)
	}
	if greeting.Type != "session" {
		ms.t.Fatalf("first frame = %s, want the child's session greeting", msg)
	}
	return greeting.BootID, false
}

// TestMachineServerReportsSessionActivity runs a real turn in a session's
// child and watches the sessions list follow it: idle with no last activity
// before, busy with a last activity while the turn runs, idle again after,
// keeping the time it was last seen busy.
func TestMachineServerReportsSessionActivity(t *testing.T) {
	ms, stop := startMachineServer(t)
	defer stop()
	// The mock answers the turn, so the model is never called — but a turn
	// with no model is refused before it reaches the mock.
	ms.setDefaultModel(core.ModelRef{Provider: "test", Model: "test-model"})

	sess := ms.openSession(newProjectDir(t), http.StatusCreated)
	if sess.Busy || sess.LastActive != nil {
		t.Fatalf("fresh session = %+v, want idle with no last activity", sess)
	}

	before := time.Now()
	release := holdTurn(t, ms, sess)
	busy := ms.waitForSession(sess.ID, "busy", 15*time.Second, func(s machineserver.Session) bool { return s.Busy })
	if busy.LastActive == nil || busy.LastActive.Before(before) {
		t.Fatalf("busy session = %+v, want a last activity after %s", busy, before.Format(time.RFC3339Nano))
	}

	release()
	idle := ms.waitForSession(sess.ID, "idle", 15*time.Second, func(s machineserver.Session) bool { return !s.Busy })
	if idle.LastActive == nil || idle.LastActive.Before(*busy.LastActive) {
		t.Fatalf("idle session = %+v, want the last activity kept from when it was busy (%s)",
			idle, busy.LastActive.Format(time.RFC3339Nano))
	}
}

// TestMachineServerKeepsAnUnviewedTurnUntilItFinishes checks session lifetime
// against real children. An idle unviewed child disappearing witnesses the
// supervisor's grace expiring while a disconnected viewer's turn stays busy.
func TestMachineServerKeepsAnUnviewedTurnUntilItFinishes(t *testing.T) {
	ms, stop := startMachineServer(t)
	defer stop()
	ms.setDefaultModel(core.ModelRef{Provider: "test", Model: "test-model"})

	deadline := time.Now().Add(90 * time.Second)
	if end, ok := t.Deadline(); ok && end.Before(deadline) {
		deadline = end
	}
	sess := ms.openSession(newProjectDir(t), http.StatusCreated)
	release, disconnect := holdTurnWithViewer(t, ms, sess)
	ms.waitForSession(sess.ID, "busy", time.Until(deadline), func(s machineserver.Session) bool { return s.Busy })
	disconnect()
	disconnectedAt := time.Now()
	witness := ms.openSession(newProjectDir(t), http.StatusCreated)

	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	expired := time.NewTimer(time.Until(deadline))
	defer expired.Stop()
	wait := func(what string, done func([]machineserver.Session) bool) {
		t.Helper()
		for {
			list := ms.mustListSessions()
			if done(list) {
				return
			}
			select {
			case <-tick.C:
			case <-expired.C:
				t.Fatalf("%s: test deadline expired; sessions: %+v", what, list)
			}
		}
	}
	wait("idle unviewed session should vanish while the turn holds its session", func(list []machineserver.Session) bool {
		var held, idle *machineserver.Session
		for i := range list {
			switch list[i].ID {
			case sess.ID:
				held = &list[i]
			case witness.ID:
				idle = &list[i]
			}
		}
		if held == nil || held.State != machineserver.SessionRunning || !held.Busy || held.PID != sess.PID {
			t.Fatalf("disconnect cancelled or stopped the held turn: sessions %+v", list)
		}
		if idle != nil {
			return false
		}
		if elapsed := time.Since(disconnectedAt); elapsed < 10*time.Second {
			t.Fatalf("idle witness vanished after %s, before the 10s viewer grace expired", elapsed)
		}
		return true
	})
	t.Log("idle witness vanished after grace; disconnected session still running its held turn")

	release()
	wait("released unviewed session should vanish", func(list []machineserver.Session) bool {
		for _, s := range list {
			if s.ID == sess.ID {
				return false
			}
		}
		return true
	})
	if dialable(sess.Addr) {
		t.Fatalf("session vanished but its child at %s still accepts connections", sess.Addr)
	}
}

// holdTurn starts a turn in a new conversation on sess's child and holds it
// open on a paused scripted response — the worker's test mock, which every
// non-production build carries — talking to the child through the proxy as a
// viewer would. It returns once the child reports the turn paused, with the
// func that lets the turn finish.
func holdTurn(t *testing.T, ms *machineServer, sess machineserver.Session) (release func()) {
	t.Helper()
	release, _ = holdTurnWithViewer(t, ms, sess)
	return release
}

// holdTurnWithViewer also lets the caller disconnect the turn's only viewer.
// Release after disconnect uses a direct child socket, so it does not renew the
// supervisor's viewer grace. No control socket exists during the unviewed turn.
func holdTurnWithViewer(t *testing.T, ms *machineServer, sess machineserver.Session) (release, disconnect func()) {
	t.Helper()
	prefix := "/s/" + sess.ID

	resp, err := ms.do(http.MethodGet, prefix+"/", nil)
	if err != nil {
		t.Fatalf("proxied GET index: %v", err)
	}
	page, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	m := apiTokenPattern.FindSubmatch(page)
	if m == nil {
		t.Fatalf("proxied index.html carries no API token")
	}
	token := string(m[1])

	req, err := http.NewRequest(http.MethodPost, ms.url(prefix+"/api/conversations"),
		strings.NewReader(`{"name":"held turn"}`))
	if err != nil {
		t.Fatalf("build create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Juggler-Token", token)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("create conversation: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create conversation: status %d, body %s", resp.StatusCode, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &created); err != nil || created.ID == "" {
		t.Fatalf("create conversation: body %s (%v)", body, err)
	}
	convID := created.ID

	header := http.Header{"Origin": []string{"http://" + ms.Addr}}
	wsURL := "ws://" + ms.Addr + prefix + apipaths.WebSocket + "?role=viewer&token=" + token
	conn, wsResp, err := websocket.DefaultDialer.Dial(wsURL, header)
	if wsResp != nil && wsResp.Body != nil {
		_ = wsResp.Body.Close()
	}
	if err != nil {
		t.Fatalf("proxied WebSocket dial: %v", err)
	}
	// Frames come from this goroutine and, as replies, from the reader below;
	// one writer goroutine owns the socket's write side.
	outbox, closed := make(chan any), make(chan struct{})
	var closeOnce sync.Once
	disconnect = func() {
		closeOnce.Do(func() {
			close(closed)
			_ = conn.Close()
		})
	}
	t.Cleanup(disconnect)
	go func() {
		for {
			select {
			case frame := <-outbox:
				if err := conn.WriteJSON(frame); err != nil {
					return
				}
			case <-closed:
				return
			}
		}
	}()
	send := func(msgType string, payload any) {
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Errorf("marshal %s: %v", msgType, err)
			return
		}
		select {
		case outbox <- map[string]any{
			"type": "worker-message", "conversationId": convID,
			"workerMsgType": msgType, "payload": json.RawMessage(raw),
		}:
		case <-closed:
		}
	}

	// The reader answers the turn's requests for tools and rendered context —
	// the engine's job, done here so the turn needs no engine to reach the
	// mock — and reports the frames the steps below wait for. A turn the child
	// refuses (no model, say) never pauses, so its reason ends the wait at once.
	ready, acked, paused := make(chan struct{}, 1), make(chan struct{}, 1), make(chan struct{}, 1)
	refused := make(chan string, 1)
	signal := func(ch chan struct{}) {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
	go func() {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var env struct {
				Type           string          `json:"type"`
				ConversationID string          `json:"conversationId"`
				Payload        json.RawMessage `json:"payload"`
			}
			if json.Unmarshal(raw, &env) != nil || env.Type != "worker-message" || env.ConversationID != convID {
				continue
			}
			var msg struct {
				Type      string `json:"type"`
				Status    string `json:"status"`
				Message   string `json:"message"`
				RequestID string `json:"requestId"`
			}
			if json.Unmarshal(env.Payload, &msg) != nil {
				continue
			}
			switch msg.Type {
			case "ready":
				signal(ready)
			case "ack":
				signal(acked)
			case "status":
				switch msg.Status {
				case "mock-paused":
					signal(paused)
				case "validation-error":
					select {
					case refused <- msg.Status + ": " + msg.Message:
					default:
					}
				}
			case "request-tools":
				send("tools-result", map[string]any{"type": "tools-result", "requestId": msg.RequestID, "tools": []any{}})
			case "render-context-items-request":
				send("render-context-items-response", map[string]any{"type": "render-context-items-response", "requestId": msg.RequestID})
			}
		}
	}()
	await := func(ch chan struct{}, what string) {
		t.Helper()
		select {
		case <-ch:
		case why := <-refused:
			t.Fatalf("held turn: the child refused it while waiting for %s (%s)", what, why)
		case <-time.After(30 * time.Second):
			t.Fatalf("held turn: no %s from the child", what)
		}
	}

	send("init", map[string]any{
		"type":         "init",
		"conversation": map[string]any{"id": convID, "name": "held turn"},
		"config":       map[string]any{"projectPath": sess.Project},
	})
	await(ready, "ready")
	send("set-mock-responses", map[string]any{
		"type": "set-mock-responses", "ackId": "held-turn",
		"responses": []any{map[string]any{
			"blocks":            []any{map[string]any{"type": "text", "content": "held"}},
			"stopReason":        "end_turn",
			"pauseBeforeReturn": true,
		}},
	})
	await(acked, "ack for the scripted response")
	send("send-message", map[string]any{"type": "send-message", "text": "hold this turn"})
	await(paused, "mock-paused status")

	release = func() {
		select {
		case <-closed:
			// This test-only control connection is made after proving the
			// turn survives without viewers, and bypasses the proxy so it
			// cannot restart the supervisor's grace.
			header := http.Header{"Origin": []string{"http://" + sess.Addr}}
			controlURL := "ws://" + sess.Addr + apipaths.WebSocket + "?role=viewer&token=" + url.QueryEscape(token)
			control, resp, err := websocket.DefaultDialer.Dial(controlURL, header)
			if resp != nil && resp.Body != nil {
				_ = resp.Body.Close()
			}
			if err != nil {
				t.Fatalf("reconnect to release held turn: %v", err)
			}
			t.Cleanup(func() { _ = control.Close() })
			if err := control.WriteJSON(map[string]any{
				"type": "worker-message", "conversationId": convID,
				"workerMsgType": "release-mock", "payload": map[string]any{"type": "release-mock"},
			}); err != nil {
				t.Fatalf("release held turn after disconnect: %v", err)
			}
		default:
			send("release-mock", map[string]any{"type": "release-mock"})
		}
	}
	return release, disconnect
}

// TestMachineServerRestartsACrashedChild kills a real session child out from
// under the machine server: the session is respawned under the same ID, with a
// new child, and the proxy routes /s/<id>/ to the new one. The policy's other
// branches (clean exit, giving up, stop during the backoff) are covered against
// stand-in children in machineserver/restart_test.go.
func TestMachineServerRestartsACrashedChild(t *testing.T) {
	ms, stop := startMachineServer(t)
	defer stop()

	project := newProjectDir(t)
	sess := ms.openSession(project, http.StatusCreated)
	prefix := "/s/" + sess.ID
	oldToken := ms.sessionPageToken(prefix)
	oldBoot, _ := ms.greetViewer(prefix, oldToken)

	p, err := os.FindProcess(sess.PID)
	if err != nil {
		t.Fatalf("find child pid %d: %v", sess.PID, err)
	}
	if err := p.Kill(); err != nil {
		t.Fatalf("kill child pid %d: %v", sess.PID, err)
	}

	back := ms.waitForSession(sess.ID, "running in a new child", 30*time.Second, func(s machineserver.Session) bool {
		return s.State == machineserver.SessionRunning && s.PID != 0 && s.PID != sess.PID
	})
	ms.noteChild(back)
	if back.Restarts != 1 || back.Error != "" {
		t.Fatalf("restarted session = %+v, want one restart and no error", back)
	}

	code, body := sessionCall(t, http.MethodGet, ms.url(prefix+apipaths.HealthInstance), ms.sessionPageToken(prefix), nil)
	var inst struct {
		PID int `json:"pid"`
	}
	if err := json.Unmarshal([]byte(body), &inst); err != nil || code != http.StatusOK {
		t.Fatalf("instance through the restarted session: status %d (%s), %v", code, body, err)
	}
	if inst.PID != back.PID {
		t.Fatalf("/s/%s/ reached pid %d, want the new child %d", sess.ID, inst.PID, back.PID)
	}
	if list := ms.mustListSessions(); len(list) != 1 || list[0].ID != sess.ID {
		t.Fatalf("sessions after the restart = %+v, want only %s", list, sess.ID)
	}

	// A tab loaded before the crash reconnects with its page's token. It must
	// be told this is another server — a different boot id, or a socket closed
	// before any greeting — so it reloads and picks up the new child's token.
	if boot, closed := ms.greetViewer(prefix, oldToken); !closed && boot == oldBoot {
		t.Fatalf("a tab from before the restart reconnected to boot id %q, the same as before: it would carry on with a dead token", boot)
	}
}

// TestSessionChildTreatsItsSupervisorsIngressAsRemote runs a session child the
// way the machine server spawns one, with an ingress secret and API token the
// test knows, and stands in for the supervisor. The child serves exactly that
// token, never one of its own. A request carrying that secret is a caller the
// supervisor saw off loopback, so it may not change this machine's window
// preferences or take the engine slot, though it arrives over loopback. A
// request carrying any other value is a local caller, as one carrying none is.
//
// A caller off loopback reaches the child through the real machine server in
// TestMachineServerOnTheLAN. The server's half — sending this header, with
// this child's secret, for exactly those callers — is covered against real
// processes by
// TestSpawnedChildGetsItsOwnIngressSecret (machineserver/child_test.go).
func TestSessionChildTreatsItsSupervisorsIngressAsRemote(t *testing.T) {
	const secret = "0123456789abcdef-test-ingress-secret"
	token := ingress.NewSecret()
	addr := startSessionChild(t, newProjectDir(t), secret, token)
	base := "http://" + addr

	resp, err := http.Get(base + "/") //nolint:gosec // the test's own loopback child
	if err != nil {
		t.Fatalf("GET index: %v", err)
	}
	page, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	m := apiTokenPattern.FindSubmatch(page)
	if m == nil {
		t.Fatalf("index.html carries no API token (status %d)", resp.StatusCode)
	}
	if served := string(m[1]); served != token {
		t.Fatalf("the child serves API token %q, want %q, the one its spawner minted", served, token)
	}

	putUIPrefs := func(ingressHeader string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPut, base+"/api/session/ui-prefs", strings.NewReader(`{"ui":{"juggler-column-width":"31.5"}}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Juggler-Token", token)
		if ingressHeader != "" {
			req.Header.Set(ingress.Header, ingressHeader)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("PUT ui-prefs: %v", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}
	for _, c := range []struct {
		name, header string
		want         int
	}{
		{"no ingress header", "", http.StatusOK},
		{"a forged ingress header", "not-the-secret", http.StatusOK},
		{"the supervisor's ingress header", secret, http.StatusForbidden},
	} {
		if code, body := putUIPrefs(c.header); code != c.want {
			t.Errorf("PUT ui-prefs with %s: status %d (%s), want %d", c.name, code, strings.TrimSpace(body), c.want)
		}
	}

	// The engine slot, asked for with the session's own token so that only
	// where the request came from can be what refuses it.
	header := http.Header{"Origin": []string{base}, ingress.Header: []string{secret}}
	conn, resp, err := websocket.DefaultDialer.Dial("ws://"+addr+apipaths.WebSocket+"?role=engine&token="+url.QueryEscape(token), header)
	assertEngineSlotRefused(t, conn, resp, err, "a caller the supervisor vouched for as remote")
}

// TestMachineServerRefusesRebindingHost plays a DNS-rebinding page against a
// real machine server: its own domain pointed at the server's address, so it
// sends that domain as Host and as its Origin. The control API, a session's
// page (which carries the child's API token) and the session's WebSocket must
// all refuse it, while the same requests naming the server by its address work.
func TestMachineServerRefusesRebindingHost(t *testing.T) {
	ms, stop := startMachineServer(t)
	defer stop()
	sess := ms.openSession(newProjectDir(t), http.StatusCreated)
	prefix := "/s/" + sess.ID

	get := func(path, host string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, ms.url(path), nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Host = host
		req.Header.Set("Origin", "http://"+host)
		// The token too, so only the Host can be what refuses the rebound page.
		req.Header.Set(machineserver.TokenHeader, ms.Token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(body)
	}

	const rebound = "attacker.example:8080"
	for _, p := range []string{"/api/server/sessions", prefix + "/"} {
		code, body := get(p, rebound)
		if code != http.StatusForbidden {
			t.Errorf("GET %s with Host %s: status %d, want 403", p, rebound, code)
		}
		if apiTokenPattern.MatchString(body) {
			t.Errorf("GET %s with Host %s handed out the session's API token", p, rebound)
		}
		if code, _ := get(p, ms.Addr); code != http.StatusOK {
			t.Errorf("GET %s with Host %s: status %d, want 200", p, ms.Addr, code)
		}
	}

	dialer := websocket.Dialer{
		NetDial: func(network, _ string) (net.Conn, error) { return net.Dial(network, ms.Addr) },
	}
	header := http.Header{"Origin": []string{"http://" + rebound}}
	conn, resp, err := dialer.Dial("ws://"+rebound+prefix+apipaths.WebSocket+"?role=viewer", header)
	if conn != nil {
		_ = conn.Close()
	}
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Errorf("WebSocket upgrade with Host %s: err %v, status %d; want refused with 403", rebound, err, status)
	}
}

// TestMachineServerControlAPIRequiresToken checks a real machine server's
// control API against a caller on loopback: without the token from server.json,
// or with another, it lists nothing and shuts nothing down; with it, both work.
func TestMachineServerControlAPIRequiresToken(t *testing.T) {
	ms, stop := startMachineServer(t)
	defer stop()
	if ms.Token == "" {
		t.Fatal("server.json carries no control-API token")
	}

	call := func(method, path, token string) int {
		t.Helper()
		req, err := http.NewRequest(method, ms.url(path), nil)
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set(machineserver.TokenHeader, token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}

	for _, token := range []string{"", "not-the-token"} {
		for _, c := range []struct{ method, path string }{
			{http.MethodGet, "/api/server/sessions"},
			{http.MethodPost, "/api/server/shutdown"},
		} {
			if code := call(c.method, c.path, token); code != http.StatusUnauthorized {
				t.Errorf("%s %s with token %q: status %d, want 401", c.method, c.path, token, code)
			}
		}
	}
	if code := call(http.MethodGet, "/api/server/sessions", ms.Token); code != http.StatusOK {
		t.Errorf("GET /api/server/sessions with the token: status %d, want 200", code)
	}
	select {
	case <-ms.exited:
		t.Fatal("an unauthorised shutdown request stopped the machine server")
	default:
	}
}

// TestMachineServerChildListensOnLoopbackOnly checks a spawned child from the
// outside: its port answers on loopback and refuses every other address this
// machine has, so nothing off the machine can bypass the proxy.
func TestMachineServerChildListensOnLoopbackOnly(t *testing.T) {
	ms, stop := startMachineServer(t)
	defer stop()

	sess := ms.openSession(newProjectDir(t), http.StatusCreated)
	_, port, err := net.SplitHostPort(sess.Addr)
	if err != nil {
		t.Fatalf("session addr %q: %v", sess.Addr, err)
	}

	if !dialable(net.JoinHostPort("127.0.0.1", port)) {
		t.Fatalf("child port %s refuses loopback", port)
	}

	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatalf("interface addresses: %v", err)
	}
	var probed []string
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok || ipnet.IP.IsLoopback() || ipnet.IP.IsLinkLocalUnicast() {
			continue
		}
		target := net.JoinHostPort(ipnet.IP.String(), port)
		probed = append(probed, target)
		if dialable(target) {
			t.Errorf("child port %s accepts connections on non-loopback %s", port, target)
		}
	}
	if len(probed) == 0 {
		t.Skip("this machine has no non-loopback address to probe")
	}
	t.Logf("refused on %s", strings.Join(probed, ", "))
}

// assertEngineSlotRefused fails unless an engine-role dial was refused: with a
// status in place of the upgrade, or, if upgraded, closed before the session
// frame an admitted engine is greeted with.
func assertEngineSlotRefused(t *testing.T, conn *websocket.Conn, resp *http.Response, err error, who string) {
	t.Helper()
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		if resp == nil {
			t.Fatalf("engine WebSocket dial: %v", err)
		}
		return
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, msg, err := conn.ReadMessage(); err == nil {
		t.Fatalf("%s took the engine slot; first frame %s", who, msg)
	}
}
