//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package localai

import "juggler/cmd/juggler/providers/openaibase"

// reasoningReplay is the descriptor's ReasoningReplayFn. LocalAI reads
// "reasoning" on an assistant message back into the model's context
// (https://localai.io/docs/features/interleaved-thinking/).
func reasoningReplay(string) openaibase.ReasoningReplay {
	return openaibase.ReasoningReplay{Field: "reasoning"}
}
