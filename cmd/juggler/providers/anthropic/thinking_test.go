//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package anthropic

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestBuildMessageParamsThinkingLevel pins the extended-thinking request shape:
// a supported level sets the thinking param with the expected budget, kept below
// max_tokens.
func TestBuildMessageParamsThinkingLevel(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929"}

	cases := map[string]int64{
		provider.ThinkingLow:    2048,
		provider.ThinkingMedium: 8192,
		provider.ThinkingHigh:   16384,
		provider.ThinkingMax:    32768,
	}
	for level, wantBudget := range cases {
		params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: level})
		got := params.Thinking.GetBudgetTokens()
		if got == nil {
			t.Fatalf("level %q: thinking param missing, want budget %d", level, wantBudget)
		}
		if *got != wantBudget {
			t.Errorf("level %q: budget = %d, want %d", level, *got, wantBudget)
		}
		if *got >= params.MaxTokens {
			t.Errorf("level %q: budget %d must be < max_tokens %d", level, *got, params.MaxTokens)
		}
	}
}

// TestBuildMessageParamsThinkingClamped pins the budget clamp: Opus 4.x caps
// max_tokens at 32000, so the "max" budget is clamped below it with answer
// headroom rather than exceeding the ceiling (a hard 400).
func TestBuildMessageParamsThinkingClamped(t *testing.T) {
	c := &Client{model: "claude-opus-4-20250514"}
	params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: provider.ThinkingMax})
	got := params.Thinking.GetBudgetTokens()
	if got == nil {
		t.Fatal("thinking param missing for opus max")
	}
	if want := int64(32000 - 4096); *got != want {
		t.Errorf("clamped budget = %d, want %d", *got, want)
	}
}

// TestBuildMessageParamsThinkingClampedToCapability pins the divergence guard:
// when the admission capability snapshot carries a lower output limit than the
// static catalog, the thinking budget clamps against the wire max_tokens (the
// snapshot), never the catalog — budget_tokens ≥ max_tokens is a hard 400. And
// when the snapshot leaves no room for even the minimum budget plus answer
// headroom, thinking drops for that turn instead of erroring.
func TestBuildMessageParamsThinkingClampedToCapability(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929", maxOutputTokens: 20000}
	params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: provider.ThinkingMax})
	got := params.Thinking.GetBudgetTokens()
	if got == nil {
		t.Fatal("thinking param missing for max level")
	}
	if want := int64(20000 - 4096); *got != want {
		t.Errorf("budget = %d, want %d (clamped to the capability wire value, not the catalog)", *got, want)
	}
	if *got >= params.MaxTokens {
		t.Errorf("budget %d must be < max_tokens %d", *got, params.MaxTokens)
	}

	c = &Client{model: "claude-sonnet-4-5-20250929", maxOutputTokens: 5000}
	params = c.buildMessageParams(provider.MessageRequest{ThinkingLevel: provider.ThinkingMax})
	if got := params.Thinking.GetBudgetTokens(); got != nil {
		t.Errorf("maxTokens 5000: budget = %d, want thinking dropped (below the 1024 minimum after headroom)", *got)
	}
}

// TestBuildMessageParamsThinkingOffAbsent pins backward compatibility: "off" and
// an absent level produce no thinking param at all.
func TestBuildMessageParamsThinkingOffAbsent(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929"}
	for _, level := range []string{"", provider.ThinkingOff, "garbage"} {
		params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: level})
		if got := params.Thinking.GetBudgetTokens(); got != nil {
			t.Errorf("level %q: thinking param present (budget %d), want omitted", level, *got)
		}
	}
}

// TestBuildMessageParamsThinkingForcedToolDrops pins the forced-tool rule:
// a forced tool_choice is incompatible with thinking (a hard 400), so the
// thinking param is dropped for that turn.
func TestBuildMessageParamsThinkingForcedToolDrops(t *testing.T) {
	c := &Client{model: "claude-sonnet-4-5-20250929"}
	tools := []provider.ToolDefinition{{Name: "return_result", InputSchema: []byte(`{"type":"object"}`)}}
	for _, tc := range []*provider.ToolChoice{
		{Mode: provider.ToolChoiceTool, Name: "return_result"},
		{Mode: provider.ToolChoiceAny},
	} {
		params := c.buildMessageParams(provider.MessageRequest{
			ThinkingLevel: provider.ThinkingHigh,
			Tools:         tools,
			ToolChoice:    tc,
		})
		if got := params.Thinking.GetBudgetTokens(); got != nil {
			t.Errorf("forced tool (mode %q): thinking present (budget %d), want dropped", tc.Mode, *got)
		}
	}

	// A non-forcing choice (none) still allows thinking.
	params := c.buildMessageParams(provider.MessageRequest{
		ThinkingLevel: provider.ThinkingHigh,
		Tools:         tools,
		ToolChoice:    &provider.ToolChoice{Mode: provider.ToolChoiceNone},
	})
	if got := params.Thinking.GetBudgetTokens(); got == nil {
		t.Error("mode none must still allow thinking")
	}
}

// TestBuildMessageParamsThinkingUnsupportedModel pins that a level on a model
// without extended-thinking support (Claude 3.5) is ignored.
func TestBuildMessageParamsThinkingUnsupportedModel(t *testing.T) {
	c := &Client{model: "claude-3-5-sonnet-20241022"}
	params := c.buildMessageParams(provider.MessageRequest{ThinkingLevel: provider.ThinkingHigh})
	if got := params.Thinking.GetBudgetTokens(); got != nil {
		t.Errorf("unsupported model: thinking present (budget %d), want omitted", *got)
	}
}

// TestSupportsThinking pins the model-capability classifier.
func TestSupportsThinking(t *testing.T) {
	yes := []string{
		"claude-sonnet-4-5-20250929", "claude-sonnet-4", "claude-opus-4-1-20250805",
		"claude-4-sonnet", "claude-4.5-sonnet", "claude-3-7-sonnet-20250219", "claude-3.7-sonnet",
	}
	no := []string{
		"claude-3-5-sonnet-20241022", "claude-3-opus-20240229", "claude-3-haiku-20240307",
	}
	for _, m := range yes {
		if !SupportsThinking(m) {
			t.Errorf("SupportsThinking(%q) = false, want true", m)
		}
	}
	for _, m := range no {
		if SupportsThinking(m) {
			t.Errorf("SupportsThinking(%q) = true, want false", m)
		}
	}
}
