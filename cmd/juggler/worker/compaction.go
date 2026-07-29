//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	provider "juggler/cmd/juggler/providers/registry"

	ycrdt "github.com/skyterra/y-crdt"
)

const defaultSummarizationPromptMarker = "You are creating a handoff summary of the conversation so far. Another instance of yourself will use ONLY this summary"

// tryBoundedCompaction handles only browser-folded summary threads. Legacy
// folded documents are recognized by their noAutoSelect/forceTool markers. It
// is the folded-thread orchestrator for the pure bounded reducer: snapshot the
// thread's Yjs state, canonicalize it, run the reducer, commit the summary.
func (w *ConversationWorker) tryBoundedCompaction(limitErr *provider.ContextLimitExceededError, modelConfig *ModelConfig) (bool, error) {
	threadID := w.thread.itemID
	if threadID == "" || !w.isBoundedCompactionThread(threadID) {
		return false, nil
	}
	if w.compactionCancelled() {
		return true, errBoundedCompactionCancelled
	}
	pinnedModel, err := validateCompactionModel(modelConfig, "bounded compaction")
	if err != nil {
		return true, err
	}

	items := w.getTargetItems()
	promptID, failReason := w.resolveCompactionPromptItemID(threadID, items)
	if failReason != "" {
		message := "bounded compaction cannot prove which legacy item is the summarization prompt"
		if failReason == BoundedCompactionMissingPrompt {
			message = "bounded compaction cannot find the thread's recorded summarization prompt item (it may have been deleted)"
		}
		return true, &BoundedCompactionError{Reason: failReason, Message: message}
	}
	records, err := canonicalCompactionRecords(items, promptID)
	if err != nil {
		return true, &BoundedCompactionError{
			Reason:  BoundedCompactionSourceEncoding,
			Message: "bounded compaction could not encode canonical source: " + err.Error(),
			Cause:   err,
		}
	}
	if len(records) == 0 {
		return true, &BoundedCompactionError{Reason: BoundedCompactionEmptySource, Message: "bounded compaction source is empty"}
	}

	budget := boundedCompactionBudget{
		window:           limitErr.ContextWindowTokens,
		reserve:          limitErr.OutputReserveTokens,
		providerOverhead: limitErr.Breakdown.ProviderOverheadTokens,
		// The rejected original request is seeded into the reported accounting;
		// spend gates nothing (see boundedCompactionBudget).
		spend: provider.SaturatingAdd(limitErr.EstimatedInputTokens, limitErr.OutputReserveTokens),
		calls: 1,
	}

	w.recordCompactionStart(compactionKindFolded, limitErr.ContextWindowTokens, limitErr.OutputReserveTokens, limitErr.Breakdown.ProviderOverheadTokens)
	result, err := w.runReducer(compactionKindFolded, pinnedModel, budget, records)
	if err != nil {
		return true, err
	}
	if !w.writeBoundedCompactionResult(threadID, result) {
		w.recordCompactionOutcome(compactionKindFolded, "error", result, map[string]any{"reason": string(BoundedCompactionSourceChanged)})
		return true, &BoundedCompactionError{
			Reason: BoundedCompactionSourceChanged, Message: "bounded compaction thread disappeared before result commit",
			Pass: result.Passes, Calls: result.Calls, Spend: result.EstimatedSpend,
			Window: budget.window, Usage: result.Usage,
		}
	}
	w.recordCompactionOutcome(compactionKindFolded, "result", result, nil)
	return true, nil
}

