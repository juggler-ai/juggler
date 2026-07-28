//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	ycrdt "github.com/skyterra/y-crdt"
)

// resetThreadContext re-roots the worker's active thread scope: subsequent
// getTarget* / insertTarget* calls address the root conversation, not a
// sub-thread. Clears both fields together so a stale itemsArray can never
// outlive a cleared itemID.
func (w *ConversationWorker) resetThreadContext() {
	w.thread = threadContext{}
}

// getTargetItems returns items from the thread's nested array when in thread mode,
// or from the root items array otherwise.
func (w *ConversationWorker) getTargetItems() []ConversationItem {
	if w.thread.itemsArray != nil {
		return w.doc.GetItemsFromArray(w.thread.itemsArray)
	}
	return w.doc.GetItems()
}

// getTargetItemsLength returns the item count from the thread or root items array.
func (w *ConversationWorker) getTargetItemsLength() int {
	if w.thread.itemsArray != nil {
		return w.doc.GetItemsLengthFromArray(w.thread.itemsArray)
	}
	return w.doc.GetItemsLength()
}

// insertTargetMessage inserts message(s) into the thread or root items array via
// the OperationTracker (authorID origin) in both cases, so a sub-thread turn's
// content is captured for undo/redo exactly like a root turn's. Turn boundaries
// are the single global StopCapturing fired at every turn-idle (worker.go), so a
// sub-thread run groups per turn the same way root does.
//
// If a round-trip is in flight (currentTxnID != "") and the caller did not set
// TransactionID explicitly, the current txn id is stamped onto each item — so
// every item produced during a round-trip carries it.
func (w *ConversationWorker) insertTargetMessage(index int, msgs ...ConversationItem) {
	if w.currentTxnID != "" {
		for i := range msgs {
			if msgs[i].TransactionID == "" {
				msgs[i].TransactionID = w.currentTxnID
			}
		}
	}
	if w.thread.itemsArray != nil {
		w.tracker.InsertMessageIntoArray(w.thread.itemsArray, index, msgs...)
	} else {
		w.tracker.InsertMessage(index, msgs...)
	}
}

// getTargetItemsYArray returns the raw Y.Array for the current target (thread or root).
func (w *ConversationWorker) getTargetItemsYArray() *ycrdt.YArray {
	if w.thread.itemsArray != nil {
		return w.thread.itemsArray
	}
	return w.doc.getItems()
}

// updateTargetItemByID updates an item field in the thread or root items array.
func (w *ConversationWorker) updateTargetItemByID(itemID, field string, value any) error {
	if w.thread.itemsArray != nil {
		return w.doc.UpdateItemByIDInArray(w.thread.itemsArray, itemID, field, value)
	}
	return w.doc.UpdateItemByID(itemID, field, value)
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
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		state, _ := m.Get("state").(string)
		if state == StateCompleted || state == StateCancelled {
			return false
		}
		threadID = currentThreadID
		return true
	})
	return threadID, found
}

// CancelStaleToolActions marks in-flight tool-action items as interrupted.
// Called on strategy loop exit to clean up tools that were running when
// the operation was interrupted (e.g., page reload, cancellation).
// Recursively traverses thread nested items.
//
// Single-writer rule: the worker is the sole writer of cancellation results.
// The frontend kills the process (resource cleanup) but does not write to
// the Y.doc result field on abort — this eliminates the race between
// two Yjs clients writing the same key.
func (w *ConversationWorker) CancelStaleToolActions() {
	ycrdtMu.Lock()
	executingIDs := w.cancelToolsInArray(w.doc.getItems(), false, false)
	ycrdtMu.Unlock()
	w.dispatchCancelTools(executingIDs)
}

// CancelInFlightToolActions cancels all non-terminal tool-actions including
// ones in StateApproved, but leaves StatePending (awaiting-approval) tools
// alone. Called on cancellation paths where the browser is the canceller of
// pending approvals (the StateProcessing/finalizeCancellation path).
func (w *ConversationWorker) CancelInFlightToolActions() {
	ycrdtMu.Lock()
	executingIDs := w.cancelToolsInArray(w.doc.getItems(), true, false)
	ycrdtMu.Unlock()
	w.dispatchCancelTools(executingIDs)
}

// CancelAllToolActions cancels every non-terminal tool-action, including those
// still awaiting manual approval (StatePending). Called on handleCancel's
// awaiting_llm branch where the user's Escape/deny means "stop everything in
// this parked turn" — the worker is the sole canceller there (no live LLM call,
// and the test path has no browser-side approval cancel).
func (w *ConversationWorker) CancelAllToolActions() {
	ycrdtMu.Lock()
	executingIDs := w.cancelToolsInArray(w.doc.getItems(), true, true)
	ycrdtMu.Unlock()
	w.dispatchCancelTools(executingIDs)
}

