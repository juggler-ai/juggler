//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ollama

import "juggler/cmd/juggler/providers/openaibase"

// reasoningReplay is the descriptor's ReasoningReplayFn. Ollama's
// OpenAI-compatible endpoint maps "reasoning" on an assistant message to the
// model's native thinking, which its templates render; "reasoning_content" is
// silently ignored (measured on qwen3: the prompt grew by the reasoning's
// tokens under one key and not the other).
func reasoningReplay(string) openaibase.ReasoningReplay {
	return openaibase.ReasoningReplay{Field: "reasoning"}
}
