//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package httpx is Juggler's single outbound-HTTP seam. Every client that talks
// to a provider endpoint, a remote MCP server, or the web builds its transport
// here so one proxy policy governs all of it. The policy is a process-wide
// resolver read on each request from an atomic snapshot, so a settings change
// takes effect immediately without rebuilding any already-constructed client.
//
// Precedence (highest first): a manual proxy URL from settings, then the
// standard proxy environment variables, then the OS system proxy (Windows
// registry / macOS SCDynamicStore), then direct. Loopback targets always
// bypass the proxy so local model servers (Ollama, llama.cpp) and instance IPC
// stay reachable regardless of configuration.
package httpx

import (
	"net/http"
	"net/url"
	"sync/atomic"
	"time"
)

// Proxy modes, mirrored by core.ProxyMode* on the persisted-settings side. They
// are plain strings so this package carries no dependency on core; the app/
// server layer passes the saved mode straight through to SetConfig.
const (
	// ModeSystem honours the standard proxy env vars and the OS system proxy;
	// it degrades to direct when neither is configured. This is the default.
	ModeSystem = "system"
	// ModeNone forces every request direct, ignoring env and OS proxy.
	ModeNone = "none"
	// ModeManual routes through the explicit URL in Config.URL.
	ModeManual = "manual"
)

// Config is the live proxy configuration. URL is consulted only in ModeManual.
type Config struct {
	Mode string
	URL  string
}

// resolver holds the pre-computed proxy decision for one Config. Building it
// once per SetConfig keeps the per-request path allocation-free: Proxy just
// loads the pointer and calls fn.
type resolver struct {
	fn func(*http.Request) (*url.URL, error)
}

// current is the process-wide resolver snapshot. Nil until SetConfig runs at
// startup, in which case Proxy falls back to the environment.
var current atomic.Pointer[resolver]

// SetConfig installs cfg as the live proxy policy. It is called once at startup
// and again whenever settings are saved; the swap is atomic, so in-flight and
// already-built clients pick up the new policy on their next request.
func SetConfig(cfg Config) {
	current.Store(buildResolver(cfg))
}

// Proxy is the process-wide proxy resolver. Wire it as http.Transport.Proxy on
// every transport. Loopback targets always return direct; otherwise the active
// resolver decides. Before SetConfig has run it honours the proxy env vars.
func Proxy(req *http.Request) (*url.URL, error) {
	if req != nil && isLoopback(req.URL) {
		return nil, nil
	}
	r := current.Load()
	if r == nil {
		return http.ProxyFromEnvironment(req)
	}
	return r.fn(req)
}

// Transport returns a clone of http.DefaultTransport with Proxy wired in.
// Callers that need custom timeouts start from this rather than a bare
// &http.Transport{}, so they inherit the standard dial/TLS/idle defaults.
func Transport() *http.Transport {
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		t := base.Clone()
		t.Proxy = Proxy
		return t
	}
	return &http.Transport{Proxy: Proxy}
}

// Client returns an *http.Client with the given client-level timeout and a
// proxy-aware transport. Pass 0 for streaming callers that need long-lived
// connections and rely on transport/context deadlines instead.
func Client(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: Transport()}
}
