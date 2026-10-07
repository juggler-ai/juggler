//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// insertRunningTool inserts a running-with-no-result tool-action and stamps its
// generation + claim time the way the engine's claimRunning would. Fields are
// written as plain ints (convertToYcrdt narrows int/float64 but not int64 — the
// same shape a synced JS number lands as).
func insertRunningTool(w *ConversationWorker, itemID, toolUseID, toolName string, runningEpoch, runningStartedAt int) {
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: itemID, ToolUseID: toolUseID,
		ToolName: toolName, State: StateRunning,
	})
	w.doc.UpdateToolActionFieldsRecursive(toolUseID, map[string]any{
		"runningEpoch":     runningEpoch,
		"runningStartedAt": runningStartedAt,
	})
}

// sendExecReport ingests a tool-execution-report as if from the named engine
// client. executing maps toolUseId → runningEpoch for the reported executing set.
func sendExecReport(w *ConversationWorker, originClient string, seq, sentAt int64, executing map[string]int64) {
	type entry struct {
		ToolUseID    string `json:"toolUseId"`
		RunningEpoch int64  `json:"runningEpoch"`
	}
	ex := make([]entry, 0, len(executing))
	for id, ep := range executing {
		ex = append(ex, entry{ToolUseID: id, RunningEpoch: ep})
	}
	payload, _ := json.Marshal(map[string]any{"seq": seq, "sentAt": sentAt, "executing": ex})
	w.handleToolExecutionReport(payload, originClient)
}

func toolState(w *ConversationWorker, toolUseID string) string {
	s, _ := readToolActionField(w, toolUseID, "state").(string)
	return s
}

// TestExecReport_FinalizesToolAbsentFromTwoReports is the core INV-B/C path: a
// tool stuck at running-with-no-result, absent from two consecutive fresh accepted
// reports whose sentAt postdates its claim, is finalized exactly once.
func TestExecReport_FinalizesToolAbsentFromTwoReports(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-absent")
	w := h.w
	insertRunningTool(w, "ta-1", "tu-1", "bash", 3, 1000)

	// Two reports, both after the claim (1000 + grace 2000 = 3000 < 5000/6000), both
	// with an empty executing set → tu-1 absent in both.
	sendExecReport(w, "engine", 1, 5000, map[string]int64{})
	sendExecReport(w, "engine", 2, 6000, map[string]int64{})

	w.finalizeToolsAbsentFromExecReport()
	if got := toolState(w, "tu-1"); got != StateCancelled {
		t.Fatalf("absent-from-two-reports tool should be finalized cancelled, got %q", got)
	}
	// Idempotent: a second tick is a no-op (already terminal).
	w.finalizeToolsAbsentFromExecReport()
	if got := toolState(w, "tu-1"); got != StateCancelled {
		t.Fatalf("re-running the rule must not disturb an already-cancelled tool, got %q", got)
	}
}

// TestExecReport_PresentToolUntouched: a genuinely long-running tool the engine
// keeps reporting (matching generation) is never finalized, no matter how long.
func TestExecReport_PresentToolUntouched(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-present")
	w := h.w
	insertRunningTool(w, "ta-1", "tu-1", "bash", 3, 1000)

	sendExecReport(w, "engine", 1, 5000, map[string]int64{"tu-1": 3})
	sendExecReport(w, "engine", 2, 6000, map[string]int64{"tu-1": 3})

	w.finalizeToolsAbsentFromExecReport()
	if got := toolState(w, "tu-1"); got != StateRunning {
		t.Fatalf("a tool present in the reports (matching epoch) must stay running, got %q", got)
	}
}

// TestExecReport_DifferentEpochFinalized: the id is present but under a DIFFERENT
// generation than the doc's — the reported incarnation is a re-run of a dead one,
// so the doc's stale running execution is finalized.
func TestExecReport_DifferentEpochFinalized(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-diffepoch")
	w := h.w
	insertRunningTool(w, "ta-1", "tu-1", "bash", 3, 1000)

	sendExecReport(w, "engine", 1, 5000, map[string]int64{"tu-1": 9})
	sendExecReport(w, "engine", 2, 6000, map[string]int64{"tu-1": 9})

	w.finalizeToolsAbsentFromExecReport()
	if got := toolState(w, "tu-1"); got != StateCancelled {
		t.Fatalf("a tool present under a different generation must be finalized, got %q", got)
	}
}

