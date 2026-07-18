//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
)

// Strategy loop constants
const (
	// MaxBarrenTurns caps consecutive turns where the LLM emitted no
	// user-visible content (no assistant text, no tool_use) before we
	// give up and surface a placeholder. Each loop iteration is a full
	// round-trip, so this bounds both latency and cost when the model
	// gets stuck thinking-only or the provider returns an empty stream.
	MaxBarrenTurns  = 3
	MaxLLMRetries   = 3
	ToolExecTimeout = 2 * time.Minute
	ContextTimeout  = 30 * time.Second

	// LLMTimeout is a coarse wall-clock backstop on one waitForLLMResponse,
	// NOT the primary stream-liveness guard. Liveness now lives at the provider
	// boundary: every streaming provider arms an idle watchdog
	// (utils.StreamIdleTimeout of silence; claudecode's own streamIdleTimeout)
	// that aborts a stalled stream and surfaces a transient error within
	// seconds of the upstream going quiet. This timer only catches the
	// pathological case a provider watchdog somehow misses — a turn that never
	// returns AND never goes idle long enough to trip its own guard. It is
	// therefore deliberately generous: an idle deadline would duplicate the
	// provider watchdogs, and a tight absolute deadline would wrongly kill a
	// healthy long-but-continuously-streaming turn (e.g. a large cold-start
	// that re-ingests history then generates for minutes). Cancel/wake paths
	// (Stop, interruptInFlightLLMForWake) still unblock the wait immediately,
	// so this value is never the latency a user actually waits on.
	LLMTimeout = 30 * time.Minute

	// TransientRetryWait is the fixed backoff before retrying a transient
	// transport failure (a stalled/dropped CLI stream). Unlike a rate-limit
	// there is no server-suggested delay; a short pause lets a flaky
	// connection or just-slept machine settle before the fresh attempt.
	TransientRetryWait = 1 * time.Second
)

