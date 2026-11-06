//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openai

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
)

// Register adds this provider to the global registry. Called explicitly from
// main; no init()-time side effects.
func Register() {
	openaibase.Register(openaibase.Descriptor{
		Name:              "openai",
		DisplayName:       "OpenAI ChatGPT",
		ConfigKeyName:     "openai_api_key",
		EnvVarName:        "OPENAI_API_KEY",
		APIKeyURL:         "https://platform.openai.com/api-keys",
		DisplayProvider:   "OpenAI",
		Filter:            isChatModel,
		ContextWindowCaps: contextWindowCaps,
		MaxOutputCaps:     maxOutputCaps,
		InputModalitiesFn: inputModalities,
		ThinkingSpecFn:    openaibase.OpenAIThinkingSpec,
		// Small/fast tier for out-of-band micro-tasks (auto-naming a tab).
		CheapModel: "gpt-5.6-luna",
		Quirks: openaibase.Quirks{
			UseDeveloperRole:          true,
			MaxTokensParamName:        "max_completion_tokens",
			ForcedToolChoiceSupported: true,
		},
	})
}

// visionGeneration is the OpenAI generation from which every mainline gpt model
// accepts image input. A model wrongly reported text-only does not error: the
// images are simply dropped from the turn.
const visionGeneration = 5

// inputModalities reports the input modalities for an OpenAI model id. Returns
// ["text","image"] for vision-capable families, nil (text-only) otherwise.
func inputModalities(modelID string) []string {
	if supportsVision(modelID) {
		return []string{"text", "image"}
	}
	return nil
}

// supportsVision reports whether an OpenAI model accepts image input. Every
// mainline gpt model from visionGeneration onwards takes images, so that line
// is drawn by generation and covers ids newer than this code; the families
// below it are named individually. Vision families: gpt-4o*, gpt-4.1*,
// gpt-4-turbo*, gpt-5 and later, chatgpt-4o*, o4-mini, and the full o1/o3
// reasoning models. Text-only exceptions handled by exclusion: gpt-4 base,
// gpt-3.5, o1-mini, o1-preview, o3-mini.
func supportsVision(modelID string) bool {
	m := strings.ToLower(modelID)
	if openaibase.GPTGeneration(m) >= visionGeneration {
		return true
	}
	switch {
	case strings.HasPrefix(m, "gpt-4o"),
		strings.HasPrefix(m, "chatgpt-4o"),
		strings.HasPrefix(m, "gpt-4.1"),
		strings.HasPrefix(m, "gpt-4-turbo"),
		strings.HasPrefix(m, "o4-mini"):
		return true
	// o1 / o3 full reasoning models support vision; their -mini and o1-preview
	// variants are text-only. Match the bare id and dated ids (o1-2024-…),
	// excluding the -mini/-preview suffixes.
	case m == "o1" || strings.HasPrefix(m, "o1-2"),
		m == "o3" || strings.HasPrefix(m, "o3-2"):
		return true
	default:
		return false
	}
}