// TestExecReport_FresherClaimUntouched: the claim postdates the reports (a re-claim
// that simply hasn't appeared in one yet) — the happens-after guard leaves it alone.
func TestExecReport_FresherClaimUntouched(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-fresh-claim")
	w := h.w
	insertRunningTool(w, "ta-1", "tu-1", "bash", 3, 9000) // claim at 9000

	sendExecReport(w, "engine", 1, 5000, map[string]int64{})
	sendExecReport(w, "engine", 2, 6000, map[string]int64{})

	w.finalizeToolsAbsentFromExecReport()
	if got := toolState(w, "tu-1"); got != StateRunning {
		t.Fatalf("a claim newer than the reports must not be finalized, got %q", got)
	}
}

// TestExecReport_BeltRequiresTwoReports: absence in only ONE accepted report is not
// enough — the 2-consecutive belt holds finalization until a second report agrees.
func TestExecReport_BeltRequiresTwoReports(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-belt")
	w := h.w
	insertRunningTool(w, "ta-1", "tu-1", "bash", 3, 1000)

	sendExecReport(w, "engine", 1, 5000, map[string]int64{})
	w.finalizeToolsAbsentFromExecReport()
	if got := toolState(w, "tu-1"); got != StateRunning {
		t.Fatalf("one report is not enough (belt); tool must stay running, got %q", got)
	}
	// Second agreeing report → now it finalizes.
	sendExecReport(w, "engine", 2, 6000, map[string]int64{})
	w.finalizeToolsAbsentFromExecReport()
	if got := toolState(w, "tu-1"); got != StateCancelled {
		t.Fatalf("after a second agreeing report the tool must finalize, got %q", got)
	}
}

// TestExecReport_ToolWithResultUntouched: a running tool that already carries a
// result (its terminal write landed between report and tick) is not the wedge shape.
func TestExecReport_ToolWithResultUntouched(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-hasresult")
	w := h.w
	insertRunningTool(w, "ta-1", "tu-1", "bash", 3, 1000)
	w.doc.UpdateToolActionFieldsRecursive("tu-1", map[string]any{
		"result": map[string]any{"content": "done"},
	})

	sendExecReport(w, "engine", 1, 5000, map[string]int64{})
	sendExecReport(w, "engine", 2, 6000, map[string]int64{})

	w.finalizeToolsAbsentFromExecReport()
	if r := readToolActionField(w, "tu-1", "result"); r == nil {
		t.Fatal("precondition: tu-1 should still carry its result")
	}
	// State was left running with a result — the rule must not have touched it.
	if got := toolState(w, "tu-1"); got != StateRunning {
		t.Fatalf("a running tool that already has a result must be left untouched, got %q", got)
	}
}

// TestExecReport_StaleReportNoFinalize: when the engine goes quiet (the last report
// aged past the freshness window), the rule stands down — orphan recovery is the
// reattach path's job, not this one's.
func TestExecReport_StaleReportNoFinalize(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-stale")
	w := h.w
	insertRunningTool(w, "ta-1", "tu-1", "bash", 3, 1000)

	sendExecReport(w, "engine", 1, 5000, map[string]int64{})
	sendExecReport(w, "engine", 2, 6000, map[string]int64{})
	// Backdate both accepted reports well past the freshness window.
	w.engine.lastReport.receivedAt = time.Now().Add(-30 * time.Second)
	w.engine.prevReport.receivedAt = time.Now().Add(-33 * time.Second)

	w.finalizeToolsAbsentFromExecReport()
	if got := toolState(w, "tu-1"); got != StateRunning {
		t.Fatalf("a stale (quiet-engine) report must not finalize; tool stays running, got %q", got)
	}
}

// TestExecReport_ViewerOriginRejected: a report whose OriginClient is not the
// attached engine (a viewer, a superseded engine) is inadmissible — no state stored.
func TestExecReport_ViewerOriginRejected(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-viewer")
	w := h.w

	sendExecReport(w, "viewer-7", 1, 5000, map[string]int64{})
	if w.engine.lastReport != nil {
		t.Fatal("a non-engine-origin report must be rejected and store no state")
	}
}