// runStrategyLoop orchestrates the LLM conversation loop.
// Dispatched by the reducer via dispatchCallLLM. Each call does one or
// more LLM turns (auto-continue). Returns when:
//   - Tools are created → transitions to "awaiting_llm", reducer re-dispatches
//   - A thread item is created → same pattern (hasIncompleteThreads)
//   - Text + end_turn → loop ends naturally
//   - Cancellation
func (w *ConversationWorker) runStrategyLoop(userText string, isContinuation bool) {
	defer func() {
		// Non-blocking: if the loop returned after dispatching tools or
		// creating a child thread (activity="awaiting_llm"), let the reducer
		// dispatch the child. In production the run() event loop calls
		// tryReconcile(); drain it inline here so tests (no run()) also work.
		if w.getActivity() == ActivityAwaitingLLM {
			w.storeState(StateIdle)
			w.needsReconcile = true
			w.drainReconcile()
			return
		}

		wasCancelled := w.loadState() == StateCancelling
		completedThreadID := w.thread.itemID // capture before clearing

		// Promote a forced-close thread's text result if its mandated
		// return_result turn degraded to plain text — writeThreadResult is a
		// no-op for every other ending. A turn that ended on plain text, or on
		// an error, leaves the thread OPEN (no result). Run BEFORE clearing
		// state so the Y.Map read can find the items.
		if completedThreadID != "" && !wasCancelled {
			w.writeThreadResult(completedThreadID)
			// A delegated child (spawned by a delegatesToSubthread tool) whose
			// turn ended without return_result would leave its parent's stamped
			// tool_use unpaired. Resolve a result so the parent is never stranded:
			// trailing text, else the tool's onSubthreadError fallback, else a
			// default. No-op for non-delegated threads and for ones already closed
			// via return_result. Runs BEFORE state is cleared so the Y.Map read
			// finds the child's items, and BEFORE signalParentThread so the parent
			// sees the just-written result and resumes.
			w.resolveDelegatedThreadResult(completedThreadID)
		}

		w.storeState(StateIdle)
		w.processingStartedAt = 0
		w.approvalWaitStartedAt = 0
		w.lastProgressWriteMs = 0
		w.resetThreadContext()

		if wasCancelled {
			w.finalizeCancellation(completedThreadID)
			return
		}

		// signalParentThread only fires for a child that actually closed (wrote
		// a result). A child that ended openly — including one that stopped on
		// an error — has no result, so this no-ops and the conversation rests at
		// idle. An errored sub-thread therefore never auto-resumes its parent:
		// the user reviews the error (visible as an error item in the thread) and
		// resumes the thread or the parent explicitly, which the reducer honours.
		if !w.signalParentThread(completedThreadID) {
			w.sendStatus("idle", "")
			w.CancelStaleToolActions()

			// A completed sub-thread folds back into the root conversation. If
			// the user queued a message at the ROOT while the sub-thread ran —
			// e.g. typed a follow-up during /compact — nothing is left to drain
			// that queue: the loop that just ended was scoped to the sub-thread,
			// so its end-of-run drain only checked the sub-thread's own queue,
			// and signalParentThread declined to re-drive the parent (this
			// branch, because a needsStrategyRun/compaction thread is not
			// llmCreated). Without this the message is stranded in the pending
			// queue and the conversation rests at idle. Drive a fresh root turn
			// to promote and answer it (the dispatched turn's top-of-loop
			// promotePendingItems does the actual move). The sendStatus("idle")
			// above already collapsed any compaction undo-merge and closed the
			// capture window — so this follow-up becomes its own undo group —
			// and cleared the LLM claim, so requestLLM can transition from none.
			// Mirrors the reducer's ActionGoIdle drain. Guarded on
			// completedThreadID != "" so it fires ONLY for a sub-thread
			// completion — a root turn drains its own queue inside the loop (the
			// end-of-run continue), never here.
			if completedThreadID != "" && w.hasPendingItems("") {
				w.requestLLM("")
				w.needsReconcile = true
				w.drainReconcile()
				return
			}

			// Root conversation went idle — let the strategy drive any
			// post-idle work (e.g. plan execution) in the engine. Fire-and-
			// forget: its effects re-enter via doc sync + reconcile.
			w.dispatchWorkerIdleHook()
		} else {
			w.drainReconcile()
		}
	}()

	// Clear any stale streaming state from previous conversation turn
	w.finalizeStreaming()

	// Add user message if a caller passed one in directly (test helper path).
	// Production sends arrive via handleSendMessage which inserts the user
	// message before signalling the reducer; in that case userText is empty
	// and the trailing user item is found by findUnstampedUserMsgID below.
	if !isContinuation && userText != "" {
		w.addUserMessage(UserMessageInput{Text: userText})
		w.batcher.Flush() // Show user message in UI immediately
	}

	barrenTurns := 0
	// recoveryAttempted caps context-window recovery at one fold+retry per
	// strategy run: if the rebuilt request still does not fit, the error is
	// terminal rather than a summarize-retry loop.
	recoveryAttempted := false

strategyLoop:
	for {
		// Polite stop (Pause): every LLM turn begins at the top of this loop, so
		// this is the boundary where we rest before re-invoking the model. It
		// catches every in-loop re-entry a mid-turn pause can precede — a sync-tool
		// continuation, a barren retry, and the end-of-run "queued follow-up"
		// continuation. In-flight tools from the prior iteration are already
		// committed to the doc, so promoting any queued messages and returning
		// leaves a clean, resumable transcript; the deferred cleanup writes idle.
		// consumePolitePending Swap(false)s the latch so the next user-initiated
		// turn runs normally (D5, §10.4) and drops the synced pending cue. The
		// reducer's dispatchCallLLMOnThread handles the between-turn (async-tool)
		// case; this handles the never-left-the-loop case.
		if w.consumePolitePending() {
			w.promotePendingItems(w.thread.itemID)
			return
		}

		// Drain any messages queued while this turn was in flight (or while the
		// previous tool batch awaited approval) into the thread as user messages,
		// so the upcoming turn sees them. Promote BEFORE findUnstampedUserMsgID
		// so the newest queued message is the one stamped for this round-trip.
		//
		// This drains at EVERY boundary, including a tool-result continuation:
		// a message typed while tools ran (or sat at an approval prompt) is
		// steering, and the user wants it seen at the earliest opportunity, not
		// after the whole agentic run ends on assistant text. The promoted item
		// appends AFTER the completed tool batch, so the request stays strictly
		// append-only — the stateless API providers' prefix caches are
		// unaffected. The claudecode provider cannot carry user content on its
		// parked-CLI MCP fast path (userInterjectedAfterPendingTools), so an
		// interjected continuation routes through the warm-append resume there —
		// a few seconds of CLI respawn with the prompt cache intact, a fair
		// price for prompt delivery of a deliberately-typed message.
		w.promotePendingItems(w.thread.itemID)

		userMsgToStamp := w.findUnstampedUserMsgID()

		// Fire the strategy's onActivate hook (in the engine) if the active
		// strategy hasn't been activated yet. Placed AFTER promotePendingItems so
		// the just-sent user message is already in the items array — the engine's
		// injected guidance then lands deterministically after it, not racing the
		// promotion. Blocks until the guidance has synced back, so buildMessages
		// sees it. Idempotent across iterations (activatedStrategyId gate).
		w.maybeActivateStrategy()

		// Reset streaming state for this iteration — must reset message IDs
		// AND content so each iteration creates new messages rather than
		// updating previous ones.
		w.finalizeStreaming()
		w.streaming.textContent = ""
		w.streaming.thinkingContent = ""

		if w.loadState() == StateCancelling {
			return
		}

		w.sendStatus("preparing", "")
		w.batcher.Flush()

		ctxResult, tools, err := w.requestContextAndTools()
		if err != nil {
			if errors.Is(err, ErrCancelled) {
				return
			}
			w.sendError(fmt.Sprintf("Failed to get context/tools: %v", err), "")
			return
		}

		// Add return_result tool when running inside a thread
		if w.thread.itemID != "" {
			tools = append(tools, ToolDefinition{
				Name:        "return_result",
				Category:    "meta",
				Description: `Return your result to the parent conversation when this thread's task is complete. Put the full summary in the required "result" argument (not "summary" or a plain text reply) — that string is exactly what the parent receives.`,
				InputSchema: json.RawMessage(`{"type":"object","properties":{"result":{"type":"string","description":"The summary of what this thread accomplished, returned verbatim to the parent conversation."}},"required":["result"]}`),
			})
		}

		// Remember which of this turn's tools may delegate to a subthread, so
		// processLLMResponse can route a call to the build-spec round-trip. Rebuilt
		// each iteration from the freshly-offered tools (a strategy may filter the
		// set differently per turn).
		w.turnDelegatingTools = collectDelegatingToolNames(tools)
		// But a delegated sub-agent must never delegate again: inside a delegated
		// thread (or any descendant of one), delegating tools run inline and return
		// raw content, so a chain of subthreads can't recurse indefinitely.
		if len(w.turnDelegatingTools) > 0 && w.withinDelegatedThread(w.thread.itemID) {
			w.turnDelegatingTools = nil
		}

		// txnID identifies this round-trip; insertTargetMessage stamps it onto
		// every item produced during the call so callers don't plumb it through.
		txnID := generateTransactionID()
		w.currentTxnID = txnID

		llmRequest := w.buildLLMRequest(ctxResult, tools, txnID)
		var originalRequest hiddenLLMRequest
		_ = json.Unmarshal(llmRequest, &originalRequest)

		// Stamp the originating user message before the call. The transaction
		// blob is written below regardless of outcome, so on LLM failure the
		// user message + error item both link to a viewable blob.
		if userMsgToStamp != "" {
			_ = w.updateTargetItemByID(userMsgToStamp, "transactionId", txnID)
		}

		startTime := time.Now()

		response, err := w.callLLMWithRetry(llmRequest)
		if errors.Is(err, ErrRestartStrategy) {
			continue strategyLoop
		}

		duration := time.Since(startTime)

		w.batcher.Flush()

		// Persist the transaction blob BEFORE any further Yjs mutation. On
		// cancellation, capture whatever partial streaming content existed so
		// the log shows truncated output rather than "No response data".
		errMsg := ""
		blobResponse := response
		if err != nil {
			if errors.Is(err, ErrCancelled) {
				blobResponse = w.partialCancelledResponse()
			} else {
				errMsg = err.Error()
			}
		}
		if blobErr := w.txnStore.SaveBlob(TransactionBlobInput{
			ConversationID: w.conversationID,
			TxnID:          txnID,
			LLMRequest:     llmRequest,
			Response:       blobResponse,
			ErrMsg:         errMsg,
			StartTime:      startTime,
			Duration:       duration,
			ModelConfig:    w.resolveModelConfig(),
		}); blobErr != nil {
			w.log.Error("❌ Failed to save transaction blob: %v", blobErr)
		}

		if err != nil {
			if errors.Is(err, ErrCancelled) {
				w.currentTxnID = ""
				return
			}

			var contextLimit *provider.ContextLimitExceededError
			if errors.As(err, &contextLimit) {
				handled, compactErr := w.tryBoundedCompaction(contextLimit, originalRequest.ModelConfig)
				if handled {
					w.currentTxnID = ""
					if compactErr == nil {
						return
					}
					if errors.Is(compactErr, errBoundedCompactionCancelled) {
						return
					}
					err = fmt.Errorf("bounded compaction failed: %w", compactErr)
				} else if !recoveryAttempted {
					// Ordinary root / subthread turn: summarize the oldest
					// foldable history into the doc, then rebuild and retry the
					// rejected turn once (the loop-top rebuild re-runs admission
					// on the folded request).
					recoveryAttempted = true
					if recErr := w.tryContextRecovery(contextLimit, originalRequest.ModelConfig); recErr != nil {
						if errors.Is(recErr, errBoundedCompactionCancelled) {
							w.currentTxnID = ""
							return
						}
						err = fmt.Errorf("context recovery failed: %w", recErr)
					} else {
						w.currentTxnID = ""
						continue strategyLoop
					}
				}
			}

			w.log.Error("❌ LLM error: %s", err.Error())
			errorData := map[string]any{
				"duration": duration.Milliseconds(),
			}
			if mc := w.resolveModelConfig(); mc != nil {
				errorData["provider"] = mc.Provider
				errorData["model"] = mc.Model
			}
			// currentTxnID is still set, so insertTargetMessage stamps the
			// error item with txnID — the View Transaction button opens the
			// blob saved above.
			w.sendErrorWithData(err.Error(), "", errorData)
			w.currentTxnID = ""
			return
		}

		// Per-turn token economics at Info level so the prompt-cache hit rate is
		// visible in the normal conversation log without enabling trace. cached/
		// input is the prefix-cache hit rate: on an agent loop it should climb
		// toward ~1.0 once routing is pinned (prompt_cache_key). A persistent 0
		// on an OpenAI/Codex model means the growing prefix is being re-billed
		// every turn — the shard-misrouting burn. thread is logged so an
		// interleaved sub-context (its own short prefix, tiny output) is
		// distinguishable from the main task's turns rather than looking like a
		// cache miss on the same conversation.
		hitPct := 0
		if response.InputTokens > 0 {
			hitPct = response.CachedTokens * 100 / response.InputTokens
		}
		w.log.Info("[turn tokens] thread=%q input=%d cached=%d (%d%% hit) output=%d cacheWrite=%d stop=%s in %s",
			w.thread.itemID, response.InputTokens, response.CachedTokens, hitPct,
			response.OutputTokens, response.CacheWriteTokens, response.StopReason,
			duration.Round(time.Millisecond))

		shouldContinue, err := w.processLLMResponse(response)
		w.currentTxnID = ""
		if err != nil {
			if errors.Is(err, ErrCancelled) {
				return
			}
			w.sendError(fmt.Sprintf("Error processing response: %v", err), "")
			return
		}

		// Non-blocking: if async tools or a child thread were created,
		// transition to "awaiting_llm" and let the reducer re-dispatch when
		// the work completes.
		if w.hasIncompleteTools() || w.hasIncompleteThreads() {
			w.batcher.Flush()
			w.transitionToAwaitingLLM()
			return
		}

		w.batcher.Flush()

		// A turn that produced no action (no assistant text, no tool_use)
		// leaves the user with nothing new to see. Some providers
		// intermittently emit empty end_turn for transient reasons; retry
		// up to MaxBarrenTurns with a visible "retrying" status so the UI
		// doesn't look stuck. Only when the cap is hit do we surface the
		// placeholder and exit — otherwise the UI would flip silently to
		// idle, indistinguishable from a stuck spinner.
		if !w.turnProducedAction(response) {
			barrenTurns++
			if barrenTurns >= MaxBarrenTurns {
				w.insertBarrenStallPlaceholder()
				return
			}
			w.sendStatus("retrying", fmt.Sprintf(
				"No response — retrying (%d/%d)", barrenTurns, MaxBarrenTurns))
			w.batcher.Flush()
			continue strategyLoop
		}
		barrenTurns = 0

		// Action happened. Done unless we explicitly need another LLM turn —
		// processLLMResponse returns true only when sync tools fired and the
		// loop must continue so the LLM can react to their results.
		//
		// End-of-run is also a drain boundary: if the user queued a follow-up
		// while this turn ran, promote it and drive another turn instead of
		// going idle (the top-of-loop promote does the actual move).
		if !shouldContinue {
			if w.hasPendingItems(w.thread.itemID) {
				continue strategyLoop
			}
			return
		}
		if response.StopReason == "end_turn" && hasAssistantText(response) {
			if w.hasPendingItems(w.thread.itemID) {
				continue strategyLoop
			}
			return
		}
	}
}

