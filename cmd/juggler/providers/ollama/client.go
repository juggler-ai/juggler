//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ollama

import (
	"net/http"
	"os"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/openaibase"
)

// DefaultHost is the URL used when no explicit host is configured.
const DefaultHost = "http://localhost:11434"

// HostCredKey is the credentials.json field where the user-configured Ollama
// daemon URL lives. Set via the settings panel; read by host().
const HostCredKey = "ollama_host"

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:            "ollama",
		DisplayName:     "Ollama (local)",
		Description:     "Runs models locally via an Ollama daemon. The model list below mirrors whatever you have pulled (`ollama pull <name>`). Point at a non-default daemon (LAN, remote workstation) by setting the host below; otherwise defaults to http://localhost:11434.",
		AutoDetect:      detectOllama,
		ContextWindows:  ModelContextWindows,
		DisplayProvider: "Ollama",
		ContextWindowFn: getContextWindowInfo,
		BaseURLFunc:     func() string { return host() + "/v1" },
		APIKeyDefault:   "ollama", // placeholder so the OpenAI SDK accepts the request
	})
}

// host returns the configured Ollama daemon URL. Resolution order:
//  1. `ollama_host` in ~/.juggler/credentials.json (set from the settings UI)
//  2. OLLAMA_HOST environment variable
//  3. DefaultHost (http://localhost:11434)
//
// Accepts bare host:port (prepends http://) and strips trailing slashes.
func host() string {
	if store, err := core.NewCredentialsStore(); err == nil {
		if h := normaliseHost(store.GetRawKey(HostCredKey)); h != "" {
			return h
		}
	}
	if h := normaliseHost(os.Getenv("OLLAMA_HOST")); h != "" {
		return h
	}
	return DefaultHost
}

// normaliseHost trims whitespace + trailing slashes and prepends http:// if the
// caller gave a bare host:port. Returns "" for empty/whitespace input.
//
// It also repairs the common "missing //" typo (`http:host:port`,
// `https:host`): written verbatim that yields a bogus `http://http:host:port`
// URL that never connects, so the malformed scheme prefix is rewritten to the
// proper `scheme://` form before the bare-host fallback runs.
func normaliseHost(raw string) string {
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

// detectOllama probes the Ollama daemon at OLLAMA_HOST (or localhost:11434).
func detectOllama() bool {
	client := &http.Client{Timeout: 300 * time.Millisecond}
	req, err := http.NewRequest(http.MethodGet, host()+"/api/tags", nil)
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

func getContextWindowInfo(modelID string) (int, int) {
	return GetContextWindow(modelID), DefaultMaxOutputTokens
}
