//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"juggler/internal/ingress"
)

// helperChildEnv marks a run of this test binary as a stand-in session child
// (see TestHelperSessionChild).
const helperChildEnv = "JUGGLER_MACHINESERVER_HELPER_CHILD"

// helperHangEnv, set to an address, makes the stand-in child hang in its
// handshake: it dials that address and then waits, never reporting its own.
// The test listening there knows from the connection that the child is inside
// spawnChild's handshake, and from the connection closing that it has died.
const helperHangEnv = "JUGGLER_MACHINESERVER_HELPER_HANG"

// TestHelperSessionChild is not a test: it is the session child that
// spawnHelperChildren execs, this test binary run again with helperChildEnv
// set. It does what a child must for spawnChild — prints JUGGLER_ADDR= once it
// is listening — and answers every request with the ingress secret its
// environment gave it and the ingress header the request carried. GET
// /exit/<code> makes it answer, then exit with that code, as a crash (non-zero)
// or a deliberate shutdown (0) would. With helperHangEnv set it never gets as
// far as listening.
func TestHelperSessionChild(t *testing.T) {
	if os.Getenv(helperChildEnv) != "1" {
		t.Skip("run only as the stand-in session child")
	}
	if addr := os.Getenv(helperHangEnv); addr != "" {
		conn, err := net.Dial("tcp", addr) //nolint:gosec // the test's own loopback listener
		if err != nil {
			os.Exit(1)
		}
		time.Sleep(time.Hour)
		_ = conn.Close()
		os.Exit(0)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		os.Exit(1)
	}
	fmt.Printf("JUGGLER_ADDR=%s\n", ln.Addr())
	_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if code, ok := strings.CutPrefix(r.URL.Path, "/exit/"); ok {
			n, _ := strconv.Atoi(code)
			w.WriteHeader(http.StatusAccepted)
			w.(http.Flusher).Flush()
			go func() {
				time.Sleep(20 * time.Millisecond)
				os.Exit(n)
			}()
			return
		}
		_ = json.NewEncoder(w).Encode(helperReport{
			EnvSecret:          os.Getenv(ingress.SecretEnv),
			EnvToken:           os.Getenv(ingress.TokenEnv),
			EnvSupervisorAddr:  os.Getenv(ingress.SupervisorAddrEnv),
			EnvSupervisorToken: os.Getenv(ingress.SupervisorTokenEnv),
			EnvSupervisorSess:  os.Getenv(ingress.SupervisorSessionEnv),
			Header:             r.Header.Get(ingress.Header),
			BundleID:           os.Getenv("__CFBundleIdentifier"),
			XPCJob:             os.Getenv("XPC_SERVICE_NAME"),
		})
	}))
	os.Exit(0)
}

// helperReport is what the stand-in child answers.
type helperReport struct {
	EnvSecret string `json:"envSecret"`
	EnvToken  string `json:"envToken"`
	Header    string `json:"header"`
	// EnvSupervisorAddr and EnvSupervisorToken are how the child was told to
	// reach its machine server's control API, if it was.
	EnvSupervisorAddr  string `json:"envSupervisorAddr"`
	EnvSupervisorToken string `json:"envSupervisorToken"`
	// EnvSupervisorSess is the child's session id at its machine server.
	EnvSupervisorSess string `json:"envSupervisorSess"`
	// BundleID and XPCJob are the launch identity the child inherited, if
	// any (see launchIdentityEnv).
	BundleID string `json:"bundleId"`
	XPCJob   string `json:"xpcJob"`
}

// spawnHelperChildren spawns n stand-in session children through spawnChild,
// stopped when the test ends.
func spawnHelperChildren(t *testing.T, n int) []*child {
	t.Helper()
	return spawnHelperChildrenWith(t, n, nil)
}

