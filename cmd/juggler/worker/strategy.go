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

	"juggler/cmd/juggler/providers/provider"
)

// Strategy loop constants
const (
	// MaxBarrenTurns caps consecutive turns where the LLM emitted no
	// user-visible content (no assistant text, no tool_use) before we
	// give up and surface a placeholder. Each loop iteration is a full
	// round-trip, so this bounds both latency and cost when the model
	// gets stuck thinking-only or the provider returns an empty stream.
	MaxBarrenTurns = 3
	MaxLLMRetries  = 3
	ContextTimeout = 30 * time.Second

	// MaxLLMRetryWindow caps the total wall-clock time a retry sequence may
	// spend failing before the error is surfaced instead of retried again.
	// MaxLLMRetries alone bounds only the COUNT, and an attempt is not cheap:
	// a provider that runs its own internal backoff ladder (the claude CLI
	// against an overloaded upstream) can take minutes to report a single
	// failure, so three attempts could burn a quarter of an hour with the user
	// watching a spinner. Retries exist to paper over a blip; once this much
	// time has gone, the outage is not a blip and the user deserves to be told.
	MaxLLMRetryWindow = 5 * time.Minute

	// LLMTimeout is a coarse wall-clock backstop on one waitForLLMResponse,
	// NOT the primary stream-liveness guard. Liveness lives at the provider
	// boundary: every streaming provider arms an idle watchdog
	// (utils.EffectiveStreamIdleTimeout of silence, the claude CLI included)
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
func (r *run) runStrategyLoop(userText string, isContinuation bool) {
	r.runStrategyLoopWithIntent(userText, isContinuation, false)
}

func (r *run) runStrategyLoopWithIntent(userText string, isContinuation, explicitContinuation bool) {
	defer r.finishStrategyRun()
	// Deferred second so it runs first: a panicked run is made a failed one
	// before finishStrategyRun settles it (turn_panic.go).
	defer r.recoverTurnPanic()

	// Clear any stale streaming state from previous conversation turn
	r.finalizeStreaming()

	// Add user message if a caller passed one in directly (test helper path).
	// Production sends arrive via handleSendMessage which inserts the user
	// message before signalling the reducer; in that case userText is empty
	// and the trailing user item is found by findUnstampedUserMsgID below.
	if !isContinuation && userText != "" {
		r.addUserMessage(UserMessageInput{Text: userText})
		r.batcher.Flush() // Show user message in UI immediately
	}

	st := strategyRunState{}

	for {
		if r.runOneTurn(&st, explicitContinuation) == turnDone {
			return
		}
		explicitContinuation = false
	}
}

// turnVerdict is how runOneTurn tells runStrategyLoop what to do next. Every
// exit from a turn is one of exactly two things — run another turn, or end the
// run — so the caller needs no other signal to drive the loop.
type turnVerdict int

const (
	// turnContinue asks for another LLM turn in the same run.
	turnContinue turnVerdict = iota
	// turnDone ends the run; finishStrategyRun then settles it.
	turnDone
)

// strategyRunState is the bookkeeping that outlives a single turn but belongs to
// one strategy run, carried across iterations by runStrategyLoop.
type strategyRunState struct {
	// barrenTurns counts consecutive turns that produced nothing user-visible,
	// reset by any turn that does. Capped by MaxBarrenTurns.
	barrenTurns int
	// compaction bounds one context-pressure incident; a successful dispatch
	// clears it so a later overflow gets a fresh budget.
	compaction compactionAttempts
	// bypassContextGuard skips the pre-flight ceiling for the next attempt
	// only, after an overflow verdict asked to retry without it.
	bypassContextGuard bool
}

// runOneTurn runs a single pass of the strategy loop: promote queued messages,
// gather context and tools, call the LLM, persist the transaction blob, then
// process the response. It returns turnContinue when the run needs another LLM
// turn and turnDone when the run is over (rest, error or cancellation) — the
// caller returns immediately on turnDone and finishStrategyRun settles it.
func (r *run) runOneTurn(st *strategyRunState, explicitContinuation bool) turnVerdict {
	// Polite stop (Pause): every LLM turn begins here, so this is the boundary
	// where we rest before re-invoking the model. It catches every re-entry a
	// mid-turn pause can precede — a sync-tool continuation, a barren retry, and
	// the end-of-run "queued follow-up" continuation. In-flight tools from the
	// prior turn are already committed to the doc, so promoting any queued
	// messages and ending the run leaves a clean, resumable transcript;
	// finishStrategyRun writes idle. The mark is left standing — only a human
	// lifts one — which is also what stops this run's clean settlement
	// re-driving its parent through signalParentThread: the parent's own dispatch
	// asks the same question and rests too. The reducer's dispatchCallLLMOnThread
	// handles the between-turn (async-tool) case; this handles the case where the
	// run never returned to the reducer at all.
	if r.politeStopCovers(r.t.thread.itemID) {
		r.promotePendingItems(r.t.thread.itemID)
		r.t.politelyStopped = true
		return turnDone
	}

	// A browser-folded /compact (or /handoff) thread is summarized by the
	// bounded reducer, not an ordinary strategy turn.
	if verdict, handled := r.runFoldedCompactionTurn(); handled {
		return verdict
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
	r.promotePendingItems(r.t.thread.itemID)

	// Bind the turn budget to the run this turn belongs to before anything reads
	// it: a boundary carrying a count from a run that has since ended starts over
	// here, which is what keeps the budget per-run without a reset call site at
	// every way a run can end.
	r.syncRunBudget()

	// A leaf child nearing or past its run budget is told so before this turn's
	// context is gathered, so the notice is IN the request it governs — the one
	// whose tool calls will be refused (processLLMResponse) — rather than arriving
	// a turn later to explain a turn that already went wrong. Placed after the
	// promotion above so it lands at the end of the transcript, behind anything
	// the user just sent. A no-op for every thread the budget does not govern.
	r.announceRunBudgetSpent()

	// The conversation's spend ceiling lands the same way, at the same boundary,
	// on the same kind of thread: a delegated run past the ceiling is told so
	// here and has its tool calls refused, so this turn is its report. Separate
	// from the run budget because they bound different things — one run's length
	// versus everything this conversation has spent — and a child well inside its
	// run budget is exactly who a runaway fan-out is made of.
	r.announceSpendCeiling()

	userMsgToStamp := r.findUnstampedUserMsgID()

	// Fire the strategy's onActivate hook (in the engine) if the active
	// strategy hasn't been activated yet. Placed AFTER promotePendingItems so
	// the just-sent user message is already in the items array — the engine's
	// injected guidance then lands deterministically after it, not racing the
	// promotion. Blocks until the guidance has synced back, so buildMessages
	// sees it. Idempotent across iterations (activatedStrategyId gate).
	r.maybeActivateStrategy()

	// Reset streaming state for this iteration — must reset message IDs
	// AND content so each iteration creates new messages rather than
	// updating previous ones. The usage measurement goes with them: it
	// describes the call that just ended, not the one about to be made.
	r.finalizeStreaming()
	r.resetStreamingText()
	r.resetStreamingThinking()
	r.resetStreamingUsage()

	if r.loadState() == StateCancelling {
		return turnDone
	}

	// A thread deleted after it was queued has no transcript and no context left
	// to send; a request built for it carries no messages and no system prompt.
	// Every dispatcher (the reducer, the pending-request orchestrator, the
	// needsStrategyRun pickup) reaches the provider through here.
	if r.t.thread.itemID != "" && r.doc.GetThreadYMap(r.t.thread.itemID) == nil {
		return turnDone
	}

	r.sendStatus("preparing", "")
	r.batcher.Flush()

	ctxResult, tools, err := r.requestContextAndTools()
	if err != nil {
		if errors.Is(err, ErrCancelled) {
			return turnDone
		}
		r.sendError(fmt.Sprintf("Failed to get context/tools: %v", err), "")
		return turnDone
	}

	// Apply the worker's thread gate before recording the exact capabilities
	// sent to the provider. The same filtered slice builds the request, so a
	// hallucinated or withheld tool cannot later reach the full engine registry.
	tools = r.filterToolsForThread(tools)
	r.t.offeredTools = collectOfferedToolNames(tools)

	// Remember which of this turn's offered tools may delegate to a subthread,
	// so processLLMResponse can route a call to the build-spec round-trip.
	// Whether delegation is actually available is decided at the point of use.
	r.t.delegatingTools = collectDelegatingTools(tools)

	// txnID identifies this round-trip; appendTargetMessage stamps it onto
	// every item produced during the call so callers don't plumb it through.
	txnID := generateTransactionID()
	r.t.txnID = txnID

	llmRequest := r.buildLLMRequestWithIntent(ctxResult, tools, txnID, st.bypassContextGuard, explicitContinuation)

	// Stamp the originating user message before the call. The transaction
	// blob is written below regardless of outcome, so on LLM failure the
	// user message + error item both link to a viewable blob.
	if userMsgToStamp != "" {
		_ = r.updateTargetItemByID(userMsgToStamp, "transactionId", txnID)
	}

	startTime := time.Now()

	response, err := r.callLLMWithRetry(llmRequest)
	if errors.Is(err, ErrRestartStrategy) {
		return turnContinue
	}
	// A pause abandoned the backoff before any request went out. Like the restart
	// above this leaves no transaction to save — the attempt that failed already
	// saved its own — so the turn simply ends and finishStrategyRun settles it.
	if errors.Is(err, ErrPolitelyStopped) {
		r.promotePendingItems(r.t.thread.itemID)
		r.t.politelyStopped = true
		return turnDone
	}

	duration := time.Since(startTime)

	r.batcher.Flush()

	r.recordTurnTransaction(txnID, llmRequest, response, err, startTime, duration)

	if err != nil {
		return r.handleTurnFailure(st, err, llmRequest, duration)
	}

	st.bypassContextGuard = false
	// A successful dispatch closes this context-pressure incident: a later
	// overflow in the same (possibly very long) strategy run gets a fresh
	// bounded recovery budget instead of inheriting an exhausted one. This
	// cannot loop — re-entering recovery still takes a fresh provider
	// overflow, and each incident stays progress-checked and bounded.
	st.compaction = compactionAttempts{}

	// Per-turn token economics at Info level; turnTokensLine says how to read it.
	r.log.Info("%s", turnTokensLine(r.t.thread.itemID, response, duration))

	// One completed round-trip is charged to this run's budget, turn and tokens.
	// Charged here because here is where a turn is known to have HAPPENED: the
	// request went out, the provider answered, and the tokens above were spent.
	// Counting at the top of a turn would charge for attempts that never reached
	// a provider, and counting after processLLMResponse would miss the turns that
	// end in one.
	r.noteRunTurn(response)

	shouldContinue, err := r.processLLMResponse(response)
	r.t.txnID = ""
	if err != nil {
		if errors.Is(err, ErrCancelled) {
			return turnDone
		}
		r.sendError(fmt.Sprintf("Error processing response: %v", err), "")
		return turnDone
	}

	return r.settleTurn(st, response, shouldContinue)
}

// recordTurnTransaction persists one round-trip's transaction blob and charges
// it to the conversation's spend, whatever the outcome. It runs BEFORE any
// further Yjs mutation, so every item the turn goes on to write can link to it.
func (r *run) recordTurnTransaction(txnID string, llmRequest json.RawMessage, response *LLMResponse, err error, startTime time.Time, duration time.Duration) {
	// Persist the transaction blob BEFORE any further Yjs mutation. On
	// cancellation, capture whatever partial streaming content existed so
	// the log shows truncated output rather than "No response data".
	errMsg := ""
	blobResponse := response
	if err != nil {
		if errors.Is(err, ErrCancelled) {
			blobResponse = r.partialCancelledResponse()
		} else {
			errMsg = err.Error()
		}
	}
	if blobErr := r.txnStore.SaveBlob(TransactionBlobInput{
		ConversationID: r.conversationID,
		TxnID:          txnID,
		LLMRequest:     llmRequest,
		Response:       blobResponse,
		ErrMsg:         errMsg,
		StartTime:      startTime,
		Duration:       duration,
		ModelConfig:    r.resolveModelConfig(),
	}); blobErr != nil {
		r.log.Error("❌ Failed to save transaction blob: %v", blobErr)
	}

	// Charge this round-trip to the conversation's running total, against the
	// same response the blob records — so a turn the user cancelled, which the
	// provider billed all the same, is counted rather than quietly dropped.
	r.recordTurnSpend(blobResponse)
}

// settleTurn decides what follows a turn whose response has been processed:
// wait for async work, surface a truncation or refusal, retry a barren turn, or
// end the run unless the loop has something left to react to.
func (r *run) settleTurn(st *strategyRunState, response *LLMResponse, shouldContinue bool) turnVerdict {
	// Non-blocking: if async tools or a child thread were created,
	// transition to "awaiting_llm" and let the reducer re-dispatch when
	// the work completes.
	if r.hasIncompleteTools() || r.hasIncompleteThreads() {
		r.batcher.Flush()
		r.transitionToAwaitingLLM()
		return turnDone
	}

	r.batcher.Flush()

	// A turn the provider cut off at its output budget is not a blank turn,
	// and must never be retried as one: the retry re-sends the same request
	// against the same budget and is cut off at the same place, three times
	// over, before the barren cap papers it over as "no further response".
	// Worse, each round's thinking is persisted and replayed, so every attempt
	// starts nearer the limit than the last. Surface it once, here, naming the
	// budget that ended it.
	if response.StopReason == provider.StopReasonMaxTokens {
		r.insertTruncationNotice(response)
		r.batcher.Flush()
		// Truncated before it emitted anything usable: there is nothing to
		// react to and nothing a further turn could add, so rest.
		if !r.turnProducedAction(response) {
			return turnDone
		}
	}

	// A refusal is a decision, not a blank turn. It arrives as a 200 whose turn
	// may carry no text at all, which is indistinguishable by shape from the
	// barren case below — so without this the same request is re-sent and
	// refused three times over, each round billed, before the barren cap files a
	// deliberate answer under "no further response". The provider already
	// composed the notice naming the policy area, so resting is all that is left.
	if response.StopReason == provider.StopReasonRefusal {
		r.batcher.Flush()
		if !r.turnProducedAction(response) {
			return turnDone
		}
	}

	// A turn that produced no action (no assistant text, no tool_use)
	// leaves the user with nothing new to see. Some providers
	// intermittently emit empty end_turn for transient reasons; retry
	// up to MaxBarrenTurns with a visible "retrying" status so the UI
	// doesn't look stuck. Only when the cap is hit do we surface the
	// placeholder and exit — otherwise the UI would flip silently to
	// idle, indistinguishable from a stuck spinner.
	if !r.turnProducedAction(response) {
		st.barrenTurns++
		if st.barrenTurns >= MaxBarrenTurns {
			r.insertBarrenStallPlaceholder()
			return turnDone
		}
		r.sendStatus("retrying", fmt.Sprintf(
			"No response — retrying (%d/%d)", st.barrenTurns, MaxBarrenTurns))
		r.batcher.Flush()
		return turnContinue
	}
	st.barrenTurns = 0

	// Action happened. Done unless we explicitly need another LLM turn —
	// processLLMResponse returns true only when sync tools fired and the
	// loop must continue so the LLM can react to their results.
	//
	// End-of-run is also a drain boundary: if the user queued a follow-up
	// while this turn ran, promote it and drive another turn instead of
	// going idle (the next turn's promotePendingItems does the actual move).
	if !shouldContinue {
		if r.hasPendingItems(r.t.thread.itemID) {
			return turnContinue
		}
		return turnDone
	}
	if response.StopReason == provider.StopReasonEndTurn && hasAssistantText(response) {
		if r.hasPendingItems(r.t.thread.itemID) {
			return turnContinue
		}
		return turnDone
	}
	return turnContinue
}

// finishStrategyRun settles the run a strategy loop just finished, whatever the
// ending: rest, error or cancellation. Deferred by runStrategyLoop so no exit
// path can skip it and strand a stamped tool_use unpaired.
func (r *run) finishStrategyRun() {
	// Anything the provider emitted after the last wait loop returned is still
	// sitting in this run's chunk buffer, and this run is the only reader it will
	// ever have. Fold it in before the run settles.
	r.drainStreamChunks()

	// Non-blocking: if the loop returned after dispatching tools or
	// creating a child thread, THIS thread is left awaiting_llm — let the reducer
	// dispatch the child. requestReconcile hands that pass to the run() loop, so
	// the child's turn starts on a fresh iteration rather than underneath this
	// one.
	// Asked of the turn's own thread: a sibling parked awaiting dispatch is not
	// evidence that this run has work outstanding.
	if r.threadActivity(r.t.thread.itemID) == ActivityAwaitingLLM {
		r.storeState(StateIdle)
		r.requestReconcile()
		return
	}

	// A run stopped by a Pause is not finished — it is paused. It keeps its open
	// run record, so a caller parked on it stays parked and nothing downstream is
	// re-driven: settling here would report an answer the thread was stopped
	// before giving, and hand its parent (via signalParentThread) exactly the
	// fresh turn the pause exists to prevent. Nothing is stamped Interrupted
	// either. The thread is left as it stands, ready to carry on when the pause is
	// lifted. The idle frame goes out with this run's thread context intact, so it
	// drops only this thread's claim and leaves a parked parent's alone.
	if r.t.politelyStopped {
		r.t.politelyStopped = false

		// A fold is the one thread whose "carry on when the pause lifts" is not
		// free. Its run is licensed by needsStrategyRun, a one-shot the pickup
		// consumed on the way in, and the reducer's walk offers nothing to a thread
		// whose last item is the summarization prompt — so a fold paused mid-summary
		// would sit there with no summary and no way to ask for one. Re-arm the
		// trigger it spent, which is what handleUnpause offers to the pickup again.
		if r.t.thread.itemID != "" && r.isBoundedCompactionThread(r.t.thread.itemID) &&
			!r.threadHasResult(r.t.thread.itemID) {
			r.setThreadNeedsStrategyRun(r.t.thread.itemID)
		}

		r.storeState(StateIdle)
		r.releaseLLM(r.t.thread.itemID)
		r.sendStatus("idle", "")
		r.t.processingStartedAt.Store(0)
		r.t.approvalWaitStartedAt.Store(0)
		r.t.lastProgressWriteMs = 0
		r.t.lastCacheMissNotice = ""
		r.resetThreadContext()
		return
	}

	wasCancelled := r.loadState() == StateCancelling
	completedThreadID := r.t.thread.itemID // capture before clearing

	// The run this loop just ran is over: record how it came out. This is
	// the completion signal a parked caller waits on, and the source of the
	// tool_result a delegating call is owed, so it runs at EVERY ending —
	// rest, error and cancellation alike — and never leaves a stamped
	// tool_use unpaired. Run BEFORE clearing state so the Y.Map read can
	// find the items.
	if completedThreadID != "" {
		r.settleThreadRun(completedThreadID, wasCancelled)
	}

	r.storeState(StateIdle)
	// The thread context is cleared before parent/sibling settlement below. Release
	// this run's own doc claim first; a later root-scoped idle frame must not be
	// responsible for finding it, since idle preserves siblings.
	r.releaseLLM(completedThreadID)
	r.t.processingStartedAt.Store(0)
	r.t.approvalWaitStartedAt.Store(0)
	r.t.lastProgressWriteMs = 0
	r.t.lastCacheMissNotice = ""
	r.resetThreadContext()

	if wasCancelled {
		r.finalizeCancellation(completedThreadID)
		return
	}

	// signalParentThread fires for a child whose run has settled, whatever it
	// settled as: the parent asked a question and is owed the answer, and
	// "the run errored" is an answer it can act on. The child stays exactly
	// as it is — stopped, summarised or not, and free to run again.
	if !r.signalParentThread(completedThreadID) {
		// The run that just ended may not be the whole story: sibling or cousin
		// llmCreated runs can still be open, because this branch is also where a
		// child nobody is waiting on ends — a strategy-created or compaction
		// thread, neither of which is llmCreated. Publishing idle here would be a
		// lie the document's readers act on: isTurnActive() reads exactly this
		// field, so a turn-end scheduled send fires on it. Nothing would correct
		// it until the reducer's next tick dispatched the remaining work, and that
		// tick needs no user event to wait for — the window is as long as the
		// sibling takes to be picked up.
		//
		// Hand the claim to an open sibling instead, exactly as signalParentThread
		// hands it to a parent: the reducer's walk-down dispatches that run, and
		// when the last one settles, its own finishStrategyRun publishes the
		// resting idle. Guarded on completedThreadID != "" so this fires only for a
		// sub-thread completion, mirroring the root-queue drain below; a root turn
		// that rests with children still open is the awaiting_llm case handled at
		// the top of this function.
		if completedThreadID != "" {
			if openID := r.doc.firstLiveThreadID(completedThreadID); openID != "" {
				r.releaseLLM(completedThreadID)
				// If the claim can't be taken (another request already pending),
				// fall through and publish idle rather than returning with no
				// status written at all — a doc left mid-turn with nothing driving
				// it never rests, and never fires the send this guard protects.
				if r.requestLLM(openID) {
					r.requestReconcile()
					return
				}
			}
		}

		// The idle frame below is published with this run's thread context already
		// cleared, so it drops the ROOT entry — and a thread queued while this one
		// held the loop may be exactly the root: a message typed there while a
		// compaction thread summarized would lose its dispatch and sit unanswered
		// under an idle conversation. Read the marker before resting and re-raise
		// it after, the same shape the pending-queue drain below uses. Only for a
		// thread that still exists: a marker left by a deleted thread is stale.
		queuedID, requeue := r.queuedThreadIDExcept(completedThreadID)
		if requeue && queuedID != "" && r.doc.GetThreadYMap(queuedID) == nil {
			requeue = false
		}

		r.sendStatus("idle", "")
		// Scoped to the run that just ended: its own leftovers are stale, a
		// sibling's are not. Unscoped, a sub-thread coming to rest would stamp
		// "Interrupted" on every live tool in the conversation.
		r.CancelStaleToolActions(completedThreadID)

		if requeue {
			r.requestLLM(queuedID)
			r.requestReconcile()
			return
		}

		// A completed sub-thread folds back into the root conversation. If
		// the user queued a message at the ROOT while the sub-thread ran —
		// e.g. typed a follow-up during /compact — nothing is left to drain
		// that queue: the loop that just ended was scoped to the sub-thread,
		// so its end-of-run drain only checked the sub-thread's own queue,
		// and signalParentThread declined to re-drive the parent (this
		// branch, because a needsStrategyRun/compaction thread is not
		// llmCreated). Without this the message is stranded in the pending
		// queue and the conversation rests at idle. Drive a fresh root turn to
		// promote and answer it (the dispatched turn's promotePendingItems does
		// the actual move). The sendStatus("idle") above already collapsed any
		// compaction undo-merge and closed the capture window — so this follow-up
		// becomes its own undo group — and cleared the LLM claim, so requestLLM
		// can transition from none.
		// Mirrors the reducer's ActionGoIdle drain. Guarded on
		// completedThreadID != "" so it fires ONLY for a sub-thread
		// completion — a root turn drains its own queue inside the loop (the
		// end-of-run turnContinue), never here.
		if completedThreadID != "" && r.hasPendingItems("") {
			r.requestLLM("")
			r.requestReconcile()
			return
		}

		// Nothing compaction-related happens here. Automatic compaction is an
		// admission ceiling evaluated before every dispatch (see
		// provider.DefaultContextCeilingFraction), so it fires while a turn is
		// still running — including between its tool calls — rather than after
		// the conversation has settled, when a summary can no longer help the
		// work it summarizes.

		// Root conversation went idle — let the strategy drive any
		// post-idle work (e.g. plan execution) in the engine. Fire-and-
		// forget: its effects re-enter via doc sync + reconcile.
		r.dispatchWorkerIdleHook()

		// Same idle moment, one call per completed turn: let every
		// context-item type run its onTurnEnd hook in the engine (e.g. an
		// extension retaining a memory of the turn). Fire-and-forget; the
		// hook's effects are external side-effects, not doc writes.
		r.dispatchContextTurnHook()
	} else {
		r.requestReconcile()
	}
}

// turnProducedAction reports whether the LLM took any concrete step on
// this turn — emitted assistant text, or called any tool (including sync
// meta tools like drop_context_items). Pure thinking or a literally empty
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
func (r *run) insertBarrenStallPlaceholder() {
	r.appendTargetMessage(ConversationItem{
		Type:      ItemTypeAssistant,
		ItemID:    generateItemID(),
		Content:   "_(model returned no further response)_",
		Timestamp: time.Now().Format(time.RFC3339),
	})
}

// callLLMWithRetry calls the LLM with rate-limit retry handling.
// Returns ErrCancelled if the user cancelled, ErrRestartStrategy if a new user
// message arrived during a rate-limit wait (caller must continue strategyLoop).
//
// Retries are bounded twice over: by MaxLLMRetries (how many) and by
// MaxLLMRetryWindow (how long in total). The second bound is the load-bearing
// one whenever a single attempt is expensive.
func (r *run) callLLMWithRetry(req json.RawMessage) (*LLMResponse, error) {
	for attempt := 0; attempt < MaxLLMRetries; attempt++ {
		// Only the first attempt claims to be receiving. A retry keeps the
		// "retrying" spinner until real content arrives (clearRetryingStatus),
		// because the fresh attempt may itself spend minutes inside the
		// provider's own backoff before producing anything.
		if attempt == 0 {
			r.sendStatus("streaming", "")
		}
		r.batcher.Flush()

		attemptStart := time.Now()
		response, err := r.callLLM(req)
		if err == nil {
			r.resetLLMRetryBudget()
			return response, nil
		}

		// Only time spent FAILING is charged to the budget, so a long healthy
		// turn followed by a single blip still gets its full allowance.
		r.t.retrySpent += time.Since(attemptStart)

		var rErr retryableError
		if !errors.As(err, &rErr) || attempt == MaxLLMRetries-1 {
			r.resetLLMRetryBudget()
			return nil, err
		}

		if r.t.retrySpent >= MaxLLMRetryWindow {
			r.log.Info("Retryable LLM error (%v), but %v has already gone on retries (budget %v) — surfacing instead of retrying again",
				err, r.t.retrySpent.Round(time.Second), MaxLLMRetryWindow)
			r.resetLLMRetryBudget()
			return nil, err
		}

		wait := rErr.retryWait()

		// A wait the budget cannot cover is a wall, not a backoff: the attempts
		// it would buy all land inside the same refusal, and against a usage cap
		// each one is charged to the window the user is waiting for. Surface it
		// now, with the provider's own number intact.
		if remaining := MaxLLMRetryWindow - r.t.retrySpent; wait > remaining {
			r.log.Info("Retryable LLM error (%v), but it asks for %v and only %v of the %v budget is left — surfacing instead of retrying",
				err, wait.Round(time.Second), remaining.Round(time.Second), MaxLLMRetryWindow)
			r.resetLLMRetryBudget()
			return nil, err
		}

		r.log.Info("Retryable LLM error (%v), retrying in %v (attempt %d/%d, %v of %v budget spent)",
			err, wait, attempt+1, MaxLLMRetries, r.t.retrySpent.Round(time.Second), MaxLLMRetryWindow)

		status := rErr.retryStatus(attempt+1, MaxLLMRetries)
		if r.t.retrySpent >= time.Minute {
			status = fmt.Sprintf("%s — %s so far", status, r.t.retrySpent.Round(time.Second))
		}
		r.sendRetryingStatus(status)
		r.batcher.Flush()

		res := r.waitForRetryDelay(wait)
		if res.Cancelled {
			r.t.txnID = ""
			r.resetLLMRetryBudget()
			return nil, ErrCancelled
		}
		if res.NewMessage {
			// A new user message is a new intent, and gets a fresh allowance.
			r.t.txnID = ""
			r.resetLLMRetryBudget()
			return nil, ErrRestartStrategy
		}
		if res.Paused {
			// The retry the pause prevented was never sent, so there is nothing to
			// record and nothing to report: the turn ends at rest.
			r.t.txnID = ""
			r.resetLLMRetryBudget()
			return nil, ErrPolitelyStopped
		}

		// The streamed OUTPUT is dropped so the fresh attempt starts clean —
		// otherwise a partial answer from the failed attempt would be prefixed
		// to this one. The input measurement deliberately is not: a retry
		// re-sends `req` unchanged, so a prompt size the failed attempt already
		// measured describes this attempt's prompt exactly, and it is the only
		// account available if this attempt is cancelled before reporting its
		// own. Dropping it would write a blob that reports nothing.
		//
		// That is why there is no resetStreamingUsage() here and there is one
		// in runOneTurn: the strategy loop's next iteration sends a DIFFERENT
		// prompt, grown by the tool results since. A retry does not.
		r.finalizeStreaming()
		r.resetStreamingText()
		r.resetStreamingThinking()
		r.t.offeredTools = nil
		r.t.delegatingTools = nil
	}
	return nil, errors.New("unexpected retry loop exit")
}

// resetLLMRetryBudget ends the current retry sequence's wall-clock accounting.
// Called on every exit from callLLMWithRetry — success, terminal error, cancel,
// or a new user message — so the next sequence starts with a full allowance.
func (r *run) resetLLMRetryBudget() {
	r.t.retrySpent = 0
}

// sendRetryingStatus publishes the "retrying" spinner and latches it so the
// label survives into the next attempt. Without the latch the loop announced a
// retry and then immediately claimed to be streaming again, so the UI read
// "Receiving" for however long the fresh attempt spent backing off.
func (r *run) sendRetryingStatus(message string) {
	r.t.retryStatusActive = true
	r.sendStatus("retrying", message)
}

// clearRetryingStatus flips the spinner off "retrying" once real content
// arrives. Only content may do this: merely starting an attempt proves nothing,
// which is exactly the mistake that made the spinner lie.
func (r *run) clearRetryingStatus() {
	if !r.t.retryStatusActive {
		return
	}
	r.t.retryStatusActive = false
	r.sendStatus("streaming", "")
}

// finalizeCancellation handles cleanup when runStrategyLoop exits due to cancellation.
func (r *run) finalizeCancellation(completedThreadID string) {
	// Scoped to the cancelled run's own subtree ("" is root, i.e. everything —
	// which is right, since cancelling the root turn stops the conversation).
	r.CancelInFlightToolActions(completedThreadID)
	// Stop is a promote-and-idle boundary: keep any queued messages by moving
	// them into the thread as user items (the user reviews/edits, then sends to
	// run) rather than dropping them.
	r.promotePendingItems(completedThreadID)
	// For document-driven threads, needsStrategyRun is a one-shot trigger.
	// If cancellation leaves it set while result is empty, checkForNewThreads
	// would immediately re-run the same thread on the next observer tick.
	if completedThreadID != "" {
		r.clearThreadNeedsStrategyRun(completedThreadID)
	}
	r.sendStatus("idle", "")
}

// signalParentThread notifies a child thread's parent that the run it called
// for has settled, so the parent's LLM loop continues.
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
	settled := threadRunSettledLocked(threadYMap)
	llmCreated, _ := threadYMap.Get("llmCreated").(bool)
	ycrdtMu.Unlock()

	if !settled || !llmCreated {
		return false
	}
	parentThreadID := w.doc.ParentThreadID(completedThreadID)
	// Release the finished CHILD's claim before requesting the parent — only the
	// run that just ended is over. The parent may already be awaiting_llm (its
	// own turn parked when it spawned this child), which requestLLM below reports
	// as the idempotent success it is.
	w.releaseLLM(completedThreadID)
	if !w.requestLLM(parentThreadID) {
		return false
	}
	w.sched.markReconcile()
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
// the run's own thread.
func (r *run) addUserMessage(input UserMessageInput) {
	r.addUserMessageTo(r.t.thread, input)
}

// addUserMessageTo appends a user message to dest.
func (r *run) addUserMessageTo(dest threadContext, input UserMessageInput) {
	r.appendMessageTo(dest, newUserItem(input))
}

// findUnstampedUserMsgID returns the ItemID of the trailing user message in
// the current target (root or thread) if it lacks a TransactionID, otherwise
// "". Walks backward from the end and stops as soon as it sees an item that
// either is non-user or already has a transactionId — only the most recent
// user submission needs stamping for the round-trip about to begin.
func (r *run) findUnstampedUserMsgID() string {
	items := r.getTargetItems()
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
func (r *run) callLLM(request json.RawMessage) (*LLMResponse, error) {
	return r.callLLMWithSink(request, r.queueStreamChunk)
}

// callLLMWithSink is the transport primitive shared by visible turns and hidden
// worker operations. A nil sink discards stream chunks while preserving the
// normal server/cache/provider/admission path and cancellation semantics.
func (r *run) callLLMWithSink(request json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
	turnID := generateRequestID()
	r.t.llmTurnID = turnID
	correlatedSink := func(chunk StreamChunk) {
		if sink != nil {
			chunk.TurnID = turnID
			sink(chunk)
		}
	}

	if r.mock != nil {
		return r.callLLMMockWithSink(turnID, correlatedSink)
	}

	if r.llmCallFunc == nil {
		return nil, fmt.Errorf("LLM caller not configured")
	}

	// Reset the wake-interrupt flag for this attempt so a wake that fired
	// during a previous turn can't be misattributed to this call's error.
	r.t.wakeInterrupt.Store(false)

	ctx, cancel := context.WithCancel(context.Background())
	r.t.cancelLLM.Store(&cancel)
	defer r.t.cancelLLM.Store(nil)

	go func() {
		defer cancel()
		response, err := r.llmCallFunc(ctx, request, correlatedSink)
		r.deliverLLMResponse(turnID, response, err)
	}()

	response, err := r.waitForLLMResponse(turnID, LLMTimeout)
	if err != nil {
		var delivered *deliveredLLMError
		if !errors.As(err, &delivered) {
			return nil, err
		}
		// A system-wake cancelled this call: the connection was dropped while
		// the machine slept. Surface a clear, retryable message instead of the
		// provider's raw "context canceled".
		if r.t.wakeInterrupt.Load() {
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
	// A provider that read its own 429 hands us the wait as a number, taken from
	// the header the message text never carries. Prefer it, and fall through to
	// reading the text when the provider stated nothing.
	var limited *provider.RateLimitedError
	if errors.As(cause, &limited) && limited.RetryAfter > 0 {
		return newRateLimitError(limited.RetryAfter, true, msg, cause)
	}
	var unusable *provider.UnusableOutputError
	if errors.As(cause, &unusable) {
		return &UnusableOutputError{Wait: TransientRetryWait, Message: "LLM error: " + msg, Cause: cause}
	}

	switch {
	case isRateLimitMsg(msg):
		wait, stated := parseRetryWaitFromMsg(msg)
		return newRateLimitError(wait, stated, msg, cause)
	case isTransientMsg(msg):
		return &TransientError{Wait: TransientRetryWait, Message: "LLM error: " + msg, Cause: cause}
	case cause != nil:
		return fmt.Errorf("LLM error: %w", cause)
	default:
		return fmt.Errorf("LLM error: %s", msg)
	}
}

// newRateLimitError stamps a stated wait with the wall-clock time it expires,
// which is what the rest of the conversation and the user-facing report need. A
// wait nobody stated is left unstamped: it is a guess, and a guess must not
// stand over anything.
func newRateLimitError(wait time.Duration, stated bool, msg string, cause error) *RateLimitError {
	err := &RateLimitError{Wait: wait, Message: "LLM error: " + msg, Cause: cause}
	if stated {
		err.ResetAt = time.Now().Add(wait)
	}
	return err
}

// providerUnavailableDetail returns the credential resolver's own explanation
// from an error wrapping ErrProviderUnavailable: everything the LLM caller
// appended after the sentinel. Only the resolver knows which of the several
// user-fixable states this is ("no API key configured", "codex access token is
// expired; sign in with the Codex app…"), and Guard B's lead can't convey it.
// The text is located by the sentinel rather than by trimming a prefix because
// the error reaches Guard B already wrapped (classifyLLMError, delivery). An
// error carrying nothing beyond the sentinel yields "".
func providerUnavailableDetail(err error) string {
	if err == nil {
		return ""
	}
	marker := ErrProviderUnavailable.Error() + ": "
	raw := err.Error()
	i := strings.Index(raw, marker)
	if i < 0 {
		return ""
	}
	return strings.TrimSpace(raw[i+len(marker):])
}

// processLLMResponse handles the LLM response blocks.
// Returns true if the strategy loop should continue.
//
// IMPORTANT: Text and thinking blocks are NOT processed here. They are added
// during streaming via processStreamChunk. The blocks array contains raw
// chunks (one per streamed piece), not merged content blocks, so we cannot
// match them reliably.
func (r *run) processLLMResponse(response *LLMResponse) (bool, error) {
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
	//   Meta tools    → no tool-action, execute in worker (drop_context_items)
	//   create_thread → creates thread item, returns immediately (reducer dispatches child)
	//   Async tools   → tool-action created, browser executes (bash, glob, etc.)
	hasAsyncTools := false
	landing := r.landing()
	for _, block := range toolUseBlocks {
		// A delegated run told to report may still reach for a tool, since the
		// tools stay in its request to keep the prompt cache (landingRefusesTools).
		// The call is answered, not run, and the next turn offers no tools.
		if landing {
			r.addMetaToolResult(block.ID, block.Name, block.Input, landingRefusal, true)
			r.t.runBudget.refused = true
			continue
		}

		if !r.toolWasOfferedThisTurn(block.Name) {
			content := fmt.Sprintf("Tool %q wasn't available in this thread, so it wasn't run.", block.Name)
			r.addMetaToolResult(block.ID, block.Name, block.Input, content, true)
			continue
		}

		if isMetaTool(block.Name) {
			if err := r.executeMetaTool(block.ID, block.Name, block.Input); err != nil {
				r.log.Error("Meta tool execution failed: %v", err)
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
			if err := r.executeCreateThread(block.ID, block.Name, block.Input); err != nil {
				r.log.Error("Thread creation failed: %v", err)
			}
			continue
		}

		// Delegating tool: ask the engine to build a subthread spec. A spec
		// spawns a delegated child (parked like create_thread — the run it
		// starts becomes this tool_use's result); a null/timeout falls through
		// to the ordinary client-side tool-action below.
		if r.tryDelegateTool(block.ID, block.Name, block.Input) {
			continue
		}

		r.addToolAction(block.ID, block.Name, block.Input, block.Metadata)
		hasAsyncTools = true
	}

	if hasAsyncTools {
		// This turn produced tool-actions that the engine (the single tool
		// executor) must run. Command it: driveToolActions pushes the doc state
		// and dispatches evaluate-tool / execute-tool for each non-terminal
		// tool-action, rather than relying on the engine to auto-load on an
		// incidental sync (racy → the "tools stuck" wedge). The reducer pass does
		// the driving, on the run loop, once this turn has handed it back.
		r.requestReconcile()
	}

	return true, nil
}

func (r *run) addToolAction(toolUseID, toolName string, toolInput json.RawMessage, metadata map[string]any) {
	r.log.Tool(toolName, toolSummary(toolName, toolInput))
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
	r.appendTargetMessage(msg)
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
func (r *run) addThinkingMessage(text string) {
	msg := ConversationItem{
		Type:      ItemTypeThinking,
		ItemID:    generateItemID(),
		Content:   text,
		Timestamp: time.Now().Format(time.RFC3339),
	}
	r.appendTargetMessage(msg)
}

// addMetaToolResult adds a meta tool result to the conversation for LLM context.
func (r *run) addMetaToolResult(toolUseID, toolName string, toolInput json.RawMessage, content string, isError bool) {
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
	r.appendTargetMessage(msg)
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
