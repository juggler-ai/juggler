//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"cmp"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/internal/jlog"
	"juggler/internal/lanfind"
	"juggler/internal/qrsvg"
)

// LAN access: the server listens on every interface, and the LAN gate
// (lanGate) decides whether a caller off this machine gets in. A start turns
// it on only if serve --lan or the saved connectivity.lanOnLaunch says to
// (launchExposure); switching it while running is never remembered. Only a
// caller on this machine may switch it or read its addresses (localOnly):
// exposure is the machine owner's decision, never a viewer's. While it is on,
// the server also announces itself on the network (startAdvertising), which is
// how another computer's desktop app lists it under "Connect to another
// computer".

// lanAddress is a reachable LAN address (IPv4 or IPv6) and the network
// interface it belongs to, so each can be told apart when several exist.
type lanAddress struct {
	iface string
	ip    string
}

// lanAddresses returns the reachable addresses of this machine's active
// non-loopback interfaces. Global and unique-local unicast addresses count;
// loopback, link-local (which needs a zone to be usable) and multicast do not.
// IPv4 comes first, so the most broadly reachable URL leads.
func lanAddresses() []lanAddress {
	var v4, v6 []lanAddress
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		ifAddrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range ifAddrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
				ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
				continue
			}
			if ip4 := ip.To4(); ip4 != nil {
				v4 = append(v4, lanAddress{iface: iface.Name, ip: ip4.String()})
			} else {
				v6 = append(v6, lanAddress{iface: iface.Name, ip: ip.String()})
			}
		}
	}
	return append(v4, v6...)
}

// lanURL is one address another device reaches this server at.
type lanURL struct {
	URL       string `json:"url"`
	Interface string `json:"interface"`
	// QR is the URL as a QR code, in SVG (qrsvg), for a phone to scan.
	QR string `json:"qr,omitempty"`
	// Session is the session the caller asked about, at this address.
	Session *pageLink `json:"session,omitempty"`
}

// pageLink is one page of this server — a session's, at its project's link —
// at one of its addresses, with its QR code.
type pageLink struct {
	URL string `json:"url"`
	QR  string `json:"qr,omitempty"`
}

// newPageLink is the page at u, with its QR code when u can be drawn as one.
func newPageLink(u string) *pageLink {
	link := &pageLink{URL: u}
	if svg, err := qrsvg.Encode(u); err == nil {
		link.QR = svg
	}
	return link
}

// askedSession is the path a LAN or tunnel request's session is offered at
// (?session=<id>, a session child asking for its own links), or "" when it
// names none this server has: its project's link (projectlink.go), which is
// where the session is served, and opens whichever session the project has
// when someone who scanned or kept it comes back.
func (s *Server) askedSession(r *http.Request) string {
	id := r.URL.Query().Get("session")
	if id == "" {
		return ""
	}
	sess, ok := s.reg.get(id)
	if !ok {
		return ""
	}
	return projectLink(sess.Project)
}

// lanResponse is the GET/PUT /api/server/lan payload: whether LAN access is
// on and, while it is, where to connect from and whether the server's
// announcements are leaving the machine (announcement), so the page claims
// other computers can find it only while they can, and says why not when
// they cannot.
type lanResponse struct {
	Enabled      bool             `json:"enabled"`
	URLs         []lanURL         `json:"urls"`
	Announced    bool             `json:"announced"`
	NotAnnounced *lanNotAnnounced `json:"notAnnounced,omitempty"`
	Firewall     *lanFirewall     `json:"firewall,omitempty"`
}

// lanFirewall is what a host firewall must let in for LAN access to work,
// named on a system where one may be dropping it unseen (firewallOS): the
// server's TCP port, and mDNS, so other computers can find it.
type lanFirewall struct {
	Port int `json:"port"`
}

// firewallOS is the system LAN access is read for: on Linux a host firewall
// (ufw, firewalld) drops what other devices send without the server seeing
// anything — its sends still leave, so it is announced all the same — so
// while LAN access is on it names what to allow. macOS asks the user itself,
// and its refusals show (lanNotAnnounced). A seam for tests.
var firewallOS = runtime.GOOS

// Why a server with LAN access on is not announced (lanNotAnnounced.Reason).
const (
	// notAnnouncedDenied is macOS refusing the server the local network
	// (lanfind.ErrLocalNetworkDenied) until App is allowed onto it.
	notAnnouncedDenied = "local-network-denied"
	// notAnnouncedFailed is any other failure, which Error says.
	notAnnouncedFailed = "failed"
)

// lanNotAnnounced is why a server with LAN access on is not announced: a
// Reason, the failure's text for notAnnouncedFailed, and for
// notAnnouncedDenied the app macOS asks the user to allow (responsibleApp),
// "" when it cannot be told, and whether System Settings can remove it from
// its Local Network list (localNetworkListRemovable) — the one way to have
// macOS ask again once the user has answered.
type lanNotAnnounced struct {
	Reason    string `json:"reason"`
	Error     string `json:"error,omitempty"`
	App       string `json:"app,omitempty"`
	Removable bool   `json:"removable,omitempty"`
}

