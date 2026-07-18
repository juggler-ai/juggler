//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package moonshot

import (
	"testing"

	provider "juggler/cmd/juggler/providers/registry"
)

// TestContextWindow pins the known windows and the unknown-model default: the
// 1M flagship, the 256K K2.x line, the legacy moonshot-v1 sizes, and a
// yet-unseen id falling back to the modern default.
func TestContextWindow(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		{"kimi-k3", 1000000},
		{"kimi-k2.7-code", 256000},
		{"kimi-k2.7-code-highspeed", 256000},
		{"kimi-k2.6", 256000},
		{"kimi-k2.5", 256000},
		{"moonshot-v1-8k", 8000},
		{"moonshot-v1-32k", 32000},
		{"moonshot-v1-128k", 128000},
		{"kimi-latest", DefaultContextWindow}, // unlisted → default
		{"kimi-k4-future", DefaultContextWindow},
	}
	for _, tc := range cases {
		if got := contextWindowCaps.Lookup(tc.model); got != tc.want {
			t.Errorf("contextWindow(%q) = %d, want %d", tc.model, got, tc.want)
		}
	}
}

// TestOutputCapReasoningHeadroomAndFitsWindow guards two invariants: the
// reasoning flagship (kimi-k3) gets output budget well above 8192 for
// chain-of-thought, and no model's output cap exceeds its own context window
// (which would make max_tokens structurally impossible and 400 the request).
func TestOutputCapReasoningHeadroomAndFitsWindow(t *testing.T) {
	if got := maxOutputCaps.Lookup("kimi-k3"); got < 65536 {
		t.Errorf("maxOutput(kimi-k3) = %d, want >= 65536 (reasoning needs headroom)", got)
	}
	for _, model := range []string{
		"kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
		"moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k",
		"moonshot-v1-8k-vision-preview", "kimi-latest",
	} {
		out := maxOutputCaps.Lookup(model)
		win := contextWindowCaps.Lookup(model)
		if out >= win {
			t.Errorf("maxOutput(%q) = %d must be < contextWindow %d (leave room for input)", model, out, win)
		}
	}
}

// TestInputModalities checks the vision line (K2.5/2.6/2.7 + every -vision-
// variant) reports image input, while text-only models (kimi-k3, plain
// moonshot-v1) report none.
func TestInputModalities(t *testing.T) {
	vision := []string{
		"kimi-k3", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k2.7-code-highspeed",
		"moonshot-v1-8k-vision-preview", "moonshot-v1-128k-vision-preview",
	}
	for _, m := range vision {
		got := inputModalities(m)
		if len(got) != 2 || got[0] != "text" || got[1] != "image" {
			t.Errorf("inputModalities(%q) = %v, want [text image]", m, got)
		}
	}
	textOnly := []string{"moonshot-v1-8k", "moonshot-v1-128k", "kimi-latest"}
	for _, m := range textOnly {
		if got := inputModalities(m); got != nil {
			t.Errorf("inputModalities(%q) = %v, want nil (text-only)", m, got)
		}
	}
}

// TestThinkingSpec verifies only kimi-k3 exposes a reasoning-effort selector
// (mapping the canonical "max" level to the native "max"), and that the K2.x
// thinking models and legacy moonshot-v1 models expose no selector — sending
// reasoning_effort to them would be rejected.
func TestThinkingSpec(t *testing.T) {
	k3 := thinkingSpec("kimi-k3")
	if len(k3.Levels) == 0 {
		t.Fatalf("thinkingSpec(kimi-k3) has no levels, want a reasoning selector")
	}
	if k3.Effort[provider.ThinkingMax] != "max" {
		t.Errorf("thinkingSpec(kimi-k3).Effort[max] = %q, want \"max\"", k3.Effort[provider.ThinkingMax])
	}
	for _, m := range []string{"kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "moonshot-v1-128k"} {
		if spec := thinkingSpec(m); len(spec.Levels) != 0 {
			t.Errorf("thinkingSpec(%q).Levels = %v, want empty (no reasoning_effort control)", m, spec.Levels)
		}
	}
}

// TestCapabilitiesFailClosedOnUncataloguedModel pins the admission contract:
// catalogued ids resolve statically, live-listed-but-uncatalogued ids get
// their limits from the live list instead, and user-invented aliases fail
// closed rather than inheriting the provider defaults.
func TestCapabilitiesFailClosedOnUncataloguedModel(t *testing.T) {
	Register()
	info, found := provider.GetProviderInfo("moonshot")
	if !found || info.ResolveModelCapabilities == nil {
		t.Fatal("moonshot registration has no capability resolver")
	}
	got, found := info.ResolveModelCapabilities("kimi-k3")
	want := provider.ModelCapabilities{ContextWindowTokens: 1000000, MaxOutputTokens: 131072}
	if !found || got != want {
		t.Fatalf("kimi-k3 capabilities = (%+v, %v), want (%+v, true)", got, found, want)
	}
	if _, found := info.ResolveModelCapabilities("kimi-latest"); found {
		t.Fatal("kimi-latest resolved statically — uncatalogued ids must come from the live list")
	}
	if got, found := info.ResolveModelCapabilities("my-custom-kimi"); found || got != (provider.ModelCapabilities{}) {
		t.Fatalf("custom alias capabilities = (%+v, %v), want zero, false", got, found)
	}
}

// TestIsChatModel admits the kimi-* / moonshot-* chat lines and rejects
// embeddings and foreign ids.
func TestIsChatModel(t *testing.T) {
	cases := []struct {
		model string
		want  bool
	}{
		{"kimi-k3", true},
		{"kimi-k2.7-code", true},
		{"moonshot-v1-128k", true},
		{"moonshot-v1-8k-vision-preview", true},
		{"moonshot-v1-embedding", false},
		{"text-embedding-3-large", false},
		{"gpt-4", false},
		{"glm-4.6", false},
	}
	for _, tc := range cases {
		if got := isChatModel(tc.model); got != tc.want {
			t.Errorf("isChatModel(%q) = %v, want %v", tc.model, got, tc.want)
		}
	}
}
