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
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

// DefaultHost is the URL used when no explicit host is configured.
const DefaultHost = "http://localhost:11434"

// HostCredKey is the credentials.json field where the user-configured Ollama
// daemon URL lives. Set via the settings panel; read by the shared LocalHost.
const HostCredKey = "ollama_host"

// NumCtxCredKey is the credentials.json field where the user-declared daemon
// context size lives. Ollama's OpenAI-compatible /v1 endpoint cannot set the
// context size per request, and the daemon never reports its configured
// num_ctx over the API, so users who raised their daemon default
// (OLLAMA_CONTEXT_LENGTH) declare it here. Per-model Modelfile parameters
// probed from /api/show take precedence; the OLLAMA_NUM_CTX and
// OLLAMA_CONTEXT_LENGTH environment variables are read as fallbacks too.
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

// daemon describes the local Ollama server as a keyless, host-configurable
// OpenAI-compatible endpoint. The shared helper supplies host resolution, URL
// normalisation, the /v1 base URL, and the health-probe detector.
var daemon = openaibase.LocalHost{
	CredKey:     HostCredKey,
	EnvVar:      "OLLAMA_HOST",
	DefaultHost: DefaultHost,
	HealthPath:  "/api/tags",
}

// daemonHTTPClient bounds native-endpoint probes (tags/show). Local daemons
// answer in milliseconds, and listModels only runs after the health probe has
// already proven the host reachable, so a short timeout is safe — it caps the
// per-probe wait so a slow model can't stall the whole refresh (probes also run
// pooled; see maxConcurrentProbes).
var daemonHTTPClient = &http.Client{Timeout: 3 * time.Second}

// maxConcurrentProbes bounds the per-model /api/show fan-out in listModels: a
// local daemon serves one model at a time, so hitting it with the whole list at
// once buys nothing and competes with the request the user is waiting on.
const maxConcurrentProbes = 4

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		ReasoningReplayFn: reasoningReplay,
		Name:              "ollama",
		DisplayName:       "Ollama (local)",
		Description:       msg.New("Runs models locally via an Ollama daemon. The model list below mirrors whatever you have pulled (`ollama pull <name>`). Point at a non-default daemon (LAN, remote workstation) by setting the host below; otherwise defaults to http://localhost:11434. Juggler enforces the context window each model actually serves: its Modelfile num_ctx, or a conservative 4096 otherwise; declare a higher daemon default via ollama_num_ctx in credentials.json."),
		AutoDetect:        daemon.AutoDetect(),
		DisplayProvider:   "Ollama",
		ContextWindowFn:   getContextWindowInfo,
		// The model catalog and its real serving windows live on Ollama's
		// native endpoints, not the OpenAI-compatible /v1 ones.
		ListModelsOverride: listModels,
		// The override bypasses the shared list's thinking lookup, so listModels
		// fills the levels itself; this resolves the same spec for each client.
		ThinkingSpecFn: thinkingSpec,
		// Deliberately no ContextWindows: the static family catalog holds
		// training maximums, and admission must never enforce a window the
		// daemon does not serve.
		BaseURLFunc:   daemon.BaseURLFunc(),
		APIKeyDefault: "ollama", // placeholder so the OpenAI SDK accepts the request
		// Models run on the user's own hardware, so a micro-task can re-use the
		// conversation's model instead of needing a cheap tier named here — which
		// could not be named anyway, the catalog being whatever has been pulled.
		FreeToRun: true,
	})
}

// getContextWindowInfo is the static capability path, used before model
// discovery publishes live values. It cannot probe the daemon, so it reports
// the conservative serving window (the user override when declared); live
// /api/show results replace it per model once the model list is published.
func getContextWindowInfo(_ string) (int, int) {
	window := servingContextWindow(0, userNumCtxOverride())
	return window, servingMaxOutput(window)
}

