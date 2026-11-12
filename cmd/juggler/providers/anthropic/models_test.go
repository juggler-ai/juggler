//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	anthropicsdk "github.com/anthropics/anthropic-sdk-go"

	"juggler/cmd/juggler/providers/provider"
)

// TestGetContextWindow pins the offline window, including the generation-5
// lineup's 1M. Reporting 200k for a 1M model is not a cosmetic error: it is what
// the compaction trigger measures against, so it folds history at a fifth of the
// real capacity.
func TestGetContextWindow(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		{"claude-fable-5-2", 1000000},
		{"claude-mythos-5-2", 1000000},
		{"claude-opus-5-5", 1000000},
		{"claude-sonnet-5-5", 1000000},
		// Haiku joined the lineup at 5.5. A family list naming only the
		// frontier families sizes it at 200000 offline.
		{"claude-haiku-5-5", 1000000},
		{"claude-haiku-5-5-20261007", 1000000},
		{"claude-fable-5-1", 1000000},
		{"claude-mythos-5-1", 1000000},
		{"claude-fable-5", 1000000},
		{"claude-mythos-5", 1000000},
		{"claude-opus-5", 1000000},
		{"claude-sonnet-5", 1000000},
		// The 1M window arrives at 4.6, not at 5. A gate that starts at
		// generation 5 sizes these four at 200000 — a fifth of the truth — and
		// the only symptom is history folded long before it had to be.
		{"claude-opus-4-8", 1000000},
		{"claude-opus-4-7", 1000000},
		{"claude-opus-4-6", 1000000},
		{"claude-sonnet-4-6", 1000000},
		{"claude-opus-4-7-20260210", 1000000},
		// 4.5 and below stayed at 200000.
		{"claude-opus-4-5", 200000},
		{"claude-sonnet-4-5-20250929", 200000},
		{"claude-haiku-4-5-20251001", 200000},
		{"some-future-model", DefaultContextWindow},
		{"", DefaultContextWindow},
	}
	for _, tc := range cases {
		if got := GetContextWindow(tc.model); got != tc.want {
			t.Errorf("GetContextWindow(%q) = %d, want %d", tc.model, got, tc.want)
		}
	}
}

// TestSupportsImageInput pins that the classifier keys on the generation rather
// than on a list of family names — the shape that answered "no" for Fable and
// Mythos purely because it had never been told those names.
func TestSupportsImageInput(t *testing.T) {
	yes := []string{
		"claude-3-5-sonnet-20241022", "claude-3-opus-20240229",
		"claude-sonnet-4-5-20250929", "claude-4.5-sonnet",
		"claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5",
	}
	no := []string{"claude-mythos-preview", "some-future-model", ""}
	for _, m := range yes {
		if !SupportsImageInput(m) {
			t.Errorf("SupportsImageInput(%q) = false, want true", m)
		}
	}
	for _, m := range no {
		if SupportsImageInput(m) {
			t.Errorf("SupportsImageInput(%q) = true, want false", m)
		}
	}
}

// TestModelInfoFromAPIPrefersAPIValues pins that a Models API response is
// believed over the static catalog. The response carries max_input_tokens,
// max_tokens and a capabilities object; the catalog can only ever infer those
// from the id, and infers them wrongly for any model whose family or generation
// it predates. Decoding real JSON rather than building the struct is deliberate:
// the presence flags this reads (respjson.Field.Valid) are only set by the
// decoder, so a hand-built struct would not exercise the branch.
func TestModelInfoFromAPIPrefersAPIValues(t *testing.T) {
	var model anthropicsdk.ModelInfo
	payload := `{
		"type": "model",
		"id": "claude-fable-5-1",
		"display_name": "Claude Fable 5.1",
		"max_input_tokens": 1000000,
		"max_tokens": 128000,
		"capabilities": {
			"image_input": {"supported": true},
			"thinking": {"supported": true, "types": {"adaptive": {"supported": true}, "enabled": {"supported": false}}}
		}
	}`
	if err := json.Unmarshal([]byte(payload), &model); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	info := modelInfoFromAPI(model)
	if info.ContextWindow != 1000000 {
		t.Errorf("ContextWindow = %d, want 1000000", info.ContextWindow)
	}
	if info.MaxOutputTokens != 128000 {
		t.Errorf("MaxOutputTokens = %d, want 128000", info.MaxOutputTokens)
	}
	if !info.FromAPI {
		t.Error("FromAPI = false, want true when the API states the window")
	}
	if info.DisplayName != "Claude Fable 5.1" {
		t.Errorf("DisplayName = %q, want the API's own label", info.DisplayName)
	}
	if len(info.InputModalities) != 2 {
		t.Errorf("InputModalities = %v, want text+image", info.InputModalities)
	}
	if len(info.ThinkingLevels) == 0 {
		t.Error("ThinkingLevels empty, want the effort ladder for a thinking model")
	}
}

