//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

// outBuf is a writer the test reads while other goroutines write to it. Each
// write goes down a channel; text, called only from the test's goroutine,
// gathers what has arrived.
type outBuf struct {
	ch  chan string
	got strings.Builder
}

func newOutBuf() *outBuf { return &outBuf{ch: make(chan string, 1024)} }

func (b *outBuf) Write(p []byte) (int, error) {
	b.ch <- string(p)
	return len(p), nil
}

// text is everything written so far.
func (b *outBuf) text() string {
	for {
		select {
		case s := <-b.ch:
			b.got.WriteString(s)
		default:
			return b.got.String()
		}
	}
}

// useStandInChildren makes every session child this process spawns the
// stand-in (TestHelperSessionChild), until the test ends.
func useStandInChildren(t *testing.T) {
	t.Helper()
	t.Setenv("JUGGLER_LOG_DIR", t.TempDir())
	orig := newChildCommand
	newChildCommand = func(string, string, []string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperSessionChild$") //nolint:gosec // this test binary
		cmd.Env = append(os.Environ(), helperChildEnv+"=1")
		return cmd
	}
	t.Cleanup(func() { newChildCommand = orig })
}

// projectDir makes a project folder named name under dir.
func projectDir(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.Mkdir(p, 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// servedHere hands the test the Server a RunTerminal in this process serves,
// once it is serving (serveListening).
func servedHere(t *testing.T) <-chan *Server {
	t.Helper()
	got := make(chan *Server, 1)
	orig := serveListening
	serveListening = func(s *Server) { got <- s }
	t.Cleanup(func() { serveListening = orig })
	return got
}

// terminalRun is a bare juggler (RunTerminal) running in this process, driven
// by the test: it reads what it prints, and stops it as Ctrl-C would.
type terminalRun struct {
	out, errOut *outBuf
	sig         chan os.Signal
	ready       chan string
	code        chan int
}

// runTerminal starts RunTerminal with opts, its output, signals and Ready
// supplied by the test. One still running when the test ends is interrupted
// and waited for.
func runTerminal(t *testing.T, opts TerminalOptions) *terminalRun {
	t.Helper()
	r := &terminalRun{out: newOutBuf(), errOut: newOutBuf(), sig: make(chan os.Signal, 4),
		ready: make(chan string, 1), code: make(chan int, 1)}
	opts.Stdout, opts.Stderr, opts.Signals = r.out, r.errOut, r.sig
	opts.Ready = func(url string) { r.ready <- url }
	go func() { r.code <- RunTerminal(opts) }()
	t.Cleanup(func() {
		select {
		case <-r.code:
		default:
			r.sig <- os.Interrupt
			<-r.code
		}
	})
	return r
}

// waitReady returns the URL the run is ready at, failing if it exits first.
func (r *terminalRun) waitReady(t *testing.T) string {
	t.Helper()
	select {
	case url := <-r.ready:
		return url
	case code := <-r.code:
		r.code <- code
		t.Fatalf("bare juggler exited %d before it was ready; stdout %q, stderr %q", code, r.out.text(), r.errOut.text())
	}
	return ""
}

// interrupt sends the run a Ctrl-C and returns its exit code.
func (r *terminalRun) interrupt() int {
	r.sig <- os.Interrupt
	return r.wait()
}

// wait returns the run's exit code once it has exited.
func (r *terminalRun) wait() int {
	code := <-r.code
	r.code <- code
	return code
}

// statusOf is the status of the server c reaches.
func statusOf(t *testing.T, c *Client) statusResponse {
	t.Helper()
	var st statusResponse
	if err := c.do(http.MethodGet, "/status", nil, &st); err != nil {
		t.Fatalf("status: %v", err)
	}
	return st
}

// sessionsOf is the sessions of the server c reaches.
func sessionsOf(t *testing.T, c *Client) []Session {
	t.Helper()
	var list []Session
	if err := c.do(http.MethodGet, "/sessions", nil, &list); err != nil {
		t.Fatalf("sessions: %v", err)
	}
	return list
}

// waitStatusAttached returns once the server c reaches counts n attached
// clients. A detach is counted when the server notices the client has gone,
// which the client's own exit does not wait for.
func waitStatusAttached(t *testing.T, c *Client, n int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		st := statusOf(t, c)
		if st.Attached == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d clients attached, want %d", st.Attached, n)
		}
		time.Sleep(time.Millisecond)
	}
}

