//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	ycrdt "github.com/skyterra/y-crdt"
)

// resetThreadContext re-roots this run's own thread: subsequent getTarget* /
// appendTargetMessage calls address the root conversation, not a sub-thread.
// Anything filed under the thread a turn was begun for after this runs asks the
// live-run registry, not t.thread (see runScheduler.unregister).
func (r *run) resetThreadContext() {
	r.t.thread = threadContext{}
}

// The getTarget* / appendTargetMessage / updateTargetItemByID family addresses
// the run's OWN thread, turnState.thread, which is fixed for a dispatched turn by
// beginTurn. Each is a one-line spelling of the *In / *To form below with that
// destination filled in.
//
// A handler that writes into some other thread (an intake for an idle thread, a
// thread created under a named parent) resolves that thread with resolveThread
// and passes it to the *In / *To form. It never re-points the turn: the turn it
// runs on is the ambient one, shared by every handler the run loop serves, and a
// destination parked there has to be saved and restored on every path out of
// every handler that sets it.

// resolveThread returns the destination for threadItemID — the zero
// threadContext for the root — and false when no thread has that id. The check
// answers for this moment only: each read and write through the result finds
// the thread again where it acts, and one whose thread has gone since reads
// empty and writes nothing.
func (w *ConversationWorker) resolveThread(threadItemID string) (threadContext, bool) {
	if threadItemID == "" {
		return threadContext{}, true
	}
	if !w.doc.HasThread(threadItemID) {
		return threadContext{}, false
	}
	return threadContext{itemID: threadItemID}, true
}

// itemsIn returns the items of dest: a thread's nested array, or the root's;
// none for a thread that has gone.
func (w *ConversationWorker) itemsIn(dest threadContext) []ConversationItem {
	if dest.itemID != "" {
		return w.doc.GetThreadItems(dest.itemID)
	}
	return w.doc.GetItems()
}

// itemsLengthIn returns the item count of dest.
func (w *ConversationWorker) itemsLengthIn(dest threadContext) int {
	if dest.itemID != "" {
		return w.doc.GetThreadItemsLength(dest.itemID)
	}
	return w.doc.GetItemsLength()
}

// appendMessageTo adds message(s) to the end of dest via the OperationTracker
// (authorID origin) in both cases, so a sub-thread's content is captured for
// undo/redo exactly like the root's. Turn boundaries are the single global
// StopCapturing fired at every turn-idle (worker.go), so a sub-thread run groups
// per turn the same way root does.
//
// If a round-trip is in flight on this run (turn.txnID != "") and the caller did
// not set TransactionID explicitly, the current txn id is stamped onto each
// item — so every item produced during a round-trip carries it.
//
// Appending is the only insert this package does: there is deliberately no
// insert-at-index spelling, because reading the end position and writing at it
// are two ycrdtMu holds, and that lock promises only that no two y-crdt calls
// overlap — never that a sequence of them is atomic. Asking for the end and
// writing at the end is one question, so it takes one hold. For a thread, the
// same hold finds the thread; one that has gone takes nothing.
func (r *run) appendMessageTo(dest threadContext, msgs ...ConversationItem) {
	r.stampTxnID(msgs)
	if dest.itemID != "" {
		r.tracker.AppendMessageToThread(dest.itemID, msgs...)
	} else {
		r.tracker.AppendMessage(msgs...)
	}
}

// getTargetItems returns the items of the run's own thread.
func (r *run) getTargetItems() []ConversationItem { return r.itemsIn(r.t.thread) }

// appendTargetMessage appends message(s) to the run's own thread; see
// appendMessageTo.
func (r *run) appendTargetMessage(msgs ...ConversationItem) {
	r.appendMessageTo(r.t.thread, msgs...)
}

// stampTxnID marks items produced during an in-flight round-trip with its id,
// leaving any the caller set explicitly alone.
func (r *run) stampTxnID(msgs []ConversationItem) {
	if r.t.txnID == "" {
		return
	}
	for i := range msgs {
		if msgs[i].TransactionID == "" {
			msgs[i].TransactionID = r.t.txnID
		}
	}
}