// TestModelInfoFromAPIContradictingCatalog pins the direction of authority: when
// the API and the catalog disagree, the API wins. The catalog reads this id as a
// thinking, image-capable generation-5 model; the response says otherwise, and
// the response is the one that knows.
func TestModelInfoFromAPIContradictingCatalog(t *testing.T) {
	var model anthropicsdk.ModelInfo
	payload := `{
		"type": "model",
		"id": "claude-fable-5-1",
		"max_input_tokens": 200000,
		"max_tokens": 8192,
		"capabilities": {
			"image_input": {"supported": false},
			"thinking": {"supported": false, "types": {"adaptive": {"supported": false}, "enabled": {"supported": false}}}
		}
	}`
	if err := json.Unmarshal([]byte(payload), &model); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	info := modelInfoFromAPI(model)
	if info.ContextWindow != 200000 || info.MaxOutputTokens != 8192 {
		t.Errorf("limits = %d/%d, want the API's 200000/8192 over the catalog's 1000000/128000",
			info.ContextWindow, info.MaxOutputTokens)
	}
	if len(info.InputModalities) != 0 {
		t.Errorf("InputModalities = %v, want none when the API denies image input", info.InputModalities)
	}
	if len(info.ThinkingLevels) != 0 {
		t.Errorf("ThinkingLevels = %v, want none when the API denies thinking", info.ThinkingLevels)
	}
}

// TestModelInfoFromAPIFallsBackPerField pins that each field falls back on its
// own. A response stating limits but omitting capabilities must keep its limits
// and derive only the capabilities; a response omitting everything must fall
// back wholesale and say so via FromAPI.
func TestModelInfoFromAPIFallsBackPerField(t *testing.T) {
	t.Run("limits present, capabilities absent", func(t *testing.T) {
		var model anthropicsdk.ModelInfo
		payload := `{"type":"model","id":"claude-fable-5-1","max_input_tokens":1000000,"max_tokens":128000}`
		if err := json.Unmarshal([]byte(payload), &model); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		info := modelInfoFromAPI(model)
		if info.ContextWindow != 1000000 || !info.FromAPI {
			t.Errorf("window = %d (fromAPI %t), want the stated 1000000", info.ContextWindow, info.FromAPI)
		}
		if len(info.ThinkingLevels) == 0 || len(info.InputModalities) == 0 {
			t.Error("capabilities not derived from the catalog when the response omits them")
		}
	})

	t.Run("bare response falls back wholesale", func(t *testing.T) {
		var model anthropicsdk.ModelInfo
		if err := json.Unmarshal([]byte(`{"type":"model","id":"claude-3-opus-20240229"}`), &model); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		info := modelInfoFromAPI(model)
		if info.FromAPI {
			t.Error("FromAPI = true, want false when the response states no window")
		}
		if info.ContextWindow != 200000 || info.MaxOutputTokens != 4096 {
			t.Errorf("limits = %d/%d, want the catalog's 200000/4096",
				info.ContextWindow, info.MaxOutputTokens)
		}
		if len(info.ThinkingLevels) != 0 {
			t.Errorf("ThinkingLevels = %v, want none for Claude 3 Opus", info.ThinkingLevels)
		}
		if info.DisplayName == "" {
			t.Error("DisplayName empty, want one derived from the id")
		}
	})
}

