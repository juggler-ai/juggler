//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package deepseek

import (
	"juggler/cmd/juggler/providers/openaibase"
)

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		ReasoningReplayFn: reasoningReplay,
		Name:              "deepseek",
		DisplayName:       "DeepSeek",
		ConfigKeyName:     "deepseek_api_key",
		EnvVarName:        "DEEPSEEK_API_KEY",
		APIKeyURL:         "https://platform.deepseek.com/api_keys",
		DisplayProvider:   "DeepSeek",
		// The catalog is flash and pro; flash is the cheap half by name and by
		// price.
		CheapModel:         "deepseek-v4-flash",
		Filter:             modelFilter(),
		ContextWindowCaps:  contextWindowCaps,
		MaxOutputCaps:      maxOutputCaps,
		UsageStatsOverride: usageStats,
		BaseURL:            "https://api.deepseek.com/v1",
		Quirks: openaibase.Quirks{
			IncludePresencePenalty:  true,
			IncludeFrequencyPenalty: true,
			// No ForcedToolChoiceSupported: DeepSeek's thinking mode 400s on a
			// named tool_choice, so it relies on the fail-safe default (forced
			// tool choice downgraded to auto).
		},
	})
}
