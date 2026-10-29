//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside worker_cancel_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"encoding/json"
	"testing"
	"time"
)

// TestCancelParksWhenToolExecuting verifies the executing-must-park rule AND
// that the cancel preserves the warm session: when the user cancels while a turn
// parked in awaiting_llm has a genuinely executing tool (not merely awaiting
// approval), the worker (a) keeps any queued message (promotes it into the
// thread) and rests at idle WITHOUT driving a new LLM turn — the interrupted
// work must not be silently re-driven — and (b) releases the provider session,
// which is warm-preserving (the resume anchor survives), so the next turn
// resumes via regimeResumeDelta rather than cold-starting the conversation. The
// browser harness cannot pin a running tool under awaiting_llm (pauseBeforeReturn
// pins the LLM call, i.e. StateProcessing), so this branch is covered here; the
// pure-approval continue path is covered by the queued-message integration tests.
func TestCancelParksWhenToolExecuting(t *testing.T) {
	w := NewConversationWorker("test-cancel-park", "user:test")

	// A turn parked in awaiting_llm with one tool genuinely executing (running)
	// AND one still pending approval — the "mixed" case: approvals plus a
	// long-running task in flight.
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "do work",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "Working.",
		Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-run", ToolUseID: "tu-run",
		ToolName: "bash", State: StateRunning,
	})
	w.doc.InsertMessage(3, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-pend", ToolUseID: "tu-pend",
		ToolName: "bash", State: StatePending,
	})

	// Queue a follow-up message at root while the turn is in flight.
	w.enqueuePendingMessage("", UserMessageInput{Text: "queued follow-up"})

	// A turn that began a minute ago is anchored in memory and in the doc.
	oldAnchor := time.Now().Add(-60 * time.Second).UnixMilli()
	w.turn.processingStartedAt.Store(oldAnchor)

	// Record that the worker released the provider session (warm-preserving).
	var released bool
	w.SetCancelLLMSession(func(_, _ string) { released = true })

	// The post-tool branch: worker idle, activity=awaiting_llm, the minute-old
	// anchor visible in the doc.
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityAwaitingLLM,
		"threadItemId": "",
		"status":       "processing_tools",
		"startedAt":    oldAnchor,
	})
	w.currentRun().storeState(StateIdle)

	// Precondition: a running tool means this is NOT a pure-approval block.
	if w.blockedOnlyByApprovals("") {
		t.Fatal("precondition: a running tool must make blockedOnlyByApprovals=false")
	}

	w.currentRun().handleCancel(cancelReasonUnspecified)

	// The elapsed-time anchor must reset on the stop. Parking rests the turn via
	// sendStatus("idle"), so the NEXT turn — a Continue the user presses to start
	// the queued message — begins its timer from zero instead of inheriting this
	// cancelled turn's minute-old anchor (the "elapsed time didn't reset" bug).
	if w.turn.processingStartedAt.Load() != 0 {
		t.Errorf("park: expected in-memory elapsed anchor reset to 0, got %d", w.turn.processingStartedAt.Load())
	}
	if startedAtPresent(t, w) {
		t.Error("park: expected doc startedAt dropped once the turn rests at idle")
	}

	// Real work was in flight: the worker releases the provider session, which
	// is warm-preserving (the resume anchor + sidecar survive). Re-driving the
	// interrupted tools is prevented by the parking below, NOT by dropping the
	// session — dropping it would force a multi-minute cold start, the dominant
	// spurious-cold-start path, since Claude emits multi-tool batches where one
	// tool executes while a sibling still awaits approval.
	if !released {
		t.Error("executing-tool cancel: expected the provider session to be released")
	}

	// Parked: activity cleared, no new LLM claim.
	if got := w.getActivity(); got != ActivityNone {
		t.Errorf("park: expected activity=%q (rested), got %q", ActivityNone, got)
	}
	if w.isLLMClaimed() {
		t.Error("park: expected no LLM claim after cancel")
	}

	// The queue was kept (promoted into items), not dropped, and is now empty.
	if w.hasPendingItems("") {
		t.Error("park: expected the pending queue to be promoted (empty)")
	}
	items := w.doc.GetItems()
	last := items[len(items)-1]
	if last.Type != ItemTypeUser || last.Content != "queued follow-up" {
		t.Errorf("park: expected last item to be the promoted user message, got type=%q content=%q",
			last.Type, last.Content)
	}

	// Every in-flight tool — running AND pending — was cancelled (Escape = stop all).
	for _, it := range items {
		if it.Type != ItemTypeToolAction {
			continue
		}
		if it.State != StateCancelled {
			t.Errorf("park: expected tool %q cancelled, got state=%q", it.ToolUseID, it.State)
		}
	}

	w.doc.Destroy()
}

// TestStrategyLoopExitCleansUpToolActions verifies that when the strategy loop
// exits (via cancellation), stale tool-actions are cleaned up with interrupted results.
func TestStrategyLoopExitCleansUpToolActions(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Set up mock mode with a response that creates tool actions
	w.setMockResponses([]MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-1", Name: "bash", Input: json.RawMessage(`{"command":"ls"}`)},
			},
			StopReason: "tool_use",
		},
	})

	// Add a tool-action item manually (simulating what addToolAction does)
	// to represent an in-flight tool that won't complete
	w.doc.InsertMessage(0, ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-stale",
		ToolUseID: "tu-stale",
		ToolName:  "bash",
	})

	// Call CancelStaleToolActions directly (as the strategy loop defer would)
	w.CancelStaleToolActions("")

	// Verify the stale tool-action was marked as interrupted
	items := w.doc.GetItems()
	found := false
	for _, item := range items {
		if item.ToolUseID == "tu-stale" {
			found = true
			if len(item.Result) == 0 {
				t.Error("Stale tool-action should have interrupted result")
			} else {
				var r map[string]any
				_ = json.Unmarshal(item.Result, &r)
				if r["content"] != "Interrupted" {
					t.Errorf("Expected 'Interrupted', got %v", r["content"])
				}
				if r["cancelled"] != true {
					t.Error("Expected cancelled=true")
				}
			}
		}
	}
	if !found {
		t.Error("Stale tool-action not found in items")
	}

	w.doc.Destroy()
}
