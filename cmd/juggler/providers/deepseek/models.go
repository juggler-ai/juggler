//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package deepseek

import (
	"juggler/cmd/juggler/providers/openaibase"
	"juggler/cmd/juggler/providers/utils"
)

// modelFilter admits DeepSeek's chat models from the live list. The exclusions
// are SUFFIXES: "-vision" drops an id that ends there, which the current
// deepseek-v4-flash-vision-exp does not — it is a chat model that happens to
// take images, and it is meant to reach users.
func modelFilter() openaibase.ModelFilterFunc {
	return openaibase.PrefixModelFilter("deepseek-", "-embedding", "-vision", "-tts")
}

// DeepSeek's /v1/models returns id, object and owned_by, and nothing else — no
// window, no output cap, not even a created timestamp. There is nothing for
// endpoint discovery to read, so this file is not a fallback here: it is the
// only source of limits DeepSeek models will ever have, and an entry that goes
// stale stays stale until someone edits it.

// ModelContextWindows maps DeepSeek model names to context window sizes (tokens).
// Every current API model carries a 1M-token window (DeepSeek API docs, Models
// & Pricing).
//
// 1000000 rather than the 1048576 the weights config allows: DeepSeek publishes
// the round figure, and this number decides when a conversation compacts and
// when admission refuses a request. Being 4.6% under the true ceiling costs a
// little context; being over it fails a turn with the whole prompt already
// built. The direction of the error is chosen, not accidental.
var ModelContextWindows = map[string]int{
	"deepseek-v4-flash": 1000000,
	"deepseek-v4-pro":   1000000,
	// The undated alias of the latest Flash snapshot (V4.1 Flash 1017).
	"deepseek-flash": 1000000,
	// Ships images, and reaches users: the provider's model filter drops ids
	// ending in "-vision", and this one ends "-exp".
	"deepseek-v4-flash-vision-exp": 1000000,
}

// DefaultContextWindow is used for unknown DeepSeek models. Deliberately far
// below the current line's 1M: an id this file has never heard of is one the
// endpoint cannot be asked about either, and an under-estimate only compacts
// early where an over-estimate fails the turn.
const DefaultContextWindow = 128000

// DefaultMaxOutputTokens is the per-request output cap for DeepSeek models not
// in ModelMaxOutputTokens. Well above the old flat 8192 so an unrecognised
// model — which, on this vendor, is likely to be a reasoning model — is not
// truncated mid-thought.
const DefaultMaxOutputTokens = 32768

// ModelMaxOutputTokens holds the documented 384K ceiling for the models that
// have one.
//
// The entry that used to live here was for deepseek-reasoner (R1), and the
// reason it existed outlives it: a reasoning model spends output budget on
// chain-of-thought before the answer, so a cap sized for a chat model throttles
// the reasoning itself and yields empty `finish=length` turns. Every model
// DeepSeek now serves reasons, and every one of them documents 384K — which
// fits alongside the 600K of input the 60% budget allows in a 1M window.
var ModelMaxOutputTokens = map[string]int{
	"deepseek-v4-flash":            384000,
	"deepseek-v4-pro":              384000,
	"deepseek-flash":               384000,
	"deepseek-v4-flash-vision-exp": 384000,
}

// contextWindowCaps / maxOutputCaps are the single source for per-model
// lookups, consumed by both the Get* getters and the provider Descriptor.
var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens, Overrides: ModelMaxOutputTokens}
)
