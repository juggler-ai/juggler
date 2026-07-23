//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package opencodezen

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
	provider "juggler/cmd/juggler/providers/registry"
	"juggler/cmd/juggler/providers/utils"
)

// ModelContextWindows maps OpenCode Zen model names to context window sizes.
// Source: https://opencode.ai/zen/v1 models endpoint.
var ModelContextWindows = map[string]int{
	"big-pickle":             200000,
	"claude-fable-5":         1000000,
	"claude-haiku-4-5":       200000,
	"claude-opus-4-1":        200000,
	"claude-opus-4-5":        200000,
	"claude-opus-4-6":        1000000,
	"claude-opus-4-7":        1000000,
	"claude-opus-4-8":        1000000,
	"claude-sonnet-4":        1000000,
	"claude-sonnet-4-5":      1000000,
	"claude-sonnet-4-6":      1000000,
	"claude-sonnet-5":        1000000,
	"deepseek-v4-flash":      1000000,
	"deepseek-v4-flash-free": 200000,
	"deepseek-v4-pro":        1000000,
	"glm-5":                  204800,
	"glm-5.1":                204800,
	"glm-5.2":                1000000,
	"gpt-5":                  400000,
	"gpt-5-codex":            400000,
	"gpt-5-nano":             400000,
	"gpt-5.1":                400000,
	"gpt-5.1-codex":          400000,
	"gpt-5.1-codex-max":      400000,
	"gpt-5.1-codex-mini":     400000,
	"gpt-5.2":                400000,
	"gpt-5.2-codex":          400000,
	"gpt-5.3-codex":          400000,
	"gpt-5.3-codex-spark":    128000,
	"gpt-5.4":                1050000,
	"gpt-5.4-mini":           400000,
	"gpt-5.4-nano":           400000,
	"gpt-5.4-pro":            1050000,
	"gpt-5.5":                1050000,
	"gpt-5.5-pro":            1050000,
	"gpt-5.6-luna":           1050000,
	"gpt-5.6-sol":            1050000,
	"gpt-5.6-terra":          1050000,
	"gemini-3-flash":         1048576,
	"gemini-3.1-pro":         1048576,
	"gemini-3.5-flash":       1048576,
	"grok-4.5":               500000,
	"grok-build-0.1":         256000,
	"kimi-k2.5":              262144,
	"kimi-k2.6":              262144,
	"kimi-k2.7-code":         262144,
	"mimo-v2.5-free":         200000,
	"minimax-m2.5":           204800,
	"minimax-m2.7":           204800,
	"minimax-m3":             512000,
	"nemotron-3-ultra-free":  1000000,
	"north-mini-code-free":   256000,
	"qwen3.5-plus":           262144,
	"qwen3.6-plus":           262144,
}

const DefaultContextWindow = 200000
const DefaultMaxOutputTokens = 32000

var ModelMaxOutputTokens = map[string]int{
	"deepseek-v4-flash":     384000,
	"deepseek-v4-pro":       384000,
	"grok-4.5":              500000,
	"grok-build-0.1":        256000,
	"kimi-k2.7-code":        262144,
	"minimax-m3":            128000,
	"nemotron-3-ultra-free": 128000,
	"north-mini-code-free":  64000,
}

var (
	contextWindowCaps = utils.ModelCaps{Default: DefaultContextWindow, Overrides: ModelContextWindows}
	maxOutputCaps     = utils.ModelCaps{Default: DefaultMaxOutputTokens, Overrides: ModelMaxOutputTokens}
)

// thinkingSpec returns the reasoning-effort spec for an OpenCode Zen model.
// Most models support low/medium/high; DeepSeek V4 models use high/xhigh.
func thinkingSpec(modelID string) openaibase.ThinkingSpec {
	m := strings.ToLower(modelID)

	if strings.HasPrefix(m, "deepseek-v4") {
		return openaibase.ThinkingSpec{
			Levels:  []string{provider.ThinkingHigh, "xhigh"},
			Default: provider.ThinkingHigh,
			Effort: map[string]string{
				provider.ThinkingHigh: "high",
				"xhigh":               "xhigh",
			},
		}
	}

	// All other models on this gateway support low/medium/high
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