// turnProducedAction reports whether the LLM took any concrete step on
// this turn — emitted assistant text, or called any tool (including sync
// meta tools like return_result). Pure thinking or a literally empty
// stream do NOT count; those mark a barren turn.
func (w *ConversationWorker) turnProducedAction(response *LLMResponse) bool {
	if hasAssistantText(response) {
		return true
	}
	for _, block := range response.Blocks {
		if block.Type == provider.ContentBlockTypeToolUse {
			return true
		}
	}
	return false
}

// insertBarrenStallPlaceholder appends a visible assistant note when the
// strategy loop is about to exit after MaxBarrenTurns iterations that
// produced nothing the user can see. Without this the UI silently flips
// back to idle and is indistinguishable from a stuck spinner.
func (w *ConversationWorker) insertBarrenStallPlaceholder() {
	w.insertTargetMessage(w.getTargetItemsLength(), ConversationItem{
		Type:      ItemTypeAssistant,
		ItemID:    generateItemID(),
		Content:   "_(model returned no further response)_",
		Timestamp: time.Now().Format(time.RFC3339),
	})
}

// callLLMWithRetry calls the LLM with rate-limit retry handling.
// Returns ErrCancelled if the user cancelled, ErrRestartStrategy if a new user
// message arrived during a rate-limit wait (caller must continue strategyLoop).
func (w *ConversationWorker) callLLMWithRetry(req json.RawMessage) (*LLMResponse, error) {
	for attempt := 0; attempt < MaxLLMRetries; attempt++ {
		w.sendStatus("streaming", "")
		w.batcher.Flush()

		response, err := w.callLLM(req)
		if err == nil {
			return response, nil
		}

		var rErr retryableError
		if !errors.As(err, &rErr) || attempt == MaxLLMRetries-1 {
			return nil, err
		}

		wait := rErr.retryWait()
		w.log.Info("Retryable LLM error (%v), retrying in %v (attempt %d/%d)", err, wait, attempt+1, MaxLLMRetries)
		w.sendStatus("retrying", rErr.retryStatus(attempt+1, MaxLLMRetries))
		w.batcher.Flush()

		res := w.waitForRetryDelay(wait)
		if res.Cancelled {
			w.currentTxnID = ""
			return nil, ErrCancelled
		}
		if res.NewMessage {
			w.currentTxnID = ""
			return nil, ErrRestartStrategy
		}

		w.finalizeStreaming()
		w.streaming.textContent = ""
		w.streaming.thinkingContent = ""
	}
	return nil, errors.New("unexpected retry loop exit")
}

