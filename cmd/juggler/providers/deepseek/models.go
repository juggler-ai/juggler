//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package deepseek

import "juggler/cmd/juggler/providers/utils"

// ModelContextWindows maps DeepSeek model names to context window sizes (tokens).
// The v4 API models carry a 1M-token window (DeepSeek API docs, Models & Pricing).
var ModelContextWindows = map[string]int{
	"deepseek-chat":       128000,
	"deepseek-reasoner":   128000,
	"deepseek-coder":      128000,
	"deepseek-v4-flash":   1000000,
	"deepseek-v4-pro":     1000000,
}

// DefaultContextWindow is used for unknown DeepSeek models.
const DefaultContextWindow = 128000

// DefaultMaxOutputTokens is the per-request output cap for DeepSeek models not
// in ModelMaxOutputTokens. Well above the old flat 8192 so chat models aren't
// truncated mid-answer.
const DefaultMaxOutputTokens = 32768

// ModelMaxOutputTokens overrides the default for the reasoning model:
// deepseek-reasoner (R1) spends output budget on chain-of-thought before the
// answer, so an 8192 cap throttled the reasoning itself and produced empty
// `finish=length` turns. DeepSeek documents 64K max output for R1.
var ModelMaxOutputTokens = map[string]int{
	"deepseek-reasoner": 65536,
}

// contextWindowCaps / maxOutputCaps are the single source for per-model
// lookups, consumed by both the Get* getters and the provider Descriptor.
var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens, Overrides: ModelMaxOutputTokens}
)
