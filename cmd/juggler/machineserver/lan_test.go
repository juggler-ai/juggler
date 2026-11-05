//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/lanfind"
	"juggler/internal/userpaths/userpathstest"
)

// lanCall sends one control-API request to front with the token and returns
// the status and body.
func lanCall(t *testing.T, method, url, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(TokenHeader, testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// TestLANAccessIsSwitchedFromThisMachineOnly: LAN access is off at the start
// and switched through the control API, by a caller on this machine alone. A
// caller on the LAN can neither read its addresses nor flip it — nor stop the
// whole server — and a status says it.
func TestLANAccessIsSwitchedFromThisMachineOnly(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1)}
	local := httptest.NewServer(s.routes())
	defer local.Close()
	remote := httptest.NewServer(asCaller("192.168.1.20:54321", s.routes()))
	defer remote.Close()

	var got lanResponse
	code, body := lanCall(t, "GET", local.URL+"/api/server/lan", "")
	if err := json.Unmarshal([]byte(body), &got); code != http.StatusOK || err != nil || got.Enabled {
		t.Fatalf("GET lan at the start: %d %s; want 200, off", code, body)
	}

	if code, body := lanCall(t, "PUT", local.URL+"/api/server/lan", `{"enabled":true}`); code != http.StatusOK || !s.lan.Load() {
		t.Fatalf("PUT lan on from this machine: %d %s, on=%v; want 200, on", code, body, s.lan.Load())
	}
	var st statusResponse
	_, body = lanCall(t, "GET", local.URL+"/api/server/status", "")
	if err := json.Unmarshal([]byte(body), &st); err != nil || !st.LAN {
		t.Errorf("status with LAN on: %s; want lan true", body)
	}

	for _, c := range []struct{ method, path, body string }{
		{"GET", "/api/server/lan", ""},
		{"PUT", "/api/server/lan", `{"enabled":false}`},
		{"POST", "/api/server/shutdown", ""},
	} {
		if code, _ := lanCall(t, c.method, remote.URL+c.path, c.body); code != http.StatusForbidden {
			t.Errorf("%s %s from the LAN: status %d, want 403", c.method, c.path, code)
		}
	}
	if !s.lan.Load() || len(s.shutdownReq) != 0 {
		t.Errorf("a LAN caller changed the server: lan on=%v, shutdown signalled=%v", s.lan.Load(), len(s.shutdownReq) != 0)
	}

	if code, _ := lanCall(t, "PUT", local.URL+"/api/server/lan", `{"enabled":false}`); code != http.StatusOK || s.lan.Load() {
		t.Errorf("PUT lan off from this machine: %d, on=%v; want 200, off", code, s.lan.Load())
	}
	if code, _ := lanCall(t, "PUT", local.URL+"/api/server/lan", `{"enabled":"yes"}`); code != http.StatusBadRequest {
		t.Errorf("PUT lan with a body that says nothing: status %d, want 400", code)
	}
}

// TestLANAccessListsTheAddressesToUse: with LAN access on, the server names a
// URL for each of this machine's LAN addresses at its own port, each with a
// QR code of it for a phone; with it off it names none.
func TestLANAccessListsTheAddressesToUse(t *testing.T) {
	addrs := lanAddresses()
	if len(addrs) == 0 {
		t.Skip("this machine has no LAN address")
	}
	s := &Server{reg: newRegistry(), token: testToken, addr: "127.0.0.1:3941"}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	var got lanResponse
	_, body := lanCall(t, "GET", front.URL+"/api/server/lan", "")
	if err := json.Unmarshal([]byte(body), &got); err != nil || len(got.URLs) != 0 {
		t.Errorf("LAN off: %s; want no URLs", body)
	}
	s.lan.Store(true)
	_, body = lanCall(t, "GET", front.URL+"/api/server/lan", "")
	if err := json.Unmarshal([]byte(body), &got); err != nil || len(got.URLs) != len(addrs) {
		t.Fatalf("LAN on: %s; want one URL per address %v", body, addrs)
	}
	for i, u := range got.URLs {
		want := "http://" + net.JoinHostPort(addrs[i].ip, "3941") + "/"
		if u.URL != want || !strings.HasPrefix(u.QR, "<svg") || !strings.Contains(u.QR, "currentColor") {
			t.Errorf("URL %d: %q with QR %.40q; want %q with an SVG QR", i, u.URL, u.QR, want)
		}
	}
}