// finalizeCancellation handles cleanup when runStrategyLoop exits due to cancellation.
func (w *ConversationWorker) finalizeCancellation(completedThreadID string) {
	w.CancelInFlightToolActions()
	// Stop is a promote-and-idle boundary: keep any queued messages by moving
	// them into the thread as user items (the user reviews/edits, then sends to
	// run) rather than dropping them.
	w.promotePendingItems(completedThreadID)
	// For document-driven threads, needsStrategyRun is a one-shot trigger.
	// If cancellation leaves it set while result is empty, checkForNewThreads
	// would immediately re-run the same thread on the next observer tick.
	if completedThreadID != "" {
		w.clearThreadNeedsStrategyRun(completedThreadID)
	}
	w.sendStatus("idle", "")
}

// signalParentThread notifies a completed child thread's parent to continue its LLM loop.
// Returns true if the parent was signaled, false if no signal was needed.
// Only signals for LLM-created threads (via create_thread tool, llmCreated=true);
// strategy-created threads are observed directly by the browser.
func (w *ConversationWorker) signalParentThread(completedThreadID string) bool {
	if completedThreadID == "" {
		return false
	}
	threadYMap := w.doc.GetThreadYMap(completedThreadID)
	if threadYMap == nil {
		return false
	}
	ycrdtMu.Lock()
	result, _ := threadYMap.Get("result").(string)
	llmCreated, _ := threadYMap.Get("llmCreated").(bool)
	ycrdtMu.Unlock()

	if result == "" || !llmCreated {
		return false
	}
	parentThreadID := w.doc.findParentThreadID(completedThreadID)
	// Release the calling_llm claim before requesting the parent.
	// Without this, requestLLM sees activity="calling_llm" and refuses to set awaiting_llm.
	w.releaseLLM()
	if !w.requestLLM(parentThreadID) {
		return false
	}
	w.needsReconcile = true
	return true
}