// runFoldedThreadCompaction summarizes a browser-folded /compact (or /handoff)
// thread with a single probe-then-reduce pass, and is the folded thread's sole
// summarizer — it replaces the return_result strategy turn. It dispatches the
// whole canonical transcript as one final-summary request; if the provider
// accepts it, that one-pass summary is committed. If the provider rejects it as
// too large, the reported context window seeds the bounded reducer
// (tryBoundedCompaction) to map/reduce the transcript. Either way the summary is
// committed through the one path, writeBoundedCompactionResult. Returns
// handled=false only when the thread is not a bounded compaction thread.
func (w *ConversationWorker) runFoldedThreadCompaction(modelConfig *ModelConfig) (bool, error) {
	threadID := w.thread.itemID
	if threadID == "" || !w.isBoundedCompactionThread(threadID) {
		return false, nil
	}
	if w.compactionCancelled() {
		return true, errBoundedCompactionCancelled
	}
	pinnedModel, err := validateCompactionModel(modelConfig, "bounded compaction")
	if err != nil {
		return true, err
	}

	items := w.getTargetItems()
	promptID, failReason := w.resolveCompactionPromptItemID(threadID, items)
	if failReason != "" {
		message := "bounded compaction cannot prove which legacy item is the summarization prompt"
		if failReason == BoundedCompactionMissingPrompt {
			message = "bounded compaction cannot find the thread's recorded summarization prompt item (it may have been deleted)"
		}
		return true, &BoundedCompactionError{Reason: failReason, Message: message}
	}
	records, err := canonicalCompactionRecords(items, promptID)
	if err != nil {
		return true, &BoundedCompactionError{
			Reason:  BoundedCompactionSourceEncoding,
			Message: "bounded compaction could not encode canonical source: " + err.Error(),
			Cause:   err,
		}
	}
	if len(records) == 0 {
		return true, &BoundedCompactionError{Reason: BoundedCompactionEmptySource, Message: "bounded compaction source is empty"}
	}

	w.recordCompactionStart(compactionKindFolded, 0, 0, 0)
	probe := w.newBoundedReducer(compactionKindFolded, pinnedModel, boundedCompactionBudget{})
	result, overflow, probeErr := probe.probeFinal(records)
	if probeErr != nil {
		if errors.Is(probeErr, errBoundedCompactionCancelled) {
			w.recordCompactionOutcome(compactionKindFolded, "cancelled", result, nil)
			return true, &BoundedCompactionCancelledError{Result: result}
		}
		reason := "error"
		var bounded *BoundedCompactionError
		if errors.As(probeErr, &bounded) {
			reason = string(bounded.Reason)
		}
		w.recordCompactionOutcome(compactionKindFolded, "error", result, map[string]any{"reason": reason})
		return true, probeErr
	}
	if overflow != nil {
		// The transcript does not fit one call: chunk it with the reported
		// window through the bounded reducer's map/reduce path.
		return w.tryBoundedCompaction(overflow, modelConfig)
	}
	if w.compactionCancelled() {
		w.recordCompactionOutcome(compactionKindFolded, "cancelled", result, nil)
		return true, &BoundedCompactionCancelledError{Result: result}
	}
	if !w.writeBoundedCompactionResult(threadID, result) {
		w.recordCompactionOutcome(compactionKindFolded, "error", result, map[string]any{"reason": string(BoundedCompactionSourceChanged)})
		return true, &BoundedCompactionError{
			Reason: BoundedCompactionSourceChanged, Message: "bounded compaction thread disappeared before result commit",
			Pass: result.Passes, Calls: result.Calls, Spend: result.EstimatedSpend, Usage: result.Usage,
		}
	}
	w.recordCompactionOutcome(compactionKindFolded, "result", result, nil)
	return true, nil
}

