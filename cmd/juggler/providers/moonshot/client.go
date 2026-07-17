//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package moonshot provides direct access to Moonshot AI's Kimi models through
// their OpenAI-compatible Chat Completions API.
package moonshot

import "juggler/cmd/juggler/providers/openaibase"

const baseURL = "https://api.moonshot.cn/v1"

// Register adds the Moonshot Kimi provider to the global registry. It uses a
// credential and provider id independent from the user-configured OpenAI-
// compatible provider, so both can be configured at the same time.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:              "moonshot",
		DisplayName:       "Moonshot Kimi",
		Description:       "Kimi models through Moonshot AI's official OpenAI-compatible API. Models are discovered from Moonshot's /v1/models endpoint.",
		ConfigKeyName:     "moonshot_api_key",
		EnvVarName:        "MOONSHOT_API_KEY",
		APIKeyURL:         "https://platform.kimi.com/console/api-keys",
		DisplayProvider:   "Moonshot Kimi",
		Filter:            modelFilter,
		ContextWindowCaps: contextWindowCaps,
		MaxOutputCaps:     maxOutputCaps,
		InputModalitiesFn: inputModalities,
		ThinkingSpecFn:    thinkingSpec,
		BaseURL:           baseURL,
		Quirks: openaibase.Quirks{
			// Kimi thinking models require the complete assistant message,
			// including reasoning_content, on subsequent tool-call turns.
			EchoReasoningContent: true,
		},
	})
}