// newUserItem builds a user ConversationItem from the inseparable submission
// unit. This is the ONLY constructor of a user item from input — both the
// immediate send (addUserMessage) and the queued "type while busy" path
// (enqueuePendingMessage) route through it — so the text and its attachments
// can never be split apart on the way into the doc. Empty attachments serialize
// to no "attachments" key (conversationItemToYMap omits empty slices), so a
// plain text message stays byte-identical to the legacy shape.
func newUserItem(input UserMessageInput) ConversationItem {
	return ConversationItem{
		Type:        ItemTypeUser,
		ItemID:      generateItemID(),
		Content:     input.Text,
		Timestamp:   time.Now().Format(time.RFC3339),
		Attachments: input.Attachments,
		TaskSource:  input.TaskSource,
	}
}

// addUserMessage appends a user message (text + attachments, as one unit) to
// the current target (root or thread).
func (w *ConversationWorker) addUserMessage(input UserMessageInput) {
	w.insertTargetMessage(w.getTargetItemsLength(), newUserItem(input))
}

// findUnstampedUserMsgID returns the ItemID of the trailing user message in
// the current target (root or thread) if it lacks a TransactionID, otherwise
// "". Walks backward from the end and stops as soon as it sees an item that
// either is non-user or already has a transactionId — only the most recent
// user submission needs stamping for the round-trip about to begin.
func (w *ConversationWorker) findUnstampedUserMsgID() string {
	items := w.getTargetItems()
	for i := len(items) - 1; i >= 0; i-- {
		it := items[i]
		if it.Type != ItemTypeUser {
			continue
		}
		if it.TransactionID != "" {
			return ""
		}
		return it.ItemID
	}
	return ""
}