// updateTargetItemByID updates an item field in the run's own thread, failing
// when the thread or the item has gone.
func (r *run) updateTargetItemByID(itemID, field string, value any) error {
	if r.t.thread.itemID != "" {
		return r.doc.UpdateItemByIDInThread(r.t.thread.itemID, itemID, field, value)
	}
	return r.doc.UpdateItemByID(itemID, field, value)
}

// updateRunItem is updateTargetItemByID for the writes a run makes as it goes —
// a streamed block rewriting its item, the user message a round-trip stamps —
// where a failure means the item has gone (a viewer deleted it mid-stream) and
// the run has nothing to do but carry on. The failure is logged at Debug, once
// per item: a streaming block rewrites its item many times a second.
func (r *run) updateRunItem(itemID, field string, value any) {
	err := r.updateTargetItemByID(itemID, field, value)
	if err == nil || r.t.unwrittenItems[itemID] {
		return
	}
	if r.t.unwrittenItems == nil {
		r.t.unwrittenItems = map[string]bool{}
	}
	r.t.unwrittenItems[itemID] = true
	r.log.Debug("[worker] %s of item %s not written, and will not be reported again this run: %v", field, itemID, err)
}

// findThreadWithIncompleteTool returns the itemID of the innermost thread
// containing any non-terminal tool-action (pending / approved / running /
// state-unset), with ok=true. Returns ("", true) if such a tool exists at
// root, or ("", false) if every tool-action is completed/cancelled.
// Used at init-time to re-establish activity="awaiting_llm" when restart
// landed mid-approval — without it the thread reducer would refuse to
// dispatch the follow-up LLM turn after the user approves and the tool
// finishes.
func (w *ConversationWorker) findThreadWithIncompleteTool() (string, bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	var threadID string
	found := walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, currentThreadID string) bool {
		if t := yMapString(m, keyType); t != ItemTypeToolAction {
			return false
		}
		state := yMapString(m, keyState)
		if isTerminalToolState(state) {
			return false
		}
		threadID = currentThreadID
		return true
	})
	return threadID, found
}

// Each of the three cancel entry points takes the SUBTREE it applies to:
// threadItemID names the thread whose items (and nested threads) are swept, and
// "" is the root — which is the whole conversation, since every thread hangs off
// it. Naming it is what keeps one thread's cancellation from stamping
// "Interrupted" on a sibling's live tools; a thread that no longer exists sweeps
// nothing.

// CancelStaleToolActions marks in-flight tool-action items under threadItemID as
// interrupted. Called on strategy loop exit to clean up tools that were running
// when the operation was interrupted (e.g., page reload, cancellation).
// Recursively traverses thread nested items.
//
// Single-writer rule: the worker is the sole writer of cancellation results.
// The frontend kills the process (resource cleanup) but does not write to
// the Y.doc result field on abort — this eliminates the race between
// two Yjs clients writing the same key.
func (w *ConversationWorker) CancelStaleToolActions(threadItemID string) {
	w.cancelToolsUnder(threadItemID, false, false)
}

// CancelInFlightToolActions cancels all non-terminal tool-actions under
// threadItemID including ones in StateApproved, but leaves StatePending
// (awaiting-approval) tools alone. Called on cancellation paths where the
// browser is the canceller of pending approvals (the
// StateProcessing/finalizeCancellation path).
func (w *ConversationWorker) CancelInFlightToolActions(threadItemID string) {
	w.cancelToolsUnder(threadItemID, true, false)
}

// CancelAllToolActions cancels every non-terminal tool-action under
// threadItemID, including those still awaiting manual approval (StatePending).
// Called on handleCancel's awaiting_llm branch where the user's Escape/deny
// means "stop everything in this parked turn" — the worker is the sole canceller
// there (no live LLM call, and the test path has no browser-side approval
// cancel).
func (w *ConversationWorker) CancelAllToolActions(threadItemID string) {
	w.cancelToolsUnder(threadItemID, true, true)
}

// cancelToolsUnder resolves the subtree and cancels within it under ONE ycrdtMu
// hold, then dispatches the engine aborts with the lock released (see
// dispatchCancelTools). Resolving the array inside the hold is deliberate: the
// lock promises only that no two y-crdt calls overlap, so finding the thread and
// walking it are one question and take one hold.
func (w *ConversationWorker) cancelToolsUnder(threadItemID string, includeApproved, includePending bool) {
	var executingIDs []toolCancelRef
	withYDoc(func() {
		arr := w.doc.getItems()
		if threadItemID != "" {
			arr = findThreadItemsArray(arr, threadItemID)
		}
		executingIDs = w.cancelToolsInArray(arr, includeApproved, includePending)
	})
	w.dispatchCancelTools(executingIDs)
}