// fakeAdverts records a Server's advertisements: one entry per start, and how
// many of them were stopped. Each announces as sends would go: refused while
// refuse holds an error, left while it holds none.
type fakeAdverts struct {
	started   []string
	stopped   atomic.Int32
	fail      error
	refuse    atomic.Pointer[error]
	announces atomic.Int32
	// sendFailed is the responder having failed a send since the last announcement.
	sendFailed atomic.Bool
}

func (f *fakeAdverts) advertise(name string, port int, version string) (lanAdvert, error) {
	if f.fail != nil {
		return nil, f.fail
	}
	f.started = append(f.started, fmt.Sprintf("%s:%d %s", name, port, version))
	return fakeAdvert{f}, nil
}

// refuseWith makes every send refused with err from now on; nil lets them leave.
func (f *fakeAdverts) refuseWith(err error) { f.refuse.Store(&err) }

type fakeAdvert struct{ f *fakeAdverts }

func (a fakeAdvert) Announce() error {
	a.f.announces.Add(1)
	a.f.sendFailed.Store(false)
	if err := a.f.refuse.Load(); err != nil {
		return *err
	}
	return nil
}
func (a fakeAdvert) SendFailed() bool { return a.f.sendFailed.Load() }
func (a fakeAdvert) Stop()            { a.f.stopped.Add(1) }

// errDenied is a refusal as macOS gives one.
var errDenied = fmt.Errorf("%w: write udp: sendmsg: no route to host", lanfind.ErrLocalNetworkDenied)

// captureLog collects what the server logs while the test runs.
func captureLog(t *testing.T) *strings.Builder {
	t.Helper()
	var b strings.Builder
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&b)
	log.SetFlags(0)
	t.Cleanup(func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) })
	return &b
}

// useResponsibleApp makes name the app macOS holds responsible for this
// server, and removable whether its Local Network list can remove an app.
func useResponsibleApp(t *testing.T, name string, removable bool) {
	t.Helper()
	prevApp, prevRemovable := responsibleApp, localNetworkListRemovable
	responsibleApp = func() string { return name }
	localNetworkListRemovable = func() bool { return removable }
	t.Cleanup(func() { responsibleApp, localNetworkListRemovable = prevApp, prevRemovable })
}

// countLocalNetworkRequests counts the server's asking macOS for the local
// network (requestLocalNetwork) while the test runs.
func countLocalNetworkRequests(t *testing.T) *atomic.Int32 {
	t.Helper()
	var n atomic.Int32
	prev := requestLocalNetwork
	requestLocalNetwork = func() { n.Add(1) }
	t.Cleanup(func() { requestLocalNetwork = prev })
	return &n
}

