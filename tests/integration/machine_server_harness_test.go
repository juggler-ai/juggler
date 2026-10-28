//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"
	"juggler/internal/ingress"
	"juggler/internal/srcroot"
	"juggler/tests/helpers"
)

// machineServerStartTimeout bounds how long `juggler serve` may take to print
// its address. It binds before it does anything else, so this is generous.
const machineServerStartTimeout = 30 * time.Second

// machineServerStopTimeout bounds a graceful shutdown: the server stops its
// children concurrently, each allowed an interrupt grace then a kill grace.
const machineServerStopTimeout = 20 * time.Second

// sessionOpenTimeout bounds POST /api/server/sessions, which blocks until the
// child reports its address (the machine server's own spawn timeout is 20s).
const sessionOpenTimeout = 60 * time.Second

// webviewReleaseTimeout bounds the wait for Windows to release a run's
// temporary directory. A killed child's WebView2 runtime processes are not its
// children and exit on their own once they notice it is gone, holding files in
// its user data folder (home\.juggler\cache\webview2) until they do — longer,
// on a busy runner, than the ~2s testing's TempDir removal retries for.
const webviewReleaseTimeout = 30 * time.Second

// removeOnceReleased removes dir, retrying while something still holds a file
// in it, for up to timeout. A dir still held then is left for TempDir's own
// removal to report.
func removeOnceReleased(dir string, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for os.RemoveAll(dir) != nil && time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
	}
}

// machineServer is one `juggler serve` process run by a test, isolated under
// its own temporary HOME so its server.lock and server.json never meet the
// developer's, another test's, or a real machine server's.
type machineServer struct {
	t         *testing.T
	Addr      string      // host:port from the JUGGLER_ADDR= line
	Home      string      // the temporary HOME it and its children run under
	ConfigDir string      // where it keeps server.lock and server.json, under Home
	Logs      string      // JUGGLER_LOG_DIR for it and its children
	Token     string      // the control-API token, read from server.json as a client would
	iso       isolatedRun // the binary and environment it runs under, for CLI clients of it
	cmd       *exec.Cmd
	exited    chan struct{} // closed once the process has been reaped
	stderr    string        // path of the captured stderr

	// Every child pid seen → its address, for the leak check. Touched only
	// from the test's own goroutine.
	children map[int]string
}

// configDirUnder is the config dir a server run under the harness environment
// resolves for itself: JUGGLER_CONFIG_DIR and XDG_CONFIG_HOME are blanked, so
// it is ~/.juggler on macOS and Windows and the XDG default ~/.config/juggler
// everywhere else. Spelled out here rather than asked of userpaths, which reads
// the test process's environment, not the server's.
func configDirUnder(home string) string {
	switch runtime.GOOS {
	case "darwin", "windows":
		return filepath.Join(home, ".juggler")
	default:
		return filepath.Join(home, ".config", "juggler")
	}
}

