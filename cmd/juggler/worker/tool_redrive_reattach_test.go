//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// reattachHarness wires a worker with an attached engine that counts the
// execute-tool commands the worker dispatches, keyed by toolUseId. A
// sentinel rides the SAME ordered engine mailbox as the commands, so flush()
// is a deterministic barrier (no sleeps): once the callback observes the
// sentinel, every command enqueued before it has already been delivered.
//
// The engine callback runs on its own mailbox goroutine, so each execute-tool
// id is handed to the test goroutine over a buffered channel (no mutex); the
// tally map is drained and read only on the test goroutine, after flush().
type reattachHarness struct {
	w          *ConversationWorker
	executesCh chan string
	counted    map[string]int
	flushCh    chan struct{}
}

func newReattachHarness(t *testing.T, convID string) *reattachHarness {
	t.Helper()
	w := NewConversationWorker(convID, "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: convID},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)

	h := &reattachHarness{
		w:          w,
		executesCh: make(chan string, 64),
		counted:    map[string]int{},
		flushCh:    make(chan struct{}, 1),
	}
	w.SetCallback("engine", func(b []byte) {
		var m ToolCommand
		_ = json.Unmarshal(b, &m)
		switch {
		case m.Type == "flush-sentinel":
			select {
			case h.flushCh <- struct{}{}:
			default:
			}
		case m.Type == "execute-tool" && m.ToolUseID != "":
			h.executesCh <- m.ToolUseID
		}
	})
	w.SetEngineClientID("engine")
	return h
}

// flushBarrierWait is how long a flush barrier waits for its sentinel, here and
// in the cancel-epoch harness. What it waits on is a channel hand-off between
// two goroutines of this process, so the wait is a deadlock detector and never a
// measurement: the outcomes are microseconds, or never. A short value therefore
// buys nothing and costs a failure on any machine busy enough to delay a
// hand-off — CI has taken six seconds over these, which is how the 10s version
// of this wait came to fail — so it sits where no amount of starvation reaches
// it while a barrier that genuinely never lifts still ends the test. Past it the
// package's own -timeout is the better diagnosis anyway: that panics with a
// goroutine dump naming the blocked send, which this Fatal cannot do.
const flushBarrierWait = 90 * time.Second

func (h *reattachHarness) flush(t *testing.T) {
	t.Helper()
	b, _ := json.Marshal(ToolCommand{Type: "flush-sentinel"})
	h.w.callbacks.sendToEngine(b)
	select {
	case <-h.flushCh:
	case <-time.After(flushBarrierWait):
		t.Fatal("flush barrier timed out")
	}
}

// executeCount drains every execute-tool id delivered so far (the flush
// barrier guarantees all prior callback sends have completed) into the
// test-goroutine-owned tally, then returns the count for the given id.
func (h *reattachHarness) executeCount(id string) int {
	for {
		select {
		case x := <-h.executesCh:
			h.counted[x]++
		default:
			return h.counted[id]
		}
	}
}

// reattach drives the engine-reattach path exactly as the manager does
// (SendFromClient → "resync-to-origin"): clears the command-dedup bookkeeping,
// resets stranded running tools, and re-drives every non-terminal tool-action
// against the freshly attached engine.
func (h *reattachHarness) reattach() {
	h.w.currentRun().dispatchMessage(workerMessage{Type: "resync-to-origin", OriginClient: "engine"})
}

// TestReattach_SkipsToolWhoseResultDeliveredThisTurn is the Item 1.1 genesis
// guard. A tool can be sitting in state=running with no result in the doc while
// the worker has ALREADY delivered a result for it to the provider this turn —
// the auto-continue race feeds an isError placeholder for a not-yet-complete
// tool (llm_request.go buildMessages). If an engine reattach then fires
// mid-turn, resetRunningToolsForReattach must NOT reset+re-execute that tool:
// re-running re-fires the side effect, and the real result the re-run produces
// is dropped by the provider's per-turn fedResultIDs guard as a duplicate —
// stranding the model on the placeholder. The reattach reset must treat a
// tool whose result was delivered this turn as terminal-for-this-turn.
//
// This is the AUTHORITATIVE repro for the duplicate re-feed: it cannot be
// constructed through the claudecode provider's own streamMessage, because
// extractToolResults filters feeds to the current pendingTools — so the
// genesis only manifests worker-side, here, at the re-drive source.
func TestReattach_SkipsToolWhoseResultDeliveredThisTurn(t *testing.T) {
	h := newReattachHarness(t, "conv-reattach-delivered")
	w := h.w

	// A side-effecting tool the engine claimed (state=running) but whose result
	// has NOT landed in the doc yet.
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateRunning,
	})

	// The worker builds a provider request while tu-1 is still running: this is
	// the real feed path. buildMessages emits an isError placeholder tool-result
	// for tu-1 (it isn't completed), delivering a result for tu-1 this turn.
	msgs := w.currentRun().buildMessages(nil)
	if !hasToolResultFor(msgs, "tu-1") {
		t.Fatalf("precondition: buildMessages should feed a (placeholder) tool-result for the running tu-1; messages=%+v", msgs)
	}

	// Engine reattaches mid-turn.
	h.reattach()
	h.flush(t)

	if got := h.executeCount("tu-1"); got != 0 {
		t.Fatalf("reattach re-executed tu-1 after its result was already delivered this turn: "+
			"want 0 execute-tool commands, got %d (duplicate side effect; real result will be dropped by the provider)", got)
	}
}

