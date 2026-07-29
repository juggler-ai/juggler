//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "encoding/json"

// autoCompactThreshold is the fraction of the model context window at which the
// worker proactively folds the root conversation into a compaction summary at
// turn-settle. Mirrors the browser AUTO_COMPACT_THRESHOLD this replaces.
const autoCompactThreshold = 0.85

// autoCompactThresholdCrossed reports whether an anchored input usage warrants a
// proactive fold against a known window. Both must be positive; the worker-side
// counterpart of the browser's shouldAutoCompactInputUsage.
func autoCompactThresholdCrossed(anchoredInput, windowTokens int) bool {
	return anchoredInput > 0 && windowTokens > 0 &&
		float64(anchoredInput)/float64(windowTokens) >= autoCompactThreshold
}

// resolveContextWindow maps the conversation's effective model to its context
// window and output reserve (tokens) via the injected resolver. Returns (0, 0)
// when no resolver is wired (tests) or the model is unknown — the proactive
// trigger reads a non-positive window as "no threshold" and stays dormant.
func (w *ConversationWorker) resolveContextWindow() (windowTokens, reserveTokens int) {
	if w.windowResolver == nil {
		return 0, 0
	}
	mc := w.resolveModelConfig()
	if mc == nil {
		return 0, 0
	}
	return w.windowResolver(*mc)
}

// lastRootTransactionID walks the root items backward and returns the most
// recent non-empty TransactionID — the anchor whose saved blob carries the input
// usage the proactive trigger measures. Empty when the root has no stamped turn
// (e.g. right after a fold moved the history into a thread), which is why the
// trigger cannot loop: the anchor it measured is gone once it has folded.
func (w *ConversationWorker) lastRootTransactionID() string {
	items := w.doc.GetItems()
	for i := len(items) - 1; i >= 0; i-- {
		if items[i].TransactionID != "" {
			return items[i].TransactionID
		}
	}
	return ""
}

// anchoredInputTokens reads inputTokens from a transaction blob on disk. Zero on
// any miss (no store, unreadable, unparsable) so the trigger simply declines.
func (w *ConversationWorker) anchoredInputTokens(txnID string) int {
	if w.txnStore == nil || txnID == "" {
		return 0
	}
	data, err := w.txnStore.Load(w.conversationID, txnID)
	if err != nil {
		return 0
	}
	var blob struct {
		InputTokens int `json:"inputTokens"`
	}
	if err := json.Unmarshal(data, &blob); err != nil {
		return 0
	}
	return blob.InputTokens
}

// maybeAutoCompactAtSettle is the worker-side proactive compaction trigger. At
// root turn-settle it compares the last turn's anchored input usage against the
// resolved context window and, if the threshold is crossed, folds the root
// conversation into an unsummarized bounded-compaction thread and hands it to the
// existing pickup path (checkForNewThreads), which summarizes it and collapses
// the whole operation into one undo group.
//
// The numerator (anchored input) is worker-owned — the worker itself saved the
// transaction blob the browser used to round-trip; only the denominator (window)
// needed the injected resolver. Both absent ⇒ dormant, so this is a no-op unless
// fully wired (tests without a resolver never fold).
//
// Returns true when it folded and drove the pickup — the caller then skips its
// own idle-hook dispatch, because the pickup's own turn-settle already fired it.
//
// U2 (no undo↔auto-compact ping-pong) holds structurally, without an undo
// generation counter: this is the trigger's ONLY call site and it fires only at
// a strategy-loop turn-settle, while handleUndoOrRedo cancels to idle and applies
// the undo WITHOUT starting a strategy loop (and suppresses reconcile for 500ms
// afterward). So an undo that pops a fold never produces a settle, and cannot be
// immediately re-folded. A genuinely new user turn after an undo DOES produce a
// fresh anchor that postdates the undo — re-folding there is correct (the user is
// over budget again), which is exactly what U2 permits. The autoCompactAnchorTxnID
// debounce additionally blocks re-evaluating the same anchor. U5: this
// bookkeeping is worker state, never on the undo stack.
func (w *ConversationWorker) maybeAutoCompactAtSettle() bool {
	// Root only: the trigger measures and folds the root conversation. The
	// deferred cleanup has already cleared thread context by the time this runs,
	// so this is belt-and-suspenders against a future caller.
	if w.thread.itemID != "" {
		return false
	}
	window, _ := w.resolveContextWindow()
	if window <= 0 {
		return false
	}
	txnID := w.lastRootTransactionID()
	if txnID == "" {
		return false
	}
	// Debounce: evaluate each anchor at most once. An unchanged anchor means no
	// new turn has landed since the last check, so re-folding it would be a
	// no-op-or-loop. Recorded below before folding so even an under-threshold or
	// nothing-to-fold outcome is not re-read on every idle tick.
	if txnID == w.autoCompactAnchorTxnID {
		return false
	}
	anchored := w.anchoredInputTokens(txnID)
	w.autoCompactAnchorTxnID = txnID
	if !autoCompactThresholdCrossed(anchored, window) {
		return false
	}

	threadID, folded, err := w.foldConversationForCompaction(false)
	if err != nil {
		w.log.Error("[auto-compact] fold failed at %d/%d input tokens: %v", anchored, window, err)
		return false
	}
	if !folded {
		return false
	}
	w.log.Info("[auto-compact] folded root into %s at %d/%d input tokens (%.0f%%)",
		threadID, anchored, window, 100*float64(anchored)/float64(window))

	// Drive the pickup now: checkForNewThreads runs the fold thread through the
	// Phase-3 folded-compaction summarizer and snapshots compactionMergeFromIdx
	// against the fold group (now the top of the undo stack) so fold + summary
	// collapse into one undo group. State is StateIdle at the settle point, so
	// the claim succeeds. If pickup somehow declines, the thread still carries
	// needsStrategyRun and a later handleItemsChange picks it up.
	w.checkForNewThreads()
	return true
}