// TestGetMaxOutputTokens pins the per-model output ceiling. The provider used to
// hardcode 8192 for every model, which (a) silently truncated Sonnet/Opus 4.x
// responses (32k–64k) at 8192 and (b) exceeded the 4096 ceiling of the Claude 3
// (non-3.5) models, producing a hard 400 on every request. The detection must be
// robust to the dated model ids the Models API actually returns.
func TestGetMaxOutputTokens(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		// Claude 3 (non-3.5): 4096 — the ids that 400'd on max_tokens=8192.
		{"claude-3-opus-20240229", 4096},
		{"claude-3-opus", 4096},
		{"claude-3-haiku-20240307", 4096},
		{"claude-3-sonnet-20240229", 4096},
		// Claude 3.5 / 3.7 Sonnet & Haiku.
		{"claude-3-5-sonnet-20241022", 8192},
		{"claude-3-5-sonnet-20240620", 8192},
		{"claude-3-5-haiku-20241022", 8192},
		{"claude-3-7-sonnet-20250219", 64000},
		// Claude 4.x — dated API ids AND short aliases (both naming orders) resolve.
		{"claude-sonnet-4-20250514", 64000},
		{"claude-sonnet-4-5-20250929", 64000},
		{"claude-sonnet-4.5", 64000},
		{"claude-4.5-sonnet", 64000},
		{"claude-haiku-4-5-20251001", 64000},
		{"claude-opus-4-20250514", 32000},
		{"claude-opus-4-1-20250805", 32000},
		// 4.6 raised the ceiling to 128000 along with the window. The family
		// ladder below answers 32000 for an Opus and 64000 for a Sonnet, which
		// truncates a long answer at a quarter of what the model would give.
		{"claude-opus-4-8", 128000},
		{"claude-opus-4-7", 128000},
		{"claude-opus-4-6", 128000},
		{"claude-sonnet-4-6", 128000},
		// Generation 5 shares one ceiling across every family, including the two
		// (Fable, Mythos) that no family ladder keyed on opus/sonnet/haiku sees.
		{"claude-fable-5-1", 128000},
		{"claude-mythos-5-1", 128000},
		{"claude-opus-5", 128000},
		{"claude-sonnet-5", 128000},
		{"claude-fable-5-2", 128000},
		{"claude-opus-5-5", 128000},
		{"claude-sonnet-5-5", 128000},
		{"claude-haiku-5-5", 128000},
		// Unknown / empty → conservative default (never below a known model's min).
		// A generation past the catalog's knowledge stays here rather than
		// inheriting generation 5's ceiling: too high is a hard 400 per request.
		{"claude-sonnet-6", defaultMaxOutputTokens},
		{"some-future-model", defaultMaxOutputTokens},
		{"", defaultMaxOutputTokens},
	}
	for _, tc := range cases {
		if got := GetMaxOutputTokens(tc.model); got != tc.want {
			t.Errorf("GetMaxOutputTokens(%q) = %d, want %d", tc.model, got, tc.want)
		}
	}
}

// TestBuildMessageParamsGeneration5 pins the whole wire shape for the
// generation-5 lineup, where getting it wrong is a hard 400 rather than a
// degradation. Thinking is adaptive and always on: the manual form
// (thinking.type "enabled" with budget_tokens) is rejected, as is
// thinking.type "disabled". Effort is the only depth control, and max_tokens
// must reach the real 128k ceiling rather than the 8k an unrecognised id
// defaults to.
func TestBuildMessageParamsGeneration5(t *testing.T) {
	for _, model := range []string{"claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5"} {
		t.Run(model, func(t *testing.T) {
			c := &Client{model: model}
			params := c.buildMessageParams(provider.MessageRequest{
				Messages:      []provider.Message{{Type: "user", Content: "hi"}},
				ThinkingLevel: "high",
			})
			if params.MaxTokens != 128000 {
				t.Errorf("MaxTokens = %d, want 128000", params.MaxTokens)
			}
			if params.Thinking.OfAdaptive == nil {
				t.Error("thinking is not the adaptive form; the manual form is a 400 here")
			}
			if got := params.Thinking.GetBudgetTokens(); got != nil {
				t.Errorf("budget_tokens = %v, want none (rejected on this generation)", *got)
			}
			if got := string(params.OutputConfig.Effort); got != "high" {
				t.Errorf("effort = %q, want \"high\"", got)
			}
		})
	}
}