// threadHasResult reports whether the thread already carries a committed result.
func (w *ConversationWorker) threadHasResult(threadID string) bool {
	m := w.doc.GetThreadYMap(threadID)
	if m == nil {
		return false
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	result, _ := m.Get("result").(string)
	return result != ""
}

// validateCompactionModel returns the pinned model config or a typed
// MissingModel error. label prefixes the message ("bounded compaction" /
// "context recovery") so the caller's wording is preserved.
func validateCompactionModel(modelConfig *ModelConfig, label string) (ModelConfig, error) {
	if modelConfig == nil || modelConfig.Provider == "" || modelConfig.Model == "" {
		return ModelConfig{}, &BoundedCompactionError{Reason: BoundedCompactionMissingModel, Message: label + " requires the rejected request's model config"}
	}
	return *modelConfig, nil
}

// newBoundedReducer builds a reducer with the worker's shared wiring
// (conversation/thread ids, hidden-call dispatcher, cancellation probe, and the
// tape hooks for this kind). Only the pinned model and pre-computed budget vary
// between the folded, recovery, and shrink orchestrators.
func (w *ConversationWorker) newBoundedReducer(kind string, pinnedModel ModelConfig, budget boundedCompactionBudget) *boundedReducer {
	// The folded /compact orchestrator produces a user-facing handoff summary, so
	// its final call uses the rich DefaultSummarizationPrompt (the same structured
	// prompt the retired return_result strategy turn used). Recovery and shrink
	// keep the terse final prompts.
	finalPrompt := ""
	if kind == compactionKindFolded {
		finalPrompt = DefaultSummarizationPrompt
	}
	return &boundedReducer{
		conversationID: w.conversationID,
		threadID:       w.thread.itemID,
		modelConfig:    pinnedModel,
		budget:         budget,
		dispatcher:     w,
		cancelled:      w.compactionCancelled,
		hooks:          w.compactionTapeHooks(kind),
		finalUsesTool:  compactionFinalUsesTool(pinnedModel.Provider),
		finalPrompt:    finalPrompt,
	}
}

// compactionFinalUsesTool reports whether the final compaction call should force
// the return_result tool for this provider. Providers that cannot reliably honor
// a forced tool choice (local daemons and OpenAI-compatible gateways) instead get
// a tool-free plain-text final call. An unregistered provider keeps the tool
// path, preserving behavior for the mainstream providers.
func compactionFinalUsesTool(providerName string) bool {
	info, ok := provider.GetProviderInfo(providerName)
	if !ok {
		return true
	}
	return !info.ForcedToolChoiceUnsupported
}

// runReducer builds the reducer, runs it, and records the outcome. On error the
// returned error is already typed (BoundedCompactionCancelledError /
// BoundedCompactionError) and the outcome has been recorded, so callers add only
// their unique commit/fold step. The post-run cancellation re-check lives here
// too, since both the folded and recovery orchestrators duplicated it. The
// shrink orchestrator records per-tool-result outcomes and so builds its reducer
// via newBoundedReducer directly rather than through this helper.
func (w *ConversationWorker) runReducer(kind string, pinnedModel ModelConfig, budget boundedCompactionBudget, records []string) (CompactionResult, error) {
	reducer := w.newBoundedReducer(kind, pinnedModel, budget)
	result, err := reducer.run(records)
	if err != nil {
		if errors.Is(err, errBoundedCompactionCancelled) {
			w.recordCompactionOutcome(kind, "cancelled", result, nil)
			return result, &BoundedCompactionCancelledError{Result: result}
		}
		reason := "error"
		var bounded *BoundedCompactionError
		if errors.As(err, &bounded) {
			reason = string(bounded.Reason)
		}
		w.recordCompactionOutcome(kind, "error", result, map[string]any{"reason": reason})
		return result, err
	}
	if w.compactionCancelled() {
		w.recordCompactionOutcome(kind, "cancelled", result, nil)
		return result, &BoundedCompactionCancelledError{Result: result}
	}
	return result, nil
}

func (w *ConversationWorker) isBoundedCompactionThread(threadID string) bool {
	m := w.doc.GetThreadYMap(threadID)
	if m == nil {
		return false
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	marked, _ := m.Get("boundedCompaction").(bool)
	noAutoSelect, _ := m.Get("noAutoSelect").(bool)
	forceTool, _ := m.Get("forceTool").(string)
	return marked || (noAutoSelect && forceTool == "return_result")
}

func (w *ConversationWorker) compactionPromptItemID(threadID string) string {
	m := w.doc.GetThreadYMap(threadID)
	if m == nil {
		return ""
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	id, _ := m.Get("compactionPromptItemId").(string)
	return id
}

// resolveCompactionPromptItemID returns the thread's summarization-prompt item
// id and an empty reason on success, or "" and a typed failure reason. The two
// failure modes are distinct: a marked thread whose recorded
// compactionPromptItemId no longer resolves to an item (deleted) reports
// BoundedCompactionMissingPrompt; an unmarked (legacy) thread whose heuristic
// finds zero or multiple candidate prompts reports
// BoundedCompactionUnsafeLegacyPrompt.
func (w *ConversationWorker) resolveCompactionPromptItemID(threadID string, items []ConversationItem) (string, BoundedCompactionReason) {
	if id := w.compactionPromptItemID(threadID); id != "" {
		for _, item := range items {
			if item.ItemID == id {
				return id, ""
			}
		}
		return "", BoundedCompactionMissingPrompt
	}
	matches := ""
	for _, item := range items {
		if item.Type != ItemTypeUser || !strings.HasPrefix(item.Content, defaultSummarizationPromptMarker) {
			continue
		}
		if matches != "" {
			return "", BoundedCompactionUnsafeLegacyPrompt
		}
		matches = item.ItemID
	}
	if matches == "" {
		return "", BoundedCompactionUnsafeLegacyPrompt
	}
	return matches, ""
}

// dispatchHiddenCompaction sends one pre-planned hidden call through the
// normal server/provider path (registry admission included) with stream chunks
// discarded, and maps engine-side cancellation onto the reducer's sentinel.
func (w *ConversationWorker) dispatchHiddenCompaction(encoded json.RawMessage) (*LLMResponse, error) {
	response, err := w.callLLMWithSink(encoded, nil)
	if err != nil && (errors.Is(err, ErrCancelled) || w.compactionCancelled() || w.llmWakeInterrupt.Load()) {
		return nil, errBoundedCompactionCancelled
	}
	return response, err
}

// writeBoundedCompactionResult commits the final summary onto the folded
// thread's Y.Map along with the operation's durable accounting. Returns false
// when the thread disappeared mid-reduce.
func (w *ConversationWorker) writeBoundedCompactionResult(threadID string, result CompactionResult) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	m := findThreadYMap(w.doc.getItems(), threadID)
	if m == nil {
		return false
	}
	if existing, _ := m.Get("result").(string); existing != "" {
		return true
	}
	accounting := convertToYcrdt(compactionAccountingMap(result))
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		m.Set("result", result.Summary)
		m.Set("compactionAccounting", accounting)
	}, w.doc.authorID)
	return true
}