// startMachineServer runs `juggler serve --port 0` from the suite's server
// binary under a fresh temporary HOME and returns once it has printed its
// address, with the cleanup that stops it. The cleanup asks for a graceful
// shutdown through the control API, falls back to killing the process, and
// fails the test if any session child it saw is still serving afterwards.
//
// Children are spawned from the machine server's own executable, as in
// production: JUGGLER_SERVER_BIN is cleared rather than set, so the harness
// runs the same path a shipped `juggler serve` does. They inherit the
// temporary HOME and log dir. serveArgs are appended to the serve command
// line; without `--test` among them the children run as production children
// and enforce the per-instance API token.
func startMachineServer(t *testing.T, serveArgs ...string) (*machineServer, func()) {
	t.Helper()
	iso := newIsolatedRun(t)

	cmd := exec.Command(iso.binary, append([]string{"serve", "--port", "0"}, serveArgs...)...)
	cmd.Env = iso.env
	helpers.SetProcGroupAttr(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	stderrPath := filepath.Join(iso.base, "serve-stderr.log")
	stderrFile, err := os.Create(stderrPath)
	if err != nil {
		t.Fatalf("stderr file: %v", err)
	}
	cmd.Stderr = stderrFile
	if err := cmd.Start(); err != nil {
		_ = stderrFile.Close()
		t.Fatalf("start %s serve: %v", iso.binary, err)
	}
	_ = stderrFile.Close()

	ms := &machineServer{
		t: t, Home: iso.home, ConfigDir: configDirUnder(iso.home), Logs: iso.logs, iso: iso, cmd: cmd,
		exited: make(chan struct{}), stderr: stderrPath,
		children: map[int]string{},
	}

	// Scan for the handshake, then keep draining so the server never blocks
	// on a full pipe. Wait runs only after the scanner reaches EOF.
	addrCh := make(chan string, 1)
	scanned := make(chan struct{})
	go func() {
		defer close(scanned)
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if after, ok := strings.CutPrefix(sc.Text(), "JUGGLER_ADDR="); ok {
				select {
				case addrCh <- strings.TrimSpace(after):
				default:
				}
			}
		}
	}()
	go func() {
		<-scanned
		_ = cmd.Wait()
		close(ms.exited)
	}()

	var once sync.Once
	stop := func() { once.Do(ms.stop) }

	select {
	case ms.Addr = <-addrCh:
		// server.json is written, token and all, before the server listens,
		// so it is complete by the time the address is printed.
		ms.Token = ms.readServerInfo().Token
	case <-ms.exited:
		t.Fatalf("machine server exited before printing its address:\n%s", ms.stderrText())
	case <-time.After(machineServerStartTimeout):
		stop()
		t.Fatalf("machine server did not print its address within %s:\n%s", machineServerStartTimeout, ms.stderrText())
	}
	return ms, stop
}

// isolatedRun is what the harness runs a juggler process under: the suite's
// server binary and an environment rooted at a fresh temporary HOME.
type isolatedRun struct {
	binary string
	env    []string
	base   string // the temporary directory everything below lives in
	home   string // HOME (and USERPROFILE)
	logs   string // JUGGLER_LOG_DIR
}

// newIsolatedRun prepares an isolatedRun, skipping the test in -short mode
// since every caller spawns the binary. Its environment is the test's own with
// HOME moved, the config/cache/state/data overrides blanked, a log dir of its
// own and an empty skills dir, so nothing it does meets the developer's files,
// another test's, or a real machine server's.
func newIsolatedRun(t *testing.T) isolatedRun {
	t.Helper()
	if testing.Short() {
		t.Skip("spawns the juggler binary; skipped in -short mode")
	}
	root, err := srcroot.Find(".")
	if err != nil {
		t.Fatalf("find project root: %v", err)
	}
	binary := helpers.ServerBinary(root)
	if _, err := os.Stat(binary); err != nil {
		t.Fatalf("server binary not built at %s: %v", binary, err)
	}

	base := t.TempDir()
	if runtime.GOOS == "windows" {
		// Registered after TempDir, so it runs before TempDir's own removal.
		t.Cleanup(func() { removeOnceReleased(base, webviewReleaseTimeout) })
	}
	home := filepath.Join(base, "home")
	logs := filepath.Join(base, "logs")
	skills := filepath.Join(base, "skills")
	for _, d := range []string{home, logs, skills} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}

	env := os.Environ()
	for k, v := range map[string]string{
		"HOME":        home,
		"USERPROFILE": home,
		// Empty values are ignored by the resolvers, so these fall back to
		// paths under HOME instead of an ambient override.
		"JUGGLER_CONFIG_DIR": "",
		"XDG_CONFIG_HOME":    "",
		"XDG_CACHE_HOME":     "",
		"XDG_STATE_HOME":     "",
		"XDG_DATA_HOME":      "",
		"JUGGLER_SERVER_BIN": "",
		"JUGGLER_LOG_DIR":    logs,
		// An empty skills dir, so a user's skills never reach a child.
		"JUGGLER_SKILLS_USER_DIR": skills,
	} {
		env = helpers.EnvWithOverride(env, k, v)
	}
	return isolatedRun{binary: binary, env: env, base: base, home: home, logs: logs}
}

