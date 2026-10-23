//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package lmstudio

import "juggler/cmd/juggler/providers/openaibase"

// reasoningReplay is the descriptor's ReasoningReplayFn. LM Studio accepts
// reasoning_content on an assistant message, the field it streams reasoning
// under; whether a model's template renders it is LM Studio's business.
func reasoningReplay(string) openaibase.ReasoningReplay {
	return openaibase.ReasoningReplay{Field: "reasoning_content"}
}