// callLLM calls the LLM provider directly and waits for response.
// Chunks are streamed via the worker's Send method for UI updates.
// In mock mode, returns the next scripted response instead of calling real LLM.
func (w *ConversationWorker) callLLM(request json.RawMessage) (*LLMResponse, error) {
	return w.callLLMWithSink(request, w.queueStreamChunk)
}

// callLLMWithSink is the transport primitive shared by visible turns and hidden
// worker operations. A nil sink discards stream chunks while preserving the
// normal server/cache/provider/admission path and cancellation semantics.
func (w *ConversationWorker) callLLMWithSink(request json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
	if w.mock != nil {
		return w.callLLMMockWithSink(sink)
	}

	if w.llmCallFunc == nil {
		return nil, fmt.Errorf("LLM caller not configured")
	}

	// Reset the wake-interrupt flag for this attempt so a wake that fired
	// during a previous turn can't be misattributed to this call's error.
	w.llmWakeInterrupt.Store(false)

	// Drain any stale response left by a previously-cancelled call.
	select {
	case <-w.llmResponseChan:
	default:
	}

	ctx, cancel := context.WithCancel(context.Background())
	w.llmCancelFunc.Store(&cancel)
	defer w.llmCancelFunc.Store(nil)

	go func() {
		defer cancel()
		response, err := w.llmCallFunc(ctx, request, func(chunk StreamChunk) {
			if sink != nil {
				sink(chunk)
			}
		})
		w.deliverLLMResponse(response, err)
	}()

	response, err := w.waitForLLMResponse(LLMTimeout)
	if err != nil {
		var delivered *deliveredLLMError
		if !errors.As(err, &delivered) {
			return nil, err
		}
		// A system-wake cancelled this call: the connection was dropped while
		// the machine slept. Surface a clear, retryable message instead of the
		// provider's raw "context canceled".
		if w.llmWakeInterrupt.Load() {
			return nil, fmt.Errorf("LLM request interrupted: the system resumed from sleep and the connection was dropped — please resend")
		}
		return nil, classifyLLMError(err.Error(), err)
	}

	if response.Error != "" {
		return nil, classifyLLMError(response.Error, nil)
	}

	return response, nil
}

