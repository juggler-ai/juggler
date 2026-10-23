//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package llamacpp

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
)

// reasoningReplay is the descriptor's ReasoningReplayFn. llama-server passes
// reasoning_content on an assistant message to the chat template, which keeps
// it where the model's template supports it and drops it otherwise
// (ggml-org/llama.cpp#18994). gpt-oss's template answers 500 to content,
// reasoning and tool calls on one message (ggml-org/llama.cpp#19701), so
// gpt-oss gets none.
func reasoningReplay(modelID string) openaibase.ReasoningReplay {
	if strings.Contains(strings.ToLower(modelID), "gpt-oss") {
		return openaibase.ReasoningReplay{}
	}
	return openaibase.ReasoningReplay{Field: "reasoning_content"}
}