// TestBuildMessageParamsGeneration5ThinkingOff pins what "off" means on a model
// that cannot stop thinking. It must never become thinking.type "disabled" or
// the manual budget form — both are a 400 here — and it must not carry an
// effort, since no level was asked for. But the adaptive config still goes out,
// because it is what carries block_binding, and without that a thinking block
// whose prefix moved fails the whole request instead of being dropped.
func TestBuildMessageParamsGeneration5ThinkingOff(t *testing.T) {
	c := &Client{model: "claude-fable-5-1"}
	params := c.buildMessageParams(provider.MessageRequest{
		Messages:      []provider.Message{{Type: "user", Content: "hi"}},
		ThinkingLevel: "off",
	})
	if params.Thinking.GetBudgetTokens() != nil {
		t.Error("manual thinking budget sent, which this model rejects with a 400")
	}
	if got := string(params.OutputConfig.Effort); got != "" {
		t.Errorf("effort = %q, want unset — no level asked for thinking", got)
	}
	if params.Thinking.OfAdaptive == nil {
		t.Fatal("adaptive config omitted, so block_binding never goes out")
	}
	if got := params.Thinking.OfAdaptive.BlockBinding.PrefixMismatchBehavior; got != "drop_block" {
		t.Errorf("prefix_mismatch_behavior = %q, want \"drop_block\"", got)
	}
	// Not "summarized" — no reasoning was asked for — and not left to the
	// model's own default, which is "omitted" and returns every thinking block
	// emptied. See TestThinkingDisplayScope.
	if got := string(params.Thinking.OfAdaptive.Display); got != "updates" {
		t.Errorf("display = %q, want \"updates\" at level \"off\"", got)
	}
}

// TestThinkingDisplayScope pins what each model/level pair asks to be shown.
//
// The case that matters is "off" on a model that cannot stop thinking. Its
// default display is "omitted", which returns every thinking block stripped of
// its text — so a turn that spends minutes between tool calls shows nothing and
// reads as a hang. "updates" returns the short progress lines and still withholds
// the reasoning, which is what "off" was asking for. A model that CAN be quiet
// is not given a display at all at "off": it simply does not think, so there is
// nothing to show and nothing to ask for.
func TestThinkingDisplayScope(t *testing.T) {
	const updatesBeta = "thinking-display-updates-2026-08-18"
	hasBeta := func(params anthropicsdk.BetaMessageNewParams) bool {
		for _, b := range params.Betas {
			if string(b) == updatesBeta {
				return true
			}
		}
		return false
	}

	cases := []struct {
		name, model, level string
		wantDisplay        string
	}{
		{"always-thinking at off shows progress, not reasoning", "claude-fable-5-1", "off", "updates"},
		{"always-thinking with a level shows reasoning", "claude-fable-5-1", "high", "summarized"},
		{"Opus 5.5 always thinks, so off shows progress", "claude-opus-5-5", "off", "updates"},
		{"optional-thinking with a level shows reasoning", "claude-opus-4-7-20260210", "high", "summarized"},
		{"optional-thinking at off asks for nothing", "claude-opus-4-7-20260210", "off", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Client{model: tc.model}
			params := c.buildMessageParams(provider.MessageRequest{
				Messages:      []provider.Message{{Type: "user", Content: "hi"}},
				ThinkingLevel: tc.level,
			})
			got := ""
			if params.Thinking.OfAdaptive != nil {
				got = string(params.Thinking.OfAdaptive.Display)
			}
			if got != tc.wantDisplay {
				t.Errorf("display = %q, want %q", got, tc.wantDisplay)
			}
			// "updates" is beta-gated; the value and its beta must never come apart.
			if want := tc.wantDisplay == "updates"; hasBeta(params) != want {
				t.Errorf("%s beta sent = %t, want %t", updatesBeta, hasBeta(params), want)
			}
		})
	}
}

// TestBlockBindingScope pins which models the drop_block safety net reaches, and
// which are deliberately left alone.
//
// The net matters because Juggler replays every signed thinking block from every
// earlier turn, and moves the prefix those blocks are bound to on ordinary paths
// (a live-rendered pinned file, a tool arriving mid-conversation, a compaction
// fold). Without it the default is a 400 that fails the whole request.
//
// It is NOT extended to "off" on a model that can be quiet: there, omitting the
// thinking config is how "no thinking" is said, and sending one to carry
// block_binding would buy the safety net by turning thinking on — and paying for
// it — on turns that asked for none.
func TestBlockBindingScope(t *testing.T) {
	const beta = "thinking-binding-controls-2026-08-01"
	hasBeta := func(params anthropicsdk.BetaMessageNewParams) bool {
		for _, b := range params.Betas {
			if string(b) == beta {
				return true
			}
		}
		return false
	}

	cases := []struct {
		name, model, level string
		wantBinding        bool
	}{
		{"always-thinking model at off", "claude-fable-5-1", "off", true},
		{"always-thinking model with a level", "claude-fable-5-1", "high", true},
		{"Opus 5.5 always thinks, so off still binds", "claude-opus-5-5", "off", true},
		{"optional-thinking model with a level", "claude-opus-4-7-20260210", "high", true},
		{"optional-thinking model at off keeps its silence", "claude-opus-4-7-20260210", "off", false},
		{"manual-thinking model is a different wire form", "claude-sonnet-4-5-20250929", "high", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Client{model: tc.model}
			params := c.buildMessageParams(provider.MessageRequest{
				Messages:      []provider.Message{{Type: "user", Content: "hi"}},
				ThinkingLevel: tc.level,
			})
			gotBinding := params.Thinking.OfAdaptive != nil &&
				params.Thinking.OfAdaptive.BlockBinding.PrefixMismatchBehavior == "drop_block"
			if gotBinding != tc.wantBinding {
				t.Errorf("block binding sent = %t, want %t", gotBinding, tc.wantBinding)
			}
			// The field is meaningless without the beta that enables it, so the
			// two must never come apart.
			if got := hasBeta(params); got != tc.wantBinding {
				t.Errorf("%s beta sent = %t, want %t", beta, got, tc.wantBinding)
			}
		})
	}
}