// TestBareJugglerWithNoServerServesInItsForeground: with no server running,
// bare juggler is the server — implicit, holding itself attached so it never
// exits idle under its own terminal — and opens a session for its project. A
// Ctrl-C with only that session open stops the server, which lets the lock go.
func TestBareJugglerWithNoServerServesInItsForeground(t *testing.T) {
	home := userpathstest.Isolate(t)
	useStandInChildren(t)
	proj := projectDir(t, home, "proj")
	served := servedHere(t)

	run := runTerminal(t, TerminalOptions{Project: proj})
	url := run.waitReady(t)
	s := <-served
	if !s.implicit || s.attached.Load() != 1 || !s.heldUp() {
		t.Fatalf("foreground server: implicit %v, %d attached, held up %v; want implicit, itself attached, held up",
			s.implicit, s.attached.Load(), s.heldUp())
	}
	list := s.reg.snapshot()
	if len(list) != 1 || list[0].Project != proj || list[0].State != SessionRunning {
		t.Fatalf("sessions = %+v, want one running for %s", list, proj)
	}
	if want := "http://" + s.addr + "/s/" + list[0].ID + "/"; url != want {
		t.Fatalf("ready at %s, want %s", url, want)
	}
	out := run.out.text()
	for _, want := range []string{
		"Started the Juggler server at http://" + s.addr + "/",
		"Session for " + proj + ": " + url,
		"Ctrl-C stops the server and every session on it.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout %q, want it to say %q", out, want)
		}
	}

	if code := run.interrupt(); code != 0 {
		t.Fatalf("Ctrl-C: exit %d, want 0; stderr %q", code, run.errOut.text())
	}
	if out := run.out.text(); !strings.Contains(out, "Stopping the Juggler server.") || strings.Contains(out, "other") {
		t.Errorf("stdout %q, want a plain stop with no other sessions named", out)
	}
	lock := NewMachineLock(userpaths.ConfigDir())
	if (lock.probe() == lockHeld) || lock.readInfo() != nil || len(s.reg.snapshot()) != 0 {
		t.Fatalf("after Ctrl-C: lock held %v, server.json %+v, sessions %+v; want none of them",
			(lock.probe() == lockHeld), lock.readInfo(), s.reg.snapshot())
	}
}

// TestCtrlCOnAForegroundServerNamesTheOtherSessions: the sessions another
// client opened go with the foreground server, and Ctrl-C says which.
func TestCtrlCOnAForegroundServerNamesTheOtherSessions(t *testing.T) {
	home := userpathstest.Isolate(t)
	useStandInChildren(t)
	proj, other := projectDir(t, home, "proj"), projectDir(t, home, "other")
	served := servedHere(t)

	run := runTerminal(t, TerminalOptions{Project: proj})
	run.waitReady(t)
	s := <-served
	c, err := Connect(ConnectOptions{})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if _, _, err := c.OpenSession(other); err != nil {
		t.Fatalf("open %s: %v", other, err)
	}

	if code := run.interrupt(); code != 0 {
		t.Fatalf("Ctrl-C: exit %d, want 0", code)
	}
	if out, want := run.out.text(), "Stopping the Juggler server and its 1 other session: "+other; !strings.Contains(out, want) {
		t.Errorf("stdout %q, want %q", out, want)
	}
	if left := s.reg.snapshot(); len(left) != 0 {
		t.Fatalf("sessions after Ctrl-C = %+v, want none", left)
	}
}

// startedServer starts a detached stand-in machine server and holds the test
// process attached, as a desktop app would.
func startedServer(t *testing.T) *Client {
	t.Helper()
	start, _ := helperStarter(t)
	c, err := Connect(ConnectOptions{Start: start})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	a, err := c.Attach()
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	t.Cleanup(a.Close)
	return c
}

