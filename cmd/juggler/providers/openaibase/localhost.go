//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"net/http"
	"os"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
)

// LocalHost describes a keyless, host-configurable local OpenAI-compatible
// server (e.g. an Ollama daemon or a llama.cpp llama-server). Providers of that
// shape differ only in a handful of constants — credential key, env var,
// default URL, health-probe path — so they declare a LocalHost and let it
// synthesise the closures a Descriptor needs (BaseURLFunc + AutoDetect) instead
// of hand-rolling identical host resolution, URL normalisation, and detection.
type LocalHost struct {
	CredKey     string // credentials.json field set from the settings UI (e.g. "ollama_host")
	EnvVar      string // environment-variable fallback (e.g. "OLLAMA_HOST")
	DefaultHost string // used when neither the credential nor the env var is set
	HealthPath  string // GET path probed by AutoDetect (e.g. "/api/tags", "/health")
}

// Host returns the configured server URL. Resolution order:
//  1. CredKey in ~/.juggler/credentials.json (set from the settings UI)
//  2. EnvVar environment variable
//  3. DefaultHost
//
// Each candidate is passed through NormaliseHost, so a bare host:port is
// accepted, trailing slashes are stripped, and the "missing //" typo is
// repaired before use.
func (l LocalHost) Host() string {
	if store, err := core.NewCredentialsStore(); err == nil {
		if h := NormaliseHost(store.GetRawKey(l.CredKey)); h != "" {
			return h
		}
	}
	if h := NormaliseHost(os.Getenv(l.EnvVar)); h != "" {
		return h
	}
	return l.DefaultHost
}

// BaseURLFunc returns a resolver suitable for Descriptor.BaseURLFunc: the
// configured host with the OpenAI-compatible "/v1" suffix, resolved fresh on
// each client construction so a host change takes effect without a restart.
func (l LocalHost) BaseURLFunc() func() string {
	return func() string { return l.Host() + "/v1" }
}

// AutoDetect returns a probe suitable for Descriptor.AutoDetect: a short-timeout
// GET of HealthPath at the configured host, reporting whether it answers 200.
func (l LocalHost) AutoDetect() func() bool {
	return func() bool {
		client := &http.Client{Timeout: 300 * time.Millisecond}
		req, err := http.NewRequest(http.MethodGet, l.Host()+l.HealthPath, nil)
		if err != nil {
			return false
		}
		resp, err := client.Do(req)
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	}
}

// NormaliseHost trims whitespace + trailing slashes and prepends http:// if the
// caller gave a bare host:port. Returns "" for empty/whitespace input.
//
// It also repairs the common "missing //" typo (`http:host:port`,
// `https:host`): written verbatim that yields a bogus `http://http:host:port`
// URL that never connects, so the malformed scheme prefix is rewritten to the
// proper `scheme://` form before the bare-host fallback runs.
func NormaliseHost(raw string) string {
	h := strings.TrimSpace(raw)
	if h == "" {
		return ""
	}
	// Repair `http:host` / `https:host` (scheme colon but no `//`).
	for _, scheme := range []string{"http", "https"} {
		if strings.HasPrefix(h, scheme+":") && !strings.HasPrefix(h, scheme+"://") {
			h = scheme + "://" + strings.TrimPrefix(h, scheme+":")
			break
		}
	}
	if !strings.HasPrefix(h, "http://") && !strings.HasPrefix(h, "https://") {
		h = "http://" + h
	}
	return strings.TrimRight(h, "/")
}
