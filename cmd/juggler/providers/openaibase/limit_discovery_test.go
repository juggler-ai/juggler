//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/providers/utils"
)

// TestDiscoverLimits runs one recorded row per server shape we have evidence
// for. Each `raw` is the row as that server publishes it, trimmed of the fields
// that carry no limits, so the case names the vendor it protects and a change
// in one shape cannot quietly alter another.
func TestDiscoverLimits(t *testing.T) {
	tests := []struct {
		name       string
		raw        string
		wantWindow int
		wantOutput int
	}{{
		name:       "vLLM publishes the serving window",
		raw:        `{"id":"Qwen/Qwen3-30B","object":"model","owned_by":"vllm","root":"Qwen/Qwen3-30B","parent":null,"max_model_len":131072}`,
		wantWindow: 131072,
	}, {
		name: "vLLM LoRA row carries no window of its own",
		raw:  `{"id":"adapter","object":"model","parent":"Qwen/Qwen3-30B","max_model_len":null}`,
	}, {
		// n_ctx is the slot window the server is running with; n_ctx_train is
		// what the checkpoint could take. Only the first is a promise.
		name:       "llama.cpp prefers the slot window over the training window",
		raw:        `{"id":"model.gguf","object":"model","owned_by":"llamacpp","meta":{"n_ctx":8192,"n_ctx_train":131072,"n_vocab":128256,"n_params":8030261312}}`,
		wantWindow: 8192,
	}, {
		name:       "llama.cpp falls back to the training window",
		raw:        `{"id":"model.gguf","object":"model","meta":{"n_ctx_train":131072,"n_embd":4096}}`,
		wantWindow: 131072,
	}, {
		name: "llama.cpp row with no meta at all",
		raw:  `{"id":"model.gguf","object":"model","meta":null}`,
	}, {
		// The architectural max overstates a model loaded at a smaller window.
		name:       "LM Studio prefers the loaded window over the architecture max",
		raw:        `{"id":"google/gemma-3-4b","object":"model","type":"vlm","state":"loaded","max_context_length":131072,"loaded_context_length":12918}`,
		wantWindow: 12918,
	}, {
		name:       "LM Studio unloaded model reports its architecture max",
		raw:        `{"id":"google/gemma-3-4b","object":"model","state":"not-loaded","max_context_length":131072,"loaded_context_length":null}`,
		wantWindow: 131072,
	}, {
		name:       "Groq",
		raw:        `{"id":"llama-3.1-8b-instant","object":"model","owned_by":"Meta","active":true,"context_window":131072,"max_completion_tokens":8192}`,
		wantWindow: 131072,
		wantOutput: 8192,
	}, {
		name:       "Together",
		raw:        `{"id":"Austism/chronos-hermes-13b","object":"model","type":"chat","context_length":2048}`,
		wantWindow: 2048,
	}, {
		name:       "Mistral",
		raw:        `{"id":"mistral-large-2512","object":"model","capabilities":{"completion_chat":true},"max_context_length":256000}`,
		wantWindow: 256000,
	}, {
		name:       "Moonshot",
		raw:        `{"id":"kimi-k3","object":"model","owned_by":"moonshot","context_length":1048576,"supports_image_in":true,"supports_reasoning":true}`,
		wantWindow: 1048576,
	}, {
		name:       "xAI",
		raw:        `{"id":"grok-420-reasoning","object":"model","owned_by":"xai","context_length":256000,"long_context_threshold":128000}`,
		wantWindow: 256000,
		// long_context_threshold is a pricing boundary, not a limit.
		wantOutput: 0,
	}, {
		name:       "DeepInfra nests both under metadata",
		raw:        `{"id":"deepseek-ai/DeepSeek-V4","object":"model","owned_by":"deepinfra","metadata":{"context_length":1000000,"max_tokens":384000,"tags":["chat"]}}`,
		wantWindow: 1000000,
		wantOutput: 384000,
	}, {
		name:       "LiteLLM",
		raw:        `{"id":"gpt-4o","object":"model","created":1677610602,"owned_by":"openai","max_input_tokens":128000,"max_output_tokens":16384}`,
		wantWindow: 128000,
		wantOutput: 16384,
	}, {
		name: "Copilot nests limits under capabilities",
		raw:  `{"id":"gpt-5","name":"GPT-5","vendor":"Azure OpenAI","capabilities":{"limits":{"max_context_window_tokens":264000,"max_prompt_tokens":128000,"max_output_tokens":64000},"supports":{"tool_calls":true}}}`,
		// max_prompt_tokens is the enforceable input ceiling; the advertised
		// window above it is documented as not fully usable.
		wantWindow: 128000,
		wantOutput: 64000,
	}, {
		name:       "Fireworks control plane uses camelCase",
		raw:        `{"id":"accounts/fireworks/models/deepseek-v4-pro","contextLength":1048576,"trainingContextLength":1048576}`,
		wantWindow: 1048576,
	}, {
		name:       "OpenRouter takes the routed provider's smaller window",
		raw:        `{"id":"openai/gpt-4","context_length":8192,"top_provider":{"context_length":4096,"max_completion_tokens":2048}}`,
		wantWindow: 4096,
		wantOutput: 2048,
	}, {
		name:       "Gemini",
		raw:        `{"name":"models/gemini-3.8-flash","inputTokenLimit":1048576,"outputTokenLimit":65536}`,
		wantWindow: 1048576,
		wantOutput: 65536,
	}, {
		name: "OpenAI publishes nothing but an id",
		raw:  `{"id":"gpt-5.6-sol","object":"model","created":1677610602,"owned_by":"openai"}`,
	}, {
		name: "DeepSeek publishes nothing but an id",
		raw:  `{"id":"deepseek-v4-pro","object":"model","owned_by":"deepseek"}`,
	}, {
		name: "Ollama's OpenAI route publishes nothing but an id",
		raw:  `{"id":"llama3.2:latest","object":"model","created":1739000000,"owned_by":"library"}`,
	}, {
		// The dangerous field: it is the output cap next to a window, and the
		// context window on DeepInfra's native list. With a window present the
		// reading is unambiguous.
		name:       "a bare max_tokens beside a window is the output cap",
		raw:        `{"id":"claude-opus-5","max_input_tokens":1000000,"max_tokens":128000}`,
		wantWindow: 1000000,
		wantOutput: 128000,
	}, {
		name: "a bare max_tokens alone is too ambiguous to use",
		raw:  `{"id":"some-model","max_tokens":128000}`,
	}, {
		name: "zero is not a limit",
		raw:  `{"id":"claude-opus-5","max_input_tokens":0,"max_tokens":0}`,
	}, {
		name: "null is not a limit",
		raw:  `{"id":"grok-4","context_length":null}`,
	}, {
		name: "a negative window is not a limit",
		raw:  `{"id":"broken","context_length":-1}`,
	}, {
		name: "a window that is not a number is not a limit",
		raw:  `{"id":"broken","context_length":"131072"}`,
	}, {
		name: "an unparseable row is not a limit",
		raw:  `{"id":"broken",`,
	}, {
		name: "an empty row is not a limit",
		raw:  ``,
	}}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := DiscoverLimits(tc.raw)
			if got.ContextWindow != tc.wantWindow {
				t.Errorf("ContextWindow = %d, want %d", got.ContextWindow, tc.wantWindow)
			}
			if got.MaxOutput != tc.wantOutput {
				t.Errorf("MaxOutput = %d, want %d", got.MaxOutput, tc.wantOutput)
			}
			wantSource := utils.LimitSourceUnknown
			if tc.wantWindow > 0 {
				wantSource = utils.LimitSourceEndpoint
			}
			if got.Source != wantSource {
				t.Errorf("Source = %q, want %q", got.Source, wantSource)
			}
		})
	}
}

