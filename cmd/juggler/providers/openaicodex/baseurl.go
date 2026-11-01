//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"juggler/internal/jlog"
)

// baseURLEnv overrides baseURL for responses, models and usage. Its value is
// expanded with os.ExpandEnv, so it may name a port known only at runtime.
const baseURLEnv = "JUGGLER_CODEX_BASE_URL"

// codexBaseURL returns the endpoint every Codex request is built on. An
// override that fails validation is logged and the default is used instead.
func codexBaseURL() string {
	raw := os.Getenv(baseURLEnv)
	if raw == "" {
		return baseURL
	}
	resolved, err := parseBaseURLOverride(os.ExpandEnv(raw))
	if err != nil {
		jlog.Error("[openaicodex] ignoring %s: %v", baseURLEnv, err)
		return baseURL
	}
	return resolved
}

// parseBaseURLOverride accepts an https URL, or an http URL whose host is
// loopback, since the bearer token rides every request.
func parseBaseURLOverride(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("invalid URL %q: %w", raw, err)
	}
	if u.Host == "" {
		return "", fmt.Errorf("URL %q has no host", raw)
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !isLoopbackHost(u.Hostname()) {
			return "", fmt.Errorf("http is allowed only for a loopback host, got %q", u.Hostname())
		}
	default:
		return "", fmt.Errorf("URL %q must use https, or http to a loopback host", raw)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("URL %q must not carry a query or fragment", raw)
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