// toolCancelRef identifies a tool-action to cancel plus the execution generation
// it was observed in. The engine aborts an in-flight execution only when the
// running generation matches RunningEpoch, so a cancel meant for a prior run
// can't kill a fresh re-run of the same toolUseId. RunningEpoch is 0 for a
// tool cancelled while still StateApproved (never claimed → no epoch stamped),
// meaning "unscoped" — the gap-closing behaviour dispatchCancelTools documents.
type toolCancelRef struct {
	ToolUseID    string
	RunningEpoch int64
}

// dispatchCancelTools commands the engine to abort the in-flight execution of
// each cancelled tool-action. MUST be called with ycrdtMu released — dispatch
// must not happen under the lock (the engine mailbox send is independent of doc
// state). handleCancelTool / cancelByToolUseId is idempotent, so a command for
// an approved-but-not-yet-running tool is harmless: it closes the gap where the
// engine claimed approved→running but that write hasn't synced back yet.
func (w *ConversationWorker) dispatchCancelTools(refs []toolCancelRef) {
	for _, ref := range refs {
		w.dispatchToolCommandEpoch(msgCancelTool, ref.ToolUseID, ref.RunningEpoch)
	}
}

// blockedOnlyByApprovals reports whether the turn on threadItemID is parked
// solely on tool approvals: at least one tool-action in that subtree is awaiting
// manual approval (StatePending) and nothing in it is actually executing (no
// approved/running tool, no open sub-thread). This is the signal that a cancel
// should hand off to the reducer — which continues a queued turn or rests —
// rather than parking. When real work is in flight, cancel must park so the
// interrupted work isn't silently re-driven. "" is the root, i.e. the whole
// conversation.
func (w *ConversationWorker) blockedOnlyByApprovals(threadItemID string) bool {
	hasPending, hasExecuting := w.approvalBlockState(threadItemID)
	return hasPending && !hasExecuting
}

// approvalBlockState scans one subtree once ("" being the root, so the whole
// conversation tree) and reports whether any tool-action there is awaiting
// manual approval (hasPending) and whether anything in it is genuinely executing
// (hasExecuting): an approved/running tool-action or an open sub-thread. The two
// booleans together distinguish the approval-block shapes — parked-on-approval
// (pending && !executing), resumed/working (executing), and idle (neither) —
// that the elapsed-timer anchor and the cancel-handoff logic both key off.
func (w *ConversationWorker) approvalBlockState(threadItemID string) (hasPending, hasExecuting bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.getItems()
	if threadItemID != "" {
		arr = findThreadItemsArray(arr, threadItemID)
	}
	return scanApprovalBlock(arr)
}

// scanApprovalBlock walks an items array (recursing into sub-threads) and
// reports whether it contains any tool-action awaiting approval (hasPending)
// and whether anything is genuinely executing (hasExecuting): an approved or
// running tool-action, or an open (resultless) sub-thread.
func scanApprovalBlock(arr *ycrdt.YArray) (hasPending, hasExecuting bool) {
	if arr == nil {
		return false, false
	}
	length := int(arr.GetLength())
	for i := 0; i < length; i++ {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		switch t := yMapString(m, keyType); t {
		case ItemTypeToolAction:
			switch state := yMapString(m, keyState); state {
			case StatePending:
				hasPending = true
			case StateApproved, StateRunning:
				hasExecuting = true
			}
		case ItemTypeThread:
			// An alias holds no transcript: the thread it is a second view of
			// stands in this same array and is scanned on its own. Reading one
			// here would find no items and no result and call it executing
			// forever, wedging the desktop quit guard.
			if aliasOf := yMapString(m, keyAliasOf); aliasOf != "" {
				continue
			}
			// Recurse first so we can tell a genuinely-working sub-thread from
			// one that is itself only parked on approvals.
			var np, ne bool
			if nested, ok := yMapArray(m, keyItems); ok {
				np, ne = scanApprovalBlock(nested)
			}
			hasPending = hasPending || np
			hasExecuting = hasExecuting || ne
			// A sub-thread with an unsettled run normally means work is in flight
			// — its LLM turn is running with no in-doc tool marker yet. But a
			// sub-thread whose only non-terminal work is a pending approval
			// (np && !ne) is suspended exactly like a top-level approval park:
			// quitting and restarting leaves the approval intact, so it must NOT
			// count as executing. Otherwise the desktop quit guard false-positives
			// on a conversation whose sub-thread is merely awaiting an approval.
			// Equivalently (De Morgan): count it as executing only when it is not
			// that pure-approval shape — nothing pending, or something executing.
			if !threadRunSettledLocked(m) && (!np || ne) {
				hasExecuting = true
			}
		}
	}
	return hasPending, hasExecuting
}