// lanAdvert is a running announcement (lanfind.Advertisement): Announce sends
// one and says whether it left the machine, SendFailed says whether an answer
// sent since has failed, Stop ends it.
type lanAdvert interface {
	Announce() error
	SendFailed() bool
	Stop()
}

// advertState is the announcement while LAN access is on: the running one
// (ad), or none when it could not start, and what was last found of it —
// whether its last announcement left (a nil err), or why it could not start.
type advertState struct {
	name string
	ad   lanAdvert
	last atomic.Pointer[announceResult]
}

// announceResult is what one announcement, or one try to start them, found:
// nil err for one that left the machine.
type announceResult struct {
	err error
}

func (st *advertState) stop() {
	if st.ad != nil {
		st.ad.Stop()
	}
}

// responsibleApp is the app macOS asks the user to let onto the local network
// for this server, as System Settings lists it (responsibleAppName): Juggler
// Server for one the desktop app launched, the terminal for `juggler serve`
// run in one; "" when that cannot be told. It never changes while the process
// runs. A seam for tests.
var responsibleApp = sync.OnceValue(responsibleAppName)

// localNetworkListRemovable is whether this macOS's Local Network list can
// remove an app (removableFrom). A seam for tests.
var localNetworkListRemovable = func() bool { return removableFrom(osProductVersion()) }

// removableFrom is whether macOS version v (such as "27.0.1") can remove an
// app from its Local Network list, which resets the user's choice so the app's
// next use of the local network asks again: 27.2 and later can; before it the
// choice can only be switched.
func removableFrom(v string) bool {
	majorStr, rest, _ := strings.Cut(v, ".")
	minorStr, _, _ := strings.Cut(rest, ".")
	major, err := strconv.Atoi(majorStr)
	if err != nil {
		return false
	}
	minor, err := strconv.Atoi(minorStr)
	if err != nil {
		minor = 0
	}
	return major > 27 || (major == 27 && minor >= 2)
}

// bundleOf is the app bundle exe is the main executable of — the innermost
// .app it is in, when it sits in that bundle's Contents/MacOS — or "" for an
// executable that is no bundle's.
func bundleOf(exe string) string {
	dir, file := path.Split(exe)
	bundle, ok := strings.CutSuffix(dir, "/Contents/MacOS/")
	if file == "" || !ok {
		return ""
	}
	if name := path.Base(bundle); name == ".app" || !strings.HasSuffix(name, ".app") {
		return ""
	}
	return bundle
}

// requestLocalNetwork asks macOS to let this server onto the local network
// (lanfind.RequestLocalNetwork). A seam: the package's tests ask nothing.
var requestLocalNetwork = lanfind.RequestLocalNetwork

// announcement is whether the server's announcements are leaving the machine
// and, while they are not, why. It looks again each time it is asked unless
// the last announcement left and nothing has failed since: an announcement
// that could not start is tried again, and one refused sent again, so the
// first read after the OS lets it out (the user allowing it) says so. A read
// of a server known to be announced sends nothing.
func (s *Server) announcement() (bool, *lanNotAnnounced) {
	st := s.advert.Load()
	if st == nil {
		return false, nil
	}
	if st.ad == nil {
		s.startAdvertising()
		if st = s.advert.Load(); st == nil {
			return false, nil
		}
	}
	r := s.announce(st)
	if r == nil || r.err == nil {
		return r != nil, nil
	}
	if errors.Is(r.err, lanfind.ErrLocalNetworkDenied) {
		return false, &lanNotAnnounced{Reason: notAnnouncedDenied, App: responsibleApp(), Removable: localNetworkListRemovable()}
	}
	return false, &lanNotAnnounced{Reason: notAnnouncedFailed, Error: r.err.Error()}
}

// announce sends st's announcement, unless its last one left and nothing has
// failed since, and answers what was found. Reads that announce at once each
// find something true; whichever records its finding over the one it read is
// the one that logs the change.
func (s *Server) announce(st *advertState) *announceResult {
	prev := st.last.Load()
	if st.ad == nil || (prev != nil && prev.err == nil && !st.ad.SendFailed()) {
		return prev
	}
	next := &announceResult{err: st.ad.Announce()}
	if st.last.CompareAndSwap(prev, next) {
		s.logAnnouncement(st.name, prev, next)
	}
	return next
}

// logAnnouncement logs what an announcement found, when it differs from what
// was found before it (nil for nothing yet).
func (s *Server) logAnnouncement(name string, before, after *announceResult) {
	if after == nil {
		return
	}
	text := func(r *announceResult) string {
		if r.err == nil {
			return ""
		}
		return r.err.Error()
	}
	if before != nil && text(before) == text(after) {
		return
	}
	switch {
	case after.err == nil:
		jlog.Info("   announced on this network as %q", name)
	case before != nil && before.err == nil:
		jlog.Info("   no longer announced on this network (other computers can still use the addresses above): %v", after.err)
	case errors.Is(after.err, lanfind.ErrLocalNetworkDenied):
		app := cmp.Or(responsibleApp(), "the app that started this server")
		jlog.Info("   not announced on this network yet: macOS is blocking %s from the local network — allow it in System Settings → Privacy & Security → Local Network (other computers can still use the addresses above)", app)
	default:
		jlog.Info("   not announced on this network (other computers can still use the addresses above): %v", after.err)
	}
}

