//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import (
	"slices"
	"testing"
)

// TestGLMOutputCapHasReasoningHeadroom guards that GLM's output cap leaves room
// for chain-of-thought. GLM is a reasoning model: it spends output budget
// thinking before it answers. The original flat 8192 cap throttled the
// reasoning itself, yielding empty `finish=length` turns that the worker
// silently retried — minutes of dead "Receiving". The cap must be well above
// 8192 yet stay within z.ai's documented per-model maxima (GLM-4.6 128K,
// GLM-4.5 96K).
//
// GLM-5.2 and the GLM-5.3 line get their whole ceiling, verified on the wire
// against the coding endpoint (2026-10-22): 131072 is accepted and 131073 is
// rejected with "限制数值范围[1,131072]". A cap below it cuts a long chain of
// reasoning off before the model acts, for no reason the endpoint gives.
func TestGLMOutputCapHasReasoningHeadroom(t *testing.T) {
	cases := []struct {
		model   string
		atLeast int
		atMost  int
	}{
		{"glm-4.6", 32768, 98304},
		{"glm-4.5", 32768, 98304},
		{"glm-4.7", 32768, 98304},
		{"glm-5.2", 131072, 131072},
		{"glm-5.3", 131072, 131072},
		{"glm-5.3-flash", 131072, 131072},
		{"glm-9-future", 16384, 98304}, // unverified → generous default, still bounded
		{"glm-4-flash", 16384, 98304},
		// The vision line's documented ceilings are a fraction of the text
		// line's, and the flat default sits above them. z.ai answers a
		// max_tokens over a model's ceiling with a 400, so without their own
		// entries every turn on these models fails.
		{"glm-4.6v", 8192, 32000},
		{"glm-4.6v-flash", 8192, 32000},
		{"glm-4.5v", 8192, 16000},
		{"glm-4-32b-0414-128k", 8192, 16000},
	}
	for _, tc := range cases {
		got := maxOutputCaps.Lookup(tc.model)
		if got < tc.atLeast {
			t.Errorf("GetMaxOutputTokens(%q) = %d, want >= %d (reasoning needs headroom)", tc.model, got, tc.atLeast)
		}
		if got > tc.atMost {
			t.Errorf("GetMaxOutputTokens(%q) = %d, want <= %d (within plan/model ceiling)", tc.model, got, tc.atMost)
		}
	}
}

// TestContextWindowDefaultsToModernCatalog guards the window sizing: the whole
// current z.ai catalog is 200K except the glm-4.5 series (128K), so the default
// is optimistic (200K) and only off-default models carry an override. A new
// model the API starts advertising therefore inherits 200K, not a stale 128K.
// GLM-5.2 and GLM-5.3 override upward: they serve a 1M window under their plain
// base ids over the standard coding endpoint (verified on the wire — see
// models.go).
func TestContextWindowDefaultsToModernCatalog(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		{"glm-4.6", 200000},        // default
		{"glm-4.7", 200000},        // default
		{"glm-5.1", 200000},        // default
		{"glm-5.2", 1000000},       // override → 1M window on the base id
		{"glm-5.3", 1000000},       // override → 1M window on the base id
		{"glm-5.3-flash", 1000000}, // the vision-capable flash variant, same 1M window
		{"glm-4.6v", 128000},       // the vision line is below the default
		{"glm-9-future", 200000},   // unknown → default
		{"glm-4.5", 128000},        // override
		{"glm-4.5-air", 128000},    // override
	}
	for _, tc := range cases {
		if got := contextWindowCaps.Lookup(tc.model); got != tc.want {
			t.Errorf("contextWindow(%q) = %d, want %d", tc.model, got, tc.want)
		}
	}
}

// TestThinkingSpec pins the reasoning-effort selector to GLM-5.2+: those models
// advertise three distinct tiers (default max), while earlier GLM releases expose
// no control — sending them reasoning_effort would be rejected. GLM-5.2's floor
// is none (it can skip thinking); GLM-5.3 always thinks, so its floor is low and
// a forward-dated release (glm-6) inherits that shape.
func TestThinkingSpec(t *testing.T) {
	cases := []struct {
		models []string
		want   []string
	}{
		{[]string{"glm-5.2"}, []string{"none", "high", "max"}},
		{[]string{"glm-5.3", "glm-6", "glm-6.1-air"}, []string{"low", "high", "max"}},
	}
	for _, tc := range cases {
		for _, m := range tc.models {
			spec := thinkingSpec(m)
			if !slices.Equal(spec.Levels, tc.want) {
				t.Errorf("thinkingSpec(%q).Levels = %v, want %v", m, spec.Levels, tc.want)
			}
			if spec.Default != "max" {
				t.Errorf("thinkingSpec(%q).Default = %q, want max", m, spec.Default)
			}
		}
	}
	noSelector := []string{"glm-5.1", "glm-5", "glm-4.7", "glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4-flash"}
	for _, m := range noSelector {
		if spec := thinkingSpec(m); len(spec.Levels) != 0 {
			t.Errorf("thinkingSpec(%q).Levels = %v, want empty (reasoning_effort unsupported)", m, spec.Levels)
		}
	}
}

// TestGLMVersion pins the version parser that gates the selector: dotted and
// bare versions, suffixed variants, and non-GLM / unparseable ids.
func TestGLMVersion(t *testing.T) {
	cases := []struct {
		model        string
		major, minor int
		ok           bool
	}{
		{"glm-5.2", 5, 2, true},
		{"glm-5.3", 5, 3, true},
		{"glm-4.5-air", 4, 5, true},
		{"glm-5", 5, 0, true},
		{"glm-4.6", 4, 6, true},
		{"glm-6", 6, 0, true},
		{"GLM-5.2", 5, 2, true},  // case-insensitive
		{"gpt-5", 0, 0, false},   // wrong prefix
		{"glm-air", 0, 0, false}, // no numeric version
		{"", 0, 0, false},
	}
	for _, tc := range cases {
		major, minor, ok := glmVersion(tc.model)
		if major != tc.major || minor != tc.minor || ok != tc.ok {
			t.Errorf("glmVersion(%q) = (%d, %d, %v), want (%d, %d, %v)",
				tc.model, major, minor, ok, tc.major, tc.minor, tc.ok)
		}
	}
}

// TestInputModalities: only GLM's vision line ("v" straight after the version)
// accepts images. The text line — GLM-5.3 included — answers any request
// carrying an image with a 400, so it must be declared text-only for the
// request builder to withhold tool-result images from it.
func TestInputModalities(t *testing.T) {
	for _, m := range []string{"glm-4.6v", "glm-4.6v-flash", "glm-4.6v-flashx", "glm-4.5v", "GLM-4.6V"} {
		if got := inputModalities(m); !slices.Contains(got, "image") {
			t.Errorf("inputModalities(%q) = %v, want image input", m, got)
		}
	}
	for _, m := range []string{"glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-4.6", "glm-4.5-air", "glm-4-32b-0414-128k", ""} {
		if got := inputModalities(m); got != nil {
			t.Errorf("inputModalities(%q) = %v, want nil (text-only)", m, got)
		}
	}
}
