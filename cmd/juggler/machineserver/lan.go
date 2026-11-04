//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"

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
// on and, while it is, where to connect from and whether the server is
// announcing itself on the network there (startAdvertising), so the page claims
// other computers can find it only while they can.
type lanResponse struct {
	Enabled   bool     `json:"enabled"`
	URLs      []lanURL `json:"urls"`
	Announced bool     `json:"announced"`
}

// lanState is LAN access as it stands, with the URLs while it is on and,
// beside each, the page at sessionPath there ("" for none).
func (s *Server) lanState(sessionPath string) lanResponse {
	resp := lanResponse{Enabled: s.lan.Load(), URLs: []lanURL{}}
	if !resp.Enabled {
		return resp
	}
	resp.Announced = s.advert.Load() != nil
	_, port, err := net.SplitHostPort(s.addr)
	if err != nil {
		return resp
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
var advertiseLAN = lanfind.Advertise

// startAdvertising announces this server on the network under this machine's
// name, so the desktop app on another computer lists it to connect to. A
// failure (no multicast on this network, the OS refusing it) is logged and
// changes nothing else: the server is reachable by its address all the same.
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
	name := lanfind.InstanceName(host)
	stop, err := s.advertise(name, port, core.Version)
	if err != nil {
		jlog.Info("   not announced on this network (other computers can still use the addresses above): %v", err)
		return
	}
	if prev := s.advert.Swap(&stop); prev != nil {
		(*prev)()
	}
	if !s.lan.Load() {
		s.stopAdvertising()
		return
	}
	jlog.Info("   announced on this network as %q", name)
}

// stopAdvertising ends the server's announcement, if one is running.
func (s *Server) stopAdvertising() {
	if stop := s.advert.Swap(nil); stop != nil {
		(*stop)()
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
// machine only (localOnly).
func (s *Server) handleSetLAN(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&req); err != nil || req.Enabled == nil {
		writeMessageError(w, http.StatusBadRequest, msg.New("say whether LAN access is on: enabled, true or false"))
		return
	}
	s.setLAN(*req.Enabled)
	writeJSON(w, http.StatusOK, s.lanState(s.askedSession(r)))
}
