//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"errors"
	"strings"

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
	if modelConfig == nil || modelConfig.Provider == "" || modelConfig.Model == "" {
		return true, &BoundedCompactionError{Reason: BoundedCompactionMissingModel, Message: "bounded compaction requires the rejected request's model config"}
	}
	pinnedModel := *modelConfig

	items := w.getTargetItems()
	promptID, safe := w.resolveCompactionPromptItemID(threadID, items)
	if !safe {
		return true, &BoundedCompactionError{Reason: BoundedCompactionUnsafeLegacyPrompt, Message: "bounded compaction cannot prove which legacy item is the summarization prompt"}
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

	sourceReq := provider.MessageRequest{Messages: []provider.Message{{Type: "user", Content: strings.Join(records, "\n")}}}
	sourceTokens := provider.EstimateMessageRequestTokenBreakdown(sourceReq, 0).Total
	initialSpend := saturatingAdd64(limitErr.EstimatedInputTokens, limitErr.OutputReserveTokens)
	reducer := &boundedReducer{
		conversationID: w.conversationID,
		threadID:       threadID,
		modelConfig:    pinnedModel,
		budget: boundedCompactionBudget{
			window:           limitErr.ContextWindowTokens,
			reserve:          limitErr.OutputReserveTokens,
			providerOverhead: limitErr.Breakdown.ProviderOverheadTokens,
			maxSpend:         minSaturating(mulSaturating(sourceTokens, 4), mulSaturating(limitErr.ContextWindowTokens, 8)),
			spend:            initialSpend,
			calls:            1,
		},
		dispatcher: w,
		cancelled:  w.compactionCancelled,
		hooks:      w.compactionTapeHooks(compactionKindFolded),
	}

	w.recordCompactionStart(compactionKindFolded, limitErr.ContextWindowTokens, limitErr.OutputReserveTokens, limitErr.Breakdown.ProviderOverheadTokens)
	result, err := reducer.run(records)
	if err != nil {
		if errors.Is(err, errBoundedCompactionCancelled) {
			w.recordCompactionOutcome(compactionKindFolded, "cancelled", result, nil)
			return true, &BoundedCompactionCancelledError{Result: result}
		}
		reason := "error"
		var bounded *BoundedCompactionError
		if errors.As(err, &bounded) {
			reason = string(bounded.Reason)
		}
		w.recordCompactionOutcome(compactionKindFolded, "error", result, map[string]any{"reason": reason})
		return true, err
	}
	if w.compactionCancelled() {
		w.recordCompactionOutcome(compactionKindFolded, "cancelled", result, nil)
		return true, &BoundedCompactionCancelledError{Result: result}
	}
	if !w.writeBoundedCompactionResult(threadID, result) {
		w.recordCompactionOutcome(compactionKindFolded, "error", result, map[string]any{"reason": string(BoundedCompactionSourceChanged)})
		return true, &BoundedCompactionError{
			Reason: BoundedCompactionSourceChanged, Message: "bounded compaction thread disappeared before result commit",
			Pass: result.Passes, Calls: result.Calls, Spend: result.EstimatedSpend,
			MaxSpend: reducer.budget.maxSpend, Window: reducer.budget.window, Usage: result.Usage,
		}
	}
	w.recordCompactionOutcome(compactionKindFolded, "result", result, nil)
	return true, nil
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

func (w *ConversationWorker) resolveCompactionPromptItemID(threadID string, items []ConversationItem) (string, bool) {
	if id := w.compactionPromptItemID(threadID); id != "" {
		for _, item := range items {
			if item.ItemID == id {
				return id, true
			}
		}
		return "", false
	}
	matches := ""
	for _, item := range items {
		if item.Type != ItemTypeUser || !strings.HasPrefix(item.Content, defaultSummarizationPromptMarker) {
			continue
		}
		if matches != "" {
			return "", false
		}
		matches = item.ItemID
	}
	return matches, matches != ""
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