// startSessionChild runs one session child for project directly, spawned as
// the machine server spawns it (--session-child, an ephemeral loopback port,
// the ingress secret in its environment) but with a secret the test chose, so
// the test can stand in for the supervisor. It returns the child's address
// once printed; the child is killed, with its process group, when the test
// ends.
func startSessionChild(t *testing.T, project, ingressSecret string) string {
	t.Helper()
	iso := newIsolatedRun(t)
	return startServerProcess(t, iso, helpers.EnvWithOverride(iso.env, ingress.SecretEnv, ingressSecret),
		"--session-child", "--port", "0", "--project", project)
}

// startStandaloneServer runs a per-project server for project in its own
// process (--standalone; no --session-child, no --test, so the API token and
// every production gate are in force), on an ephemeral port with no window,
// with extraArgs after the rest. It returns the server's address once printed;
// the server is killed, with its process group, when the test ends.
func startStandaloneServer(t *testing.T, project string, extraArgs ...string) string {
	t.Helper()
	iso := newIsolatedRun(t)
	args := append([]string{"--standalone", "--port", "0", "--window=false", "--project", project}, extraArgs...)
	return startServerProcess(t, iso, iso.env, args...)
}

// startServerProcess runs the suite's binary with args under env, returns the
// address from its JUGGLER_ADDR= line, and kills its process group when the
// test ends.
func startServerProcess(t *testing.T, iso isolatedRun, env []string, args ...string) string {
	t.Helper()
	cmd := exec.Command(iso.binary, args...) //nolint:gosec // the suite's own binary
	cmd.Env = env
	helpers.SetProcGroupAttr(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	stderrPath := filepath.Join(iso.base, "server-stderr.log")
	stderrFile, err := os.Create(stderrPath)
	if err != nil {
		t.Fatalf("stderr file: %v", err)
	}
	cmd.Stderr = stderrFile
	if err := cmd.Start(); err != nil {
		_ = stderrFile.Close()
		t.Fatalf("start %s %s: %v", iso.binary, strings.Join(args, " "), err)
	}
	_ = stderrFile.Close()

	addrCh := make(chan string, 1)
	exited := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if after, ok := strings.CutPrefix(sc.Text(), "JUGGLER_ADDR="); ok {
				select {
				case addrCh <- strings.TrimSpace(after):
				default:
				}
			}
		}
		_ = cmd.Wait()
		close(exited)
	}()
	t.Cleanup(func() {
		helpers.SignalGroup(cmd, syscall.SIGKILL)
		<-exited
	})

	select {
	case addr := <-addrCh:
		return addr
	case <-exited:
		b, _ := os.ReadFile(stderrPath)
		t.Fatalf("%s exited before printing its address:\n%s", strings.Join(args, " "), b)
	case <-time.After(sessionOpenTimeout):
		t.Fatalf("%s did not print its address within %s", strings.Join(args, " "), sessionOpenTimeout)
	}
	return ""
}

// stop shuts the machine server down and checks it took its children with it.
func (ms *machineServer) stop() {
	t := ms.t
	// Record whatever is live now, so the leak check covers children the test
	// never looked at.
	if sessions, err := ms.listSessions(); err == nil {
		for _, s := range sessions {
			ms.noteChild(s)
		}
	}

	if resp, err := ms.do(http.MethodPost, "/api/server/shutdown", nil); err == nil {
		_ = resp.Body.Close()
	}
	select {
	case <-ms.exited:
	case <-time.After(machineServerStopTimeout):
		t.Errorf("machine server did not exit within %s of a shutdown request — killing it", machineServerStopTimeout)
		helpers.SignalGroup(ms.cmd, syscall.SIGKILL)
		<-ms.exited
	}

	for pid, addr := range ms.children {
		if addr != "" && dialable(addr) {
			t.Errorf("session child pid %d at %s is still serving after the machine server exited", pid, addr)
		}
		if p, err := os.FindProcess(pid); err == nil {
			_ = p.Kill()
		}
	}
	if t.Failed() {
		t.Logf("machine server stderr:\n%s", ms.stderrText())
	}
}