// handleCompact folds the conversation on request from the browser /compact or
// /handoff command — the single Go fold, which replaced the browser-side JS
// fold. The command framework has already settled
// the worker to idle and closed the undo capture window (cancelAndSettle +
// stop-undo-capturing on the same ordered channel), so the fold starts a fresh
// undo group and the checkForNewThreads pickup merges fold + summary into one
// group (compactionMergeFromIdx), matching the old browser-fold undo semantics.
//
// It replies BEFORE driving the pickup so the browser command returns promptly;
// the summarization then runs on the worker loop without blocking the command —
// exactly as a browser-synced fold's pickup ran synchronously inside handleYjsSync.
func (w *ConversationWorker) handleCompact(payload json.RawMessage) {
	var msg CompactMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		w.log.Error("Failed to parse compact message: %v", err)
		return
	}
	ack := AckMessage{Type: "ack", AckID: msg.AckID}
	if w.loadState() != StateIdle {
		ack.Result = map[string]any{"folded": false, "error": "conversation is busy"}
		w.reply(ack)
		return
	}
	_, folded, err := w.foldConversationForCompaction(msg.HandoffPromote)
	if err != nil {
		w.log.Error("[compact] fold failed: %v", err)
		ack.Result = map[string]any{"folded": false, "error": err.Error()}
		w.reply(ack)
		return
	}
	ack.Result = map[string]any{"folded": folded}
	w.reply(ack)
	if folded {
		w.checkForNewThreads()
	}
}

