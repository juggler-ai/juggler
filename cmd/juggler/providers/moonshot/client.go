//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package moonshot

import (
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/openaibase"
)

// Register adds the Moonshot (Kimi) provider to the global registry. Called
// explicitly from main; no init()-time side effects.
//
// Moonshot speaks the OpenAI Chat-Completions protocol, so it rides the shared
// openaibase machinery. Its API key is independent of the generic
// OpenAI-compatible provider, so a user can configure both side by side.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		ReasoningReplayFn: reasoningReplay,
		Name:              "moonshot",
		DisplayName:       "Moonshot Kimi",
		Description:       msg.New("Kimi models through Moonshot AI's official OpenAI-compatible API. Models are discovered from Moonshot's /v1/models endpoint."),
		ConfigKeyName:     "moonshot_api_key",
		EnvVarName:        "MOONSHOT_API_KEY",
		APIKeyURL:         "https://platform.moonshot.cn/console/api-keys",
		DisplayProvider:   "Moonshot",
		Filter:            isChatModel,
		ContextWindowCaps: contextWindowCaps,
		MaxOutputCaps:     maxOutputCaps,
		InputModalitiesFn: inputModalities,
		ThinkingSpecFn:    thinkingSpec,
		BaseURL:           "https://api.moonshot.cn/v1",
	})
}