// classifyLLMError retains legacy message-based rate-limit and transient
// classification while preserving an in-process provider error as the cause.
// Wire and scripted responses have no concrete cause and continue to use their
// LLMResponse.Error text.
func classifyLLMError(msg string, cause error) error {
	switch {
	case isRateLimitMsg(msg):
		return &RateLimitError{Wait: parseRetryWaitFromMsg(msg), Message: "LLM error: " + msg, Cause: cause}
	case isTransientMsg(msg):
		return &TransientError{Wait: TransientRetryWait, Message: "LLM error: " + msg, Cause: cause}
	case cause != nil:
		return fmt.Errorf("LLM error: %w", cause)
	default:
		return fmt.Errorf("LLM error: %s", msg)
	}
}

// processLLMResponse handles the LLM response blocks.
// Returns true if the strategy loop should continue.
//
// IMPORTANT: Text and thinking blocks are NOT processed here. They are added
// during streaming via processStreamChunk. The blocks array contains raw
// chunks (one per streamed piece), not merged content blocks, so we cannot
// match them reliably.
func (w *ConversationWorker) processLLMResponse(response *LLMResponse) (bool, error) {
	var toolUseBlocks []LLMResponseBlock
	for _, block := range response.Blocks {
		switch block.Type {
		case provider.ContentBlockTypeText, provider.ContentBlockTypeThinking:
			// Already added during streaming via processStreamChunk.
			continue
		case provider.ContentBlockTypeToolUse:
			toolUseBlocks = append(toolUseBlocks, block)
		}
	}

	if len(toolUseBlocks) == 0 {
		return false, nil
	}

	// Categorize and execute tools:
	//   Meta tools    → no tool-action, execute in worker (return_result, drop_context_items)
	//   create_thread → creates thread item, returns immediately (reducer dispatches child)
	//   Async tools   → tool-action created, browser executes (bash, glob, etc.)
	// Assistant prose emitted on this same turn — the fallback source for a
	// return_result call whose argument is empty or mis-named (the model wrote
	// its summary as text and called the tool with nothing useful).
	turnText := assistantResponseText(response)

	hasAsyncTools := false
	for _, block := range toolUseBlocks {
		if isMetaTool(block.Name) {
			if err := w.executeMetaTool(block.ID, block.Name, block.Input, turnText); err != nil {
				w.log.Error("Meta tool execution failed: %v", err)
			}
			continue
		}

		// create_thread: creates thread item + user message, returns
		// immediately. hasIncompleteThreads triggers awaiting_llm. The
		// toolUseID/toolName/toolInput are stamped onto the thread item so
		// buildMessages can reconstruct the assistant tool_use + user
		// tool_result pair on the parent's next turn — without this the
		// parent LLM has no record that it spawned a thread and re-does the work.
		if block.Name == "create_thread" {
			if err := w.executeCreateThread(block.ID, block.Name, block.Input); err != nil {
				w.log.Error("Thread creation failed: %v", err)
			}
			continue
		}

		// Delegating tool: ask the engine to build a subthread spec. A spec
		// spawns a delegated child (parked like create_thread — its
		// return_result becomes this tool_use's result); a null/timeout falls
		// through to the ordinary client-side tool-action below.
		if w.tryDelegateTool(block.ID, block.Name, block.Input) {
			continue
		}

		w.addToolAction(block.ID, block.Name, block.Input, block.Metadata)
		hasAsyncTools = true
	}

	if hasAsyncTools {
		// This turn produced tool-actions that the engine (the single tool
		// executor) must run. Command it: driveToolActions pushes the doc state
		// and dispatches evaluate-tool / execute-tool for each non-terminal
		// tool-action, rather than relying on the engine to auto-load on an
		// incidental sync (racy → the "tools stuck" wedge).
		w.driveToolActions()
	}

	if !hasAsyncTools {
		// If return_result was called in a thread, stop the loop.
		if w.thread.itemID != "" {
			if ymap := w.doc.GetThreadYMap(w.thread.itemID); ymap != nil {
				if result, _ := ymap.Get("result").(string); result != "" {
					return false, nil
				}
			}
		}
		return true, nil
	}

	return true, nil
}