// TestSupportsForcedToolChoice pins the version boundaries. Anthropic documents
// losing forced tool use as a breaking change *from* Fable 5, so Fable 5 accepts
// a forced choice and only 5.1 onward rejects it; Opus and Sonnet lose it at 5.5.
// Haiku 5.5 keeps it, so a generation-only test would wrongly disarm it, as it
// would Opus 5 and Sonnet 5.
func TestSupportsForcedToolChoice(t *testing.T) {
	cases := []struct {
		model string
		want  bool
	}{
		{"claude-fable-5-1", false},
		{"claude-mythos-5-1", false},
		{"claude-fable-5-2", false},
		{"claude-opus-5-5", false},
		{"claude-sonnet-5-5", false},
		{"claude-haiku-5-5", true},
		{"claude-fable-5", true},
		{"claude-mythos-5", true},
		{"claude-opus-5", true},
		{"claude-sonnet-5", true},
		{"claude-sonnet-4-5-20250929", true},
		{"claude-3-opus-20240229", true},
		{"some-future-model", true},
		{"", true},
	}
	for _, tc := range cases {
		if got := supportsForcedToolChoice(tc.model); got != tc.want {
			t.Errorf("supportsForcedToolChoice(%q) = %t, want %t", tc.model, got, tc.want)
		}
	}
}

// TestSupportsAssistantPrefill pins which models get the continuation turn in
// place of a prefill. Every family rejects a prefill from 5.5 on, and Fable and
// Mythos at every version; Opus 5 and Sonnet 5 still take one.
func TestSupportsAssistantPrefill(t *testing.T) {
	cases := []struct {
		model string
		want  bool
	}{
		{"claude-opus-5-5", false},
		{"claude-sonnet-5-5", false},
		{"claude-haiku-5-5", false},
		{"claude-haiku-5-5-20261007", false},
		{"claude-fable-5-2", false},
		{"claude-fable-5", false},
		{"claude-mythos-5-1", false},
		{"claude-opus-5", true},
		{"claude-sonnet-5", true},
		{"claude-opus-4-8", true},
		{"claude-haiku-4-5-20251001", true},
		{"some-future-model", true},
		{"", true},
	}
	for _, tc := range cases {
		if got := supportsAssistantPrefill(tc.model); got != tc.want {
			t.Errorf("supportsAssistantPrefill(%q) = %t, want %t", tc.model, got, tc.want)
		}
	}
}