// TestExecReport_StaleSeqRejected: a report whose seq does not advance past the last
// accepted one is dropped (duplicate/reorder fence).
func TestExecReport_StaleSeqRejected(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-seq")
	w := h.w

	sendExecReport(w, "engine", 5, 5000, map[string]int64{"tu-x": 1})
	sendExecReport(w, "engine", 3, 6000, map[string]int64{}) // stale seq — rejected

	if w.engine.reportSeq != 5 {
		t.Fatalf("stale-seq report must not advance the fence: want seq 5, got %d", w.engine.reportSeq)
	}
	if w.engine.lastReport == nil || w.engine.lastReport.seq != 5 {
		t.Fatal("stale-seq report must not replace the last accepted report")
	}
}

// TestExecReport_EngineAttachClearsState: a report from a NEW engine client drops
// the previous engine's stored reports and resets the seq fence, so a single early
// report from the new engine cannot finalize on its own (belt not yet satisfied).
func TestExecReport_EngineAttachClearsState(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-reattach")
	w := h.w
	insertRunningTool(w, "ta-1", "tu-1", "bash", 3, 1000)

	// Old engine reported absence twice.
	sendExecReport(w, "engine", 1, 5000, map[string]int64{})
	sendExecReport(w, "engine", 2, 6000, map[string]int64{})

	// A new engine attaches and sends its first (early) report.
	w.SetEngineClientID("engine2")
	sendExecReport(w, "engine2", 1, 7000, map[string]int64{})

	if w.engine.reportClient != "engine2" {
		t.Fatalf("report state should now belong to engine2, got %q", w.engine.reportClient)
	}
	if w.engine.prevReport != nil {
		t.Fatal("attach must clear the previous engine's reports (no belt from a dead engine)")
	}
	w.finalizeToolsAbsentFromExecReport()
	if got := toolState(w, "tu-1"); got != StateRunning {
		t.Fatalf("a single early report from a freshly attached engine must not finalize, got %q", got)
	}
}

// TestExecReport_WorkerExecutedNeverFinalized: worker-executed tools never appear in
// an engine report, so the rule must skip them — both via the executor='worker'
// stamp and the create_thread name fallback.
func TestExecReport_WorkerExecutedNeverFinalized(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-worker")
	w := h.w

	// Stamped executor='worker' (a generic worker-managed tool).
	insertRunningTool(w, "ta-1", "tu-stamp", "some_worker_tool", 3, 1000)
	w.doc.UpdateToolActionFieldsRecursive("tu-stamp", map[string]any{"executor": "worker"})
	// Fallback: create_thread by name (docs predating the stamp).
	insertRunningTool(w, "ta-2", "tu-thread", "create_thread", 3, 1000)

	sendExecReport(w, "engine", 1, 5000, map[string]int64{})
	sendExecReport(w, "engine", 2, 6000, map[string]int64{})

	w.finalizeToolsAbsentFromExecReport()
	if got := toolState(w, "tu-stamp"); got != StateRunning {
		t.Fatalf("an executor='worker' tool must never be finalized by the report rule, got %q", got)
	}
	if got := toolState(w, "tu-thread"); got != StateRunning {
		t.Fatalf("a create_thread tool must never be finalized by the report rule, got %q", got)
	}
}

// TestExecReport_ApprovedToolUntouched: only the running-with-no-result shape is a
// candidate; an approved (not yet claimed) tool is out of scope.
func TestExecReport_ApprovedToolUntouched(t *testing.T) {
	h := newCancelEpochHarness(t, "conv-exec-approved")
	w := h.w
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1",
		ToolName: "bash", State: StateApproved,
	})

	sendExecReport(w, "engine", 1, 5000, map[string]int64{})
	sendExecReport(w, "engine", 2, 6000, map[string]int64{})

	w.finalizeToolsAbsentFromExecReport()
	if got := toolState(w, "tu-1"); got != StateApproved {
		t.Fatalf("an approved (unclaimed) tool must be left untouched, got %q", got)
	}
}