// TestReattach_RedrivesUndeliveredRunningTool is the crash-recovery guard that
// the fix must NOT regress: a tool genuinely stranded in state=running by a
// dead engine — no result delivered to the provider this turn — MUST be reset
// and re-executed on reattach, preserving the documented crash-mid-execution
// recovery property.
func TestReattach_RedrivesUndeliveredRunningTool(t *testing.T) {
	h := newReattachHarness(t, "conv-reattach-undelivered")
	w := h.w

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-2", ToolUseID: "tu-2",
		ToolName: "bash", State: StateRunning,
	})

	// No buildMessages dispatch: nothing was ever fed for tu-2 this turn.

	h.reattach()
	h.flush(t)

	if got := h.executeCount("tu-2"); got != 1 {
		t.Fatalf("reattach failed to re-execute a genuinely-stranded running tool: "+
			"want 1 execute-tool command, got %d (crash-recovery regressed)", got)
	}
}

// TestReattach_SkipsWorkerExecutedToolByStamp guards the executor="worker" stamp
// half of resetRunningToolsForReattach's worker-executed skip. A worker-managed
// tool carrying the stamp (written at evaluate) but NOT named "create_thread" must
// be treated as worker-executed: never reset to approved, never re-driven against
// the engine (the worker owns its re-drive). This mirrors the stamp-primary +
// create_thread-fallback shape in finalizeToolsAbsentFromExecReport; only the
// stamp can exclude a tool whose name isn't the create_thread fallback.
func TestReattach_SkipsWorkerExecutedToolByStamp(t *testing.T) {
	h := newReattachHarness(t, "conv-reattach-worker-stamp")
	w := h.w

	// Stranded worker-managed tool: state=running, no result, stamped
	// executor="worker", and deliberately not named create_thread so only the
	// stamp can exclude it.
	insertRunningTool(w, "ta-1", "tu-1", "some_worker_tool", 1, 1000)
	w.doc.UpdateToolActionFieldsRecursive("tu-1", map[string]any{"executor": "worker"})

	h.reattach()
	h.flush(t)

	if got := h.executeCount("tu-1"); got != 0 {
		t.Fatalf("reattach re-drove a worker-executed (executor=worker) tool: "+
			"want 0 execute-tool commands, got %d", got)
	}
	if got := toolState(w, "tu-1"); got != StateRunning {
		t.Fatalf("reattach reset a worker-executed tool off running: want %q, got %q", StateRunning, got)
	}
}

func hasToolResultFor(messages []map[string]any, toolUseID string) bool {
	for _, m := range messages {
		if m["type"] == "tool-result" {
			if id, _ := m["toolUseId"].(string); id == toolUseID {
				return true
			}
		}
	}
	return false
}

// TestReattach_NullResultIsNoResult: a stranded running tool whose result is a
// JS-written null (createToolActionMessage's `result: null`) has no result, so
// reattach must reset and re-drive it like any other stranded tool.
func TestReattach_NullResultIsNoResult(t *testing.T) {
	h := newReattachHarness(t, "conv-reattach-null-result")
	w := h.w

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-2", ToolUseID: "tu-2",
		ToolName: "bash", State: StateRunning,
	})
	setNullResult(w, "tu-2")

	h.reattach()
	h.flush(t)

	if got := h.executeCount("tu-2"); got != 1 {
		t.Fatalf("reattach must re-drive a stranded running tool whose result is null: want 1 execute-tool, got %d", got)
	}
}