// cli runs the suite's binary as a client of this server — `juggler server …`
// or `juggler open …` — under the server's own environment, so it finds the
// server through the same server.json. It returns the exit code and output.
func (ms *machineServer) cli(args ...string) (code int, stdout, stderr string) {
	ms.t.Helper()
	cmd := exec.Command(ms.iso.binary, args...)
	cmd.Env = ms.iso.env
	var out, errOut strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	err := cmd.Run()
	var exitErr *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exitErr):
		code = exitErr.ExitCode()
	default:
		ms.t.Fatalf("run %s %v: %v", ms.iso.binary, args, err)
	}
	return code, out.String(), errOut.String()
}

// noteChild records a session's child for the leak check at stop.
func (ms *machineServer) noteChild(s machineserver.Session) {
	if s.PID == 0 {
		return
	}
	ms.children[s.PID] = s.Addr
}

func (ms *machineServer) stderrText() string {
	b, err := os.ReadFile(ms.stderr)
	if err != nil {
		return fmt.Sprintf("(unreadable: %v)", err)
	}
	return string(b)
}

// whereTheLaneStopped says how far a browser test queued in the session at
// prefix got, for a wait on its result that ran out: the child's queue audit
// (never dispatched means its window never asked for work — not loaded, or not
// running), the machine's load as the child reads it, and the tail of each
// session child's logs. Without them a timeout says only that nothing came back.
func (ms *machineServer) whereTheLaneStopped(prefix, name string) string {
	var b strings.Builder
	client := &http.Client{Timeout: 5 * time.Second}
	for _, path := range []string{prefix + "/api/test/audit?name=" + name, prefix + "/api/test/machine"} {
		resp, err := client.Get("http://" + ms.Addr + path)
		if err != nil {
			fmt.Fprintf(&b, "GET %s: %v\n", path, err)
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		resp.Body.Close()
		fmt.Fprintf(&b, "GET %s → %d: %s\n", path, resp.StatusCode, bytes.TrimSpace(body))
	}
	logs, _ := filepath.Glob(filepath.Join(ms.Logs, "*", "server*.log"))
	if len(logs) == 0 {
		fmt.Fprintf(&b, "no session child logs under %s\n", ms.Logs)
	}
	for _, path := range logs {
		data, err := os.ReadFile(path)
		if err != nil {
			fmt.Fprintf(&b, "%s: %v\n", path, err)
			continue
		}
		lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
		if len(lines) > 40 {
			lines = lines[len(lines)-40:]
		}
		fmt.Fprintf(&b, "── tail of %s ──\n%s\n", path, strings.Join(lines, "\n"))
	}
	return b.String()
}

// readServerInfo reads the server.json the machine server keeps under its
// temporary HOME.
func (ms *machineServer) readServerInfo() machineserver.ServerInfo {
	ms.t.Helper()
	b, err := os.ReadFile(filepath.Join(ms.ConfigDir, "server.json"))
	if err != nil {
		ms.t.Fatalf("read server.json: %v", err)
	}
	var info machineserver.ServerInfo
	if err := json.Unmarshal(b, &info); err != nil {
		ms.t.Fatalf("parse server.json %q: %v", b, err)
	}
	return info
}

// setDefaultModel stores ref as the explicit default model under the machine
// server's temporary HOME, so every conversation a session child creates from
// then on is seeded with it. Without one a child derives the default from the
// providers it finds installed, which a machine with none — a hosted CI runner —
// answers with no model at all, and a turn is then refused before it starts.
func (ms *machineServer) setDefaultModel(ref core.ModelRef) {
	ms.t.Helper()
	b, err := json.Marshal(ref)
	if err != nil {
		ms.t.Fatalf("marshal default model: %v", err)
	}
	if err := os.WriteFile(filepath.Join(ms.ConfigDir, "default-model.json"), b, 0o600); err != nil {
		ms.t.Fatalf("write default-model.json: %v", err)
	}
}

// url returns the machine server's URL for path.
func (ms *machineServer) url(path string) string {
	return "http://" + ms.Addr + path
}

// do sends one request to the machine server, JSON-encoding body when given.
func (ms *machineServer) do(method, path string, body any) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, ms.url(path), r)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	// Only the control API takes the machine server's token; a session's own
	// routes take its child's, which a test sets itself.
	if strings.HasPrefix(path, "/api/server/") {
		req.Header.Set(machineserver.TokenHeader, ms.Token)
	}
	client := &http.Client{
		Timeout: sessionOpenTimeout,
		// Redirects are part of what the proxy does; tests see them as sent.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return client.Do(req)
}