// spawnHelperChildrenWith is spawnHelperChildren with env passed to spawnChild
// as the supervisor's own additions to each child's environment.
func spawnHelperChildrenWith(t *testing.T, n int, env []string) []*child {
	t.Helper()
	t.Setenv("JUGGLER_LOG_DIR", t.TempDir())
	// An ingress secret in the supervisor's own environment must not reach a
	// child in place of the one spawnChild mints for it.
	t.Setenv(ingress.SecretEnv, "the-supervisor-s-own")
	t.Setenv(ingress.TokenEnv, "the-supervisor-s-own")
	// Nor may a control link the supervisor inherited from a supervisor of
	// its own.
	t.Setenv(ingress.SupervisorAddrEnv, "127.0.0.1:1")
	t.Setenv(ingress.SupervisorTokenEnv, "the-supervisor-s-own")
	t.Setenv(ingress.SupervisorSessionEnv, "the-supervisor-s-own")
	// Nor may the launch identity of the app that started the supervisor.
	t.Setenv("__CFBundleIdentifier", "studio.juggler.juggler")
	t.Setenv("XPC_SERVICE_NAME", "application.studio.juggler.juggler.1.2")
	orig := newChildCommand
	newChildCommand = func(string, string, []string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperSessionChild$") //nolint:gosec // this test binary
		cmd.Env = append(os.Environ(), helperChildEnv+"=1")
		return cmd
	}
	t.Cleanup(func() { newChildCommand = orig })

	out := make([]*child, n)
	for i := range out {
		c, err := spawnChild(context.Background(), "unused", t.TempDir(), nil, env)
		if err != nil {
			t.Fatalf("spawn stand-in child: %v", err)
		}
		t.Cleanup(c.stop)
		out[i] = c
	}
	return out
}

// fetchReport GETs url and decodes the stand-in child's report.
func fetchReport(t *testing.T, url string) helperReport {
	t.Helper()
	code, body := get(t, url)
	if code != http.StatusOK {
		t.Fatalf("GET %s: status %d: %s", url, code, body)
	}
	var rep helperReport
	if err := json.Unmarshal([]byte(body), &rep); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	return rep
}

// TestASpawnedChildDoesNotInheritAnAppsLaunchIdentity: macOS gives a launched
// app its bundle identifier and launchd job in its environment, and a server
// the desktop app starts inherits them. A child runs AppKit (the engine
// WebView), so one carrying them checks in with LaunchServices as the app —
// and opening the app then brings the child forward instead of launching it.
// A child is spawned without them.
func TestASpawnedChildDoesNotInheritAnAppsLaunchIdentity(t *testing.T) {
	c := spawnHelperChildren(t, 1)[0]
	if rep := fetchReport(t, "http://"+c.addr+"/"); rep.BundleID != "" || rep.XPCJob != "" {
		t.Fatalf("child inherited bundle id %q and launchd job %q; want neither", rep.BundleID, rep.XPCJob)
	}
}

// TestSpawnedChildGetsItsOwnIngressSecret runs the supervisor's whole half of
// caller identity against real processes: spawnChild hands each child a
// secret of its own in its environment, and a remote caller's request through
// the proxy reaches that child carrying exactly that secret.
func TestSpawnedChildGetsItsOwnIngressSecret(t *testing.T) {
	children := spawnHelperChildren(t, 2)

	first := fetchReport(t, "http://"+children[0].addr+"/")
	second := fetchReport(t, "http://"+children[1].addr+"/")
	if first.EnvSecret == "" || first.EnvSecret == second.EnvSecret || first.EnvSecret == "the-supervisor-s-own" {
		t.Fatalf("children were spawned with secrets %q and %q, want two fresh distinct ones", first.EnvSecret, second.EnvSecret)
	}
	if first.EnvSecret != children[0].ingressSecret {
		t.Fatalf("child's environment has %q, but the supervisor holds %q for it", first.EnvSecret, children[0].ingressSecret)
	}

	s := &Server{reg: newRegistry()}
	s.lan.Store(true)
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, children[0], children[0].cmd.Process.Pid)
	front := httptest.NewServer(asCaller("203.0.113.7:54321", s.routes()))
	defer front.Close()

	if got := fetchReport(t, front.URL+"/s/"+sess.ID+"/"); got.Header != first.EnvSecret {
		t.Fatalf("remote caller through the proxy: child saw %s %q, want its own secret %q", ingress.Header, got.Header, first.EnvSecret)
	}
}