// lanState is LAN access as it stands, with the URLs while it is on and,
// beside each, the page at sessionPath there ("" for none).
func (s *Server) lanState(sessionPath string) lanResponse {
	resp := lanResponse{Enabled: s.lan.Load(), URLs: []lanURL{}}
	if !resp.Enabled {
		return resp
	}
	resp.Announced, resp.NotAnnounced = s.announcement()
	_, port, err := net.SplitHostPort(s.addr)
	if err != nil {
		return resp
	}
	if n, err := strconv.Atoi(port); err == nil && firewallOS == "linux" {
		resp.Firewall = &lanFirewall{Port: n}
	}
	for _, a := range lanAddresses() {
		root := newPageLink("http://" + net.JoinHostPort(a.ip, port) + "/")
		u := lanURL{URL: root.URL, Interface: a.iface, QR: root.QR}
		if sessionPath != "" {
			u.Session = newPageLink(strings.TrimSuffix(root.URL, "/") + sessionPath)
		}
		resp.URLs = append(resp.URLs, u)
	}
	return resp
}

// setLAN switches LAN access, saying where to connect from once it is on, and
// announces the server on the network for exactly as long as it is.
func (s *Server) setLAN(on bool) {
	if s.lan.Swap(on) == on {
		return
	}
	if !on {
		s.stopAdvertising()
		jlog.Info("🔒 LAN access off: this server accepts connections from this machine only")
		return
	}
	jlog.Info("📡 LAN access on — no password: anyone on this network can use this server")
	for _, u := range s.lanState("").URLs {
		jlog.Info("   %s (%s)", u.URL, u.Interface)
	}
	s.startAdvertising()
}

// advertiseLAN is what Serve announces a server with (Server.advertise). A
// seam: the package's tests announce nothing on a real network.
var advertiseLAN = func(name string, port int, version string) (lanAdvert, error) {
	ad, err := lanfind.Advertise(name, port, version)
	if err != nil {
		return nil, err
	}
	return ad, nil
}

// startAdvertising announces this server on the network under this machine's
// name, so the desktop app on another computer lists it to connect to, and
// logs whether the announcement left the machine. One that could not start or
// did not leave (no multicast on this network, the OS refusing it) changes
// nothing else: the server is reachable by its address all the same, and the
// next read of LAN access tries again (announcement).
//
// LAN access switched off while the announcement starts is caught by the
// check after it is published: whichever of the two runs second stops it.
func (s *Server) startAdvertising() {
	if s.advertise == nil {
		return
	}
	_, portStr, err := net.SplitHostPort(s.addr)
	if err != nil {
		return
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return
	}
	host, _ := os.Hostname()
	st := &advertState{name: lanfind.InstanceName(host)}
	st.ad, err = s.advertise(st.name, port, core.Version)
	if err != nil {
		st.ad = nil
		st.last.Store(&announceResult{err: err})
	}
	prev := s.advert.Swap(st)
	if prev != nil {
		prev.stop()
	}
	if !s.lan.Load() {
		s.stopAdvertising()
		return
	}
	if st.ad == nil {
		var before *announceResult
		if prev != nil {
			before = prev.last.Load()
		}
		s.logAnnouncement(st.name, before, st.last.Load())
		return
	}
	s.announce(st)
}

// stopAdvertising ends the server's announcement, if one is running.
func (s *Server) stopAdvertising() {
	if st := s.advert.Swap(nil); st != nil {
		st.stop()
	}
}

// localOnly refuses a caller that is not on this machine (callerKind) with
// 403, before the route runs: what it guards changes the server for everyone,
// or tells where it can be reached from, which is the machine owner's to
// share. A tunnel's link works from anywhere, so a LAN viewer who could read
// it would hold a grant wider than the one it came in by.
func (s *Server) localOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.callerKind(r) != "" {
			writeMessageError(w, http.StatusForbidden, msg.New("Only this machine can do that."))
			return
		}
		next(w, r)
	}
}

// handleGetLAN serves LAN access as it stands. GET /api/server/lan, with
// ?session=<id> for that session's links (askedSession); this machine only
// (localOnly).
func (s *Server) handleGetLAN(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.lanState(s.askedSession(r)))
}

// handleSetLAN switches LAN access and answers with the result. PUT
// /api/server/lan {"enabled": bool}, with ?session= as GET has it; this
// machine only (localOnly). Switching it on asks macOS for the local network
// first (requestLocalNetwork), so a prompt the user has yet to answer comes up
// now, while they are looking, even should the announcement fail to start.
func (s *Server) handleSetLAN(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil || req.Enabled == nil {
		writeMessageError(w, http.StatusBadRequest, msg.New("say whether LAN access is on: enabled, true or false"))
		return
	}
	if *req.Enabled && !s.lan.Load() {
		requestLocalNetwork()
	}
	s.setLAN(*req.Enabled)
	writeJSON(w, http.StatusOK, s.lanState(s.askedSession(r)))
}