// TestBareJugglerAttachesToTheRunningServer: with a server running, bare
// juggler attaches, counted as a client for as long as it runs, and opens its
// project's session there. Ctrl-C releases its hold without stopping another
// terminal viewing the same session.
func TestBareJugglerAttachesToTheRunningServer(t *testing.T) {
	home := userpathstest.Isolate(t)
	proj := projectDir(t, home, "proj")
	c := startedServer(t)

	run := runTerminal(t, TerminalOptions{Project: proj})
	url := run.waitReady(t)
	list := sessionsOf(t, c)
	if len(list) != 1 || list[0].Project != proj || url != c.SessionURL(list[0].ID) {
		t.Fatalf("sessions %+v, ready at %s; want one for %s at its URL", list, url, proj)
	}
	waitStatusAttached(t, c, 2)
	out := run.out.text()
	for _, want := range []string{
		"Using the Juggler server at http://" + c.Addr() + "/",
		"Session for " + proj + ": " + url,
		"Ctrl-C detaches from this session.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("stdout %q, want it to say %q", out, want)
		}
	}

	viewer := runTerminal(t, TerminalOptions{Project: proj})
	viewer.waitReady(t)
	if code := run.interrupt(); code != 0 {
		t.Fatalf("Ctrl-C: exit %d, want 0; stderr %q", code, run.errOut.text())
	}
	if !strings.Contains(run.out.text(), "Detached from the session for "+proj+".") {
		t.Errorf("stdout %q, want it to say the session was detached", run.out.text())
	}
	if left := sessionsOf(t, c); len(left) != 1 || left[0].ID != list[0].ID {
		t.Fatalf("sessions after Ctrl-C = %+v, want the other viewer's session", left)
	}
	waitStatusAttached(t, c, 2)
}

// TestBareJugglerLeavesASessionItDidNotOpen: an existing session's other
// viewer keeps its hold when bare juggler detaches.
func TestBareJugglerLeavesASessionItDidNotOpen(t *testing.T) {
	home := userpathstest.Isolate(t)
	proj := projectDir(t, home, "proj")
	c := startedServer(t)
	sess, opened, err := c.OpenSession(proj)
	if err != nil || !opened {
		t.Fatalf("first open: %+v, opened %v, %v; want a session this open spawned", sess, opened, err)
	}
	viewer, err := c.Attach(sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(viewer.Close)

	run := runTerminal(t, TerminalOptions{Project: proj})
	if url := run.waitReady(t); url != c.SessionURL(sess.ID) {
		t.Fatalf("ready at %s, want the open session's %s", url, c.SessionURL(sess.ID))
	}
	if !strings.Contains(run.out.text(), "Ctrl-C detaches from this session.") {
		t.Errorf("stdout %q, want it to say Ctrl-C leaves the session", run.out.text())
	}
	if code := run.interrupt(); code != 0 {
		t.Fatalf("Ctrl-C: exit %d, want 0", code)
	}
	if !strings.Contains(run.out.text(), "Detached from the session for "+proj+".") {
		t.Errorf("stdout %q, want it to say it left the session", run.out.text())
	}
	if list := sessionsOf(t, c); len(list) != 1 || list[0].ID != sess.ID {
		t.Fatalf("sessions after Ctrl-C = %+v, want %s still open", list, sess.ID)
	}
}

// TestBareJugglerSaysSoWhenItsServerStops: the server going away under an
// attached bare juggler — stopped by another client here — ends it, and it
// says why.
func TestBareJugglerSaysSoWhenItsServerStops(t *testing.T) {
	home := userpathstest.Isolate(t)
	proj := projectDir(t, home, "proj")
	c := startedServer(t)

	run := runTerminal(t, TerminalOptions{Project: proj})
	run.waitReady(t)
	if err := c.do(http.MethodPost, "/shutdown", nil, nil); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	if code := run.wait(); code != 0 {
		t.Fatalf("exit %d when the server stopped, want 0", code)
	}
	if want := "The Juggler server at http://" + c.Addr() + "/ has stopped."; !strings.Contains(run.out.text(), want) {
		t.Errorf("stdout %q, want %q", run.out.text(), want)
	}
}

// endedServer is a server whose lifetime has ended — one caught on its way
// out — and a client of it, at this binary's version.
func endedServer(t *testing.T) (*Server, *Client) {
	t.Helper()
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1)}
	front := httptest.NewServer(s.routes())
	t.Cleanup(front.Close)
	s.addr = front.Listener.Addr().String()
	s.endLifetime()
	return s, &Client{addr: s.addr, token: testToken, http: &http.Client{Timeout: 5 * time.Second}, Version: core.Version, Build: ownBuild()}
}

