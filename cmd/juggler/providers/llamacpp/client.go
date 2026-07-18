//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package llamacpp

import (
	"encoding/json"
	"net/http"
	"time"

	"juggler/cmd/juggler/providers/openaibase"
)

// DefaultHost is the URL used when no explicit host is configured. 8080 is
// llama-server's own default port.
const DefaultHost = "http://127.0.0.1:8080"

// HostCredKey is the credentials.json field where the user-configured
// llama-server URL lives. Set via the settings panel; read by the shared
// LocalHost.
const HostCredKey = "llamacpp_host"

// DefaultContextWindow is advertised when the running llama-server can't be
// queried (not up yet, /props unreachable). A conservative non-zero value so a
// failed probe never advertises a 0-token window to the token budgeter.
const DefaultContextWindow = 8192

// server describes the local llama-server as a keyless, host-configurable
// OpenAI-compatible endpoint. The shared helper supplies host resolution, URL
// normalisation, the /v1 base URL, and the health-probe detector.
var server = openaibase.LocalHost{
	CredKey:     HostCredKey,
	EnvVar:      "LLAMACPP_HOST",
	DefaultHost: DefaultHost,
	HealthPath:  "/health",
}

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:            "llamacpp",
		DisplayName:     "llama.cpp (local)",
		Description:     "Runs a model locally via llama-server's OpenAI-compatible API. Start llama-server yourself first (Juggler doesn't launch it); point at a non-default host (LAN, remote workstation, custom port) below, otherwise defaults to http://127.0.0.1:8080.",
		AutoDetect:      server.AutoDetect(),
		DisplayProvider: "llama.cpp",
		ContextWindowFn: getContextWindowInfo,
		BaseURLFunc:     server.BaseURLFunc(),
		APIKeyDefault:   "llamacpp", // placeholder so the OpenAI SDK accepts the request
	})
}

// propsResponse is the subset of llama-server's native GET /props response we
// care about. default_generation_settings.n_ctx reflects the server's actual
// configured --ctx-size (verified against a live instance), unlike /v1/models'
// n_ctx_train, which is only the model's trained maximum and ignores how the
// server was actually launched.
type propsResponse struct {
	DefaultGenerationSettings struct {
		NCtx int `json:"n_ctx"`
	} `json:"default_generation_settings"`
}

// getContextWindowInfo queries the running llama-server for its actual
// configured context window. llama-server serves one model per process, so
// there's no per-model table to maintain the way Ollama needs one, and no
// naming convention to pattern-match on as a fallback; when the server can't be
// reached we advertise DefaultContextWindow rather than 0. Max output tokens is
// left at 0 (unknown) — llama.cpp has no separate output cap distinct from the
// context window, so the caller falls back to the shared default.
func getContextWindowInfo(modelID string) (int, int) {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Get(server.Host() + "/props")
	if err != nil {
		return DefaultContextWindow, 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return DefaultContextWindow, 0
	}
	var props propsResponse
	if err := json.NewDecoder(resp.Body).Decode(&props); err != nil {
		return DefaultContextWindow, 0
	}
	if props.DefaultGenerationSettings.NCtx <= 0 {
		return DefaultContextWindow, 0
	}
	return props.DefaultGenerationSettings.NCtx, 0
}