// servingContextWindow resolves the context window the daemon will actually
// serve for one model — the value admission must enforce, because Ollama
// silently truncates requests that exceed it. Precedence: the model's own
// Modelfile num_ctx (per-model, deliberately configured), then the
// user-declared daemon default, then the conservative fallback. Training
// maximums (models.go) are not consulted: they are display ceilings, not
// serving configuration.
// The user override is resolved once by the caller and passed in, rather than
// re-read per model, so a model list does not re-open the credentials store and
// re-read the environment N times.
func servingContextWindow(modelfileNumCtx, override int) int {
	if modelfileNumCtx > 0 {
		return modelfileNumCtx
	}
	if override > 0 {
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
// undeclared. Resolution order mirrors the host: credentials.json, then
// OLLAMA_NUM_CTX, then OLLAMA_CONTEXT_LENGTH (the variable the daemon itself
// honors — when the daemon is local it is often visible in Juggler's
// environment).
func userNumCtxOverride() int {
	if store, err := core.NewCredentialsStore(); err == nil {
		if n := parsePositiveInt(store.GetRawKey(NumCtxCredKey)); n > 0 {
			return n
		}
	}
	if n := parsePositiveInt(os.Getenv("OLLAMA_NUM_CTX")); n > 0 {
		return n
	}
	return parsePositiveInt(os.Getenv("OLLAMA_CONTEXT_LENGTH"))
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
	// Resolve the user override once (not per model — it opens the credentials
	// store and reads the env), and probe every model's Modelfile num_ctx through
	// the shared bounded pool so a long list doesn't serialize N slow /api/show
	// calls. A failed or timed-out probe degrades to 0 (the conservative window),
	// identical to the single-probe path; the short daemon timeout plus the pool
	// bound total refresh time to roughly ceil(len/maxConcurrentProbes) probe
	// intervals.
	// The same /api/show answer carries each model's thinking support, which is
	// remembered for the clients later built for it.
	override := userNumCtxOverride()
	probes := utils.MapConcurrent(ctx, names, maxConcurrentProbes, func(ctx context.Context, name string) modelProbe {
		show, err := probeShow(ctx, name, headers)
		if err != nil {
			return modelProbe{}
		}
		spec := thinkingSpecFromShow(show.Capabilities, show.Thinking)
		rememberThinkingSpec(name, spec)
		return modelProbe{numCtx: parseNumCtx(show.Parameters), thinking: spec}
	})
	models := make([]provider.ModelInfo, 0, len(names))
	for i, name := range names {
		probe := probes[i]
		window := servingContextWindow(probe.numCtx, override)
		models = append(models, provider.ModelInfo{
			ID:              name,
			ContextWindow:   window,
			MaxOutputTokens: servingMaxOutput(window),
			FromAPI:         true,
			// Neither the Modelfile nor the user named a window, so this is the
			// conservative fallback standing in for a daemon setting nobody can
			// read back.
			WindowAssumed:        probe.numCtx <= 0 && override <= 0,
			ThinkingLevels:       probe.thinking.Options(),
			DefaultThinkingLevel: probe.thinking.Default,
		})
	}
	return models, nil
}

// modelProbe is what one /api/show answer contributes to a model's entry: its
// Modelfile num_ctx (0 when unset or unprobeable) and its thinking levels.
type modelProbe struct {
	numCtx   int
	thinking openaibase.ThinkingSpec
}

func listModelNames(ctx context.Context, headers map[string]string) ([]string, error) {
	var tags struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := doJSON(ctx, http.MethodGet, daemon.Host()+"/api/tags", headers, nil, &tags); err != nil {
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

// showRequest is the /api/show request body, built as a struct rather than an
// ad-hoc map.
type showRequest struct {
	Model string `json:"model"`
}

// showResponse is the part of /api/show listModels reads. `parameters` is the
// Modelfile parameters block as flat text ("num_ctx 32768\ntemperature 0.7\n...");
// `thinking` is absent on daemons that predate per-model thinking metadata.
type showResponse struct {
	Parameters   string              `json:"parameters"`
	Capabilities []string            `json:"capabilities"`
	Thinking     *thinkingDescriptor `json:"thinking"`
}

func probeShow(ctx context.Context, model string, headers map[string]string) (showResponse, error) {
	var show showResponse
	payload, err := json.Marshal(showRequest{Model: model})
	if err != nil {
		return show, err
	}
	err = doJSON(ctx, http.MethodPost, daemon.Host()+"/api/show", headers, strings.NewReader(string(payload)), &show)
	return show, err
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
