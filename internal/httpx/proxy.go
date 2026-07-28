//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package httpx

import (
	"net"
	"net/http"
	"net/url"
	"strings"

	"juggler/internal/jlog"

	ieproxy "github.com/mattn/go-ieproxy"
	"golang.org/x/net/http/httpproxy"
)

// NormalizeMode maps any value to a known proxy mode, defaulting empty or
// unrecognised input to system. Callers never have to special-case "".
func NormalizeMode(mode string) string {
	switch mode {
	case ModeNone:
		return ModeNone
	case ModeManual:
		return ModeManual
	default:
		return ModeSystem
	}
}

// direct is the resolver that sends every request straight to its origin.
var direct = &resolver{fn: func(*http.Request) (*url.URL, error) { return nil, nil }}

// buildResolver pre-computes the proxy decision function for cfg:
//   - none:   always direct.
//   - manual: route through the configured URL, honouring env NO_PROXY (and the
//     built-in localhost/loopback bypass) so local endpoints still connect. A
//     blank or unparseable URL logs once and falls back to direct rather than
//     bricking every request.
//   - system: delegate to go-ieproxy, which folds the proxy env vars together
//     with the OS system proxy (Windows registry / macOS SCDynamicStore) and
//     falls back to the environment on other platforms.
func buildResolver(cfg Config) *resolver {
	switch NormalizeMode(cfg.Mode) {
	case ModeNone:
		return direct

	case ModeManual:
		raw := strings.TrimSpace(cfg.URL)
		if raw == "" {
			jlog.Info("httpx: manual proxy selected with no URL; sending traffic direct")
			return direct
		}
		if u, err := url.Parse(raw); err != nil || u.Host == "" {
			jlog.Info("httpx: manual proxy URL %q is invalid (%v); sending traffic direct", raw, err)
			return direct
		}
		// Apply the manual URL to both http and https targets while inheriting
		// NO_PROXY semantics from the environment. httpproxy.Config.ProxyFunc
		// also special-cases localhost/loopback to direct.
		pcfg := &httpproxy.Config{
			HTTPProxy:  raw,
			HTTPSProxy: raw,
			NoProxy:    httpproxy.FromEnvironment().NoProxy,
		}
		pf := pcfg.ProxyFunc()
		return &resolver{fn: func(req *http.Request) (*url.URL, error) { return pf(req.URL) }}

	default: // system
		return &resolver{fn: ieproxy.GetProxyFunc()}
	}
}

// isLoopback reports whether u targets localhost or a loopback IP. Such targets
// always bypass the proxy: local model servers (Ollama, llama.cpp) and instance
// IPC must stay reachable no matter how the proxy is configured. This backstops
// the bypass the resolvers already apply, in case a future resolver omits it.
func isLoopback(u *url.URL) bool {
	if u == nil {
		return false
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}
