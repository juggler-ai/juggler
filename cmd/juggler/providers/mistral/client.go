//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package mistral

import (
	"juggler/cmd/juggler/providers/openaibase"
)

// Register adds the Mistral AI provider to the global registry. Called
// explicitly from main; no init()-time side effects.
//
// Mistral speaks the OpenAI Chat-Completions protocol, so it rides the shared
// openaibase machinery. Its API key is independent of the generic
// OpenAI-compatible provider, so a user can configure both side by side.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:              "mistral",
		DisplayName:       "Mistral AI",
		Description:       "Mistral AI models via the official OpenAI-compatible API.",
		ConfigKeyName:     "mistral_api_key",
		EnvVarName:        "MISTRAL_API_KEY",
		APIKeyURL:         "https://console.mistral.ai/settings/keys",
		DisplayProvider:   "Mistral AI",
		ContextWindowCaps: contextWindowCaps,
		MaxOutputCaps:     maxOutputCaps,
		InputModalitiesFn: inputModalities,
		ThinkingSpecFn:    thinkingSpec,
		BaseURL:           "https://api.mistral.ai/v1",
	})
}

// inputModalities returns the input modalities a Mistral model accepts.
// Vision-capable models accept images; others are text-only.
func inputModalities(modelID string) []string {
	switch modelID {
	case "codestral-latest", "devstral-medium-latest", "mistral-tiny-latest":
		return nil
	default:
		return []string{"image"}
	}
}