// TestSpawnedChildGetsItsOwnAPIToken: whoever spawns a session child mints its
// API token and hands it over in the child's environment, so the spawner holds
// the credential for the child's API without asking the child for it. Each
// child gets a fresh one, and a token the spawner itself inherited never
// stands in for it.
func TestSpawnedChildGetsItsOwnAPIToken(t *testing.T) {
	children := spawnHelperChildren(t, 2)

	first := fetchReport(t, "http://"+children[0].addr+"/")
	second := fetchReport(t, "http://"+children[1].addr+"/")
	if first.EnvToken == "" || first.EnvToken == second.EnvToken || first.EnvToken == "the-supervisor-s-own" {
		t.Fatalf("children were spawned with tokens %q and %q, want two fresh distinct ones", first.EnvToken, second.EnvToken)
	}
	if first.EnvToken != children[0].apiToken {
		t.Fatalf("child's environment has token %q, but its spawner holds %q for it", first.EnvToken, children[0].apiToken)
	}
}

// TestChildrenAreToldHowToReachTheirMachineServer: a session's Settings →
// Connectivity is where its viewer switches LAN access and tunnels, which are
// the machine server's, and shares links to the session, so a child the
// machine server spawns is given the server's loopback address and control
// token, and its own session id there. A child spawned for a caller of its own
// (`juggler run`'s) is given none of them, nor one its spawner inherited.
func TestChildrenAreToldHowToReachTheirMachineServer(t *testing.T) {
	s := &Server{addr: "127.0.0.1:3939", token: "control-token"}
	got := fetchReport(t, "http://"+spawnHelperChildrenWith(t, 1, s.childEnv("sess-1"))[0].addr+"/")
	if got.EnvSupervisorAddr != "127.0.0.1:3939" || got.EnvSupervisorToken != "control-token" || got.EnvSupervisorSess != "sess-1" {
		t.Fatalf("machine server's child got supervisor %q with token %q as session %q, want 127.0.0.1:3939 and control-token as sess-1",
			got.EnvSupervisorAddr, got.EnvSupervisorToken, got.EnvSupervisorSess)
	}
	own := fetchReport(t, "http://"+spawnHelperChildren(t, 1)[0].addr+"/")
	if own.EnvSupervisorAddr != "" || own.EnvSupervisorToken != "" || own.EnvSupervisorSess != "" {
		t.Fatalf("a child with no machine server got supervisor %q with token %q as session %q, want none",
			own.EnvSupervisorAddr, own.EnvSupervisorToken, own.EnvSupervisorSess)
	}
}

// TestChildrenGetTheServersDeveloperFlags: --dev and --assets-from-disk are
// flags of the server, which passes them to every child it spawns, since a
// child is where the pages they change are served. A server given neither
// passes neither, and a test server's children are not handed the assets flag
// twice.
func TestChildrenGetTheServersDeveloperFlags(t *testing.T) {
	for _, c := range []struct {
		name string
		s    *Server
		want []string
		not  []string
	}{
		{"plain", &Server{}, nil, []string{"--dev", "--assets-from-disk", "--test"}},
		{"dev", &Server{childDev: true}, []string{"--dev"}, []string{"--assets-from-disk"}},
		{"assets from disk", &Server{childAssetsFromDisk: true}, []string{"--assets-from-disk"}, []string{"--dev"}},
		{"test with assets from disk", &Server{testChildren: true, childAssetsFromDisk: true}, []string{"--test", "--assets-from-disk"}, nil},
	} {
		got := c.s.childExtraArgs("s1")
		for _, flag := range c.want {
			if n := countArg(got, flag); n != 1 {
				t.Errorf("%s: %s appears %d times in %q, want once", c.name, flag, n, got)
			}
		}
		for _, flag := range c.not {
			if countArg(got, flag) != 0 {
				t.Errorf("%s: %q passes %s", c.name, got, flag)
			}
		}
	}
}

// countArg is how many times arg appears in args.
func countArg(args []string, arg string) int {
	n := 0
	for _, a := range args {
		if a == arg {
			n++
		}
	}
	return n
}
