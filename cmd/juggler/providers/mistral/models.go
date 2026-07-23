//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mistral

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

// ModelContextWindows maps Mistral model names to context window sizes (tokens).
// Source: https://mistral.ai/models and the /v1/models API endpoint.
var ModelContextWindows = map[string]int{
	"codestral-latest":        256000,
	"devstral-medium-latest":  262144,
	"magistral-medium-latest": 131072,
	"magistral-small-latest":  262144,
	"ministral-3b-latest":     131072,
	"ministral-8b-latest":     262144,
	"ministral-14b-latest":    262144,
	"mistral-large-latest":    262144,
	"mistral-medium-latest":   131072,
	"mistral-small-latest":    262144,
	"mistral-tiny-latest":     131072,
}

const DefaultContextWindow = 131072

const DefaultMaxOutputTokens = 16384

var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens}
)

// thinkingSpec classifies a Mistral model's reasoning-effort support. Only
// Magistral models expose reasoning through the OpenAI-shaped reasoning_effort
// field, with low/medium/high levels.
func thinkingSpec(modelID string) openaibase.ThinkingSpec {
	if strings.HasPrefix(strings.ToLower(modelID), "magistral") {
		return openaibase.ThinkingSpec{
			Levels:  []string{provider.ThinkingLow, provider.ThinkingMedium, provider.ThinkingHigh},
			Default: provider.ThinkingMedium,
			Effort: map[string]string{
				provider.ThinkingLow:    "low",
				provider.ThinkingMedium: "medium",
				provider.ThinkingHigh:   "high",
			},
		}
	}
	return openaibase.ThinkingSpec{}
}