// cancelToolsInArray writes state=cancelled + result=interrupted atomically
// on non-terminal tool-actions. When includeApproved is true, also cancels
// tools in StateApproved (user-initiated cancel). When includePending is true,
// also cancels tools awaiting manual approval (StatePending). When either is
// false, those tools are left alone — approved so the frontend reducer can
// claim them on reconnect, pending so the browser owns the approval cancel.
//
// Returns a toolCancelRef for each cancelled tool-action whose PRIOR state was
// StateApproved or StateRunning — the "executing" states where the engine may
// have an in-flight or imminent fetch to abort. The callers dispatch a
// cancel-tool command for each (AFTER releasing ycrdtMu) so the engine unwinds
// the in-flight execution; otherwise the fetch would resolve normally and the
// engine would overwrite 'cancelled' with 'completed'. The ref carries the
// tool's runningEpoch, read HERE under the same ycrdtMu hold that writes
// 'cancelled', so the cancel command is scoped to exactly the generation we
// just cancelled (a StateApproved tool has no epoch yet → 0, unscoped). Refs
// accumulate across the recursive sub-thread descent.
func (w *ConversationWorker) cancelToolsInArray(arr *ycrdt.YArray, includeApproved, includePending bool) []toolCancelRef {
	if arr == nil {
		return nil
	}
	interruptedResult := convertToYcrdt(map[string]any{
		keyContent:   "Interrupted",
		keyCancelled: true,
		keyIsError:   false,
	})

	var executingIDs []toolCancelRef
	length := int(arr.GetLength())
	for i := 0; i < length; i++ {
		raw := arr.Get(ycrdt.Number(i))
		m, ok := raw.(*ycrdt.YMap)
		if !ok {
			continue
		}
		itemType := yMapString(m, keyType)
		switch itemType {
		case ItemTypeToolAction:
			item := yMapToConversationItem(m)
			if isToolTerminal(item) {
				continue // already finished
			}
			if item.State == StatePending && !includePending {
				continue // waiting for user — don't touch
			}
			if item.State == StateApproved && !includeApproved {
				// Stale-cleanup path (e.g. reconnect): leave approved tools
				// alone so the frontend reducer can claim and execute them.
				continue
			}
			toolName := item.ToolName
			if toolName == "" {
				toolName = item.ToolUseID
			}
			w.log.Info("Cancelling tool-action: %s (state=%q)", toolName, item.State)
			w.tape.Record("tool-state", map[string]any{
				"toolUseId":       item.ToolUseID,
				"toolName":        toolName,
				"from":            string(item.State),
				"to":              "cancelled",
				"writer":          "worker-cancel",
				"includeApproved": includeApproved,
			})
			if item.State == StateApproved || item.State == StateRunning {
				// Capture the generation under the lock so the cancel command
				// targets exactly this incarnation. Absent (approved, never
				// claimed) → 0 → unscoped.
				epoch, _ := yMapInt64(m, keyRunningEpoch)
				executingIDs = append(executingIDs, toolCancelRef{ToolUseID: item.ToolUseID, RunningEpoch: epoch})
			}
			w.doc.transactTracked(func(_ *ycrdt.Transaction) {
				m.Set(keyState, StateCancelled)
				m.Set(keyResult, interruptedResult)
			})
		case ItemTypeThread:
			if nested, ok := yMapArray(m, keyItems); ok {
				executingIDs = append(executingIDs, w.cancelToolsInArray(nested, includeApproved, includePending)...)
			}
		}
	}
	return executingIDs
}

