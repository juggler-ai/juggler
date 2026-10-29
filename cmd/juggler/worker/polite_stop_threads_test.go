//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// Polite stop (Pause) in a conversation holding more than one thread.
//
// Every case in polite_stop_test.go drives a single thread, so nothing pins what
// the latch means when several runs are live — which is the ordinary shape of any
// turn that spawned sub-agents.

// feedContextAndTools answers the context/tools round-trips a dispatched turn
// makes, so a turn that wrongly dispatches COMPLETES — leaving evidence in the
// mock queue — instead of hanging the test on a reply channel.
func feedContextAndTools(t *testing.T, w *ConversationWorker) {
	t.Helper()
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
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
}

// TestPoliteStop_PausedFoldKeepsItsRightToASummary covers the window the pickup
// gate cannot: a pause that arrives while the fold is ALREADY being summarized.
// The trigger was legitimately consumed at pickup, and the reducer's walk offers
// nothing to a thread whose last item is the summarization prompt — so a run that
// simply rested here would leave the folded history behind a tile with no summary
// and nothing left to ask for one. The paused settle re-arms what the pickup
// spent, and lifting the pause summarizes it.
func TestPoliteStop_PausedFoldKeepsItsRightToASummary(t *testing.T) {
	w := NewConversationWorker("test-polite-fold", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedCompactionContextAndTools(w)
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "the summary"}}}, nil
	})

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "do the thing",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	// A fold mid-summarization: the pickup has claimed it and consumed its
	// needsStrategyRun, so the thread carries neither.
	fold := insertThreadWithOpts(w, threadOpts{
		goal: "Compacted conversation history", boundedCompaction: true,
		noAutoSelect: true, userMessage: "the folded history",
	})
	w.currentRun().claimLLM(fold)
	w.turn.thread.itemID = fold

	// The user presses Pause while the summarizer is working.
	w.markPoliteStop("")
	w.driveStrategyLoop(t, "", true)

	ymap := w.doc.GetThreadYMap(fold)
	ycrdtMu.Lock()
	armed, _ := ymap.Get("needsStrategyRun").(bool)
	summary, _ := ymap.Get("result").(string)
	ycrdtMu.Unlock()
	if summary != "" {
		t.Fatalf("the paused fold summarized anyway (result = %q)", summary)
	}
	if !armed {
		t.Fatal("a fold paused mid-summary lost its needsStrategyRun: the folded history is now behind " +
			"a tile with no summary, and nothing — not even an unpause — can ask for one")
	}

	w.handleUnpause("")
	w.quiesce(t)

	ycrdtMu.Lock()
	summary, _ = ymap.Get("result").(string)
	ycrdtMu.Unlock()
	if summary == "" {
		t.Error("lifting the pause did not summarize the fold it parked")
	}
}
