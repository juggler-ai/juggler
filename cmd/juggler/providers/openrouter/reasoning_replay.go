//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openrouter

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
)

// reasoningReplay is the descriptor's ReasoningReplayFn. OpenRouter takes plain
// reasoning back under "reasoning" on an assistant message and relays it
// upstream (https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
// Only the vendors whose reasoning is plain text and is meant to come back get
// it, each with its own Required rule. Claude, Gemini and GPT need their
// signed or encrypted reasoning_details instead, which this does not carry,
// so they get none.
func reasoningReplay(modelID string) openaibase.ReasoningReplay {
	vendor, _, _ := strings.Cut(strings.ToLower(modelID), "/")
	var replay openaibase.ReasoningReplay
	switch vendor {
	case "z-ai":
		replay = openaibase.GLMReasoningReplay
	case "moonshotai":
		replay = openaibase.KimiReasoningReplay
	case "deepseek":
		replay = openaibase.DeepSeekReasoningReplay
	default:
		return openaibase.ReasoningReplay{}
	}
	replay.Field = "reasoning"
	return replay
}