// TestBuildMessageParamsDropsForcedToolChoice pins that a forced choice is
// withheld from a model that rejects it, rather than sent and 400'd, while the
// non-forcing modes still reach the wire. "none" matters specifically: the
// folded-compaction probe sends it with the tools array intact to hold the
// cache prefix stable, and it stays legal on every model.
func TestBuildMessageParamsDropsForcedToolChoice(t *testing.T) {
	tools := []provider.ToolDefinition{{Name: "get_weather", Description: "d"}}
	msgs := []provider.Message{{Type: "user", Content: "hi"}}

	t.Run("forced choice dropped where unsupported", func(t *testing.T) {
		for _, mode := range []string{provider.ToolChoiceTool, provider.ToolChoiceAny} {
			c := &Client{model: "claude-fable-5-1"}
			params := c.buildMessageParams(provider.MessageRequest{
				Messages:   msgs,
				Tools:      tools,
				ToolChoice: &provider.ToolChoice{Mode: mode, Name: "get_weather"},
			})
			if !reflect.DeepEqual(params.ToolChoice, anthropicsdk.BetaToolChoiceUnionParam{}) {
				t.Errorf("mode %q: tool_choice sent, want it withheld", mode)
			}
		}
	})

	t.Run("none survives where forcing does not", func(t *testing.T) {
		c := &Client{model: "claude-fable-5-1"}
		params := c.buildMessageParams(provider.MessageRequest{
			Messages:   msgs,
			Tools:      tools,
			ToolChoice: &provider.ToolChoice{Mode: provider.ToolChoiceNone},
		})
		if params.ToolChoice.OfNone == nil {
			t.Error("tool_choice \"none\" withheld, want it sent (compaction's probe relies on it)")
		}
	})

	t.Run("forced choice kept where supported", func(t *testing.T) {
		c := &Client{model: "claude-opus-5"}
		params := c.buildMessageParams(provider.MessageRequest{
			Messages:   msgs,
			Tools:      tools,
			ToolChoice: &provider.ToolChoice{Mode: provider.ToolChoiceTool, Name: "get_weather"},
		})
		if params.ToolChoice.OfTool == nil {
			t.Error("tool_choice withheld from a model that accepts one")
		}
	})
}

// TestCloseTrailingPrefill pins the fix for the shape both a Continue and an
// autonomous turn leave behind: a request ending on an assistant message, which
// Anthropic reads as a prefill. Models that reject prefill get an explicit user
// turn instead; every other model keeps the zero-cost behaviour.
func TestCloseTrailingPrefill(t *testing.T) {
	// A completed assistant turn with no user message after it — what a Continue
	// produces, since its marker emits no wire message of its own.
	trailingAssistant := []provider.Message{
		{Type: "user", Content: "explain this"},
		{Type: "assistant", Content: "Partial answer, cut off"},
	}

	t.Run("prefill-rejecting model gets a user turn", func(t *testing.T) {
		c := &Client{model: "claude-fable-5-1"}
		params := c.buildMessageParams(provider.MessageRequest{Messages: trailingAssistant})

		last := params.Messages[len(params.Messages)-1]
		if last.Role != anthropicsdk.BetaMessageParamRoleUser {
			t.Fatalf("last message role = %q, want user (a trailing assistant turn is a prefill)", last.Role)
		}
		if len(last.Content) != 1 || last.Content[0].OfText == nil {
			t.Fatalf("appended turn = %+v, want a single text block", last.Content)
		}
		if got := last.Content[0].OfText.Text; got != continuationPrompt {
			t.Errorf("appended text = %q, want %q", got, continuationPrompt)
		}
		// The assistant turn itself must survive intact ahead of it.
		prev := params.Messages[len(params.Messages)-2]
		if prev.Role != anthropicsdk.BetaMessageParamRoleAssistant {
			t.Errorf("message before the appended turn = %q, want the assistant turn", prev.Role)
		}
	})

	t.Run("prefill-taking model is untouched", func(t *testing.T) {
		c := &Client{model: "claude-opus-5"}
		params := c.buildMessageParams(provider.MessageRequest{Messages: trailingAssistant})

		last := params.Messages[len(params.Messages)-1]
		if last.Role != anthropicsdk.BetaMessageParamRoleAssistant {
			t.Errorf("last message role = %q, want assistant (prefill costs nothing here)", last.Role)
		}
	})

	t.Run("no spurious turn when the request already ends on a user message", func(t *testing.T) {
		c := &Client{model: "claude-fable-5-1"}
		params := c.buildMessageParams(provider.MessageRequest{
			Messages: []provider.Message{
				{Type: "user", Content: "explain this"},
				{Type: "assistant", Content: "Here you go"},
				{Type: "user", Content: "and again"},
			},
		})
		last := params.Messages[len(params.Messages)-1]
		if len(last.Content) != 1 || last.Content[0].OfText == nil ||
			last.Content[0].OfText.Text != "and again" {
			t.Errorf("last message = %+v, want the user's own turn unaltered", last.Content)
		}
	})
}

