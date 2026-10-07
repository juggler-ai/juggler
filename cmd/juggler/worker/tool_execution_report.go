//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// execReport is one accepted tool-execution-report: the engine's snapshot of the
// tool-actions it is executing for THIS conversation, at the moment it was sent.
// ids maps each executing toolUseId to the runningEpoch (generation) it is running
// under, so absence can be judged per-incarnation rather than per-id.
type execReport struct {
	receivedAt time.Time        // worker receive time — the freshness clock
	sentAtMs   int64            // engine send time (browser Date.now()) — the happens-after clock
	seq        int64            // per-engine monotonic sequence (staleness fence)
	ids        map[string]int64 // toolUseId → runningEpoch currently executing
}

// handleToolExecutionReport ingests a tool-execution-report from the engine
// (INV-B). It runs on the run goroutine, so the report store needs no lock.
//
// The accept-gate is engineSession.admitReport: a report is evidence only if it
// came from the CURRENTLY-attached engine client and carries a seq newer than the
// last accepted one. Both outcomes go on the tape.
func (w *ConversationWorker) handleToolExecutionReport(payload json.RawMessage, originClient string) {
	var msg struct {
		Seq       int64 `json:"seq"`
		SentAt    int64 `json:"sentAt"`
		Executing []struct {
			ToolUseID    string `json:"toolUseId"`
			RunningEpoch int64  `json:"runningEpoch"`
		} `json:"executing"`
	}
	if !w.decodePayload("tool-execution-report", payload, &msg) {
		return
	}

	ids := make(map[string]int64, len(msg.Executing))
	for _, e := range msg.Executing {
		if e.ToolUseID != "" {
			ids[e.ToolUseID] = e.RunningEpoch
		}
	}
	report := &execReport{
		receivedAt: time.Now(),
		sentAtMs:   msg.SentAt,
		seq:        msg.Seq,
		ids:        ids,
	}
	switch reason, last := w.engine.admitReport(originClient, w.callbacks.engineClientID(), report); reason {
	case "":
		w.tape.Record("exec-report", map[string]any{"seq": msg.Seq, "count": len(ids)})
	case "origin":
		w.tape.Record("exec-report-rejected", map[string]any{
			"reason": reason, "from": originClient, "seq": msg.Seq,
		})
	default:
		w.tape.Record("exec-report-rejected", map[string]any{
			"reason": reason, "seq": msg.Seq, "last": last,
		})
	}
}

// finalizeToolsAbsentFromExecReport is the level-based liveness rule (INV-B/C),
// run on the liveness tick. It finalizes any tool-action stuck at
// running-with-no-result that the currently-attached engine is provably NOT
// executing — as witnessed by two consecutive fresh accepted reports in which the
// tool is absent (by generation) and which postdate the tool's claim.
//
// The sole tool-liveness backstop: it finalizes via finalizeStuckRunningToolOnField,
// which guards on state==running + no-result, so a re-run (back at approved) or an
// already-terminal tool is never clobbered.
func (w *ConversationWorker) finalizeToolsAbsentFromExecReport() {
	w.finalizeToolsAbsentFromExecReportExcept(nil)
}

func (w *ConversationWorker) finalizeToolsAbsentFromExecReportExcept(liveThreads map[string]bool) {
	// Cond 1: an engine must be attached and its last accepted report fresh.
	// Cond 5 (belt): a second, also-recent accepted report. Both report
	// conditions are engineSession.reportsCurrent, whose doc says why.
	if !w.callbacks.engineAttached() || !w.engine.reportsCurrent(time.Now()) {
		return
	}

	type cand struct {
		id    string
		epoch int64
	}
	var cands []cand
	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, threadID string) bool {
		if liveThreads[threadID] {
			return false
		}
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		// The wedge shape only: still running, no result.
		if state, _ := m.Get("state").(string); state != StateRunning {
			return false
		}
		if m.Get("result") != nil {
			return false
		}
		// Cond 2: worker-executed tools never appear in an engine report — the
		// engine's executor is not their liveness oracle. Skip the executor='worker'
		// stamp (written at evaluate) and the create_thread fallback (docs predating
		// the stamp). Only create_thread is worker-managed today, so these two cover
		// every worker-executed tool; a future one would carry the stamp.
		if ex, _ := m.Get("executor").(string); ex == "worker" {
			return false
		}
		if name, _ := m.Get("toolName").(string); name == "create_thread" {
			return false
		}
		id, _ := m.Get("toolUseId").(string)
		if id == "" {
			return false
		}
		epoch, _ := docNumberToInt64(m.Get("runningEpoch"))
		started, _ := docNumberToInt64(m.Get("runningStartedAt"))
		// Cond 3+4 must hold for BOTH consecutive reports (the belt).
		if !w.engine.provesAbsent(id, epoch, started) {
			return false
		}
		cands = append(cands, cand{id: id, epoch: epoch})
		return false
	})
	ycrdtMu.Unlock()

	for _, c := range cands {
		if w.finalizeStuckRunningToolOnField(c.id, "runningEpoch", float64(c.epoch), "exec-report-absent") {
			// Settle the parked turn now that the tool reached terminal.
			w.needsReconcile.Store(true)
		}
	}
}

// absentFromReport reports whether a running execution is provably absent from an
// accepted report: its toolUseId is either not in the report's executing set, or
// present but under a DIFFERENT generation (that incarnation died; a re-claim is a
// new epoch) — AND the doc claim provably predates the report (happens-after
// guard), so a claim fresher than the report (one that simply hasn't appeared in a
// report yet) is never treated as absent.
//
// started (doc runningStartedAt) and r.sentAtMs share the browser Date.now() clock:
// the accept-gate pins both report and claim to the same engine attachment, so the
// comparison is skew-free. A missing/zero claim stamp is treated as too-fresh
// (conservative — never finalize) rather than as ancient.
func absentFromReport(r *execReport, id string, epoch, started int64) bool {
	// Happens-after: the claim must predate the report by at least the
	// claim→executor-registration grace, or it is too fresh to have been reported.
	if started == 0 || started+execReportClaimGraceMs >= r.sentAtMs {
		return false
	}
	repEpoch, present := r.ids[id]
	if !present {
		return true // not executing at all
	}
	return repEpoch != epoch // executing a different incarnation → this one is gone
}
