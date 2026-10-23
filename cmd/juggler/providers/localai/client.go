//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package localai

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
	"juggler/internal/httpx"
)

// DefaultHost is the URL used when no explicit host is configured. 8080 is
// LocalAI's own default port — the same one llama-server uses, which is why the
// two are easy to confuse from the outside. They are told apart by what answers:
// LocalAI serves a discovery document and no /health, llama-server the reverse
// (see server for why the document's body, not just its status, is checked).
const DefaultHost = "http://127.0.0.1:8080"

// HostCredKey is the credentials.json field where the user-configured LocalAI
// URL lives. Set via the settings panel; read by the shared LocalHost.
const HostCredKey = "localai_host"

// DefaultContextWindow is advertised for a model the server describes no window
// for: an install predating the capabilities endpoint, or a backend it reports
// nothing about. It matches LocalAI's own default effective context, so it is
// the right answer more often than not — but it is still a fallback, published
// with FromAPI false so the UI can say the number was assumed.
//
// A window is load-bearing twice over: the output reserve is derived from it,
// so understating it also caps every reply at a fraction of what the model
// could give.
const DefaultContextWindow = 8192

// server describes LocalAI as a keyless, host-configurable OpenAI-compatible
// endpoint. The shared helper supplies host resolution, URL normalisation, the
// /v1 base URL, and the detection probe.
//
// HealthPath is the discovery document rather than a health route, because
// detection here has to answer "is this LocalAI" and not merely "is something
// listening on 8080". The status code cannot answer that: llama-server
// answers 404 there, but LM Studio answers 200 to every path it does not
// implement. So the body has to be LocalAI's own document (isDiscoveryDocument),
// which is what keeps LocalAI from claiming another server.
var server = openaibase.LocalHost{
	CredKey:     HostCredKey,
	EnvVar:      "LOCALAI_HOST",
	DefaultHost: DefaultHost,
	HealthPath:  "/.well-known/localai.json",
	ValidBody:   isDiscoveryDocument,
}

