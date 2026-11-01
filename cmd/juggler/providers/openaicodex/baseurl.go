//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaicodex

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"

	"juggler/internal/httpx"
	"juggler/internal/jlog"
)

// baseURLEnv overrides baseURL for responses, models and usage. Its value is
// expanded with os.ExpandEnv, so it may name a port known only at runtime.
const baseURLEnv = "JUGGLER_CODEX_BASE_URL"

// baseURLOverride is baseURLEnv's endpoint, "" when it is unset. The
// environment is fixed for the life of the process, so it is resolved once and
// an unusable value is logged once rather than on every request. A variable so
// that tests can resolve it again after setting the environment.
var baseURLOverride = sync.OnceValues(overrideFromEnv)

func overrideFromEnv() (string, error) {
	raw := os.Getenv(baseURLEnv)
	if raw == "" {
		return "", nil
	}
	resolved, err := parseBaseURLOverride(os.ExpandEnv(raw))
	if err != nil {
		err = fmt.Errorf("%s is unusable, so OpenAI Codex is not called: %w", baseURLEnv, err)
		jlog.Error("[openaicodex] %v", err)
		return "", err
	}
	return resolved, nil
}

// codexBaseURL returns the endpoint every Codex request is built on: the
// override when one is set, baseURL otherwise. An unusable override is an
// error, never a fallback to baseURL: whoever routed Codex through a gateway
// did so on purpose, and the bearer token must not go around it.
func codexBaseURL() (string, error) {
	override, err := baseURLOverride()
	if err != nil {
		return "", err
	}
	if override != "" {
		return override, nil
	}
	return baseURL, nil
}

// parseBaseURLOverride accepts an https URL, or an http URL whose host is
// loopback, since the bearer token rides every request. Its errors never repeat
// the value, which is logged and shown and may carry a credential.
func parseBaseURLOverride(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return "", fmt.Errorf("not a URL: %w", err)
	}
	if u.Host == "" {
		return "", errors.New("the URL has no host")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !httpx.IsLoopbackHost(u.Hostname()) {
			return "", fmt.Errorf("http is allowed only to a loopback host, not %q", u.Hostname())
		}
	default:
		return "", errors.New("the URL must use https, or http to a loopback host")
	}
	if u.User != nil {
		return "", errors.New("the URL must not carry a user name or password")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("the URL must not carry a query or fragment")
	}
	return strings.TrimRight(u.String(), "/"), nil
}