// TestTransformNeverEmitsEmptyTextBlock pins why the empty-assistant filler in
// insertEmptyAssistantAPIMessages has never produced a 400 despite an empty text
// block being invalid on the wire: it is unreachable. The block accumulator in
// transformToAPIMessagesInternal flushes only on a role CHANGE, so consecutive
// user-role messages — user, context-item, guidance and tool-result all map to
// the user role — merge into a single APIMessage and the alternation the filler
// repairs cannot occur. This test fails if that accumulator ever stops merging,
// which is the change that would make the filler start emitting.
func TestTransformNeverEmitsEmptyTextBlock(t *testing.T) {
	msgs := []provider.Message{
		{Type: "context-item", Content: "pinned file"},
		{Type: "user", Content: "first"},
		{Type: "guidance", Content: "a reminder"},
		{Type: "user", Content: "second"},
		{Type: "assistant", Content: "answer"},
		{Type: "tool-result", ToolUseID: "t1", Content: "result"},
		{Type: "user", Content: "third"},
	}

	api := TransformToAPIMessages(msgs)
	var prevRole string
	for i, msg := range api {
		if msg.Role == prevRole {
			t.Errorf("message %d repeats role %q; the accumulator stopped merging", i, msg.Role)
		}
		prevRole = msg.Role
		for j, block := range msg.Content {
			if block.Type == "text" && block.Text == "" {
				t.Errorf("message %d block %d is an empty text block, which the API rejects", i, j)
			}
		}
	}
}

// TestRefusalNotice pins the notice a declined turn produces. A refusal is an
// HTTP 200 that can carry no content at all, so without a notice it reaches the
// transcript as a blank turn — indistinguishable from an outage, and inviting a
// retry that will be refused identically.
func TestRefusalNotice(t *testing.T) {
	t.Run("names the policy area and keeps the explanation verbatim", func(t *testing.T) {
		chunk, ok := refusalNotice(provider.StopReasonRefusal, anthropicsdk.BetaRefusalStopDetails{
			Category:    anthropicsdk.BetaRefusalStopDetailsCategoryCyber,
			Explanation: "This request asks for working exploit code.",
		})
		if !ok {
			t.Fatal("no notice produced for a refusal")
		}
		summary, _ := chunk.Metadata["noticeSummary"].(string)
		content, _ := chunk.Metadata["noticeContent"].(string)
		// streamNoticeFrom drops a notice missing either half, so both must be set
		// or the notice silently never reaches the transcript.
		if summary == "" || content == "" {
			t.Fatalf("notice half missing: summary=%q content=%q", summary, content)
		}
		if !strings.Contains(content, "cyber") {
			t.Errorf("notice drops the policy area: %q", content)
		}
		if !strings.Contains(content, "This request asks for working exploit code.") {
			t.Errorf("notice drops the provider's own explanation: %q", content)
		}
		if !strings.HasPrefix(content, summary) {
			t.Errorf("notice body does not lead with the plain-English summary: %q", content)
		}
	})

	t.Run("still says something when the details are empty", func(t *testing.T) {
		chunk, ok := refusalNotice(provider.StopReasonRefusal, anthropicsdk.BetaRefusalStopDetails{})
		if !ok {
			t.Fatal("no notice produced for a refusal carrying no details")
		}
		summary, _ := chunk.Metadata["noticeSummary"].(string)
		content, _ := chunk.Metadata["noticeContent"].(string)
		if summary == "" || content == "" {
			t.Fatalf("notice half missing: summary=%q content=%q", summary, content)
		}
	})

	t.Run("silent for every other stop reason", func(t *testing.T) {
		for _, reason := range []provider.StopReason{provider.StopReasonEndTurn, provider.StopReasonToolUse, provider.StopReasonMaxTokens, ""} {
			if _, ok := refusalNotice(reason, anthropicsdk.BetaRefusalStopDetails{}); ok {
				t.Errorf("stop reason %q produced a refusal notice", reason)
			}
		}
	})
}

func TestBuildMessageParamsUsesAdmissionCapability(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929", maxOutputTokens: 12345}
	params := c.buildMessageParams(provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: "hi"}},
	})
	if params.MaxTokens != 12345 {
		t.Fatalf("MaxTokens = %d, want admission capability 12345", params.MaxTokens)
	}
}

// derived from the model, not a fixed 8192 — in particular that a Claude 3 Opus
// request stays at its 4096 ceiling (the value the API rejected before) and a
// Sonnet 4.5 request is allowed its full 64000.
func TestBuildMessageParamsMaxTokensPerModel(t *testing.T) {
	cases := []struct {
		model string
		want  int64
	}{
		{"claude-3-opus-20240229", 4096},
		{"claude-sonnet-4-5-20250929", 64000},
	}
	for _, tc := range cases {
		c := &Client{model: tc.model}
		params := c.buildMessageParams(provider.MessageRequest{
			Messages: []provider.Message{{Type: "user", Content: "hi"}},
		})
		if params.MaxTokens != tc.want {
			t.Errorf("model %q: MaxTokens = %d, want %d", tc.model, params.MaxTokens, tc.want)
		}
	}
}