// isDiscoveryDocument reports whether body is LocalAI's discovery document.
// LocalAI's handler writes "endpoints" and "capabilities" as objects on every
// response, in every release that serves the route; the key sets inside them
// grow over time, so only their presence and shape are checked.
func isDiscoveryDocument(body []byte) bool {
	var doc struct {
		Endpoints    map[string]json.RawMessage `json:"endpoints"`
		Capabilities map[string]json.RawMessage `json:"capabilities"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return false
	}
	return doc.Endpoints != nil && doc.Capabilities != nil
}

// probeClient bounds the model-list and capabilities reads. Both are cheap
// metadata reads a local server answers in milliseconds; the timeout caps the
// wait when the server dies mid-listing.
var probeClient = httpx.Client(3 * time.Second)

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		ReasoningReplayFn: reasoningReplay,
		Name:              "localai",
		DisplayName:       "LocalAI (local)",
		Description:       msg.New("Runs models locally through LocalAI's OpenAI-compatible API. Start LocalAI yourself first (Juggler doesn't launch it); point at a non-default host (LAN, remote box, custom port) below, otherwise defaults to http://127.0.0.1:8080. Each model's context window is read from the server, which needs LocalAI v4.10.0 or later; before that, and for a model it describes no window for, Juggler assumes 8192 and says so. Using LM Studio? Use the LM Studio (local) provider instead."),
		AutoDetect:        server.AutoDetect(),
		Successor:         successor,
		// LocalAI states a window per model on its own route, which the OpenAI
		// model list carries nothing of.
		DisplayProvider:    "LocalAI",
		ContextWindowFn:    getContextWindowInfo,
		ListModelsOverride: listModels,
		BaseURLFunc:        server.BaseURLFunc(),
		APIKeyDefault:      "localai", // placeholder so the OpenAI SDK accepts the request
		// Served off the user's own hardware at no per-token cost, so a
		// micro-task re-uses the conversation's model rather than needing a cheap
		// tier from a catalog LocalAI doesn't have.
		FreeToRun: true,
	})
}

// getContextWindowInfo resolves the window the server will serve for one model,
// falling back to DefaultContextWindow when it describes none.
//
// Max output tokens is left at 0 (unknown): LocalAI has no output ceiling
// distinct from the context window, so the caller derives the shared safety
// reserve from the window instead.
func getContextWindowInfo(modelID string) (int, int) {
	rows := openaibase.FetchModelCapabilities(context.Background(), baseURL(), "", nil)
	if window := openaibase.CapabilityWindows(rows)[modelID]; window > 0 {
		return window, 0
	}
	return DefaultContextWindow, 0
}

// listModels publishes the models the server hosts that can hold a
// conversation, each with the window it will actually be served with.
//
// Two reads, whatever the model count: the ids from the OpenAI-compatible list,
// and one capabilities call describing all of them. The capabilities row is
// load-bearing twice — it carries the only context window LocalAI publishes,
// and the only statement of what a model is FOR. Without the second, a list of
// chat models includes the box's text-to-speech voices.
func listModels(ctx context.Context, credential string, headers map[string]string) ([]provider.ModelInfo, error) {
	ids, err := fetchModelIDs(ctx, credential, headers)
	if err != nil {
		return nil, err
	}
	described := make(map[string]openaibase.ModelCapability)
	for _, row := range openaibase.FetchModelCapabilities(ctx, baseURL(), credential, headers) {
		described[row.ID] = row
	}

	models := make([]provider.ModelInfo, 0, len(ids))
	for _, id := range ids {
		row, ok := described[id]
		if ok && !servesConversation(row) {
			continue
		}
		// Only a window the server actually reported counts as API-sourced; the
		// constant is a fallback and is labelled as one.
		window, fromAPI := row.ContextSize, row.ContextSize > 0
		if !fromAPI {
			window = DefaultContextWindow
		}
		models = append(models, provider.ModelInfo{
			ID:            id,
			DisplayName:   utils.ModelDisplayName(id),
			ContextWindow: window,
			FromAPI:       fromAPI,
			WindowAssumed: !fromAPI,
		})
	}
	return models, nil
}

// servesConversation reports whether this model belongs in a list of models to
// talk to. LocalAI hosts voices, image generators and rerankers on the same
// endpoint as its chat models, and publishes all of them in one flat list;
// anything that cannot take a chat request would sit in the model picker
// waiting to fail on first use.
//
// Embeddings models stay: on LocalAI the same llama.cpp backend serves both, so
// the capability is an addition rather than an exclusion. A model that declares
// no capabilities at all is kept too — see ModelCapability.Serves.
func servesConversation(row openaibase.ModelCapability) bool {
	return row.Serves("chat") || row.Serves("embeddings")
}

// baseURL is the configured host with the OpenAI-compatible /v1 prefix the
// metadata routes live under, resolved fresh so a host change in settings takes
// effect without a restart.
func baseURL() string { return server.Host() + "/v1" }

// fetchModelIDs reads the ids the server hosts from the OpenAI-compatible model
// list. The rows carry nothing else — LocalAI's model type is an id and an
// object kind — so everything else a listing needs comes from elsewhere.
func fetchModelIDs(ctx context.Context, credential string, headers map[string]string) ([]string, error) {
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	opts := utils.JSONGetOptions{
		Bearer:  credential,
		Headers: headers,
		Label:   "LocalAI /v1/models",
		Client:  probeClient,
	}
	if err := utils.GetJSON(ctx, baseURL()+"/models", opts, &body); err != nil {
		return nil, fmt.Errorf("list LocalAI models: %w", err)
	}
	ids := make([]string, 0, len(body.Data))
	for _, row := range body.Data {
		ids = append(ids, row.ID)
	}
	return ids, nil
}