// TestCatalogDefaultDoesNotClampADiscoveredOutputCap guards the other half of
// discovery: a number the endpoint published has to survive all the way to the
// wire. The client clamps its output cap down to the descriptor catalog's
// ceiling, which is right for a model the catalog KNOWS — but a provider-wide
// default is not knowledge about a model, and clamping to it would throw away
// the larger cap the endpoint reported for that exact id, which is the whole
// number we went to discovery to get.
func TestCatalogDefaultDoesNotClampADiscoveredOutputCap(t *testing.T) {
	desc := Descriptor{
		Name:              "discovery-test",
		ContextWindowCaps: utils.ModelCaps{Default: 128000},
		MaxOutputCaps:     utils.ModelCaps{Default: 16384, Overrides: map[string]int{"catalogued": 32768}},
	}
	lookup := catalogMaxOutputLookup(desc, true)

	// The snapshot the server builds from a published listing: an endpoint that
	// reported 64000 output on a 200000 window.
	newClient := func(model string) *Client {
		return &Client{model: model, maxOutputTokens: 64000, catalogMaxOutput: lookup}
	}

	if got := newClient("endpoint-only").effectiveMaxOutputTokens(provider.MessageRequest{}); got != 64000 {
		t.Errorf("uncatalogued model: wire cap = %d, want the discovered 64000 — a provider-wide default must not override it", got)
	}
	// A per-model entry is a real statement about that model, so it still wins:
	// a snapshot above a known ceiling is a hard 400 on the wire.
	if got := newClient("catalogued").effectiveMaxOutputTokens(provider.MessageRequest{}); got != 32768 {
		t.Errorf("catalogued model: wire cap = %d, want the catalogued ceiling 32768", got)
	}
}

