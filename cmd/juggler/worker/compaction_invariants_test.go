//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// The four properties automatic compaction has to hold, each driven through
// real turns of the strategy loop against real admission.
//
// Everything else in this package tests a piece of compaction: how the reducer
// packs a chunk, which items a fold pins, what the tape records. Those tests all
// build the state they examine, so they cannot see the two things that actually
// went wrong in practice — a compaction that fired at a useless moment, and a
// compaction that cost the conversation its name. Both live in the seams
// between well-tested units, and both are outcomes of running a conversation
// rather than shapes of a data structure. So these tests run conversations.
//
//	I1 fits      — no request is ever dispatched over the window.
//	I2 timely    — compaction happens while a turn can still use it.
//	I3 identity  — compaction does not change who the conversation is.
//	I4 terminates— compaction always converges, however bad the input.

// compactionWorld is a worker wired to real registry admission over a small
// context window, with a scripted model on the other side. Turns are driven
// through runStrategyLoop exactly as production drives them.
type compactionWorld struct {
	t          *testing.T
	w          *ConversationWorker
	underlying *compactionAdmissionConversation
	autoNames  []string

	// visibleDispatches records the estimated input size of each visible
	// (non-compaction) request that admission actually let through, in order.
	visibleDispatches []int64
	// foldsAtDispatch[i] is how many compaction folds existed at the moment
	// dispatch i went out. Sampled at the dispatch itself, because that is the
	// only place the question "did this fold arrive in time to be used?" has a
	// sharp answer: a fold is timely exactly when some later request carries it.
	foldsAtDispatch []int
	reducerCalls    int
}

// runToolTurn completes one tool round-trip the way the engine does: approve
// the call, drive the execution command, write the result back, then re-enter
// the strategy loop as the reducer's dispatchCallLLMOnThread would.
func (world *compactionWorld) runToolTurn(toolUseID, result string) {
	world.t.Helper()
	if err := world.w.doc.UpdateItemByToolUseID(toolUseID, "state", StateApproved); err != nil {
		world.t.Fatal(err)
	}
	world.driveToolActions()
	if err := world.w.doc.UpdateItemByToolUseID(toolUseID, "state", StateCompleted); err != nil {
		world.t.Fatal(err)
	}
	if err := world.w.doc.UpdateItemByToolUseID(toolUseID, "result", map[string]any{"content": result, "isError": false}); err != nil {
		world.t.Fatal(err)
	}
	world.w.driveStrategyLoop(world.t, "", true)
}

func (world *compactionWorld) driveToolActions() { world.w.driveToolActions() }

func (world *compactionWorld) foldCount() int {
	folds := 0
	for _, item := range world.w.doc.GetItems() {
		if item.Type == ItemTypeThread && item.BoundedCompaction {
			folds++
		}
	}
	return folds
}

func (world *compactionWorld) errorItems() []string {
	var errs []string
	for _, item := range world.w.doc.GetItems() {
		if item.Type == ItemTypeError {
			errs = append(errs, item.Content)
		}
	}
	return errs
}

func toolUseTurn(id string) *LLMResponse {
	return &LLMResponse{
		Blocks:     []LLMResponseBlock{{Type: "tool_use", ID: id, Name: "bash", Input: json.RawMessage(`{"command":"work"}`)}},
		StopReason: "tool_use",
	}
}

func endTurn(text string) *LLMResponse {
	return &LLMResponse{
		Blocks:     []LLMResponseBlock{{Type: "text", Content: text}},
		StopReason: "end_turn",
	}
}

// repeatToTokens builds a string that admission estimates at roughly want
// tokens, by measuring rather than by a fixed repeat count. Fixtures that
// pressure the context window have to be expressed in the estimator's own units
// — a hardcoded length silently stops crossing the ceiling the moment a rate
// changes, and the test then passes vacuously instead of failing loudly.
func repeatToTokens(t *testing.T, unit string, want int64) string {
	t.Helper()
	estimate := func(s string) int64 {
		return provider.EstimateMessageRequestTokens(provider.MessageRequest{
			Messages: []provider.Message{{Type: "tool-result", Content: s}},
		})
	}
	for n := 1; n <= 1<<22; {
		text := strings.Repeat(unit, n)
		got := estimate(text)
		if got >= want {
			return text
		}
		next := int(float64(n) * float64(want) / float64(max(got, 1)))
		if next <= n {
			next = n + 1
		}
		n = next
	}
	t.Fatalf("could not reach %d tokens by repeating %q", want, unit)
	return ""
}