// finalizeStuckRunningToolOnField stamps a single tool-action state=cancelled +
// result=interrupted IFF it is currently RUNNING with no result — a tool the
// engine claimed (approved→running) but left non-terminal, the
// running-with-no-result wedge. The tool-execution-report rule
// (finalizeToolsAbsentFromExecReportExcept) reaches it for a running tool absent from
// the attached engine's executing set.
//
// Two guards keep it compatible with the worker-single-writer rule:
//   - state==running: a re-run resets the tool to approved (a fresh execution the
//     reducer owns), so a stale finalize can never clobber it and re-open the
//     restart loop that motivated single-writer cancellation.
//   - epoch match: the tool is finalized ONLY if the doc's epochField still
//     carries exactly the epoch the caller observed. This closes the ABA window
//     where a re-run re-claimed the SAME toolUseId to a fresh running (new
//     generation) between the observation and the finalize — the mismatched epoch
//     means the running execution is a different, innocent one, so it is left
//     untouched. An absent stamp reads as 0, and 0 is an observation like any
//     other: every claim stamps an epoch of at least 1 (claimRunning), so a caller
//     that saw no stamp must not finalize a tool that has since been given one.
//
// epochField names the doc generation stamp the caller observed: "runningEpoch"
// (the tool-execution-report rule — a true per-incarnation generation, immune to
// Date.now() collisions).
//
// Returns true iff it wrote (so callers reconcile only on a real state change).
// The whole find-check-write runs under one ycrdtMu hold so a concurrent re-run
// can't slip between the guard read and the write.
func (w *ConversationWorker) finalizeStuckRunningToolOnField(toolUseID, epochField string, epoch float64, reason string) bool {
	interruptedResult := convertToYcrdt(map[string]any{
		keyContent:   "Interrupted",
		keyCancelled: true,
		keyIsError:   false,
	})
	wrote := false
	var cancelEpoch int64
	withYDoc(func() {
		walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, _ string) bool {
			if t := yMapString(m, keyType); t != ItemTypeToolAction {
				return false
			}
			if id := yMapString(m, keyToolUseID); id != toolUseID {
				return false
			}
			// Found the tool-action. Only finalize the exact wedge shape: still
			// running, no result yet. Anything else (approved re-run, or already
			// terminal) is left untouched. Stop the walk either way.
			if state := yMapString(m, keyState); state != StateRunning {
				return true
			}
			if r := m.Get(keyResult); r != nil {
				return true
			}
			// Epoch guard: only finalize the exact execution the caller observed. A
			// mismatch means a re-run re-claimed this id to a fresh running — leave it.
			// A missing or non-numeric stamp reads as 0. The doc stamp round-trips as
			// int/int64/float64 depending on its write path, so it is coerced before
			// the compare.
			if de, _ := yMapInt64(m, epochField); de != int64(epoch) {
				return true
			}
			// Capture the execution generation under the lock so the belt cancel below
			// aborts exactly this incarnation, not a re-run that re-claims the id.
			cancelEpoch, _ = yMapInt64(m, keyRunningEpoch)
			toolName := yMapString(m, keyToolName)
			w.tape.Record("tool-state", map[string]any{
				"toolUseId": toolUseID,
				"toolName":  toolName,
				"from":      StateRunning,
				"to":        "cancelled",
				"writer":    "worker-finalize",
				"reason":    reason,
			})
			w.doc.transactTracked(func(_ *ycrdt.Transaction) {
				m.Set(keyState, StateCancelled)
				m.Set(keyResult, interruptedResult)
			})
			wrote = true
			return true
		})
	})
	if wrote {
		// Belt-and-suspenders: tell the engine to abort any lingering in-flight
		// execution for this id (idempotent — a no-op if nothing is running there),
		// so a late-resolving fetch can't overwrite the cancelled result. Scoped to
		// the generation just cancelled so a fresh re-run is never aborted.
		w.dispatchCancelTools([]toolCancelRef{{ToolUseID: toolUseID, RunningEpoch: cancelEpoch}})
	}
	return wrote
}
