//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"juggler/internal/qrsvg"
)

// TestSessionLinksOpenTheirSession: asked about a session, the LAN and tunnel
// routes name, beside each way in's own address, that session's address
// through it, with the QR a phone scans — and each address really opens the
// session: through this server's listener from the LAN, under the LAN
// address's own Host, and through a relay under its public host. A mode whose
// link loads pages its own way (a rendezvous bootstrap's #/path) names the
// session that way. A session it does not have, or none, gets no link.
func TestSessionLinksOpenTheirSession(t *testing.T) {
	s, local := tunnelServer(t, nil)
	id := headerEcho(t, s)
	path := "/s/" + id + "/"
	c := http.DefaultClient

	// reached GETs u's path and Host through front, and returns how the
	// session's child saw the caller.
	reached := func(front, u string) map[string]string {
		t.Helper()
		parsed, err := url.Parse(u)
		if err != nil {
			t.Fatalf("session link %q: %v", u, err)
		}
		code, body := tunnelCall(t, c, "GET", front+parsed.Path, parsed.Host, "", nil)
		var seen map[string]string
		if code != http.StatusOK || json.Unmarshal([]byte(body), &seen) != nil {
			t.Fatalf("GET %s through %s: %d %s; want the session", u, front, code, body)
		}
		return seen
	}
	wantQR := func(link *pageLink, what string) {
		t.Helper()
		want, err := qrsvg.Encode(link.URL)
		if err != nil || link.QR != want {
			t.Errorf("%s: the QR does not draw %s", what, link.URL)
		}
	}

	if addrs := lanAddresses(); len(addrs) > 0 {
		var lan lanResponse
		code, body := tunnelCall(t, c, "PUT", local+"/api/server/lan?session="+id, "", `{"enabled":true}`, nil)
		if err := json.Unmarshal([]byte(body), &lan); code != http.StatusOK || err != nil || len(lan.URLs) != len(addrs) {
			t.Fatalf("PUT lan on, asking about %s: %d %s", id, code, body)
		}
		remote := httptest.NewServer(asCaller("192.168.1.20:54321", s.routes()))
		defer remote.Close()
		for _, u := range lan.URLs {
			if u.Session == nil || u.Session.URL != u.URL+path[1:] {
				t.Fatalf("LAN address %s: session link %+v, want %s", u.URL, u.Session, u.URL+path[1:])
			}
			wantQR(u.Session, "LAN session link")
			if seen := reached(remote.URL, u.Session.URL); seen["kind"] != "lan" || seen["secret"] != "child-secret" {
				t.Errorf("LAN session link %s: the child saw %v; want a LAN caller, vouched for", u.Session.URL, seen)
			}
		}
		for _, q := range []string{"", "?session=nope"} {
			var plain lanResponse
			_, body = tunnelCall(t, c, "GET", local+"/api/server/lan"+q, "", "", nil)
			if err := json.Unmarshal([]byte(body), &plain); err != nil || len(plain.URLs) == 0 || plain.URLs[0].Session != nil {
				t.Errorf("GET lan%s: want no session link, got %+v", q, plain.URLs)
			}
		}
	}

	var tun tunnelResponse
	code, body := tunnelCall(t, c, "PUT", local+"/api/server/tunnel?session="+id, "", `{"mode":"fwd-test"}`, nil)
	if err := json.Unmarshal([]byte(body), &tun); code != http.StatusOK || err != nil || tun.Running == nil {
		t.Fatalf("PUT tunnel fwd, asking about %s: %d %s", id, code, body)
	}
	if want := "https://" + fwdHost + path; tun.Running.Session == nil || tun.Running.Session.URL != want {
		t.Fatalf("relay session link %+v, want %s", tun.Running.Session, want)
	}
	wantQR(tun.Running.Session, "relay session link")
	if seen := reached("http://"+lastForward.Load().addr, tun.Running.Session.URL); seen["kind"] != string(fwdMode) || seen["secret"] != "child-secret" {
		t.Errorf("relay session link: the child saw %v; want a caller of %s, vouched for", seen, fwdMode)
	}
	var unknown tunnelResponse
	_, body = tunnelCall(t, c, "GET", local+"/api/server/tunnel?session=nope", "", "", nil)
	if err := json.Unmarshal([]byte(body), &unknown); err != nil || unknown.Running == nil || unknown.Running.Session != nil {
		t.Errorf("GET tunnel?session=nope: want no session link, got %+v", unknown.Running)
	}

	tun = tunnelResponse{}
	code, body = tunnelCall(t, c, "PUT", local+"/api/server/tunnel?session="+id, "", `{"mode":"offer-test"}`, nil)
	if err := json.Unmarshal([]byte(body), &tun); code != http.StatusOK || err != nil || tun.Running == nil {
		t.Fatalf("PUT tunnel offer, asking about %s: %d %s", id, code, body)
	}
	if want := "https://rendezvous.example/c/abcdefghijklmnop#" + path; tun.Running.Session == nil || tun.Running.Session.URL != want {
		t.Fatalf("rendezvous session link %+v, want %s", tun.Running.Session, want)
	}
	wantQR(tun.Running.Session, "rendezvous session link")
}
