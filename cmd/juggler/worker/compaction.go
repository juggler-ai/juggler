//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/provider"

	ycrdt "github.com/skyterra/y-crdt"
)

const defaultSummarizationPromptMarker = "You are creating a handoff summary of the conversation so far. Another instance of yourself will use ONLY this summary"

// beginCompactionStatus publishes the busy frame a compaction run is shown by.
// The summarizer works entirely through hidden calls, so nothing streams into
// the transcript while it runs — this doc write is the only evidence the UI has:
// it raises the spinner, labels it, and anchors the elapsed digit. Flushed
// immediately so the label lands before the first hidden call rather than at the
// batcher's next tick.
func (r *run) beginCompactionStatus(message string) {
	r.sendStatus("compacting", message)
	r.batcher.Flush()
}

// tryBoundedCompaction handles only browser-folded summary threads. It is the
// folded-thread orchestrator for the pure bounded reducer: snapshot the thread's
// Yjs state, canonicalize it, run the reducer, commit the summary.
func (r *run) tryBoundedCompaction(limitErr *provider.ContextLimitExceededError, modelConfig *ModelConfig) (bool, error) {
	threadID := r.t.thread.itemID
	if threadID == "" || !r.isBoundedCompactionThread(threadID) {
		return false, nil
	}
	if r.compactionCancelled() {
		return true, errBoundedCompactionCancelled
	}
	pinnedModel, err := validateCompactionModel(modelConfig, "bounded compaction")
	if err != nil {
		return true, err
	}

	items := r.getTargetItems()
	promptID, failReason := r.resolveCompactionPromptItemID(threadID, items)
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

	r.beginCompactionStatus("Summarizing conversation")
	r.recordCompactionStart(compactionKindFolded, limitErr.ContextWindowTokens, limitErr.OutputReserveTokens, limitErr.Breakdown.ProviderOverheadTokens)
	result, err := r.runReducer(compactionKindFolded, pinnedModel, budget, records)
	if err != nil {
		return true, err
	}
	if !r.writeBoundedCompactionResult(threadID, result) {
		r.recordCompactionOutcome(compactionKindFolded, "error", result, map[string]any{"reason": string(BoundedCompactionSourceChanged)})
		return true, &BoundedCompactionError{
			Reason: BoundedCompactionSourceChanged, Message: "bounded compaction thread disappeared before result commit",
			Pass: result.Passes, Calls: result.Calls, Spend: result.EstimatedSpend,
			Window: budget.window, Usage: result.Usage,
		}
	}
	r.recordCompactionOutcome(compactionKindFolded, "result", result, nil)
	return true, nil
}

