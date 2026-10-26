//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mistral

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/utils"
)

// Mistral's /v1/models returns each model card's own max_context_length, and a
// listing uses that. This file is the offline answer — what Juggler knows when
// the endpoint cannot be reached — plus the output caps and modalities the card
// does not carry.

// ModelContextWindows maps Mistral model ids to context window sizes (tokens).
// Both the versioned id the API returns and the -latest alias that resolves to
// it are listed, since either can be the id a conversation was configured with.
//
// Mistral publishes these as a rounded "256k", never an exact token count, so
// 256000 is used rather than 262144: the window decides when a conversation
// compacts and when admission refuses, and of the two readings the smaller is
// the one that cannot overrun.
// Source: https://docs.mistral.ai/models
var ModelContextWindows = map[string]int{
	"mistral-medium-3-5":    256000,
	"mistral-medium-latest": 256000,
	"mistral-large-2512":    256000,
	"mistral-large-latest":  256000,
	"mistral-small-2603":    256000,
	"mistral-small-latest":  256000,
	"ministral-14b-2512":    256000,
	"ministral-14b-latest":  256000,
	"ministral-8b-2512":     256000,
	"ministral-8b-latest":   256000,
	// The docs give Ministral 3 3B 256k, but its /v1/models card reports a
	// max_context_length of 131072 (per models.dev, which reads it). The two
	// readings disagree by half, and the smaller is the one that cannot overrun.
	"ministral-3b-2512":   131072,
	"ministral-3b-latest": 131072,
	// The reverse case: the docs say 128k and the endpoint reportedly 256000.
	// 128000 stands, for the same reason; a live listing uses the endpoint's
	// own figure whenever it is reachable.
	"codestral-2508":   128000,
	"codestral-latest": 128000,
	// A third-party model Mistral hosts, and the only one on the platform with
	// a published output ceiling.
	"zai-glm-5-2": 1000000,
}

// DefaultContextWindow is used for unknown Mistral models. Deliberately half
// the current catalog's 256k: an unlisted id is one the endpoint could not be
// asked about, and an under-estimate compacts early where an over-estimate
// fails the turn.
const DefaultContextWindow = 131072

// ModelMaxOutputTokens holds the only output ceiling Mistral publishes at all —
// for the third-party model it hosts. Every Mistral-built model's page omits
// the field entirely, so their cap is DefaultMaxOutputTokens: a number of ours
// chosen to be accepted, not a limit read off the vendor.
var ModelMaxOutputTokens = map[string]int{
	"zai-glm-5-2": 128000,
}

// DefaultMaxOutputTokens is the per-request output cap for Mistral models.
const DefaultMaxOutputTokens = 16384

// contextWindowCaps / maxOutputCaps are the single source for per-model
// lookups, consumed by both the tests and the provider Descriptor.
var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens, Overrides: ModelMaxOutputTokens}
)

// thinkingSpec classifies a Mistral model's reasoning-effort support. Only
// Magistral models expose reasoning through the OpenAI-shaped reasoning_effort
// field, with low/medium/high levels. All other Mistral models return the zero
// spec (no reasoning control).
//
// No Magistral model is currently listed on the platform. The rule is kept
// rather than deleted because it is a statement about how a Magistral model
// behaves, not a claim that one is being served: a model the endpoint never
// returns never reaches it, and a reissued one is classified correctly.
func thinkingSpec(modelID string) openaibase.ThinkingSpec {
	if strings.HasPrefix(strings.ToLower(modelID), "magistral") {
		return openaibase.EffortSpec("medium", "low", "medium", "high")
	}
	return openaibase.ThinkingSpec{}
}