func (w *ConversationWorker) addToolAction(toolUseID, toolName string, toolInput json.RawMessage, metadata map[string]any) {
	w.log.Tool(toolName, toolSummary(toolName, toolInput))
	msg := ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    generateItemID(),
		ToolUseID: toolUseID,
		ToolName:  toolName,
		ToolInput: toolInput,
		// State is left undefined (= needs evaluation): the frontend determines
		// whether approval is needed based on the plugin manifest.
		Timestamp:    time.Now().Format(time.RFC3339),
		ProviderData: metadata,
	}
	w.insertTargetMessage(w.getTargetItemsLength(), msg)
}

// assistantResponseText concatenates the text blocks of a response into a
// single string (blocks joined by newlines), skipping empties. Used as the
// fallback result for a return_result call that carried no usable argument.
func assistantResponseText(response *LLMResponse) string {
	var b strings.Builder
	for _, block := range response.Blocks {
		if block.Type == provider.ContentBlockTypeText && block.Content != "" {
			if b.Len() > 0 {
				b.WriteString("\n")
			}
			b.WriteString(block.Content)
		}
	}
	return b.String()
}

// hasAssistantText reports whether the response carries any non-empty text
// block (as opposed to only thinking / tool_use blocks).
func hasAssistantText(response *LLMResponse) bool {
	for _, block := range response.Blocks {
		if block.Type == provider.ContentBlockTypeText && block.Content != "" {
			return true
		}
	}
	return false
}

// addThinkingMessage adds a thinking message to the conversation for UI feedback.
func (w *ConversationWorker) addThinkingMessage(text string) {
	msg := ConversationItem{
		Type:      ItemTypeThinking,
		ItemID:    generateItemID(),
		Content:   text,
		Timestamp: time.Now().Format(time.RFC3339),
	}
	w.insertTargetMessage(w.getTargetItemsLength(), msg)
}

// addMetaToolResult adds a meta tool result to the conversation for LLM context.
func (w *ConversationWorker) addMetaToolResult(toolUseID, toolName string, toolInput json.RawMessage, content string, isError bool) {
	result := map[string]any{
		"content": content,
		"isError": isError,
	}
	resultJSON, _ := json.Marshal(result)

	msg := ConversationItem{
		Type:      ItemTypeMetaToolResult,
		ItemID:    generateItemID(),
		ToolUseID: toolUseID,
		ToolName:  toolName,
		ToolInput: toolInput,
		Result:    resultJSON,
		IsError:   isError,
		Timestamp: time.Now().Format(time.RFC3339),
	}
	w.insertTargetMessage(w.getTargetItemsLength(), msg)
}

// =============================================================================
// ID GENERATION
// =============================================================================

var idCounter atomic.Int64

// IDs carry a fixed-width counter so the estimated size of a request envelope
// is stable for a given logical request: admission packing, budget preflight,
// and dispatch each regenerate IDs, and an unpadded counter changes the
// estimate by a token whenever it crosses a power of ten.
func generateItemID() string {
	id := idCounter.Add(1)
	return fmt.Sprintf("msg_%d_%09d", time.Now().UnixMilli(), id)
}

func generateRequestID() string {
	id := idCounter.Add(1)
	return fmt.Sprintf("req_%d_%09d", time.Now().UnixMilli(), id)
}

func generateTransactionID() string {
	id := idCounter.Add(1)
	return fmt.Sprintf("txn_%d_%09d", time.Now().UnixMilli(), id)
}

// toolSummary extracts a concise one-line summary from tool input JSON for the
// debug tool-log line. It is deliberately tool-agnostic: rather than hardcoding
// JS-plugin tool names in Go, it probes a small set of common input keys in
// priority order, then falls back to a count for batch/array-valued inputs.
func toolSummary(_ string, input json.RawMessage) string {
	var m map[string]any
	if err := json.Unmarshal(input, &m); err != nil {
		return ""
	}

	truncate := func(s string, max int) string {
		if len(s) <= max {
			return s
		}
		return s[:max] + "…"
	}

	// Probe common single-value string keys in priority order (file ops,
	// bash, glob/grep/search, web tools, thread/plan).
	for _, key := range []string{"file_path", "command", "pattern", "query", "url", "goal", "title", "path"} {
		if v, ok := m[key].(string); ok && v != "" {
			return truncate(v, 80)
		}
	}

	// Fall back to a count for array-valued batch inputs.
	for _, key := range []string{"searches", "files", "edits"} {
		if arr, ok := m[key].([]any); ok {
			return fmt.Sprintf("%d %s", len(arr), key)
		}
	}

	return ""
}