// TestBareJugglerConnectsAgainToAServerOnItsWayOut: a server found just as it
// exits refuses the open (503) or ends the attachment at once. Either means
// connect again, never fail, and nothing is printed for the server going.
func TestBareJugglerConnectsAgainToAServerOnItsWayOut(t *testing.T) {
	home := userpathstest.Isolate(t)
	proj := projectDir(t, home, "proj")
	for _, project := range []string{proj, ""} {
		_, c := endedServer(t)
		out, errOut := newOutBuf(), newOutBuf()
		code, again := attachTo(c, TerminalOptions{Project: project, Stdout: out, Stderr: errOut}, nil)
		if !again {
			t.Fatalf("project %q: exit %d, not connecting again; stdout %q, stderr %q", project, code, out.text(), errOut.text())
		}
		if strings.Contains(out.text(), "Using") || errOut.text() != "" {
			t.Fatalf("project %q: stdout %q, stderr %q; want nothing said about a server on its way out", project, out.text(), errOut.text())
		}
	}
}

// mismatchedServer is a server, its listener, and a client that found it
// answering as a build other than this binary's: version and build as given.
func mismatchedServer(t *testing.T, version, build string) (*Server, *httptest.Server, *Client) {
	t.Helper()
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1)}
	front := httptest.NewServer(s.routes())
	t.Cleanup(front.Close)
	s.addr = front.Listener.Addr().String()
	t.Cleanup(s.endLifetime)
	return s, front, &Client{addr: s.addr, token: testToken, http: &http.Client{Timeout: 5 * time.Second}, Version: version, Build: build}
}

// answers is a person at the terminal: each read runs the next step, which may
// change the world first, and answers with what it returns.
type answers []func() string

func (a *answers) Read(p []byte) (int, error) {
	if len(*a) == 0 {
		return 0, io.EOF
	}
	next := (*a)[0]
	*a = (*a)[1:]
	return copy(p, next()), nil
}

// say is a step that only answers line.
func say(line string) func() string { return func() string { return line } }

