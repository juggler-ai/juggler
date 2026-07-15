//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package llamacpp

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/openaibase"
)

// DefaultHost is the URL used when no explicit host is configured. 8080 is
// llama-server's own default port.
const DefaultHost = "http://127.0.0.1:8080"

// HostCredKey is the credentials.json field where the user-configured
// llama-server URL lives. Set via the settings panel; read by host().
const HostCredKey = "llamacpp_host"

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:            "llamacpp",
		DisplayName:     "llama.cpp (local)",
		Description:     "Runs a model locally via llama-server's OpenAI-compatible API. Start llama-server yourself first (juggler doesn't launch it); point at a non-default host (LAN, remote workstation, custom port) below, otherwise defaults to http://127.0.0.1:8080.",
		AutoDetect:      detectLlamaCpp,
		DisplayProvider: "llama.cpp",
		ContextWindowFn: getContextWindowInfo,
		BaseURLFunc:     func() string { return host() + "/v1" },
		APIKeyDefault:   "llamacpp", // placeholder so the OpenAI SDK accepts the request
	})
}

// host returns the configured llama-server URL. Resolution order:
//  1. `llamacpp_host` in ~/.juggler/credentials.json (set from the settings UI)
//  2. LLAMACPP_HOST environment variable
//  3. DefaultHost (http://127.0.0.1:8080)
//
// Accepts bare host:port (prepends http://) and strips trailing slashes.
func host() string {
	if store, err := core.NewCredentialsStore(); err == nil {
		if h := normaliseHost(store.GetRawKey(HostCredKey)); h != "" {
			return h
		}
	}
	if h := normaliseHost(os.Getenv("LLAMACPP_HOST")); h != "" {
		return h
	}
	return DefaultHost
}

// normaliseHost trims whitespace + trailing slashes and prepends http:// if the
// caller gave a bare host:port. Returns "" for empty/whitespace input.
func normaliseHost(raw string) string {
	h := strings.TrimSpace(raw)
	if h == "" {
		return ""
	}
	if !strings.HasPrefix(h, "http://") && !strings.HasPrefix(h, "https://") {
		h = "http://" + h
	}
	return strings.TrimRight(h, "/")
}

// detectLlamaCpp probes the llama-server at the configured host.
func detectLlamaCpp() bool {
	client := &http.Client{Timeout: 300 * time.Millisecond}
	req, err := http.NewRequest(http.MethodGet, host()+"/health", nil)
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

// propsResponse is the subset of llama-server's native GET /props response we
// care about. default_generation_settings.n_ctx reflects the server's actual
// configured --ctx-size (verified against a live instance), unlike
// /v1/models' n_ctx_train, which is only the model's trained maximum and
// ignores how the server was actually launched.
type propsResponse struct {
	DefaultGenerationSettings struct {
		NCtx int `json:"n_ctx"`
	} `json:"default_generation_settings"`
}

// getContextWindowInfo queries the running llama-server for its actual
// configured context window. llama-server serves one model per process, so
// there's no per-model table to maintain the way Ollama needs one; unlike
// Ollama, though, there's no naming convention to pattern-match on even if we
// wanted to fall back to one. Max output tokens is left at 0 (unknown) since
// llama.cpp has no separate output cap distinct from context) so the caller
// falls back to the shared default.
func getContextWindowInfo(modelID string) (int, int) {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Get(host() + "/props")
	if err != nil {
		return 0, 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, 0
	}
	var props propsResponse
	if err := json.NewDecoder(resp.Body).Decode(&props); err != nil {
		return 0, 0
	}
	return props.DefaultGenerationSettings.NCtx, 0
}
