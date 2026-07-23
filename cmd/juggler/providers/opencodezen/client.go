//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package opencodezen

import (
	"juggler/cmd/juggler/providers/openaibase"
)

// Register adds the OpenCode Zen provider to the global registry. Called
// explicitly from main; no init()-time side effects.
//
// OpenCode Zen is a multi-model gateway hosting models from various vendors
// (Anthropic, OpenAI, DeepSeek, Google, etc.) through an OpenAI-compatible API.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:              "opencodezen",
		DisplayName:       "OpenCode Zen",
		Description:       "Multi-model gateway with models from Anthropic, OpenAI, DeepSeek, Google, and others.",
		ConfigKeyName:     "opencode_api_key",
		EnvVarName:        "OPENCODE_API_KEY",
		APIKeyURL:         "https://opencode.ai",
		DisplayProvider:   "OpenCode Zen",
		ContextWindowCaps: contextWindowCaps,
		MaxOutputCaps:     maxOutputCaps,
		ThinkingSpecFn:    thinkingSpec,
		BaseURL:           "https://opencode.ai/zen/v1",
	})
}
