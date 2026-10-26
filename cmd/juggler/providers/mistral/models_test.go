//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mistral

import (
	"testing"
)

// TestMistralContextWindow pins the current catalog's windows, the versioned
// ids and their -latest aliases alike, and the unknown-model default.
func TestMistralContextWindow(t *testing.T) {
	cases := []struct {
		model string
		want  int
	}{
		{"mistral-large-latest", 256000},
		{"mistral-large-2512", 256000},
		{"mistral-medium-latest", 256000},
		// The docs say 256k; the endpoint is reported to serve 131072. The
		// offline answer is the smaller.
		{"ministral-3b-latest", 131072},
		{"ministral-3b-2512", 131072},
		// Codestral is the one model in the line at half the others' window.
		{"codestral-latest", 128000},
		{"codestral-2508", 128000},
		{"zai-glm-5-2", 1000000},
		{"mistral-vNext", DefaultContextWindow},
		// Withdrawn from the catalog: no entry, so no promise.
		{"magistral-medium-latest", DefaultContextWindow},
		{"devstral-medium-latest", DefaultContextWindow},
		{"mistral-tiny-latest", DefaultContextWindow},
	}
	for _, tc := range cases {
		if got := contextWindowCaps.Lookup(tc.model); got != tc.want {
			t.Errorf("context window(%q) = %d, want %d", tc.model, got, tc.want)
		}
	}
}

// TestMistralMaxOutput checks that Mistral's own models take the flat default —
// the vendor publishes no ceiling for them — while the third-party model it
// hosts uses the ceiling that model does publish.
func TestMistralMaxOutput(t *testing.T) {
	if got := maxOutputCaps.Lookup("mistral-large-latest"); got != DefaultMaxOutputTokens {
		t.Errorf("max output(mistral-large-latest) = %d, want %d", got, DefaultMaxOutputTokens)
	}
	if got := maxOutputCaps.Lookup("zai-glm-5-2"); got != 128000 {
		t.Errorf("max output(zai-glm-5-2) = %d, want its documented 128000", got)
	}
}

// TestMistralThinkingSpec guards that only Magistral models advertise a
// reasoning selector (low/medium/high), and every other model gets the zero
// spec so no reasoning param is sent.
func TestMistralThinkingSpec(t *testing.T) {
	reasoning := []string{"magistral-small-latest", "magistral-medium-latest"}
	for _, id := range reasoning {
		spec := thinkingSpec(id)
		if len(spec.Options()) != 3 {
			t.Errorf("thinkingSpec(%q) options = %d, want 3", id, len(spec.Options()))
		}
		if spec.Default != "medium" {
			t.Errorf("thinkingSpec(%q) default = %q, want medium", id, spec.Default)
		}
	}
	nonReasoning := []string{"mistral-large-latest", "codestral-latest", "ministral-8b-latest"}
	for _, id := range nonReasoning {
		if opts := thinkingSpec(id).Options(); opts != nil {
			t.Errorf("thinkingSpec(%q) options = %v, want nil (no reasoning control)", id, opts)
		}
	}
}

// TestMistralInputModalities pins the vision classification: text-only models
// return nil, image-capable models return the canonical ["text","image"].
func TestMistralInputModalities(t *testing.T) {
	if got := inputModalities("codestral-latest"); got != nil {
		t.Errorf("inputModalities(codestral-latest) = %v, want nil", got)
	}
	got := inputModalities("mistral-medium-latest")
	if len(got) != 2 || got[0] != "text" || got[1] != "image" {
		t.Errorf("inputModalities(mistral-medium-latest) = %v, want [text image]", got)
	}
}