// TestBareJugglerNeverUsesAServerOfAnotherVersion: a mismatched server that a
// client started and nothing uses is replaced without asking
// (Occupancy.Idle). Any other is the user's: with nobody to ask it is refused
// with the way out and what a restart would stop; asked, a "no" refuses the
// same way, and a "yes" stops the server and connects again. Nothing is opened
// or attached to the mismatched server either way. Another build of this
// version — a rebuild from source — is mismatched as surely as another version.
func TestBareJugglerNeverUsesAServerOfAnotherVersion(t *testing.T) {
	home := userpathstest.Isolate(t)
	proj := projectDir(t, home, "proj")
	rebuilt := core.Version + " (built 2026-01-01 00:00:00)"
	for _, c := range []struct {
		name           string
		version, build string
		occupy         func(*Server)
		answer         string // "" is nobody at the terminal
		says           string
	}{
		{"started by hand, nobody to ask", "v0.0.0-other", "v0.0.0-other", func(*Server) {}, "", "juggler serve"},
		{"started by hand, asked, no", "v0.0.0-other", "v0.0.0-other", func(*Server) {}, "n\n", "juggler serve"},
		{"another build, a client attached, nobody to ask", core.Version, rebuilt, func(s *Server) { s.implicit = true; s.attach() }, "", "1 other app or terminal"},
		{"LAN on, nobody to ask", "v0.0.0-other", "v0.0.0-other", func(s *Server) { s.implicit = true; s.lan.Store(true) }, "", "LAN access"},
	} {
		t.Run(c.name, func(t *testing.T) {
			s, _, client := mismatchedServer(t, c.version, c.build)
			c.occupy(s)
			attached := s.attached.Load()
			out, errOut := newOutBuf(), newOutBuf()
			var in *bufio.Reader
			if c.answer != "" {
				in = bufio.NewReader(strings.NewReader(c.answer))
			}
			code, again := attachTo(client, TerminalOptions{Project: proj, Stdout: out, Stderr: errOut}, in)
			if code != 1 || again {
				t.Fatalf("exit %d, again %v; want 1, not again", code, again)
			}
			msg := errOut.text()
			for _, want := range []string{c.build, ownBuild(), "juggler server stop", c.says} {
				if !strings.Contains(msg, want) {
					t.Errorf("stderr %q, want it to say %q", msg, want)
				}
			}
			if s.attached.Load() != attached || len(s.reg.snapshot()) != 0 || len(s.shutdownReq) != 0 {
				t.Fatalf("%d attached, sessions %+v, shutdown asked %v; want nothing done to the server",
					s.attached.Load(), s.reg.snapshot(), len(s.shutdownReq) == 1)
			}
		})
	}
	t.Run("idle and client-started, nobody to ask", func(t *testing.T) {
		s, front, client := mismatchedServer(t, core.Version, rebuilt)
		s.implicit = true
		gone := closeOnShutdown(t, s, front)
		code, again := attachTo(client, TerminalOptions{Project: proj, Stdout: newOutBuf(), Stderr: newOutBuf()}, nil)
		if !again || code == restarted {
			t.Fatalf("exit %d, again %v; want to connect again, on an ordinary attempt", code, again)
		}
		<-gone
	})
	t.Run("asked, yes", func(t *testing.T) {
		s, front, client := mismatchedServer(t, "v0.0.0-other", "v0.0.0-other")
		gone := closeOnShutdown(t, s, front)
		out := newOutBuf()
		code, again := attachTo(client, TerminalOptions{Project: proj, Stdout: out, Stderr: newOutBuf()}, bufio.NewReader(strings.NewReader("y\n")))
		if !again || code != restarted {
			t.Fatalf("exit %d, again %v after a yes, want to connect again afresh", code, again)
		}
		<-gone
		for _, want := range []string{"juggler serve", "Restart it? [y/N]"} {
			if !strings.Contains(out.text(), want) {
				t.Errorf("stdout %q, want the restart offer saying %q", out.text(), want)
			}
		}
	})
	t.Run("asked, yes, after it gained a session", func(t *testing.T) {
		s, _, client := mismatchedServer(t, "v0.0.0-other", "v0.0.0-other")
		s.implicit = true
		s.reg.reserve("/work/alpha")
		in := &answers{
			func() string { s.reg.reserve("/work/late"); return "y\n" },
			say("n\n"),
		}
		out, errOut := newOutBuf(), newOutBuf()
		code, again := attachTo(client, TerminalOptions{Project: proj, Stdout: out, Stderr: errOut}, bufio.NewReader(in))
		if code != 1 || again {
			t.Fatalf("exit %d, again %v; want refused at the second no", code, again)
		}
		if len(s.shutdownReq) != 0 || len(s.reg.snapshot()) != 2 {
			t.Fatalf("shutdown asked %v, sessions %+v; want both sessions running", len(s.shutdownReq) == 1, s.reg.snapshot())
		}
		text := out.text()
		if strings.Count(text, "Restart it? [y/N]") != 2 || !strings.Contains(text, "/work/late") {
			t.Errorf("stdout %q, want asked again, naming the session that opened", text)
		}
	})
}

// closeOnShutdown closes front, as a server that has gone, once s has been
// asked to shut down, and returns a channel that closes after.
func closeOnShutdown(t *testing.T, s *Server, front *httptest.Server) <-chan struct{} {
	t.Helper()
	gone := make(chan struct{})
	go func() {
		select {
		case <-s.shutdownReq:
		case <-t.Context().Done():
			return
		}
		front.Close()
		close(gone)
	}()
	return gone
}

// TestTwoBareJugglersAtOnceShareOneServer: of two bare jugglers started
// together with no server running, one serves and the other attaches to it.
func TestTwoBareJugglersAtOnceShareOneServer(t *testing.T) {
	home := userpathstest.Isolate(t)
	useStandInChildren(t)
	a := runTerminal(t, TerminalOptions{Project: projectDir(t, home, "a")})
	b := runTerminal(t, TerminalOptions{Project: projectDir(t, home, "b")})
	a.waitReady(t)
	b.waitReady(t)
	server, user := a, b
	if strings.Contains(b.out.text(), "Started the Juggler server") {
		server, user = b, a
	}
	if !strings.Contains(server.out.text(), "Started the Juggler server") || !strings.Contains(user.out.text(), "Using the Juggler server") {
		t.Fatalf("stdout %q and %q: want one to start the server and the other to use it", a.out.text(), b.out.text())
	}
	if code := user.interrupt(); code != 0 {
		t.Fatalf("Ctrl-C on the one attached: exit %d", code)
	}
	if code := server.interrupt(); code != 0 {
		t.Fatalf("Ctrl-C on the one serving: exit %d", code)
	}
}

