//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package opencodezen

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
)

// reasoningReplay is the descriptor's ReasoningReplayFn. Zen relays DeepSeek's
// own 400 when reasoning_content is missing, so its DeepSeek models get
// DeepSeek's contract. No other route is known to pass the field through, and
// the GLM route has rejected unknown request fields, so the rest get none.
func reasoningReplay(modelID string) openaibase.ReasoningReplay {
	if strings.HasPrefix(strings.ToLower(modelID), "deepseek-") {
		return openaibase.DeepSeekReasoningReplay
	}
	return openaibase.ReasoningReplay{}
}
