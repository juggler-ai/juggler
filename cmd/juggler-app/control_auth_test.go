//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"fmt"
	"net/http"
	"testing"
)

// The control listener is on loopback, but anything on this machine — any web
// page included, since a page may POST anywhere — can reach a loopback port.
// Window ids are w1, w2…, so the address alone authorised nothing: a page could
// open projects, close windows or restart the app. Only a caller holding a
// window's secret, which reaches nothing but that window's page, gets in.
func TestControlEndpointRequiresTheSecret(t *testing.T) {
	a := newTestAppState(t)
	registerTestWindow(a, "w1")
	ln, err := listenControl()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	a.serveControl(ln)
	origin := fmt.Sprintf("http://127.0.0.1:%d", a.ctlPort)
	secret := controlSecretOf(a, "w1")

	do := func(method, url, from string) (int, http.Header) {
		t.Helper()
		req, err := http.NewRequest(method, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		if from != "" {
			req.Header.Set("Origin", from)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode, resp.Header
	}

	for _, url := range []string{
		origin + "/win/w1/zoom?zoom=0",
		origin + "/not-the-secret/win/w1/zoom?zoom=0",
		origin + "/" + secret[:len(secret)-1] + "/win/w1/zoom?zoom=0",
	} {
		code, header := do(http.MethodPost, url, "https://evil.example")
		if code != http.StatusNotFound {
			t.Errorf("POST %s = %d, want 404", url, code)
		}
		if got := header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("POST %s echoed Access-Control-Allow-Origin %q", url, got)
		}
		if _, header := do(http.MethodOptions, url, "https://evil.example"); header.Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("a preflight to %s granted an origin", url)
		}
	}

	// The window's own page, which holds the secret in its ?nativeCtl=.
	base := a.controlBase("w1", secret)
	page := "http://127.0.0.1:8080"
	code, header := do(http.MethodPost, base+"/zoom?zoom=0", page)
	if code != http.StatusNoContent {
		t.Errorf("POST with the secret = %d, want 204", code)
	}
	if got := header.Get("Access-Control-Allow-Origin"); got != page {
		t.Errorf("the page cannot read its reply: Access-Control-Allow-Origin %q", got)
	}
	if code, _ := do(http.MethodGet, base+"/zoom?zoom=0", page); code != http.StatusMethodNotAllowed {
		t.Errorf("GET with the secret = %d, want 405: every action is a POST", code)
	}
}