// A terminal transfers its initial server hold to its session without a
// last-client gap. A running turn remains when only that session hold leaves.
func TestTerminalTransfersHoldAndDetachesWithoutStoppingBusySession(t *testing.T) {
	home := userpathstest.Isolate(t)
	proj := projectDir(t, home, "proj")
	s := &Server{reg: newRegistry(), token: testToken, implicit: true, shutdownReq: make(chan struct{}, 1)}
	sess, _ := s.reg.reserve(proj)
	child := &child{addr: "127.0.0.1:1", exited: make(chan struct{})}
	s.reg.setRunning(sess.ID, child, 1)
	s.reg.setActivity(sess.ID, child, true, time.Now())
	named := make(chan string, 1)
	routes := s.routes()
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == `/api/server/attach` {
			var req struct {
				PID     int    `json:"pid"`
				Session string `json:"session"`
			}
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
				return
			}
			if err := json.Unmarshal(body, &req); err != nil {
				t.Error(err)
				return
			}
			r.Body = io.NopCloser(strings.NewReader(string(body)))
			if req.Session != "" {
				named <- req.Session
			}
		}
		routes.ServeHTTP(w, r)
	}))
	t.Cleanup(front.Close)
	t.Cleanup(s.endLifetime)
	c := &Client{addr: front.Listener.Addr().String(), token: testToken, Build: ownBuild(), Implicit: true,
		http: &http.Client{Timeout: 5 * time.Second}}
	sig := make(chan os.Signal, 1)
	ready := make(chan string, 1)
	done := make(chan int, 1)
	go func() {
		code, _ := attachTo(c, TerminalOptions{Project: proj, Stdout: newOutBuf(), Stderr: newOutBuf(), Signals: sig, Ready: func(url string) { ready <- url }}, nil)
		done <- code
	}()
	t.Cleanup(func() {
		select {
		case sig <- os.Interrupt:
		default:
		}
		<-done
	})
	select {
	case <-ready:
	case code := <-done:
		done <- code
		t.Fatalf("terminal exited %d before ready", code)
	}
	list := s.reg.snapshot()
	if len(list) != 1 {
		t.Fatalf("sessions %+v, want one", list)
	}
	select {
	case id := <-named:
		if id != list[0].ID {
			t.Fatalf("named attachment %s, want %s", id, list[0].ID)
		}
	default:
		t.Error("terminal did not acquire a named session attachment")
	}
	waitAttached(t, s, 1)
	if len(s.shutdownReq) != 0 {
		t.Error("attachment transfer requested last-client shutdown")
	}
	detach := s.attach() // another server client, not another session viewer
	defer detach()
	sig <- os.Interrupt
	code := <-done
	done <- code
	if code != 0 {
		t.Fatalf("terminal exited %d", code)
	}
	waitAttached(t, s, 1)
	if sess, ok := s.reg.get(list[0].ID); !ok || sess.State != SessionRunning || !sess.Busy {
		t.Fatalf("busy session after terminal detach: %+v, present %v", sess, ok)
	}
	if len(s.shutdownReq) != 0 {
		t.Fatal("terminal detach stopped server with another client")
	}
}

// The open hands its hold to Serve instead of releasing it when Ready returns.
func TestForegroundOpenReturnsViewerHoldToServe(t *testing.T) {
	s := &Server{reg: newRegistry(), addr: "127.0.0.1:1"}
	t.Cleanup(s.endLifetime)
	sess, _ := s.reg.reserve("/project")
	s.reg.setRunning(sess.ID, &child{addr: "127.0.0.1:2"}, 1)
	ready := ""
	release, err := s.openForeground(&Foreground{Project: "/project", Out: io.Discard, Ready: func(url string) { ready = url }})
	if err != nil {
		t.Fatal(err)
	}
	if release == nil {
		t.Fatal("foreground open returned without a viewer hold for Serve")
	}
	defer release()
	if want := "http://" + s.addr + "/s/" + sess.ID + "/"; ready != want {
		t.Fatalf("ready at %q, want %q", ready, want)
	}
	noSession, err := s.openForeground(&Foreground{Out: io.Discard})
	if err != nil || noSession != nil {
		t.Fatal("project-less foreground acquired a session hold")
	}
}