// TestCatalogFallbackDoesNotClampTheWire: a fallback catalogue (third-party
// data, such as the models.dev snapshot custom endpoints consult) sizes a model
// and stops it being called assumed, but it is not a ceiling the server
// enforces. Clamping the wire to it would undo a larger cap the user set by
// hand on the strength of somebody else's table.
func TestCatalogFallbackDoesNotClampTheWire(t *testing.T) {
	desc := Descriptor{
		Name:              "fallback-test",
		ContextWindowCaps: utils.ModelCaps{Default: 128000},
		MaxOutputCaps: utils.ModelCaps{Default: 16384, Fallback: func(string) (int, bool) {
			return 8192, true
		}},
	}
	client := &Client{model: "catalogued-elsewhere", maxOutputTokens: 64000, catalogMaxOutput: catalogMaxOutputLookup(desc, true)}
	if got := client.effectiveMaxOutputTokens(provider.MessageRequest{}); got != 64000 {
		t.Errorf("wire cap = %d, want the snapshot's 64000 — a fallback catalogue is not a ceiling", got)
	}
}

// modelsListClient answers GET /models with the given body and nothing else.
func modelsListClient(body string) *http.Client {
	return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		header := make(http.Header)
		header.Set("Content-Type", "application/json")
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     header,
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	})}
}

// TestListModelsPrefersEndpointLimits is the whole point of endpoint discovery:
// a server that publishes its own limits is describing the machine that will
// serve the request, so it outranks anything compiled in. The catalog function
// here deliberately answers a wrong 128000/16384 for every id, so any model
// that comes back with those numbers was sized by a guess rather than by the
// endpoint.
//
// The ids-only row is the control. Most vendors (OpenAI, DeepSeek, z.ai) return
// nothing but an id, and for those the catalog is still the only answer — and
// FromAPI must say so, since it is what tells the UI whether a number was
// measured or assumed.
func TestListModelsPrefersEndpointLimits(t *testing.T) {
	body := `{"object":"list","data":[
		{"id":"vllm-served","object":"model","owned_by":"vllm","max_model_len":131072},
		{"id":"together-served","object":"model","context_length":262144},
		{"id":"litellm-served","object":"model","max_input_tokens":200000,"max_output_tokens":64000},
		{"id":"ids-only","object":"model","owned_by":"openai"}
	]}`

	client, err := NewClient(Config{
		APIKey:     "key",
		Model:      "vllm-served",
		BaseURL:    "https://example.test",
		HTTPClient: modelsListClient(body),
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	infos, err := client.ListModelsWithInfo(context.Background(),
		func(string) bool { return true },
		func(string) (int, int) { return 128000, 16384 },
		nil, nil, nil, "test")
	if err != nil {
		t.Fatalf("ListModelsWithInfo: %v", err)
	}

	byID := map[string]provider.ModelInfo{}
	for _, info := range infos {
		byID[info.ID] = info
	}

	want := map[string]struct {
		contextWindow   int
		maxOutputTokens int
		fromAPI         bool
	}{
		// vLLM publishes the serving window and no output cap, so the window is
		// measured and the cap still comes from the catalog.
		"vllm-served":     {131072, 16384, true},
		"together-served": {262144, 16384, true},
		// LiteLLM publishes both, so neither number is a guess.
		"litellm-served": {200000, 64000, true},
		// Nothing to discover: the catalog answers, and says that it did.
		"ids-only": {128000, 16384, false},
	}
	for id, expected := range want {
		got, ok := byID[id]
		if !ok {
			t.Errorf("%s: missing from the listing", id)
			continue
		}
		if got.ContextWindow != expected.contextWindow {
			t.Errorf("%s: ContextWindow = %d, want %d", id, got.ContextWindow, expected.contextWindow)
		}
		if got.MaxOutputTokens != expected.maxOutputTokens {
			t.Errorf("%s: MaxOutputTokens = %d, want %d", id, got.MaxOutputTokens, expected.maxOutputTokens)
		}
		if got.FromAPI != expected.fromAPI {
			t.Errorf("%s: FromAPI = %v, want %v", id, got.FromAPI, expected.fromAPI)
		}
	}
}
