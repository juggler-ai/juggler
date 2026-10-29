//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside compaction_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"encoding/json"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// TestStrategyRunThreadRecoveredByReconcileTick pins the other half: a fold that
// IS committed and then loses the claim race must still run. needsStrategyRun is
// consumed only after a successful claim, and the release that frees the claim
// writes processingState rather than items — so the items observer never fires
// again. The reducer tick is the retry; without it the thread waits forever.
func TestStrategyRunThreadRecoveredByReconcileTick(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedCompactionContextAndTools(w)
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Recovered summary."}}, StopReason: "end_turn"},
	})

	// A root turn is live when the fold lands, holding the conversation's one
	// write-capable slot, so the observer's pickup is refused admission.
	holder := w.currentRun().beginTurn("")
	w.claimLLM("")
	threadID := insertThreadWithOpts(w, threadOpts{
		goal: "Compacted conversation history", needsStrategyRun: true,
		noAutoSelect: true, boundedCompaction: true, userMessage: "history to summarize",
	})
	if got, _ := w.doc.GetThreadYMap(threadID).Get("result").(string); got != "" {
		t.Fatalf("fold summarized while the claim was held: %q", got)
	}
	if n := len(w.sched.dispatchQueue); n != 0 {
		t.Fatalf("fold was dispatched beside a live write-capable turn (%d queued)", n)
	}
	if !w.sched.reconcilePending() {
		t.Fatal("a fold that lost the claim race left no reconcile armed — nothing will ever revisit it")
	}

	// The in-flight turn ends and is retired, freeing the slot; the reducer ticks.
	w.releaseLLM("")
	w.currentRun().finishRetiredTurn(holder.t)
	w.quiesce(t)

	if got, _ := w.doc.GetThreadYMap(threadID).Get("result").(string); got != "Recovered summary." {
		t.Fatalf("thread result = %q, want the fold summarized once the claim freed", got)
	}
}

// TestResummarizeCompactionThreadRerunsSummarizer pins the Re-summarise route
// for a /compact (or /handoff) fold: the folded summarizer is re-run over the
// SAME source — the committed summary is replaced and nothing is appended to the
// thread. Routing a re-summarise through the ordinary summarise turn instead
// would inject a "summarise this thread" instruction into the very transcript
// being summarized, which the summarizer then feeds back to the model.
func TestResummarizeCompactionThreadRerunsSummarizer(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	threadID := insertBoundedCompactionThread(t, w, "history to summarize")
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		w.doc.GetThreadYMap(threadID).Set("result", "Stale summary.")
	}, w.doc.authorID)
	w.currentRun().resetThreadContext()

	stop := make(chan struct{})
	defer close(stop)
	ctxResp, _ := json.Marshal(map[string]any{
		"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{},
	})
	toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
	go func() {
		for {
			if !w.engine.contextReply.inject(stop, ctxResp) {
				return
			}
		}
	}()
	go func() {
		for {
			if !w.engine.toolsReply.inject(stop, toolsResp) {
				return
			}
		}
	}()

	itemsBefore := len(w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID)))
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Fresh summary."}}, StopReason: "end_turn"},
	})

	payload, _ := json.Marshal(ResummarizeCompactionThreadMessage{
		Type: "resummarize-compaction-thread", ThreadItemID: threadID,
	})
	w.currentRun().handleResummarizeCompactionThread(payload)
	w.quiesce(t)

	if got, _ := w.doc.GetThreadYMap(threadID).Get("result").(string); got != "Fresh summary." {
		t.Fatalf("thread result = %q, want the regenerated summary", got)
	}
	if itemsAfter := len(w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID))); itemsAfter != itemsBefore {
		t.Fatalf("thread items = %d, want %d unchanged — re-summarise must not append to the source", itemsAfter, itemsBefore)
	}
}
