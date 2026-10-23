//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package moonshot

import (
	"strings"

	"juggler/cmd/juggler/providers/openaibase"
)

// reasoningReplay is the descriptor's ReasoningReplayFn. The Kimi models all
// think; the legacy moonshot-v1 models never do, and get no field.
func reasoningReplay(modelID string) openaibase.ReasoningReplay {
	if strings.HasPrefix(strings.ToLower(modelID), "kimi-") {
		return openaibase.KimiReasoningReplay
	}
	return openaibase.ReasoningReplay{}
}