// openSession POSTs /api/server/sessions for project, requires wantStatus, and
// returns the session record.
func (ms *machineServer) openSession(project string, wantStatus int) machineserver.Session {
	ms.t.Helper()
	resp, err := ms.do(http.MethodPost, "/api/server/sessions", map[string]string{"project": project})
	if err != nil {
		ms.t.Fatalf("POST /api/server/sessions: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != wantStatus {
		ms.t.Fatalf("POST /api/server/sessions for %s: status %d, want %d; body %s", project, resp.StatusCode, wantStatus, body)
	}
	var s machineserver.Session
	if err := json.Unmarshal(body, &s); err != nil {
		ms.t.Fatalf("decode session %s: %v", body, err)
	}
	ms.noteChild(s)
	return s
}

// listSessions GETs /api/server/sessions.
func (ms *machineServer) listSessions() ([]machineserver.Session, error) {
	resp, err := ms.do(http.MethodGet, "/api/server/sessions", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET /api/server/sessions: status %d", resp.StatusCode)
	}
	var out []machineserver.Session
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// mustListSessions is listSessions that fails the test on error.
func (ms *machineServer) mustListSessions() []machineserver.Session {
	ms.t.Helper()
	out, err := ms.listSessions()
	if err != nil {
		ms.t.Fatalf("%v", err)
	}
	return out
}

// waitForSessionState polls the sessions list until id reaches state.
func (ms *machineServer) waitForSessionState(id string, state machineserver.SessionState, timeout time.Duration) machineserver.Session {
	ms.t.Helper()
	return ms.waitForSession(id, fmt.Sprintf("state %q", state), timeout,
		func(s machineserver.Session) bool { return s.State == state })
}

// waitForSession polls the sessions list until id's record satisfies ok;
// what names the condition in the failure.
func (ms *machineServer) waitForSession(id, what string, timeout time.Duration, ok func(machineserver.Session) bool) machineserver.Session {
	ms.t.Helper()
	deadline := time.Now().Add(timeout)
	var last []machineserver.Session
	for {
		last = ms.mustListSessions()
		for _, s := range last {
			if s.ID == id && ok(s) {
				return s
			}
		}
		if time.Now().After(deadline) {
			ms.t.Fatalf("session %s did not become %s within %s; sessions: %+v", id, what, timeout, last)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// newProjectDir returns a fresh project folder with symlinks resolved, so the
// path a test sends is the path the child reports back (macOS temp dirs sit
// under a /var → /private/var link).
func newProjectDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolve temp dir: %v", err)
	}
	return dir
}

// dialable reports whether something accepts TCP connections at addr.
func dialable(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}