// dispatchCancelTools commands the engine to abort the in-flight execution of
// each cancelled tool-action. MUST be called with ycrdtMu released — dispatch
// must not happen under the lock (the engine mailbox send is independent of doc
// state). handleCancelTool / cancelByToolUseId is idempotent, so a command for
// an approved-but-not-yet-running tool is harmless: it closes the gap where the
// engine claimed approved→running but that write hasn't synced back yet.
func (w *ConversationWorker) dispatchCancelTools(toolUseIDs []string) {
	for _, id := range toolUseIDs {
		w.dispatchToolCommand("cancel-tool", id)
	}
}

// blockedOnlyByApprovals reports whether the turn is parked solely on tool
// approvals: at least one tool-action is awaiting manual approval (StatePending)
// and nothing is actually executing anywhere in the conversation tree (no
// approved/running tool, no open sub-thread). This is the signal that a cancel
// should hand off to the reducer — which continues a queued turn or rests —
// rather than parking. When real work is in flight, cancel must park so the
// interrupted work isn't silently re-driven.
func (w *ConversationWorker) blockedOnlyByApprovals() bool {
	hasPending, hasExecuting := w.approvalBlockState()
	return hasPending && !hasExecuting
}

// approvalBlockState scans the whole conversation tree once and reports whether
// any tool-action is awaiting manual approval (hasPending) and whether anything
// is genuinely executing (hasExecuting): an approved/running tool-action or an
// open sub-thread. The two booleans together distinguish the approval-block
// shapes — parked-on-approval (pending && !executing), resumed/working
// (executing), and idle (neither) — that the elapsed-timer anchor and the
// cancel-handoff logic both key off.
func (w *ConversationWorker) approvalBlockState() (hasPending, hasExecuting bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return scanApprovalBlock(w.doc.getItems())
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
		switch t, _ := m.Get("type").(string); t {
		case ItemTypeToolAction:
			switch state, _ := m.Get("state").(string); state {
			case StatePending:
				hasPending = true
			case StateApproved, StateRunning:
				hasExecuting = true
			}
		case ItemTypeThread:
			// Recurse first so we can tell a genuinely-working sub-thread from
			// one that is itself only parked on approvals.
			var np, ne bool
			if nested, ok := m.Get("items").(*ycrdt.YArray); ok {
				np, ne = scanApprovalBlock(nested)
			}
			hasPending = hasPending || np
			hasExecuting = hasExecuting || ne
			// An open (resultless) sub-thread normally means work is in flight —
			// its LLM turn is running with no in-doc tool marker yet. But a
			// sub-thread whose only non-terminal work is a pending approval
			// (np && !ne) is suspended exactly like a top-level approval park:
			// quitting and restarting leaves the approval intact, so it must NOT
			// count as executing. Otherwise the desktop quit guard false-positives
			// on a conversation whose sub-thread is merely awaiting an approval.
			// Equivalently (De Morgan): count it as executing only when it is not
			// that pure-approval shape — nothing pending, or something executing.
			if result, _ := m.Get("result").(string); result == "" && (!np || ne) {
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
// Returns the toolUseIDs of cancelled tool-actions whose PRIOR state was
// StateApproved or StateRunning — the "executing" states where the engine may
// have an in-flight or imminent fetch to abort. The callers dispatch a
// cancel-tool command for each (AFTER releasing ycrdtMu) so the engine unwinds
// the in-flight execution; otherwise the fetch would resolve normally and the
// engine would overwrite 'cancelled' with 'completed'. IDs accumulate across
// the recursive sub-thread descent.
func (w *ConversationWorker) cancelToolsInArray(arr *ycrdt.YArray, includeApproved, includePending bool) []string {
	if arr == nil {
		return nil
	}
	interruptedResult := convertToYcrdt(map[string]any{
		"content":   "Interrupted",
		"cancelled": true,
		"isError":   false,
	})

	var executingIDs []string
	length := int(arr.GetLength())
	for i := 0; i < length; i++ {
		raw := arr.Get(ycrdt.Number(i))
		m, ok := raw.(*ycrdt.YMap)
		if !ok {
			continue
		}
		itemType, _ := m.Get("type").(string)
		switch itemType {
		case ItemTypeToolAction:
			item := yMapToConversationItem(m)
			if item.State == StateCompleted || item.State == StateCancelled {
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
				executingIDs = append(executingIDs, item.ToolUseID)
			}
			w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
				m.Set("state", StateCancelled)
				m.Set("result", interruptedResult)
			}, w.doc.authorID)
		case ItemTypeThread:
			if nested, ok := m.Get("items").(*ycrdt.YArray); ok {
				executingIDs = append(executingIDs, w.cancelToolsInArray(nested, includeApproved, includePending)...)
			}
		}
	}
	return executingIDs
}
