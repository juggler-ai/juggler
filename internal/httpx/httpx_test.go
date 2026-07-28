//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package httpx

import (
	"net/http"
	"testing"
	"time"
)

// mustReq builds a GET request to rawURL or fails the test.
func mustReq(t *testing.T, rawURL string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		t.Fatalf("NewRequest(%q): %v", rawURL, err)
	}
	return req
}

// proxyHostFor resolves the proxy host the active policy would use for rawURL,
// or "" for a direct connection.
func proxyHostFor(t *testing.T, rawURL string) string {
	t.Helper()
	u, err := Proxy(mustReq(t, rawURL))
	if err != nil {
		t.Fatalf("Proxy(%q): %v", rawURL, err)
	}
	if u == nil {
		return ""
	}
	return u.Host
}

func TestNormalizeMode(t *testing.T) {
	cases := map[string]string{
		ModeSystem: ModeSystem,
		ModeNone:   ModeNone,
		ModeManual: ModeManual,
		"":         ModeSystem,
		"bogus":    ModeSystem,
		"System":   ModeSystem, // case-sensitive: only the canonical value matches
	}
	for in, want := range cases {
		if got := NormalizeMode(in); got != want {
			t.Errorf("NormalizeMode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNoneModeAlwaysDirect(t *testing.T) {
	SetConfig(Config{Mode: ModeNone})
	for _, u := range []string{"https://api.anthropic.com", "http://example.com", "https://127.0.0.1:8080"} {
		if host := proxyHostFor(t, u); host != "" {
			t.Errorf("none mode proxied %q via %q; want direct", u, host)
		}
	}
}

func TestManualModeProxiesRemoteBypassesLoopback(t *testing.T) {
	SetConfig(Config{Mode: ModeManual, URL: "http://proxy.example:8080"})

	if host := proxyHostFor(t, "https://api.anthropic.com"); host != "proxy.example:8080" {
		t.Errorf("manual mode remote host = %q, want proxy.example:8080", host)
	}
	// Local model servers and instance IPC must never be proxied.
	for _, u := range []string{"http://127.0.0.1:11434", "http://localhost:8080", "http://[::1]:9000"} {
		if host := proxyHostFor(t, u); host != "" {
			t.Errorf("manual mode proxied loopback %q via %q; want direct", u, host)
		}
	}
}

func TestManualModeMalformedURLFallsBackDirect(t *testing.T) {
	for _, bad := range []string{"", "   ", "://nope", "http://"} {
		SetConfig(Config{Mode: ModeManual, URL: bad})
		if host := proxyHostFor(t, "https://api.anthropic.com"); host != "" {
			t.Errorf("manual mode with URL %q proxied via %q; want direct fallback", bad, host)
		}
	}
}

func TestManualModeHonorsNoProxyEnv(t *testing.T) {
	t.Setenv("NO_PROXY", "internal.example")
	SetConfig(Config{Mode: ModeManual, URL: "http://proxy.example:8080"})

	if host := proxyHostFor(t, "https://internal.example/models"); host != "" {
		t.Errorf("NO_PROXY host proxied via %q; want direct", host)
	}
	if host := proxyHostFor(t, "https://api.anthropic.com"); host != "proxy.example:8080" {
		t.Errorf("non-excluded host = %q, want proxy.example:8080", host)
	}
}

func TestSetConfigLiveSwap(t *testing.T) {
	const target = "https://api.anthropic.com"

	SetConfig(Config{Mode: ModeNone})
	if host := proxyHostFor(t, target); host != "" {
		t.Fatalf("after none: got %q, want direct", host)
	}
	SetConfig(Config{Mode: ModeManual, URL: "http://proxy.example:3128"})
	if host := proxyHostFor(t, target); host != "proxy.example:3128" {
		t.Fatalf("after manual swap: got %q, want proxy.example:3128", host)
	}
	SetConfig(Config{Mode: ModeNone})
	if host := proxyHostFor(t, target); host != "" {
		t.Fatalf("after swap back to none: got %q, want direct", host)
	}
}

func TestTransportAndClient(t *testing.T) {
	tr := Transport()
	if tr == nil || tr.Proxy == nil {
		t.Fatal("Transport() must return a transport with Proxy wired")
	}
	c := Client(7 * time.Second)
	if c.Timeout != 7*time.Second {
		t.Errorf("Client timeout = %v, want 7s", c.Timeout)
	}
	if c.Transport == nil {
		t.Error("Client transport must be set")
	}
}