// TestLANIsAnnouncedOnlyOnceAnAnnouncementLeaves: the server says it is
// announced (and logs it) only once an announcement has actually left the
// machine. Until one does, each read of LAN access tries again, so the
// moment the OS lets it out — the user allowing it — the next read says so.
// Once announced, a read sends nothing more, until the responder fails a send
// and the next read looks again.
func TestLANIsAnnouncedOnlyOnceAnAnnouncementLeaves(t *testing.T) {
	logged := captureLog(t)
	useResponsibleApp(t, "Terminal", false)
	ads := &fakeAdverts{}
	ads.refuseWith(errDenied)
	s := &Server{reg: newRegistry(), addr: "127.0.0.1:3941", advertise: ads.advertise}
	host, _ := os.Hostname()
	announced := fmt.Sprintf("announced on this network as %q", lanfind.InstanceName(host))

	s.setLAN(true)
	if strings.Contains(logged.String(), announced) {
		t.Errorf("logged %q before any announcement left:\n%s", announced, logged)
	}
	for range 2 {
		st := s.lanState("")
		if st.Announced || st.NotAnnounced == nil || st.NotAnnounced.Reason != "local-network-denied" || st.NotAnnounced.App != "Terminal" {
			t.Fatalf("refused: announced %v, why %+v; want not, local-network-denied by Terminal", st.Announced, st.NotAnnounced)
		}
	}
	if n := ads.announces.Load(); n != 3 {
		t.Errorf("announced %d times over the start and two reads, want 3 (one each)", n)
	}

	ads.refuseWith(nil)
	if st := s.lanState(""); !st.Announced || st.NotAnnounced != nil {
		t.Fatalf("once sends leave: announced %v, why %+v; want announced", st.Announced, st.NotAnnounced)
	}
	if strings.Count(logged.String(), announced) != 1 {
		t.Errorf("logged %q %d times once announced, want once:\n%s", announced, strings.Count(logged.String(), announced), logged)
	}
	before := ads.announces.Load()
	s.lanState("")
	s.lanState("")
	if n := ads.announces.Load() - before; n != 0 {
		t.Errorf("reads of an announced server announced %d more times, want none", n)
	}

	ads.refuseWith(errDenied)
	ads.sendFailed.Store(true)
	if st := s.lanState(""); st.Announced || st.NotAnnounced == nil {
		t.Errorf("after the responder failed a send and announcing is refused: announced %v, why %+v", st.Announced, st.NotAnnounced)
	}
	if !strings.Contains(logged.String(), "no longer announced on this network") {
		t.Errorf("did not log the announcement stopping:\n%s", logged)
	}
}

// TestLANReopensTheResponderOnceAnnouncementsLeave: a responder opened while
// its announcements were refused — macOS not yet letting the server onto the
// local network, as just after a launch or a rebuild — joined its groups then,
// and hears no query once they are let out, though announcements (on sockets
// of their own) do leave. So the first announcement that leaves after a
// refusal reopens it, and the server says it is announced once, of the new
// one. One that left from the start is never reopened.
func TestLANReopensTheResponderOnceAnnouncementsLeave(t *testing.T) {
	logged := captureLog(t)
	useResponsibleApp(t, "Juggler Server", false)
	ads := &fakeAdverts{}
	ads.refuseWith(errDenied)
	s := &Server{reg: newRegistry(), addr: "127.0.0.1:3941", advertise: ads.advertise}
	s.setLAN(true)
	defer s.stopAdvertising()
	s.lanState("")
	if len(ads.started) != 1 || ads.stopped.Load() != 0 {
		t.Fatalf("while refused: started %d, stopped %d; want the one, running", len(ads.started), ads.stopped.Load())
	}

	ads.refuseWith(nil)
	if st := s.lanState(""); !st.Announced {
		t.Fatalf("once sends leave: announced %v, why %+v", st.Announced, st.NotAnnounced)
	}
	if len(ads.started) != 2 || ads.stopped.Load() != 1 {
		t.Errorf("once sends leave: started %d, stopped %d; want the refused one stopped and a second started", len(ads.started), ads.stopped.Load())
	}
	if n := strings.Count(logged.String(), "announced on this network as"); n != 1 {
		t.Errorf("logged being announced %d times, want once:\n%s", n, logged)
	}
	for range 3 {
		s.lanState("")
	}
	if len(ads.started) != 2 {
		t.Errorf("reads of an announced server started %d responders, want no more than 2", len(ads.started))
	}

	fresh := &fakeAdverts{}
	s2 := &Server{reg: newRegistry(), addr: "127.0.0.1:3942", advertise: fresh.advertise}
	s2.setLAN(true)
	defer s2.stopAdvertising()
	s2.lanState("")
	if len(fresh.started) != 1 || fresh.stopped.Load() != 0 {
		t.Errorf("announced from the start: started %d, stopped %d; want one, never reopened", len(fresh.started), fresh.stopped.Load())
	}
}

