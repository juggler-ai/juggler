//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package zai

import "juggler/cmd/juggler/providers/openaibase"

// reasoningReplay is the descriptor's ReasoningReplayFn. The coding endpoint
// keeps reasoning across calls by default and expects every earlier block back,
// unmodified and in order; a model that never reasons produces nothing to send.
func reasoningReplay(string) openaibase.ReasoningReplay { return openaibase.GLMReasoningReplay }