// foldConversationForCompaction folds the target conversation's foldable history
// into an UNSUMMARIZED bounded-compaction thread — the worker-side port of the
// browser /compact fold. It relocates the
// leading contiguous run of foldable items into a new thread carrying the
// /compact control flags and a summarization prompt, leaving the leading
// standing-context run (rules, plans, the sticky system prompt) at the parent.
//
// The thread is spliced UNSUMMARIZED (needsStrategyRun, no result); the caller
// then lets checkForNewThreads pick it up and run it through the Phase-3
// folded-compaction summarizer, which also merges the whole operation into one
// undo group (compactionMergeFromIdx). The fold classification reuses recovery's
// unit grouping and foldability rules verbatim, so — like recovery, and unlike
// the legacy browser /compact — it never re-swallows a prior compaction summary:
// the range stops before the first interior pinned unit.
//
// handoffPromote tags the thread so the browser promotes its summary into the
// continued tab's parked first message. Returns the new thread's item id and
// true when a fold happened, ("", false, nil) when there was nothing foldable,
// and a BoundedCompactionError when encoding or the fingerprinted commit failed.
func (w *ConversationWorker) foldConversationForCompaction(handoffPromote bool) (string, bool, error) {
	items := w.getTargetItems()

	// Classify by POSITION, matching the browser /compact fold (not recovery's
	// per-item token rule): keep only the LEADING run of standing context — rules,
	// agents files, memory, and sticky preventUserDeletion items — at the parent.
	// Once the first conversational item appears, sweep EVERYTHING after it into
	// the thread, including mid-conversation context/file items the model produced
	// (those are standing context only while leading). foldStart is the first item
	// we fold.
	foldStart := -1
	inLeading := true
	for i := range items {
		it := items[i]
		if it.PreventUserDeletion {
			continue // sticky — stays at parent, transparent to the leading run
		}
		if inLeading {
			if isConversationalItemType(it.Type) {
				inLeading = false // first conversational item ends the leading run; it folds
			} else if it.ItemID != "" && it.ToolUseID == "" {
				continue // a leading standing-context item — keep at parent
			}
		}
		if it.Type == ItemTypeThread && it.BoundedCompaction {
			continue // never re-swallow a prior compaction summary (or our own fold)
		}
		foldStart = i
		break
	}
	if foldStart < 0 {
		return "", false, nil
	}

	// Extend the contiguous fold to the end, stopping before the first interior
	// pin — a prior bounded-compaction summary (never re-swallowed/nested) or a
	// sticky item that must stay put. With no interior pins this covers everything
	// after the leading context — exactly the browser /compact range.
	prefixStart := foldStart
	prefixEnd := foldStart + 1
	for prefixEnd < len(items) {
		it := items[prefixEnd]
		if it.PreventUserDeletion || (it.Type == ItemTypeThread && it.BoundedCompaction) {
			break
		}
		prefixEnd++
	}

	// Fingerprint the exact snapshot being folded so the splice aborts if the doc
	// changed underneath (an undo, a queued-message promotion). The synthesized
	// prompt id lives only inside the folded thread's nested items — it matches
	// nothing in the target array, excluding nothing from the fingerprint.
	promptID := generateItemID()
	records, err := canonicalCompactionRecords(items, promptID)
	if err != nil {
		return "", false, &BoundedCompactionError{Reason: BoundedCompactionSourceEncoding, Message: "compaction fold could not encode canonical source: " + err.Error(), Cause: err}
	}
	fingerprint := compactionSourceFingerprint(records)

	// Nested items: the folded run verbatim + the summarization prompt item. The
	// prompt content is the full DefaultSummarizationPrompt (matching the browser
	// fold's visible thread); the Phase-3 reducer's finalPrompt override supplies
	// the actual instruction, and CompactionPromptItemID excludes it from history.
	promptItem := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  promptID,
		Content: DefaultSummarizationPrompt,
	}
	nested := append(append([]ConversationItem{}, items[prefixStart:prefixEnd]...), promptItem)
	nestedJSON, err := json.Marshal(nested)
	if err != nil {
		return "", false, &BoundedCompactionError{Reason: BoundedCompactionSourceEncoding, Message: "compaction fold could not encode folded items: " + err.Error(), Cause: err}
	}

	threadID := generateItemID()
	summaryItem := ConversationItem{
		Type:                   ItemTypeThread,
		ItemID:                 threadID,
		Timestamp:              time.Now().Format(time.RFC3339),
		Goal:                   "Compacted conversation history",
		BoundedCompaction:      true,
		CompactionPromptItemID: promptID,
		NeedsStrategyRun:       true,
		NoAutoSelect:           true,
		NoContextSeed:          true,
		ForceTool:              "return_result",
		HandoffPromote:         handoffPromote,
		Items:                  nestedJSON,
	}

	if !w.foldPrefixIntoSummaryTracked(w.getTargetItemsYArray(), prefixStart, prefixEnd-prefixStart, summaryItem, promptID, fingerprint) {
		return "", false, &BoundedCompactionError{Reason: BoundedCompactionSourceChanged, Message: "conversation changed during compaction; nothing was folded"}
	}
	return threadID, true, nil
}

// foldPrefixIntoSummaryTracked commits a recovery fold as a single, atomically
// undoable operation. It performs the same fingerprint recheck-and-splice under
// one ycrdtMu hold as ConversationDocument.FoldPrefixIntoSummaryIfUnchanged, but
// runs the splice under the author origin with the UndoManager capturing,
// bracketed by StopCapturing so the whole delete+insert forms its own undo group.
// This gives recovery folds the same undo semantics as the browser /compact
// fold: one undo restores the pre-fold history and removes the summary thread,
// instead of the fold lingering as an un-undoable item while the rest of the
// conversation undoes around it. Returns false without mutating when the source
// changed under the recheck.
func (w *ConversationWorker) foldPrefixIntoSummaryTracked(arr *ycrdt.YArray, start, count int, summary ConversationItem, promptID, expectedFingerprint string) bool {
	if arr == nil || count <= 0 {
		return false
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if !w.doc.foldFingerprintUnchangedLocked(arr, start, count, promptID, expectedFingerprint) {
		return false
	}
	// Bind the UndoManager to the current items array before capturing, so a
	// post-load array-pointer swap can't leave the fold untracked.
	w.tracker.refreshScopeIfNeeded()
	um := w.tracker.ensureUndoManager()
	um.StopCapturing()
	ycrdt.Transact(w.doc.doc, func(_ *ycrdt.Transaction) {
		spliceSummaryIntoPrefix(arr, start, count, summary)
	}, w.doc.authorID, true)
	um.StopCapturing()
	return true
}

func (w *ConversationWorker) compactionCancelled() bool {
	if w.loadState() == StateCancelling {
		return true
	}
	select {
	case <-w.done:
		return true
	default:
		return false
	}
}