// TestLANNotAnnouncedSaysWhoToAllow: a refusal by macOS names the app that
// must be allowed onto the local network — the one macOS holds responsible
// for the server, whoever started it: Juggler Server for one the app
// launched, the terminal for `juggler serve` — and whether that app can be
// removed from the Local Network list, which makes macOS ask again. Any other
// failure says what it was. That is what GET /api/server/lan carries.
func TestLANNotAnnouncedSaysWhoToAllow(t *testing.T) {
	captureLog(t)
	for _, c := range []struct {
		name        string
		starter     int
		responsible string
		removable   bool
		refuse      error
		want        lanNotAnnounced
	}{
		{"the app launched it", os.Getpid(), "Juggler Server", false, errDenied, lanNotAnnounced{Reason: "local-network-denied", App: "Juggler Server"}},
		{"a terminal started it", 0, "iTerm", false, errDenied, lanNotAnnounced{Reason: "local-network-denied", App: "iTerm"}},
		{"its app can be removed", 0, "iTerm", true, errDenied, lanNotAnnounced{Reason: "local-network-denied", App: "iTerm", Removable: true}},
		{"no app is responsible", 0, "", false, errDenied, lanNotAnnounced{Reason: "local-network-denied"}},
		{"another failure", 0, "Terminal", true, errors.New("network is down"), lanNotAnnounced{Reason: "failed", Error: "network is down"}},
	} {
		useResponsibleApp(t, c.responsible, c.removable)
		ads := &fakeAdverts{}
		ads.refuseWith(c.refuse)
		s := &Server{reg: newRegistry(), addr: "127.0.0.1:3941", advertise: ads.advertise, starter: c.starter}
		s.setLAN(true)
		st := s.lanState("")
		if st.NotAnnounced == nil || *st.NotAnnounced != c.want {
			t.Errorf("%s: why not announced = %+v, want %+v", c.name, st.NotAnnounced, c.want)
		}
		s.stopAdvertising()
	}

	ads := &fakeAdverts{}
	ads.refuseWith(errDenied)
	useResponsibleApp(t, "Terminal", true)
	s := &Server{reg: newRegistry(), addr: "127.0.0.1:3941", advertise: ads.advertise}
	s.setLAN(true)
	defer s.stopAdvertising()
	body, err := json.Marshal(s.lanState(""))
	if err != nil {
		t.Fatal(err)
	}
	if want := `"announced":false,"notAnnounced":{"reason":"local-network-denied","app":"Terminal","removable":true}`; !strings.Contains(string(body), want) {
		t.Errorf("GET /api/server/lan = %s, want it to carry %s", body, want)
	}
}

// TestLANNamesThePortsAFirewallMustAllow: on Linux, where a host firewall
// can drop what other devices send without the server seeing a thing, LAN
// access names the port they connect to, for the page to say what to allow.
// Elsewhere, and with LAN access off, it names none.
func TestLANNamesThePortsAFirewallMustAllow(t *testing.T) {
	captureLog(t)
	prev := firewallOS
	t.Cleanup(func() { firewallOS = prev })
	ads := &fakeAdverts{}
	s := &Server{reg: newRegistry(), addr: "127.0.0.1:3941", advertise: ads.advertise}

	firewallOS = "linux"
	if st := s.lanState(""); st.Firewall != nil {
		t.Errorf("LAN access off: firewall %+v, want none", st.Firewall)
	}
	s.setLAN(true)
	defer s.stopAdvertising()
	if st := s.lanState(""); st.Firewall == nil || *st.Firewall != (lanFirewall{Port: 3941}) {
		t.Errorf("on linux: firewall %+v, want port 3941", st.Firewall)
	}
	body, err := json.Marshal(s.lanState(""))
	if err != nil {
		t.Fatal(err)
	}
	if want := `"firewall":{"port":3941}`; !strings.Contains(string(body), want) {
		t.Errorf("GET /api/server/lan = %s, want it to carry %s", body, want)
	}
	for _, goos := range []string{"darwin", "windows"} {
		firewallOS = goos
		if st := s.lanState(""); st.Firewall != nil {
			t.Errorf("on %s: firewall %+v, want none", goos, st.Firewall)
		}
	}
}