// runFoldedThreadCompaction summarizes a browser-folded /compact (or /handoff)
// thread with a single probe-then-reduce pass, and is the folded thread's sole
// summarizer — it replaces the ordinary strategy turn. It dispatches the
// whole canonical transcript as one final-summary request; if the provider
// accepts it, that one-pass summary is committed. If the provider rejects it as
// too large, the reported context window seeds the bounded reducer
// (tryBoundedCompaction) to map/reduce the transcript. Either way the summary is
// committed through the one path, writeBoundedCompactionResult. Returns
// handled=false only when the thread is not a bounded compaction thread.
func (r *run) runFoldedThreadCompaction(modelConfig *ModelConfig, ctxResult *ContextResult, tools []ToolDefinition) (bool, error) {
	threadID := r.t.thread.itemID
	if threadID == "" || !r.isBoundedCompactionThread(threadID) {
		return false, nil
	}
	if r.compactionCancelled() {
		return true, errBoundedCompactionCancelled
	}
	pinnedModel, err := validateCompactionModel(modelConfig, "bounded compaction")
	if err != nil {
		return true, err
	}

	items := r.getTargetItems()
	promptID, failReason := r.resolveCompactionPromptItemID(threadID, items)
	if failReason != "" {
		message := "bounded compaction cannot prove which legacy item is the summarization prompt"
		if failReason == BoundedCompactionMissingPrompt {
			message = "bounded compaction cannot find the thread's recorded summarization prompt item (it may have been deleted)"
		}
		return true, &BoundedCompactionError{Reason: failReason, Message: message}
	}
	// records is the canonical source identity (fingerprint only here); the probe
	// request below is built from the same items. Both derive from the one
	// itemWireMessages projection — records per-item, the request batched — so the
	// fingerprint and the request describe the same wire form, not the old
	// divergent raw-item-dump versus wire-message pair.
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

	r.beginCompactionStatus("Summarizing conversation")
	r.recordCompactionStart(compactionKindFolded, 0, 0, 0)
	probe := r.newBoundedReducer(compactionKindFolded, pinnedModel, boundedCompactionBudget{})
	parentThreadID := r.doc.ParentThreadID(threadID)
	// Preserve the real turn's cacheable prefix: the folded history renders through
	// the same wire path as a live turn, and the summarization instruction is
	// appended as a final user message rather than swapping the system prompt.
	// Mirror the live turn's placement (buildMessages): each standing context item
	// renders where its item stands, and one whose item is not in this thread —
	// the parent's, which foldedCompactionContextItemIDs pulls in — leads. The
	// summarization instruction stays the final user message.
	sourceItems := itemsWithoutItemID(items, promptID)
	placed, unplaced := splitContextsByPlacement(sourceItems, ctxResult.Contexts)
	wire := prependContextItemMessages(nil, unplaced)
	wire = append(wire, r.buildMessagesFromItemsWithContexts(sourceItems, false, placed)...)
	history, err := providerMessages(wire)
	if err != nil {
		return true, &BoundedCompactionError{Reason: BoundedCompactionSourceEncoding, Message: "bounded compaction could not encode semantic history: " + err.Error(), Cause: err}
	}
	messages := history
	messages = append(messages, provider.Message{Type: ItemTypeUser, Content: DefaultSummarizationPrompt})
	probeReq := hiddenLLMRequest{
		Type: "message", SystemPrompt: ctxResult.SystemPrompt,
		Messages: messages, Tools: r.filterToolsForThreadID(tools, parentThreadID),
		ConversationID: r.conversationID, ThreadID: parentThreadID, ModelConfig: &pinnedModel,
		ToolChoice:    map[string]any{"mode": provider.ToolChoiceNone},
		TransactionID: generateTransactionID(), BypassContextGuard: true,
		// It rides under the parent thread's id, so without this marker its
		// measurement would be filed as that thread's measured prefix — a
		// summarization request no real turn resembles, standing in for one.
		SyntheticTranscript: true,
	}
	result, overflow, probeErr := probe.probeRequest(probeReq, compactionSourceFingerprint(records))
	if probeErr != nil {
		if errors.Is(probeErr, errBoundedCompactionCancelled) {
			r.recordCompactionOutcome(compactionKindFolded, "cancelled", result, nil)
			return true, &BoundedCompactionCancelledError{Result: result}
		}
		reason := "error"
		var bounded *BoundedCompactionError
		if errors.As(probeErr, &bounded) {
			reason = string(bounded.Reason)
		}
		r.recordCompactionOutcome(compactionKindFolded, "error", result, map[string]any{"reason": reason})
		return true, probeErr
	}
	if overflow != nil {
		// The transcript does not fit one call: chunk it with the reported
		// window through the bounded reducer's map/reduce path.
		return r.tryBoundedCompaction(overflow, modelConfig)
	}
	if r.compactionCancelled() {
		r.recordCompactionOutcome(compactionKindFolded, "cancelled", result, nil)
		return true, &BoundedCompactionCancelledError{Result: result}
	}
	if !r.writeBoundedCompactionResult(threadID, result) {
		r.recordCompactionOutcome(compactionKindFolded, "error", result, map[string]any{"reason": string(BoundedCompactionSourceChanged)})
		return true, &BoundedCompactionError{
			Reason: BoundedCompactionSourceChanged, Message: "bounded compaction thread disappeared before result commit",
			Pass: result.Passes, Calls: result.Calls, Spend: result.EstimatedSpend, Usage: result.Usage,
		}
	}
	r.recordCompactionOutcome(compactionKindFolded, "result", result, nil)
	return true, nil
}

func (r *run) foldedCompactionContextItemIDs(threadID string) []string {
	parentID := r.doc.ParentThreadID(threadID)
	var parentItems []ConversationItem
	if parentID == "" {
		parentItems = r.doc.GetItems()
	} else {
		parentItems = r.doc.GetItemsFromArray(r.doc.GetThreadItemsArray(parentID))
	}
	ids := make([]string, 0, len(parentItems)+len(r.getTargetItems()))
	for _, item := range parentItems {
		if item.ItemID != "" && item.ItemID != threadID {
			ids = append(ids, item.ItemID)
		}
	}
	for _, item := range r.getTargetItems() {
		if item.ItemID != "" && item.ItemID != r.compactionPromptItemID(threadID) {
			ids = append(ids, item.ItemID)
		}
	}
	return ids
}