// TestBuildMessageParamsClampsCapabilityToCatalog pins F4: a capability
// snapshot carrying a derived reserve above a known model's real output ceiling
// is clamped down to the catalog value (a static-map-only claude-3-opus resolved
// from window only can arrive with a 40k reserve; its real cap is 4096, and
// sending 40k is a hard 400). Unknown ids keep the snapshot value.
func TestBuildMessageParamsClampsCapabilityToCatalog(t *testing.T) {
	cases := []struct {
		name            string
		model           string
		maxOutputTokens int64
		want            int64
	}{
		{"known model clamps derived reserve to catalog", "claude-3-opus-20240229", 40000, 4096},
		{"known model keeps snapshot below catalog", "claude-sonnet-4-5-20250929", 12345, 12345},
		{"unknown id keeps snapshot verbatim", "future-unmapped-model", 12345, 12345},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &Client{model: tc.model, maxOutputTokens: tc.maxOutputTokens}
			params := c.buildMessageParams(provider.MessageRequest{
				Messages: []provider.Message{{Type: "user", Content: "hi"}},
			})
			if params.MaxTokens != tc.want {
				t.Fatalf("MaxTokens = %d, want %d", params.MaxTokens, tc.want)
			}
		})
	}
}

// TestBuildMessageParamsHonorsARaise: a one-off raise lifts max_tokens above
// the client's resolved value, up to the catalogue ceiling, and a per-request
// lowering cap still wins over it.
func TestBuildMessageParamsHonorsARaise(t *testing.T) {
	msgs := []provider.Message{{Type: "user", Content: "hi"}}

	c := &Client{model: "claude-sonnet-4-5-20250929", maxOutputTokens: 16000}
	if got := c.buildMessageParams(provider.MessageRequest{Messages: msgs, RaiseMaxOutputTokens: 32000}).MaxTokens; got != 32000 {
		t.Fatalf("MaxTokens = %d, want the raise 32000", got)
	}
	if got := c.buildMessageParams(provider.MessageRequest{Messages: msgs, RaiseMaxOutputTokens: 1_000_000}).MaxTokens; got != 64000 {
		t.Fatalf("MaxTokens = %d, want catalogue 64000 bounding the raise", got)
	}
	if got := c.buildMessageParams(provider.MessageRequest{Messages: msgs, RaiseMaxOutputTokens: 32000, MaxOutputTokens: 4096}).MaxTokens; got != 4096 {
		t.Fatalf("MaxTokens = %d, want the lowering cap 4096", got)
	}
}

// TestBuildMessageParamsHonorsRequestOutputCap pins F1a: a per-request
// MaxOutputTokens only ever lowers the wire max_tokens (min against the client/
// catalog value), and the thinking budget follows the tightened value.
func TestBuildMessageParamsHonorsRequestOutputCap(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929"}

	// Request cap below the catalog ceiling wins.
	params := c.buildMessageParams(provider.MessageRequest{
		Messages:        []provider.Message{{Type: "user", Content: "hi"}},
		MaxOutputTokens: 4096,
	})
	if params.MaxTokens != 4096 {
		t.Fatalf("MaxTokens = %d, want request cap 4096", params.MaxTokens)
	}

	// Request cap above the effective value is ignored (never raises).
	params = c.buildMessageParams(provider.MessageRequest{
		Messages:        []provider.Message{{Type: "user", Content: "hi"}},
		MaxOutputTokens: 1_000_000,
	})
	if params.MaxTokens != 64000 {
		t.Fatalf("MaxTokens = %d, want catalog 64000 (request cap does not raise)", params.MaxTokens)
	}

	// Thinking budget clamps against the tightened request cap.
	params = c.buildMessageParams(provider.MessageRequest{
		Messages:        []provider.Message{{Type: "user", Content: "hi"}},
		ThinkingLevel:   "max",
		MaxOutputTokens: 20000,
	})
	if params.MaxTokens != 20000 {
		t.Fatalf("MaxTokens = %d, want request cap 20000", params.MaxTokens)
	}
	if got := params.Thinking.GetBudgetTokens(); got == nil || *got != int64(20000-4096) {
		t.Fatalf("thinking budget = %v, want %d (clamped to request cap)", got, 20000-4096)
	}
}