// TestLANRetriesAnAnnouncementThatCouldNotStart: an announcement that could
// not start (no multicast socket to be had, say) is tried again on each read
// while LAN access is on, and says why until it starts.
func TestLANRetriesAnAnnouncementThatCouldNotStart(t *testing.T) {
	captureLog(t)
	ads := &fakeAdverts{fail: errors.New("address already in use")}
	s := &Server{reg: newRegistry(), addr: "127.0.0.1:3941", advertise: ads.advertise}
	s.setLAN(true)
	defer s.stopAdvertising()
	if st := s.lanState(""); st.Announced || st.NotAnnounced == nil || st.NotAnnounced.Error != "address already in use" {
		t.Fatalf("could not start: announced %v, why %+v", st.Announced, st.NotAnnounced)
	}
	ads.fail = nil
	if st := s.lanState(""); !st.Announced {
		t.Fatalf("a read once it can start: announced %v, why %+v; want announced", st.Announced, st.NotAnnounced)
	}
	if len(ads.started) != 1 {
		t.Errorf("started %d announcements, want 1", len(ads.started))
	}
}

// TestBundleOfPath: the bundle a main executable is the main executable of is
// the innermost .app it is in — JugglerServer.app, launched as an app of its
// own, not the Juggler.app that holds it — and only when it sits where a
// bundle's executable does.
func TestBundleOfPath(t *testing.T) {
	for _, c := range []struct{ path, want string }{
		{"/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", "/System/Applications/Utilities/Terminal.app"},
		{"/Applications/Juggler.app/Contents/Helpers/JugglerServer.app/Contents/MacOS/juggler", "/Applications/Juggler.app/Contents/Helpers/JugglerServer.app"},
		{"/Applications/Juggler.app/Contents/MacOS/juggler-app", "/Applications/Juggler.app"},
		{"/bin/zsh", ""},
		{"/Users/me/.app/Contents/MacOS/tool", ""},
		{"/Applications/Tool.app/Contents/Resources/bin/tool", ""},
	} {
		if got := bundleOf(c.path); got != c.want {
			t.Errorf("bundleOf(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

// TestLocalNetworkListRemovableFrom: macOS 27.2 is the first whose Local
// Network list can remove an app, resetting what the user chose for it.
func TestLocalNetworkListRemovableFrom(t *testing.T) {
	for v, want := range map[string]bool{
		"27.2": true, "27.2.1": true, "27.10": true, "28.0": true, "30": true,
		"27.1.4": false, "27.0.1": false, "27": false, "26.4": false, "16.0": false, "": false, "beta": false,
	} {
		if got := removableFrom(v); got != want {
			t.Errorf("removableFrom(%q) = %v, want %v", v, got, want)
		}
	}
}

// TestStartingLANByHandAsksForTheLocalNetwork: LAN access switched on through
// the control API asks macOS for the local network then, while the user is
// looking at it, so a first prompt comes up in context. Switching it off, or
// on again while it is on, asks nothing, and nor does a start that turns it on
// by itself (serve --lan, connectivity.lanOnLaunch).
func TestStartingLANByHandAsksForTheLocalNetwork(t *testing.T) {
	asked := countLocalNetworkRequests(t)
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1)}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	s.setLAN(true)
	s.setLAN(false)
	if n := asked.Load(); n != 0 {
		t.Fatalf("switching LAN access other than by hand asked %d times, want none", n)
	}
	for _, c := range []struct {
		body string
		want int32
	}{
		{`{"enabled":true}`, 1},
		{`{"enabled":true}`, 1},
		{`{"enabled":false}`, 1},
		{`{"enabled":true}`, 2},
	} {
		if code, body := lanCall(t, "PUT", front.URL+"/api/server/lan", c.body); code != http.StatusOK {
			t.Fatalf("PUT %s: %d %s", c.body, code, body)
		}
		if n := asked.Load(); n != c.want {
			t.Errorf("after PUT %s: asked %d times, want %d", c.body, n, c.want)
		}
	}
}

// TestLANAccessIsAdvertisedWhileOn: a server announces itself on the network
// (lanfind) exactly while LAN access is on — under this machine's name, at its
// own port — stops when it is switched off or the server stops, and a second
// "on" announces nothing twice. An announcement that fails leaves LAN access on.
func TestLANAccessIsAdvertisedWhileOn(t *testing.T) {
	ads := &fakeAdverts{}
	s := &Server{reg: newRegistry(), addr: "127.0.0.1:3941", advertise: ads.advertise}
	host, _ := os.Hostname()
	want := fmt.Sprintf("%s:3941 %s", lanfind.InstanceName(host), core.Version)

	s.setLAN(true)
	s.setLAN(true)
	if !reflect.DeepEqual(ads.started, []string{want}) || ads.stopped.Load() != 0 {
		t.Fatalf("LAN on twice: started %q, stopped %d; want one %q, none stopped", ads.started, ads.stopped.Load(), want)
	}
	if !s.lanState("").Announced {
		t.Error("LAN state does not say the server is announced while it is")
	}
	s.setLAN(false)
	if ads.stopped.Load() != 1 {
		t.Errorf("LAN off: %d advertisements stopped, want 1", ads.stopped.Load())
	}
	s.setLAN(true)
	s.stopAdvertising()
	s.stopAdvertising()
	if len(ads.started) != 2 || ads.stopped.Load() != 2 {
		t.Errorf("on again, then the server stopping: started %d, stopped %d; want 2, 2", len(ads.started), ads.stopped.Load())
	}

	failing := &Server{reg: newRegistry(), addr: "127.0.0.1:3941", advertise: (&fakeAdverts{fail: errors.New("no multicast here")}).advertise}
	failing.setLAN(true)
	if !failing.lan.Load() {
		t.Error("a failed announcement switched LAN access off")
	}
	if failing.lanState("").Announced {
		t.Error("LAN state says the server is announced when its announcement failed")
	}
}

// TestServeLANStartsWithLANAccessOn: `serve --lan` starts a server with LAN
// access on (a container's, a headless machine's); without it, or the saved
// setting (TestServeOpensTheSavedWaysIn), a server starts with it off.
func TestServeLANStartsWithLANAccessOn(t *testing.T) {
	for _, c := range []struct {
		args []string
		want bool
	}{{[]string{"--port", "0"}, false}, {[]string{"--port", "0", "--lan"}, true}} {
		userpathstest.Isolate(t)
		got := servedHere(t)
		code := make(chan int, 1)
		go func() { code <- RunCommand(c.args, nil, nil) }()
		var s *Server
		select {
		case s = <-got:
		case n := <-code:
			t.Fatalf("serve %v exited %d before serving", c.args, n)
		}
		if s.lan.Load() != c.want {
			t.Errorf("serve %v: LAN access on=%v, want %v", c.args, s.lan.Load(), c.want)
		}
		s.requestShutdown()
		select {
		case n := <-code:
			if n != 0 {
				t.Errorf("serve %v exited %d", c.args, n)
			}
		case <-time.After(30 * time.Second):
			t.Fatalf("serve %v did not stop", c.args)
		}
	}
}

// TestServerLANCommand: `juggler server lan` says whether LAN access is on and
// where to connect from, and `on`/`off` switch it.
func TestServerLANCommand(t *testing.T) {
	s, _ := cliServer(t)
	s.addr = "127.0.0.1:" + strconv.Itoa(DefaultPort)

	if code, out, errOut := runCLI(t, RunServerCommand, "lan"); code != 0 || !strings.Contains(out, "off") {
		t.Errorf("server lan with it off: %d %q %q; want 0, saying off", code, out, errOut)
	}
	code, out, errOut := runCLI(t, RunServerCommand, "lan", "on")
	if code != 0 || !s.lan.Load() || !strings.Contains(out, "on") {
		t.Fatalf("server lan on: %d %q %q, on=%v; want 0, on", code, out, errOut, s.lan.Load())
	}
	for _, a := range lanAddresses() {
		if want := "http://" + net.JoinHostPort(a.ip, strconv.Itoa(DefaultPort)) + "/"; !strings.Contains(out, want) {
			t.Errorf("server lan on does not name %s: %q", want, out)
		}
	}
	if code, _, _ := runCLI(t, RunServerCommand, "lan", "off"); code != 0 || s.lan.Load() {
		t.Errorf("server lan off: %d, on=%v; want 0, off", code, s.lan.Load())
	}
	if code, _, _ := runCLI(t, RunServerCommand, "lan", "maybe"); code != 2 {
		t.Errorf("server lan maybe: exit %d, want 2", code)
	}
}
