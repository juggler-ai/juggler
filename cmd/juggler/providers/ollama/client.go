//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ollama

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/openaibase"
	provider "juggler/cmd/juggler/providers/registry"
)

// DefaultHost is the URL used when no explicit host is configured.
const DefaultHost = "http://localhost:11434"

// HostCredKey is the credentials.json field where the user-configured Ollama
// daemon URL lives. Set via the settings panel; read by host().
const HostCredKey = "ollama_host"

// NumCtxCredKey is the credentials.json field where the user-declared daemon
// context size lives. Ollama's OpenAI-compatible /v1 endpoint cannot set the
// context size per request, and the daemon never reports its configured
// num_ctx over the API, so users who raised their daemon default
// (OLLAMA_CONTEXT_LENGTH) declare it here. Per-model Modelfile parameters
// probed from /api/show take precedence; OLLAMA_NUM_CTX works too.
const NumCtxCredKey = "ollama_num_ctx"

// defaultServingContextWindow is the serving window assumed when neither the
// model's Modelfile parameters nor a user override reveal the daemon's
// num_ctx. It matches Ollama's long-standing documented default. The bias is
// deliberate: under-admission only triggers bounded compaction, while
// over-admission makes the daemon silently truncate conversation history.
const defaultServingContextWindow = 4096

// DefaultMaxOutputTokens caps generation length per request, so a response
// cannot grow past the reserve admission charged for it.
const DefaultMaxOutputTokens = 4096

// daemonHTTPClient bounds native-endpoint probes (tags/show). Local daemons
// answer in milliseconds; the timeout covers unreachable LAN hosts.
var daemonHTTPClient = &http.Client{Timeout: 10 * time.Second}

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:            "ollama",
		DisplayName:     "Ollama (local)",
		Description:     "Runs models locally via an Ollama daemon. The model list below mirrors whatever you have pulled (`ollama pull <name>`). Point at a non-default daemon (LAN, remote workstation) by setting the host below; otherwise defaults to http://localhost:11434. Juggler enforces the context window each model actually serves — its Modelfile num_ctx, or a conservative 4096 otherwise; declare a higher daemon default via ollama_num_ctx in credentials.json.",
		AutoDetect:      detectOllama,
		DisplayProvider: "Ollama",
		ContextWindowFn: getContextWindowInfo,
		// The model catalog and its real serving windows live on Ollama's
		// native endpoints, not the OpenAI-compatible /v1 ones.
		ListModelsOverride: listModels,
		// Deliberately no ContextWindows: the static family catalog holds
		// training maximums, and admission must never enforce a window the
		// daemon does not serve.
		BaseURLFunc:   func() string { return host() + "/v1" },
		APIKeyDefault: "ollama", // placeholder so the OpenAI SDK accepts the request
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

// getContextWindowInfo is the static capability path, used before model
// discovery publishes live values. It cannot probe the daemon, so it reports
// the conservative serving window (the user override when declared); live
// /api/show results replace it per model once the model list is published.
func getContextWindowInfo(_ string) (int, int) {
	window := servingContextWindow(0)
	return window, servingMaxOutput(window)
}

// servingContextWindow resolves the context window the daemon will actually
// serve for one model — the value admission must enforce, because Ollama
// silently truncates requests that exceed it. Precedence: the model's own
// Modelfile num_ctx (per-model, deliberately configured), then the
// user-declared daemon default, then the conservative fallback. Training
// maximums (models.go) are not consulted: they are display ceilings, not
// serving configuration.
func servingContextWindow(modelfileNumCtx int) int {
	if modelfileNumCtx > 0 {
		return modelfileNumCtx
	}
	if override := userNumCtxOverride(); override > 0 {
		return override
	}
	return defaultServingContextWindow
}

// servingMaxOutput caps a model's per-request output budget so the wire
// max_tokens equals the reserve admission charged: the smaller of the shared
// derived safety reserve and Ollama's flat generation cap.
func servingMaxOutput(window int) int {
	return int(min(int64(DefaultMaxOutputTokens), provider.ContextSafetyReserve(int64(window))))
}

// userNumCtxOverride returns the user-declared daemon context size, or 0 when
// undeclared. Resolution order mirrors host(): credentials.json, then env.
func userNumCtxOverride() int {
	if store, err := core.NewCredentialsStore(); err == nil {
		if n := parsePositiveInt(store.GetRawKey(NumCtxCredKey)); n > 0 {
			return n
		}
	}
	return parsePositiveInt(os.Getenv("OLLAMA_NUM_CTX"))
}

func parsePositiveInt(raw string) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

// listModels replaces the standard SDK Models.List flow: each model's real
// serving window (its Modelfile num_ctx) only exists on the native /api/show
// endpoint. Per-model probe failures degrade to the conservative window
// rather than failing the whole list.
func listModels(ctx context.Context, _ string, headers map[string]string) ([]provider.ModelInfo, error) {
	names, err := listModelNames(ctx, headers)
	if err != nil {
		return nil, err
	}
	models := make([]provider.ModelInfo, 0, len(names))
	for _, name := range names {
		window := servingContextWindow(probeModelfileNumCtx(ctx, name, headers))
		models = append(models, provider.ModelInfo{
			ID:              name,
			ContextWindow:   window,
			MaxOutputTokens: servingMaxOutput(window),
			FromAPI:         true,
		})
	}
	return models, nil
}

func listModelNames(ctx context.Context, headers map[string]string) ([]string, error) {
	var tags struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := doJSON(ctx, http.MethodGet, host()+"/api/tags", headers, nil, &tags); err != nil {
		return nil, fmt.Errorf("list ollama models: %w", err)
	}
	names := make([]string, 0, len(tags.Models))
	for _, model := range tags.Models {
		if model.Name != "" {
			names = append(names, model.Name)
		}
	}
	return names, nil
}

// probeModelfileNumCtx returns the num_ctx parameter the model was created
// with, or 0 when unset or unprobeable. /api/show reports the Modelfile
// `parameters` block as flat text ("num_ctx 32768\ntemperature 0.7\n...").
func probeModelfileNumCtx(ctx context.Context, model string, headers map[string]string) int {
	var show struct {
		Parameters string `json:"parameters"`
	}
	payload, err := json.Marshal(map[string]string{"model": model})
	if err != nil {
		return 0
	}
	if err := doJSON(ctx, http.MethodPost, host()+"/api/show", headers, strings.NewReader(string(payload)), &show); err != nil {
		return 0
	}
	return parseNumCtx(show.Parameters)
}

// parseNumCtx extracts the num_ctx value from a Modelfile parameters block.
func parseNumCtx(parameters string) int {
	for _, line := range strings.Split(parameters, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "num_ctx" {
			return parsePositiveInt(fields[1])
		}
	}
	return 0
}

func doJSON(ctx context.Context, method, url string, headers map[string]string, body io.Reader, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := daemonHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s %s: %s", method, url, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
