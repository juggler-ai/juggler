//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"fmt"
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

// parseBaseURLOverride accepts an http or https URL with a host and no query
// or fragment.
func parseBaseURLOverride(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("invalid URL %q: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("URL %q must use http or https", raw)
	}
	if u.Host == "" {
		return "", fmt.Errorf("URL %q has no host", raw)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("URL %q must not carry a query or fragment", raw)
	}
	return strings.TrimRight(u.String(), "/"), nil
}