func itemsWithoutItemID(items []ConversationItem, excludedID string) []ConversationItem {
	filtered := make([]ConversationItem, 0, len(items))
	for _, item := range items {
		if item.ItemID != excludedID {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func providerMessages(messages []map[string]any) ([]provider.Message, error) {
	encoded, err := json.Marshal(messages)
	if err != nil {
		return nil, err
	}
	var result []provider.Message
	if err := json.Unmarshal(encoded, &result); err != nil {
		return nil, err
	}
	return result, nil
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
func (r *run) newBoundedReducer(kind string, pinnedModel ModelConfig, budget boundedCompactionBudget) *boundedReducer {
	// The folded /compact orchestrator produces a user-facing handoff summary, so
	// its final call uses the rich DefaultSummarizationPrompt. Recovery and shrink
	// keep the terse final prompt.
	finalPrompt := ""
	if kind == compactionKindFolded {
		finalPrompt = DefaultSummarizationPrompt
	}
	return &boundedReducer{
		conversationID: r.conversationID,
		threadID:       r.t.thread.itemID,
		modelConfig:    pinnedModel,
		budget:         budget,
		dispatcher:     r,
		cancelled:      r.compactionCancelled,
		hooks:          r.compactionTapeHooks(kind),
		finalPrompt:    finalPrompt,
	}
}

// runReducer builds the reducer, runs it, and records the outcome. On error the
// returned error is already typed (BoundedCompactionCancelledError /
// BoundedCompactionError) and the outcome has been recorded, so callers add only
// their unique commit/fold step. The post-run cancellation re-check lives here
// too, since both the folded and recovery orchestrators duplicated it. The
// shrink orchestrator records per-tool-result outcomes and so builds its reducer
// via newBoundedReducer directly rather than through this helper.
func (r *run) runReducer(kind string, pinnedModel ModelConfig, budget boundedCompactionBudget, records []string) (CompactionResult, error) {
	reducer := r.newBoundedReducer(kind, pinnedModel, budget)
	result, err := reducer.run(records)
	if err != nil {
		if errors.Is(err, errBoundedCompactionCancelled) {
			r.recordCompactionOutcome(kind, "cancelled", result, nil)
			return result, &BoundedCompactionCancelledError{Result: result}
		}
		reason := "error"
		var bounded *BoundedCompactionError
		if errors.As(err, &bounded) {
			reason = string(bounded.Reason)
		}
		r.recordCompactionOutcome(kind, "error", result, map[string]any{"reason": reason})
		return result, err
	}
	if r.compactionCancelled() {
		r.recordCompactionOutcome(kind, "cancelled", result, nil)
		return result, &BoundedCompactionCancelledError{Result: result}
	}
	return result, nil
}

// isBoundedCompactionThread recognizes a fold thread the summarizer still owes a
// result. The boundedCompaction flag is the sole authority: it is stamped on
// every fold the browser and the auto-compaction path produce, and the
// summarizer runs tool-free, so nothing about a fold's identity is carried by a
// tool name.
func (w *ConversationWorker) isBoundedCompactionThread(threadID string) bool {
	m := w.doc.GetThreadYMap(threadID)
	if m == nil {
		return false
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	marked, _ := m.Get("boundedCompaction").(bool)
	return marked
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
func (r *run) dispatchHiddenCompaction(encoded json.RawMessage) (*LLMResponse, error) {
	response, err := r.callLLMWithSink(encoded, nil)
	// A hidden call is hidden from the transcript, not from the bill. The
	// operation keeps its own accounting for its own budget (CompactionUsage);
	// this counts the same tokens once into the conversation's lifetime total,
	// which is the only figure that answers what the conversation has cost.
	r.recordTurnSpend(response)
	if err != nil && (errors.Is(err, ErrCancelled) || r.compactionCancelled() || r.t.wakeInterrupt.Load()) {
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
	unsummarized, _ := m.Get("compactionUnsummarized").(bool)
	w.doc.transactTracked(func(_ *ycrdt.Transaction) {
		m.Set("result", result.Summary)
		m.Set("compactionAccounting", accounting)
		// A summary exists again, so any marker left by an earlier failed or
		// cancelled attempt goes with it, in the same transaction that made it
		// untrue.
		if unsummarized {
			m.Delete("compactionUnsummarized")
		}
	})
	return true
}

// handleCompact folds the conversation on request from the browser /compact or
// /handoff command — the single Go fold, which replaced the browser-side JS
// fold. The command framework has already settled
// the worker to idle and closed the undo capture window (cancelAndSettle +
// stop-undo-capturing on the same ordered channel), so the fold starts a fresh
// undo group and the checkForNewThreads pickup merges fold + summary into one
// group (undoGrouping.markCompactionStart), matching the old browser-fold undo semantics.
//
// It replies BEFORE driving the pickup so the browser command returns promptly;
// the summarization then runs on the worker loop without blocking the command —
// exactly as a browser-synced fold's pickup ran synchronously inside handleYjsSync.
func (r *run) handleCompact(payload json.RawMessage) {
	var msg CompactMessage
	if !r.decodePayload("compact", payload, &msg) {
		return
	}
	ack := AckMessage{Type: "ack", AckID: msg.AckID}
	// Busy means BOTH the run state and the doc-native LLM claim, matching every
	// other intake (handleSendMessage, task delivery). State alone is not enough:
	// a turn can leave state Idle while still holding the claim, and folding then
	// commits a thread the pickup cannot claim — leaving a fold that never
	// summarizes while the conversation reports idle. Refusing here says so.
	//
	// The fold's target is the root thread, so that is the claim it asks about. A
	// fold does rewrite the array every live descendant hangs off, so once
	// siblings can genuinely run in parallel this gate has to widen back out to
	// them; it is narrow here because root is what /compact folds. The run-state
	// half is the conversation's for that same reason — this is the one intake
	// Phase E does NOT narrow to its target thread, because folding under a
	// descendant's running turn rewrites the array that turn is writing into.
	if r.threadActivity("") != ActivityNone || r.anyRunState() != StateIdle {
		ack.Result = map[string]any{"folded": false, "error": "conversation is busy"}
		r.reply(ack)
		return
	}
	// Folding the history is human intent, so it lifts any pause standing over
	// the thread it folds, exactly as a send or Continue does. The
	// fold commits whatever the marks say — the gate above passes, since a landed
	// pause holds no claim — and the summarization it owes runs on a thread the
	// mark would then cover, leaving a conversation folded into a thread that
	// never gets its summary and that nothing re-drives. Root is the thread the
	// fold targets, and the one the busy gate above asks about.
	r.dropPoliteStopsCovering("")

	_, folded, err := r.foldConversationForCompaction(msg.HandoffPromote)
	if err != nil {
		r.log.Error("[compact] fold failed: %v", err)
		ack.Result = map[string]any{"folded": false, "error": err.Error()}
		r.reply(ack)
		return
	}
	ack.Result = map[string]any{"folded": folded}
	r.reply(ack)
	if folded {
		// Root, beside the fold: the fold thread's own items are the summarizer's
		// source, and a notice there would be summarized with them.
		if notice, ok := r.assumedWindowNotice(nil); ok {
			r.tracker.AppendMessage(notice)
		}
		r.checkForNewThreads()
	}
}

// pendingCompactionFold reports whether an item is an in-flight bounded-
// compaction fold that has not yet committed its summary. Such a thread is
// pinned: the pickup still owes it a summarization run, so a fold must not
// nest it. A summarized compaction thread is ordinary foldable content.
func pendingCompactionFold(it ConversationItem) bool {
	return it.Type == ItemTypeThread && it.BoundedCompaction && !hasThreadResult(it)
}

// summarizedCompactionThread reports whether an item is a compaction summary
// thread carrying its committed result.
func summarizedCompactionThread(it ConversationItem) bool {
	return it.Type == ItemTypeThread && it.BoundedCompaction && hasThreadResult(it)
}

// condenseForRefold returns the form in which an item nests inside a new
// compaction fold. A summarized prior compaction thread sheds its prompt pointer
// and run-control flags, which belonged to the summarization run it has
// finished. Every other item nests verbatim.
//
// Its folded transcript (Items) nests with it, so every earlier compaction
// stays browsable at any depth: compaction moves history, it never deletes it.
// Keeping it costs the model nothing — a thread's wire form (appendThreadMessages)
// is its goal + result and never reads Items, so the reducer's source and
// fingerprint see the prior summary exactly as the live conversation rendered it.
// FoldedRuns survive for the same reason: they are the caller's pairing for
// calls that have already returned.
func condenseForRefold(it ConversationItem) ConversationItem {
	if !summarizedCompactionThread(it) {
		return it
	}
	return ConversationItem{
		Type:              ItemTypeThread,
		ItemID:            it.ItemID,
		Timestamp:         it.Timestamp,
		Goal:              it.Goal,
		Result:            it.Result,
		BoundedCompaction: true,
		Items:             it.Items,
		FoldedRuns:        it.FoldedRuns,
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
// undo group (undoGrouping.markCompactionStart).
//
// Convergence invariant: each fold SWALLOWS prior summarized compaction
// threads (nested whole, transcript included, see condenseForRefold),
// so the conversation always converges to [standing context][one summary
// thread][recent tail] — summaries never accumulate, and each new summary
// carries the prior one's content forward as part of its source. A session
// thread converges the same way: earlier invocation messages fold like any
// other content, with their run records preserved on the fold (foldedRunsIn).
// Only an in-flight fold that has not yet committed its summary is pinned
// (pendingCompactionFold), along with sticky preventUserDeletion items and the
// thread's most recent invocation message (lastInvocationIndex).
//
// handoffPromote tags the thread so the browser promotes its summary into the
// continued tab's parked first message. Returns the new thread's item id and
// true when a fold happened, ("", false, nil) when there was nothing foldable,
// and a BoundedCompactionError when encoding or the fingerprinted commit failed.
func (r *run) foldConversationForCompaction(handoffPromote bool) (string, bool, error) {
	items := r.getTargetItems()

	// Classify by POSITION, matching the browser /compact fold (not recovery's
	// per-item token rule): keep only the LEADING run of standing context — rules,
	// agents files, memory, and sticky preventUserDeletion items — at the parent.
	// Once the first conversational item appears, sweep EVERYTHING after it into
	// the thread, including mid-conversation context/file items the model produced
	// (those are standing context only while leading). foldStart is the first item
	// we fold.
	// The thread's most recent invocation message is the one item a fold may not
	// take (lastInvocationIndex): the open run's outcome is stamped there, and
	// the thread's liveness is read off it.
	pinnedInvocation := lastInvocationIndex(items)

	foldStart := -1
	inLeading := true
	for i := range items {
		it := items[i]
		if it.PreventUserDeletion {
			continue // sticky — stays at parent, transparent to the leading run
		}
		if i == pinnedInvocation {
			// Pinned, but conversational, so it still ends the leading
			// standing-context run.
			inLeading = false
			continue
		}
		if inLeading {
			if isConversationalItemType(it.Type) {
				inLeading = false // first conversational item ends the leading run; it folds
			} else if it.ItemID != "" && it.ToolUseID == "" {
				continue // a leading standing-context item — keep at parent
			}
		}
		if pendingCompactionFold(it) {
			continue // an in-flight fold awaiting its summary — pinned, never nested
		}
		foldStart = i
		break
	}
	if foldStart < 0 {
		return "", false, nil
	}

	// Extend the contiguous fold to the end, stopping before the first interior
	// pin — an in-flight unsummarized fold or a sticky item that must stay put.
	// Summarized compaction threads are content and fold along with everything
	// else, so with no interior pins this covers everything after the leading
	// context.
	prefixStart := foldStart
	prefixEnd := foldStart + 1
	for prefixEnd < len(items) {
		it := items[prefixEnd]
		if it.PreventUserDeletion || pendingCompactionFold(it) || prefixEnd == pinnedInvocation {
			break
		}
		prefixEnd++
	}

	// A range holding nothing but already-summarized compaction threads would
	// only re-summarize existing summaries — nothing new to compact.
	hasFresh := false
	for _, it := range items[prefixStart:prefixEnd] {
		if !summarizedCompactionThread(it) {
			hasFresh = true
			break
		}
	}
	if !hasFresh {
		return "", false, nil
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

	// Nested items: the folded run (prior summaries stripped of their run-control
	// flags, everything else verbatim) + the summarization prompt item. Its content is
	// DefaultSummarizationPrompt, the same text the summarizer sends as the
	// final user message, so the visible item states the instruction that
	// actually ran; CompactionPromptItemID excludes it from the source history.
	promptItem := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  promptID,
		Content: DefaultSummarizationPrompt,
	}
	nested := make([]ConversationItem, 0, prefixEnd-prefixStart+1)
	for _, it := range items[prefixStart:prefixEnd] {
		nested = append(nested, condenseForRefold(it))
	}
	nested = append(nested, promptItem)
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
		HandoffPromote:         handoffPromote,
		Items:                  nestedJSON,
		FoldedRuns:             foldedRunsIn(items[prefixStart:prefixEnd]),
	}

	if !r.foldPrefixIntoSummaryTracked(r.getTargetItemsYArray(), prefixStart, prefixEnd-prefixStart, summaryItem, promptID, fingerprint) {
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

func (r *run) compactionCancelled() bool {
	if r.loadState() == StateCancelling {
		return true
	}
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}
