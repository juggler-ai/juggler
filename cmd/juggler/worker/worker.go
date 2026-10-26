//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"

	ycrdt "github.com/skyterra/y-crdt"
)

// WorkerState represents the worker's state machine
type WorkerState string

const (
	StateIdle       WorkerState = "idle"
	StateProcessing WorkerState = "processing"
	StateCancelling WorkerState = "cancelling"
)

// SaveDebounceTime is the delay before persisting state to disk.
// Changes are batched during this period to avoid excessive disk I/O.
//
// Why 2s: a streaming LLM turn typically produces a Y.Doc update every
// ~50ms; 2s coalesces a full short-message turn (~30-40 updates) into one
// write. Longer would risk losing more on crash; shorter would write while
// the model is still streaming. Empirically a clean balance.
const SaveDebounceTime = 2 * time.Second

// SaveMaxWait bounds how long a run of changes can hold the debounce off. Every
// change restarts SaveDebounceTime, so a conversation that keeps changing —
// a long streaming turn, a program writing its journal — would otherwise not be
// saved, and its transaction, asset and program-snapshot sweeps would not run,
// until it had been quiet for 2s. Ten seconds is five debounces: long enough
// that a short turn still coalesces into one write, short enough that a crash
// mid-turn loses seconds rather than the turn.
const SaveMaxWait = 10 * time.Second

// threadContext names one items array a write can land in: a thread's nested
// array, or the root conversation's for the zero value. A turn carries the one it
// writes to (turnState.thread); a handler that writes somewhere else resolves its
// own with resolveThread and passes it, rather than re-pointing a turn.
//
// It holds the thread's id and never a y-crdt handle: a turn writes to its thread
// for a whole run, and every read and write finds the thread by id where it acts
// (thread_helpers.go), so one a viewer deleted or replaced in the meantime is
// seen as it now stands (see GetThreadItemsArray).
type threadContext struct {
	itemID string
}

// ConversationWorker handles conversation orchestration.
// All state is owned by a single goroutine - no mutexes needed.
// Messages come in through the inbox and are processed sequentially.
//
// Pieces of its state that have rules of their own are objects held by name
// (engine, sched, liveness, undo, saver, baselines, pumps, inbox, tools), each
// owning its fields in its own file. The worker embeds nothing
// (TestWorkerSeamsOwnTheirState).
type ConversationWorker struct {
	conversationID string
	projectPath    string
	authorID       string

	// log is this conversation's per-conversation log sink. Every w.log.X call
	// also lands in the process-wide server.log (jlog superset), so this only
	// ADDS a filtered per-conversation file. Created in handleInit once
	// projectPath + file logging are known; nil until then and whenever on-disk
	// logging is disabled, in which case the nil-safe handle falls back to the
	// process sink + console. Closed in onShutdown.
	log *jlog.Logger

	// lastGuardLog is the last context-guard decision written to that log, so an
	// unchanged one is not restated on every dispatch. See
	// noteContextGuardDecision, which owns the rule. Behind an atomic pointer
	// because the guard runs on turn goroutines; a plain Store rather than a CAS
	// because two of them racing costs one extra line and nothing else.
	lastGuardLog atomic.Pointer[contextGuardDecision]

	// injected is what the worker is handed from outside — path and name
	// resolvers, persistence, the LLM caller, the live settings — as one
	// snapshot replaced whole. See worker_deps.go.
	injected atomic.Pointer[workerDeps]

	doc     *ConversationDocument
	tracker *OperationTracker

	// txnStore is the per-conversation transaction blob store (input/output
	// context for each LLM round-trip), and assetStore the content-addressed
	// asset store (attached images, etc.), whose bytes live out-of-doc under
	// <convDir>/assets/ while the doc holds only refs; programStore keeps the
	// snapshot a program tool takes while one of its calls waits on the user.
	// All are nil until handleInit knows projectPath.
	txnStore     *TransactionStore
	assetStore   *AssetStore
	programStore *ProgramStore

	// saver decides when the doc is written: the unsaved bit, the save debounce
	// and the forced-flush queue. See doc_saver.go, which owns every rule here;
	// the write itself is persistence.go's.
	saver docSaver

	// undo makes one undo press revert one user action: the compaction and
	// command merge marks, and the reducer holds around a history step. See
	// undo_grouping.go, which owns every rule here.
	undo undoGrouping

	// liveness measures wall-clock time the process spent frozen, which
	// detectFrozenGap excludes from the spinner's elapsed digit. See
	// liveness_clock.go.
	liveness livenessClock

	// tools holds the per-toolUseId tool-command delivery bookkeeping — the
	// state a command was last dispatched at, its dispatch time, the attempt
	// count and the re-drive interval (see tool_command_state.go).
	// driveToolActions consults it to re-dispatch only when the doc still
	// demands a command and the last dispatch at that state has aged, and to
	// escalate past maxToolCommandAttempts. Run goroutine only.
	tools *toolCommandTracker

	// baselines is what the reconcile tick remembers from its previous pass
	// (each thread's strategy, the cancelled tools), so a strategy switch and a
	// fresh denial read as edges. See reconcile_baselines.go.
	baselines reconcileBaselines

	// pumps is the running task-output delivery pumps. See delivery_pumps.go,
	// and task_delivery.go for what a pump does.
	pumps deliveryPumps

	// tape is a per-worker ring buffer that records timestamped events when
	// JUGGLER_TRACE is set. Used by the test runner's failure-dump endpoint
	// to splice the worker's view alongside JS-side iframe tapes so cross-
	// process races become visible at the failure site. No-op when tracing
	// is off (single boolean test in Record).
	tape *EventTape

	// inbox is the intake every message arrives on, and the client the one
	// being dispatched came from. See worker_inbox.go.
	inbox workerInbox

	// actor knows which goroutine is the run loop, for the state only it may
	// touch. See actor_guard.go.
	actor actorGuard

	// strategyHookTimeout bounds a turn's wait for the engine's onActivate
	// guidance (defaultStrategyHookTimeout). Set at construction; a test that
	// wants a shorter wait sets it on its own worker before the worker runs.
	strategyHookTimeout time.Duration

	// retryBackoffLimit caps the backoff the turn loop computes between
	// attempts (defaultRetryBackoffLimit); a wait the provider stated is not
	// subject to it. Set at construction; a test that drives a whole retry
	// sequence sets it to zero on its own worker before the worker runs.
	retryBackoffLimit time.Duration

	// llmTimeout is the backstop on one LLM call's wait (LLMTimeout). Set at
	// construction; a test that wants the backstop to fire sets it on its own
	// worker before the worker runs.
	llmTimeout time.Duration

	// clock is what a pending-queue drain reads as now, and what arms heldTimer.
	// The wall clock; a test installs its own before the worker runs.
	clock workerClock

	// heldTimer wakes the run loop when a send held for a time comes due on a
	// thread with no run to drain it. See held_send_timer.go.
	heldTimer heldSendTimer
	// heldIndex is the Manager's held-send index this worker publishes its
	// entry to, set before Start; nil for a worker built without a Manager.
	heldIndex *heldSendIndex
	// heldPublished is the entry last published to heldIndex. Actor only.
	heldPublished heldPublication

	done    chan struct{}
	stopped chan struct{}
	// stopOnce closes done exactly once, whichever of Stop and a cancelled
	// lifetime context gets there first (beginStop).
	stopOnce sync.Once

	// lifetime is the context Start was given: the worker's own lifetime, from
	// which every provider call it makes derives, so a cancellation from above (a
	// server shutdown) reaches each call. Written once by Start, before the run
	// loop exists; nil for a worker never started, whose calls run under
	// context.Background.
	lifetime context.Context

	// turn is the run currently in flight: the thread it writes to, the
	// round-trip in flight, and the accumulators that outlive a chunk but not the
	// run. Always non-nil; see turn.go for why these live together.
	turn *turnState

	// Per-client outbound callbacks. Owned by a dedicated actor goroutine
	// (see callback_registry.go); all ops route through callbacks.ch.
	callbacks *callbackRegistry

	// politeStops holds the "Pause" marks: one per paused thread, each standing
	// over that thread and everything nested below it. A covered thread finishes
	// what is in flight (the current LLM stream, running tools, pending approvals)
	// and rests at its next boundary, before the model is invoked again; nothing is
	// marked Interrupted or Cancelled. A mark stands until a human lifts it, so no
	// boundary consumes one. Set by a "pause" message and lifted by an "unpause", a
	// send into the covered thread, a hard cancel over it, or undo/redo. An
	// immutable map behind an atomic pointer, rewritten copy-on-write, so a pause
	// arriving on the run goroutine is visible to the boundaries — which are turn
	// goroutines — without a lock. See polite_stop.go, which owns every rule here.
	politeStops atomic.Pointer[map[string]bool]

	// rateLimits holds the account-level usage caps standing over this
	// conversation: provider name → when that provider said the cap lifts. One
	// thread discovers a cap and every other thread on that provider rests
	// instead of spending a request to be told the same thing. An immutable map
	// behind an atomic pointer like politeStops, but rewritten under
	// compare-and-swap rather than by a single writer: the writers here are turn
	// goroutines racing each other — six threads meeting the same 429 at once —
	// and the CAS is what makes exactly one of them the discoverer who reports it.
	// See rate_limit_latch.go, which owns every rule here.
	rateLimits atomic.Pointer[map[string]time.Time]

	// script is the slot a test installs scripted LLM responses in. It holds
	// nothing in a production build (mock_llm_production.go); see mock_llm.go.
	script mockScript

	// Whether handleInit has been called at least once (first-init vs reconnect)
	initialized bool

	// engine is the worker's side of its relationship with the attached engine:
	// the client round-trips, the evidence the engine is running its tool-command
	// handlers, and what the engine is believed to hold of the document. See
	// engine_session.go, which owns every rule here. Held by name rather than
	// embedded, so its state is reached through its methods.
	engine engineSession

	// turnCounter is incremented on every transition to idle. It is written
	// into the durable `completedTurns` metadata key (NOT the ephemeral
	// processingState blob) so the browser (and test harness) can observe that
	// a turn has completed even if the status transitions were merged by Yjs
	// sync batching, and so it survives a reload. Monotonic, never resets.
	//
	// Atomic because the bump belongs to the actor — a turn hands its idle edge
	// back to the run loop, which finalizes the fence as it retires the turn —
	// while a live SIBLING turn reads that fence on its own goroutine to stamp
	// the onTurnEnd context hook. Only the actor writes it, so the seed-then-
	// increment below stays a single-writer sequence.
	turnCounter atomic.Int64

	// The conversation's cumulative token spend — new input, and billed output.
	// The ceiling that stops delegated work past it is resolved through
	// deps().spendLimit. See spend.go, which owns every rule here.
	//
	// Atomic for the same reason turnCounter is, only more so: sibling threads
	// stream side by side on their own goroutines (canAdmitThread), so several
	// runs record into these at once. Each is advanced by a compare-and-swap that
	// also folds in the persisted figure (addSpendFloored), which is what keeps
	// the count both lossless under that concurrency and monotonic across a
	// reload.
	spendInput  atomic.Int64
	spendOutput atomic.Int64

	// sched is which turns run and when the reducer is next asked: the reconcile
	// bit, the run loop's dispatch and retirement hand-offs, the live-run
	// registry, the turn boundaries and the App Nap defeat. See
	// run_scheduler.go, which owns every rule here. Held by name rather than
	// embedded, so its state is reached through its methods.
	sched runScheduler

	// Outbound Yjs update debouncer; coalesces a burst into one broadcast
	// per SyncThrottleMs. See sync_batcher.go.
	batcher *syncBatcher

	// docChangeChan receives a signal whenever the Yjs document changes.
	// The observer callback fires on whichever goroutine did the Transact(),
	// which may not be the run() goroutine. This channel moves the actual
	// handleItemsChange work onto the run() goroutine to avoid data races.
	docChangeChan chan struct{}

	// deleting is set by the Manager before Stop() when the worker is being
	// removed for conversation deletion. onShutdown checks it and skips the
	// final save so the doomed conv's folder isn't recreated as
	// "Untitled--<id>" after DeleteConversation has already removed it,
	// which would otherwise leave an orphan folder that reconcile picks up
	// as a ghost tab on the next session GET.
	deleting atomic.Bool

	// purgeLogs is set by the Manager (RemoveAndPurgeLogs) before Stop() when the
	// conversation is being PERMANENTLY deleted — not for a reversible bin or a
	// plain eviction. onShutdown removes this conversation's per-conversation log
	// file(s) after closing the sink, so a deleted conversation's logs don't
	// linger until the retention sweep. Set-once before teardown; read on the
	// worker's own goroutine in onShutdown.
	purgeLogs atomic.Bool
}

// workerMessage wraps an incoming message. OriginClient is the ID of the client
// that sent it (empty for worker-internal messages), used to route a
// request-scoped reply — e.g. an ack — back to only that client instead of
// broadcasting it to every connected client.
type workerMessage struct {
	Type         string
	Payload      json.RawMessage
	OriginClient string
	Ack          chan error
}

// NewConversationWorker creates a new conversation worker.
func NewConversationWorker(conversationID, authorID string) *ConversationWorker {
	doc := NewConversationDocument(conversationID, authorID)
	tracker := NewOperationTracker(doc)

	done := make(chan struct{})
	w := &ConversationWorker{
		conversationID: conversationID,
		authorID:       authorID,
		doc:            doc,
		tracker:        tracker,
		tape:           NewEventTape(),
		callbacks:      newCallbackRegistry(),
		done:           done,
		stopped:        make(chan struct{}),
		turn:           newTurnState(),
		docChangeChan:  make(chan struct{}, 1),
		sched:          newRunScheduler(done),
		baselines:      newReconcileBaselines(),
		saver:          newDocSaver(),
		// Unbounded, order-preserving intake, its pump's lifetime tied to the
		// worker's; Send enqueues here so it never drops.
		inbox: newWorkerInbox(done),

		strategyHookTimeout: defaultStrategyHookTimeout,
		retryBackoffLimit:   defaultRetryBackoffLimit,
		llmTimeout:          LLMTimeout,
		clock:               realClock(),
	}
	w.injected.Store(&workerDeps{})
	// The actor-only seams hold the worker's guard, which exists only once w does.
	w.tools = newToolCommandTracker(&w.actor)
	w.pumps = newDeliveryPumps(&w.actor)
	w.undo = newUndoGrouping(&w.actor)
	// Created after w.done, which its reply slots share so a blocked test client
	// is released when the worker stops.
	w.engine = newEngineSession(w.done)
	w.batcher = newSyncBatcher(doc, time.Duration(SyncThrottleMs)*time.Millisecond)

	// Set up sync broadcast callback
	doc.RegisterSyncCallbacks(
		func(update []byte) {
			w.sendYjsSync(update)
			w.scheduleSave() // Persist changes to disk
		},
		func(canUndo, canRedo bool) {
			w.sendUndoState(canUndo, canRedo)
		},
	)

	// Set up document observer for approval flow
	// Unified storage: items observer also handles context item changes (context items are in items array)
	w.setupDocumentObserver()

	return w
}

// SetSyncThrottle overrides the outbound-sync coalescing window by rebuilding
// the batcher. Must be called before Start() — the batcher is untouched until
// the run loop selects on it. Used by the Manager to apply a server-configured
// throttle (default is SyncThrottleMs); the test harness widens it via the
// JUGGLER_TEST_SYNC_THROTTLE_MS knob the server reads at wiring time.
func (w *ConversationWorker) SetSyncThrottle(d time.Duration) {
	if d <= 0 {
		return
	}
	w.batcher = newSyncBatcher(w.doc, d)
}

// Start begins the worker's message processing loop, under ctx: cancelling it
// stops the worker the way Stop does, and every provider call the worker makes
// runs under a context derived from it.
func (r *run) Start(ctx context.Context) {
	r.lifetime = ctx
	go r.run(ctx)
}

// lifetimeContext is the context the worker's provider calls derive from.
func (w *ConversationWorker) lifetimeContext() context.Context {
	if w.lifetime == nil {
		return context.Background()
	}
	return w.lifetime
}

// Stop stops the worker and returns once it has gone: its turns unwound, its
// document saved (onShutdown) and its loop exited.
func (r *run) Stop() {
	r.beginStop()
	<-r.stopped
	// The loop has gone, so nothing more can be dispatched and this snapshot is
	// final. onShutdown has already waited the turns out; anything left here
	// outlived its grace, and is waited for without one, because a turn still
	// writing to the document after Stop returns would be writing into a doc the
	// caller is about to destroy.
	for _, e := range r.sched.runs() {
		<-e.t.finished
	}
}

// beginStop starts the worker's stop: it closes done, which releases every wait
// a turn can be parked in and makes each turn's unwinding quiet (stopping), then
// cancels every in-flight provider call so none is left streaming into a turn
// that has gone. Idempotent and callable from any goroutine: Stop calls it, and
// so does onShutdown, for a loop ended by its lifetime context.
func (w *ConversationWorker) beginStop() {
	w.stopOnce.Do(func() {
		close(w.done)
		for _, t := range w.allTurnStates() {
			if p := t.cancelLLM.Load(); p != nil {
				(*p)()
			}
		}
	})
}

// stopping reports whether the worker's stop has begun. A turn reads it as it
// unwinds: what ends a run during a stop is the stop, not anything the run did.
//
// A cancelled lifetime context is a stop that has begun, whether or not the run
// loop has reached beginStop yet: every provider call derives from that
// context, so its cancellation ends the call at once, and the turn unwinding
// from it can get here before the loop has closed done.
func (w *ConversationWorker) stopping() bool {
	select {
	case <-w.done:
		return true
	default:
	}
	return w.lifetime != nil && w.lifetime.Err() != nil
}

// StopForRemoval tears the worker down when its conversation is being removed
// (binned or deleted). Beyond Stop's per-turn ctx-cancel, it releases the
// provider-side LLM session, so a warm or mid-turn claudecode CLI for the
// now-gone conversation is torn down rather than orphaned. Without this, a CLI
// that streams a tool_use just as its conversation is binned parks the
// tools/call with no worker left to drive execution — the tool wedges at
// "running" until a manual cancel.
//
// The release is unconditional: it must not depend on turn.cancelLLM being set,
// since the original wedge landed in the turn-boundary window where the
// in-flight ctx had already cleared but the provider's warm CLI had not. It is
// warm-preserving (handleCancel uses the same hook) — moot for a permanent
// delete and harmless for a bin, where the resume anchor survives — and a no-op
// when no provider session exists.
func (r *run) StopForRemoval() {
	if release := r.deps().cancelLLMSession; release != nil {
		// Every thread: the conversation itself is going, so there is no thread
		// left whose session should survive.
		release(r.conversationID, provider.CancelAllThreads)
	}
	r.Stop()
}

// MarkDeleting flags the worker as being removed for conversation deletion
// so onShutdown skips the final save. Call before Stop() in the delete path.
func (w *ConversationWorker) MarkDeleting() {
	w.deleting.Store(true)
}

// Send queues a worker-internal message for processing (no originating client,
// so any reply broadcasts). The queue is unbounded and FIFO, so a message is
// never dropped; push returns after one goroutine hop (or once the worker is
// stopping), so it never blocks the caller on worker processing.
func (w *ConversationWorker) Send(msgType string, payload json.RawMessage) {
	w.SendFromClient("", msgType, payload)
}

// SendFromClient queues a message tagged with the client that originated it, so
// a request-scoped reply (an ack) routes back to only that client. clientID ""
// behaves exactly like Send (reply broadcasts).
func (w *ConversationWorker) SendFromClient(clientID, msgType string, payload json.RawMessage) {
	w.inbox.push(workerMessage{Type: msgType, Payload: payload, OriginClient: clientID})
}

// SendAndWait queues a worker-internal message and blocks until the run loop has
// processed it. It is for server-side initialization barriers, not normal viewer
// traffic.
func (w *ConversationWorker) SendAndWait(ctx context.Context, msgType string, payload json.RawMessage) error {
	return w.awaitAck(ctx, w.sendWithAck(msgType, payload))
}

// sendWithAck queues a worker-internal message and returns the channel its
// handling is acknowledged on, so one goroutine can fix the message's place in
// the mailbox and another wait for it (Manager.SeedNewConversation).
func (w *ConversationWorker) sendWithAck(msgType string, payload json.RawMessage) <-chan error {
	ack := make(chan error, 1)
	w.inbox.push(workerMessage{Type: msgType, Payload: payload, Ack: ack})
	return ack
}

// awaitAck waits for a message sendWithAck queued to be handled. A worker that
// stops first acknowledges nothing, and that is not an error.
func (w *ConversationWorker) awaitAck(ctx context.Context, ack <-chan error) error {
	select {
	case err := <-ack:
		return err
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// SetCallback sets the callback for a specific client.
func (w *ConversationWorker) SetCallback(clientID string, callback func(msg []byte)) {
	w.callbacks.set(clientID, callback)
}

// GetCallback returns the callback for a specific client (or nil if not registered).
// Blocks until the registry goroutine responds.
func (w *ConversationWorker) GetCallback(clientID string) func(msg []byte) {
	return w.callbacks.get(clientID)
}

// RemoveCallback removes the callback for a specific client.
func (w *ConversationWorker) RemoveCallback(clientID string) {
	w.callbacks.remove(clientID)
}

// SetEngineClientID tells this worker which client is the engine (the single
// tool executor), so pushStateToEngine can target it. "" detaches.
func (w *ConversationWorker) SetEngineClientID(clientID string) {
	// The incoming engine has observed none of this conversation's ops, so what
	// the previous one held describes nothing now. The next push re-seeds full
	// state.
	w.engine.forgetDocument()
	w.callbacks.setEngine(clientID)
}

// pushStateToEngine sends Yjs document state directly to the attached engine,
// guaranteeing the engine becomes a loaded peer of THIS conversation.
//
// The engine is the single place that executes tool-actions (via its reactive
// reducer), which requires the conversation to be loaded there. Relying on the
// engine to auto-load reactively on an incidental yjs-sync is racy and timing-
// dependent: a conversation that gains tool work while the engine is up but
// hasn't loaded it leaves the approved tool-action unobserved forever — the
// "tools stuck" wedge. So the worker (the authority) drives the load: whenever a
// turn produces tool-actions, it pushes state to the engine. Idempotent — if the
// engine already has the conversation the update merges as a no-op. No-op when
// no engine is attached or the doc isn't loaded yet.
//
// Only the FIRST push to a given engine is the whole document; the rest are
// deltas against what the engine was last sent (engineSession.nextPush).
// Seeding a peer that holds nothing takes full state, but repeating it does
// not, and this fires once per tool-action
// dispatched plus once per redrive interval per unanswered tool — so on a
// conversation with large tool results the full-document form re-encoded,
// base64'd and shipped megabytes down a loopback socket (where permessage-
// deflate is off) to communicate a few dozen bytes of change, several times a
// turn.
//
// A push always goes out, even when the delta is empty, because the message is
// also the ordering barrier its caller relies on: the command that follows it
// rides the same engine mailbox, and the engine flushes pending syncs before
// acting. Skipping the send on "nothing new" would let a command overtake a
// sync still queued behind a setTimeout in the engine, which is the ordering the
// caller in driveToolActionsExcept exists to guarantee.
func (w *ConversationWorker) pushStateToEngine() {
	if !w.initialized {
		return
	}
	if update, ok := w.engine.nextPush(w.doc); ok {
		w.callbacks.sendToEngine(marshalYjsSync(update, false))
	}
}

// resolveContextWindow maps the conversation's effective model to its context
// window and output reserve (tokens) via the injected resolver. Returns the
// zero value when no resolver is wired (tests) or the model is unknown; callers
// read a non-positive window as "unknown".
func (r *run) resolveContextWindow() ContextWindowInfo {
	info, _, _ := r.windowInfo(nil)
	return info
}

// autoCompactEnabled reports whether automatic compaction is enabled. A nil gate
// (tests / not wired) is treated as enabled, preserving default-on behavior.
func (w *ConversationWorker) autoCompactEnabled() bool {
	gate := w.deps().autoCompactGate
	return gate == nil || gate()
}

// interruptInFlightLLMForWake cancels the in-flight LLM request (if any)
// after the OS reports the system resumed from sleep. A request that was
// streaming when the machine slept has almost certainly had its underlying
// connection dropped; rather than waiting out the LLMTimeout backstop,
// we cancel now so the turn fails fast with a clear, retryable message.
// No-op when no LLM call is in flight.
//
// Cancelling the per-turn ctx is sufficient to recover the provider: the
// claudecode read loop selects on ctx.Done() and returns ctx.Err(), which
// finalizeTurn turns into a dropped session (the dead CLI subprocess is
// killed there). One-shot providers unwind on the same ctx cancellation.
//
// Safe to call from the Manager goroutine: turn.cancelLLM is an atomic
// pointer and the cancel func itself is goroutine-safe and idempotent, so
// this composes with callLLM's defer and handleCancel's swap without locks.
func (r *run) interruptInFlightLLMForWake() {
	// Every turn this worker owns: the wake is the machine's, not one run's, and
	// the call that was streaming through the sleep is on whichever goroutine
	// happens to hold it.
	for _, t := range r.allTurnStates() {
		if p := t.cancelLLM.Swap(nil); p != nil {
			t.wakeInterrupt.Store(true)
			r.log.Info("☀️ system wake: cancelling in-flight LLM request conv=%s (connection likely dropped during sleep)", r.conversationID)
			(*p)()
		}
	}
}

// hasLLMInFlight reports whether any turn this worker owns holds a live LLM
// context. Diagnostic only — the teardown paths cancel unconditionally.
func (w *ConversationWorker) hasLLMInFlight() bool {
	for _, t := range w.allTurnStates() {
		if t.cancelLLM.Load() != nil {
			return true
		}
	}
	return false
}

const (
	// livenessInterval is the heartbeat cadence for the frozen-gap detector. It only
	// needs to be short enough that the elapsed digit self-corrects promptly once the
	// process resumes — not precise.
	livenessInterval = 2 * time.Second
	// frozenGapThresholdMs: a liveness tick landing at least this much later than
	// livenessInterval means ticks were missed because the process wasn't running.
	// Comfortably above any normal scheduling jitter so live operation never trips it.
	frozenGapThresholdMs = 4000
	// execReportFreshMs is how recent the last accepted tool-execution-report must be
	// for finalizeToolsAbsentFromExecReport to act on it — a few engine report
	// intervals (the engine reports every ~3s while tools run). Past this the engine
	// has gone quiet and orphan recovery belongs to the reattach path, not this rule.
	execReportFreshMs = 9000
	// execReportClaimGraceMs is the claim→executor-registration lag subtracted in the
	// happens-after guard, so a tool claimed just before a report was sent (and thus
	// legitimately not yet in it) is never mistaken for absent.
	execReportClaimGraceMs = 2000
)

// detectFrozenGap keeps the elapsed-time digit counting only wall-clock time this
// process was actually running. Clients render the digit as (now - startedAt) against
// one shared anchor, so any span the machine spent frozen — system sleep, hibernation,
// a suspended VM, a stop-the-world pause — would otherwise inflate it even though no
// work happened. There is no event for "the wall clock jumped", so we poll: the
// liveness clock ticks ~every livenessInterval while run() executes, and a tick that
// lands far later than that interval measures how long we were frozen. We push the
// anchor forward by that excess (the same exclusion the approval-wait path applies via
// advanceElapsedAnchor), so the digit resumes with the dead time removed.
//
// Deliberately not sleep-specific: it corrects for ANY cause of missed ticks, which is
// why it doesn't hook the sleep/wake notification. Runs only on the run() goroutine;
// the anchor it corrects belongs to the turn that is streaming, which is why that
// field is atomic.
func (r *run) detectFrozenGap() {
	excess := r.liveness.frozenFor(time.Now().UnixMilli())
	if excess == 0 {
		return // first tick, normal cadence or a backward clock step — not a freeze
	}
	// Only meaningful while a turn's timer is actively running. Idle has no anchor;
	// while parked on an approval the wait mechanism already excludes the entire park
	// (this freeze included), so advancing here too would double-count it.
	targets := r.sched.runs()
	if len(targets) == 0 {
		targets = []liveRunEntry{{t: r.t}}
	}
	advanced := false
	for _, live := range targets {
		target := r.runFor(live.t)
		if target.t.processingStartedAt.Load() == 0 || target.t.approvalWaitStartedAt.Load() != 0 {
			continue
		}
		target.advanceElapsedAnchor(excess)
		advanced = true
	}
	if advanced {
		r.log.Info("⏱️ excluding %ds of frozen time from elapsed (process was suspended) conv=%s", excess/1000, r.conversationID)
	}
}

// Document returns the conversation document.
func (w *ConversationWorker) Document() *ConversationDocument {
	return w.doc
}

// FlushPersistence forces an immediate save and blocks until it completes.
// Bypasses the SaveDebounceTime debounce so tests and shutdown paths don't
// have to sleep. Returns whatever saveStateToDisk returns.
func (w *ConversationWorker) FlushPersistence(ctx context.Context) error {
	ack := make(chan error, 1)
	select {
	case w.saver.postFlush() <- ack:
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-ack:
		return err
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// loadState reads this run's state atomically.
func (r *run) loadState() WorkerState {
	return r.t.state.Load().(WorkerState)
}

// storeState writes this run's state atomically.
func (r *run) storeState(s WorkerState) {
	prev := r.t.state.Load()
	r.t.state.Store(s)
	if prev != nil {
		r.tape.Record("state", map[string]any{
			"from": string(prev.(WorkerState)),
			"to":   string(s),
		})
	}
}

// State returns the current worker state (for testing and monitoring).
func (w *ConversationWorker) State() WorkerState {
	return w.anyRunState()
}

// Tracker returns the operation tracker (for testing).
func (w *ConversationWorker) Tracker() *OperationTracker {
	return w.tracker
}

// resolveModelConfig returns the effective model config for the current thread context.
// Resolves from the Yjs document (thread → parent chain → conversation metadata).
func (r *run) resolveModelConfig() *ModelConfig {
	return r.doc.ResolveEffectiveModelConfig(r.t.thread.itemID)
}

// run is the main message processing loop. All state access happens here.
func (r *run) run(ctx context.Context) {
	r.actor.bind()
	defer close(r.stopped)
	// Held for as long as this loop runs; released before stopped closes, so a
	// Stop that has returned has let it go.
	defer holdYcrdtWatchdog()()
	defer r.actor.unbind()
	defer r.onShutdown()
	r.liveness.start()
	defer r.liveness.stop()
	defer r.heldTimer.disarm()
	for {
		// Each case stamps what it handled and when it began, for the
		// slow-iteration report below (loop_timing.go).
		var event string
		var started time.Time
		select {
		case <-ctx.Done():
			return
		case <-r.done:
			return
		case msg := <-r.inbox.messages():
			event, started = "message "+msg.Type, time.Now()
			r.handleMessage(msg)
		case <-r.doc.UpdateSignal():
			event, started = "doc update signal", time.Now()
			r.batcher.Schedule()
		case <-r.saver.rearmRequests():
			event, started = "save request", time.Now()
			r.saver.rearm()
		case <-r.saver.fired():
			event, started = "save", time.Now()
			// Skip if marked for deletion — the folder is about to be
			// removed, and saving would recreate it as "Untitled--<id>",
			// which reconcileConversationOrder would then ghost back into
			// the tab bar on the next session load.
			if !r.deleting.Load() {
				if err := r.saveStateToDisk(); err != nil {
					r.log.Error("Failed to save state: %v", err)
				}
			}
		case ack := <-r.saver.flushRequests():
			event, started = "flush", time.Now()
			ack <- r.flushNow()
		case <-r.docChangeChan:
			event, started = "items change", time.Now()
			r.handleItemsChange()
		case <-r.sched.wakes():
			event, started = "reconcile request", time.Now()
			r.sched.markReconcile()
		case t := <-r.sched.dispatches():
			event, started = "thread dispatch", time.Now()
			r.startPreparedThreadRun(t)
		case t := <-r.sched.retirements():
			event, started = "turn retired", time.Now()
			r.finishRetiredTurn(t)
		case <-r.liveness.ticks():
			event, started = "liveness tick", time.Now()
			r.detectFrozenGap()
			liveThreads := r.sched.liveThreads()
			// Periodic recovery remains actor-owned and skips only the subtrees whose
			// live run goroutines currently own their tool state.
			r.finalizeToolsAbsentFromExecReportExcept(liveThreads)
			r.driveToolActionsExcept(liveThreads)
		case <-r.heldTimer.fired():
			event, started = "held send due", time.Now()
			r.fireHeldSends()
		}
		handled := time.Since(started)
		// After every event, drain the reducer. A dispatch may complete
		// and raise the reconcile bit again (e.g., child thread completes →
		// parent needs dispatch). Loop until the reducer is quiet.
		// Bounded to prevent spin loops from observer re-triggering.
		reconcileStarted := time.Now()
		passes := r.drainReconcile()
		// Last, so the timer is armed against what this event and its passes
		// left in the queues.
		r.rearmHeldTimer()
		r.reportSlowIteration(event, handled, time.Since(reconcileStarted), passes)
	}
}

// recoverWorkerPanic is handleMessage's deferred recover. On panic it logs and
// reports the error into the root conversation.
//
// It settles no thread's run: handleMessage executes on the ambient turn, whose
// thread is always the root (only beginTurn gives a turn a thread, and it gives
// it to a fresh one), so there is no sub-thread run here to mark failed.
func (r *run) recoverWorkerPanic(msgType string) {
	panicValue := recover()
	if panicValue == nil {
		return
	}
	stack := debug.Stack()
	r.log.Error("Panic handling message %s: %v\n%s", msgType, panicValue, stack)
	requireDocLockAfterPanic("handling message "+msgType, panicValue, stack)
	r.sendError(msg.New("Internal error: {detail}", "detail", fmt.Sprint(panicValue)))
}

// handleMessage processes a single message from the main event loop.
func (r *run) handleMessage(msg workerMessage) {
	defer r.recoverWorkerPanic(msg.Type)
	r.dispatchMessage(msg)
}

// dispatchMessage routes a message to its type-specific handler.
func (r *run) dispatchMessage(msg workerMessage) {
	if msg.Ack != nil {
		defer func() {
			if r := recover(); r != nil {
				msg.Ack <- fmt.Errorf("worker message %s panicked: %v", msg.Type, r)
				panic(r)
			}
			msg.Ack <- nil
		}()
	}
	r.inbox.beginReply(msg.OriginClient)
	if msg.Ack != nil {
		r.inbox.answerByAck()
	}
	defer r.inbox.endReply()

	if r.handleTestMessage(msg) {
		return
	}

	handle, ok := workerInbound[wireMsgType(msg.Type)]
	if !ok {
		r.log.Error("Unknown message type: %s", msg.Type)
		return
	}
	handle(r, msg)
}

// inboundHandler runs one inbound message on the run loop.
type inboundHandler func(r *run, msg workerMessage)

// workerInbound is every message a client may send the worker, by type. Each
// handler decodes its own payload, once; TestWireParityWorkerInbound holds the
// keys to allWorkerInbound and the wire manifest.
//
// An op added here that starts work — requestLLM, setThreadNeedsStrategyRun,
// checkForNewThreads — owes an answer to the pause: it either lifts the marks
// covering the thread it runs on (a human asked for it) or leaves them standing
// and waits (the conversation carrying on by itself). The classification is in
// polite_stop.go; the choice is enforced by
// TestEveryWorkStartingOpClassifiesItselfAgainstThePause, which reads this
// table to find the ops.
var workerInbound = map[wireMsgType]inboundHandler{
	msgInit:                func(r *run, m workerMessage) { r.handleInit(m.Payload) },
	msgSendMessage:         func(r *run, m workerMessage) { r.handleSendMessage(m.Payload) },
	msgInjectThreadMessage: func(r *run, m workerMessage) { r.handleInjectThreadMessage(m.Payload) },
	msgDeliveryEnded:       func(r *run, m workerMessage) { r.handleDeliveryEnded(m.Payload) },
	msgCancel:              func(r *run, m workerMessage) { r.handleCancel(cancelReasonFromPayload(m.Payload)) },
	msgPause:               func(r *run, m workerMessage) { r.handlePause(threadItemIDFromPayload(m.Payload)) },
	msgUnpause:             func(r *run, m workerMessage) { r.handleUnpause(threadItemIDFromPayload(m.Payload)) },
	msgProviderTurn:        func(r *run, m workerMessage) { r.handleProviderTurn(m.Payload) },

	msgRenderContextItemsResponse: func(r *run, m workerMessage) { r.handleRenderContextItemsResponse(m.Payload) },
	msgToolsResult:                func(r *run, m workerMessage) { r.handleToolsResult(m.Payload) },
	msgStrategyHookResponse:       func(r *run, m workerMessage) { r.handleStrategyHookResponse(m.Payload) },
	msgBuildSubthreadSpecResponse: func(r *run, m workerMessage) { r.handleBuildSubthreadSpecResponse(m.Payload) },

	msgYjsSync:         func(r *run, m workerMessage) { r.handleYjsSync(m.Payload) },
	msgUndo:            func(r *run, m workerMessage) { r.handleUndo(m.Payload) },
	msgRedo:            func(r *run, m workerMessage) { r.handleRedo(m.Payload) },
	msgClearHistory:    func(r *run, _ workerMessage) { r.handleClearHistory() },
	msgClearUndoStacks: func(r *run, m workerMessage) { r.handleClearUndoStacks(m.Payload) },
	// Browser-driven mutations bypass the OperationTracker, so the UndoManager
	// only auto-closes its capture window on the 250 ms timeout. Multiple browser
	// actions issued within that window get merged into one undo group — undoing
	// then unexpectedly reverses all of them. The browser sends this message at
	// user-action boundaries (slash commands, context-item add/remove, etc.) to
	// force a fresh undo group.
	msgStopUndoCapturing: func(r *run, _ workerMessage) { r.tracker.StopCapturing() },
	msgBeginUndoCoalesce: func(r *run, _ workerMessage) { r.handleBeginUndoCoalesce() },
	msgEndUndoCoalesce:   func(r *run, m workerMessage) { r.handleEndUndoCoalesce(m.Payload) },

	msgRetryToolApproval:        func(r *run, m workerMessage) { r.handleRetryToolApproval(m.Payload) },
	msgRetryToolAction:          func(r *run, m workerMessage) { r.handleRetryToolAction(m.Payload) },
	msgRetryTruncatedTurn:       func(r *run, m workerMessage) { r.handleRetryTruncatedTurn(m.Payload) },
	msgUpdateToolActionForRetry: func(r *run, m workerMessage) { r.handleUpdateToolActionForRetry(m.Payload) },
	msgBackgroundTaskSnapshot:   func(r *run, m workerMessage) { r.handleBackgroundTaskSnapshot(m.Payload) },
	msgToolExecutionReport:      func(r *run, m workerMessage) { r.handleToolExecutionReport(m.Payload, m.OriginClient) },
	msgEngineTrace:              func(r *run, m workerMessage) { r.handleEngineTrace(m.Payload) },

	msgCreateThread:                func(r *run, m workerMessage) { r.handleCreateThread(m.Payload) },
	msgResummarizeCompactionThread: func(r *run, m workerMessage) { r.handleResummarizeCompactionThread(m.Payload) },
	msgCompact:                     func(r *run, m workerMessage) { r.handleCompact(m.Payload) },

	msgRequestFullState: func(r *run, _ workerMessage) { r.broadcastFullState() },
	msgResyncRequest:    func(r *run, m workerMessage) { r.handleResyncRequest(m.Payload) },
	msgResyncToOrigin:   func(r *run, _ workerMessage) { r.handleResyncToOrigin() },

	msgRenameLog:        func(r *run, _ workerMessage) { r.handleRenameLog() },
	msgRequestAutoName:  func(r *run, m workerMessage) { r.handleRequestAutoName(m.Payload) },
	msgGetTransaction:   func(r *run, m workerMessage) { r.handleGetTransaction(m.Payload) },
	msgFlushPersistence: func(r *run, m workerMessage) { r.handleFlushPersistence(m.Payload) },

	msgReleaseQueued: func(r *run, m workerMessage) { r.handleReleaseQueued(m.Payload) },
	msgRemoveQueued:  func(r *run, m workerMessage) { r.handleRemoveQueued(m.Payload) },
}

// handleClearUndoStacks wipes the conversation's undo/redo history. The browser
// sends this after seeding a new conversation's auto-items (memory, AI-assistant
// files) and after duplicating a conversation, so those non-user edits aren't
// undoable. Runtime feature — must stay outside the test-only handler gate.
func (w *ConversationWorker) handleClearUndoStacks(payload json.RawMessage) {
	ackID := w.ackIDOf("clear-undo-stacks", payload)

	w.tracker.ClearHistory()
	w.reply(AckMessage{Type: msgAck, AckID: ackID})
}

// handleGetTransaction reads an LLM-round-trip blob from disk and returns it
// to the client. The client requests this lazily — when the user opens the
// "View Transaction" panel for an item, and during the auto-compact threshold
// check. Runtime feature — must stay outside the test-only handler gate.
func (w *ConversationWorker) handleGetTransaction(payload json.RawMessage) {
	var msg GetTransactionMessage
	if !w.decodePayload("get-transaction", payload, &msg) {
		return
	}

	ack := AckMessage{Type: msgAck, AckID: msg.AckID}
	if w.txnStore != nil && msg.TransactionID != "" {
		data, err := w.txnStore.Load(w.conversationID, msg.TransactionID)
		if err == nil {
			var parsed any
			if json.Unmarshal(data, &parsed) == nil {
				ack.Result = parsed
			}
		}
	}
	w.reply(ack)
}

// handleFlushPersistence forces the conversation's in-memory state to disk
// synchronously, bypassing the SaveDebounceTime debounce, then acks. Runtime
// feature — must stay outside the test-only handler gate.
//
// This is the barrier behind the quit handshake. The worker takes inbound
// messages serially, so every yjs-sync sent before this one has already been
// applied by the time the handler runs; because it then saves inline, the ack
// means the state is on disk, not merely received. The browser sends it after
// flushing composer drafts when the native shell announces an imminent close,
// and persistence tests use it instead of sleeping past the debounce before a
// destroy+reload cycle.
//
// This runs on the worker goroutine (dispatched inline from the run loop), so it
// calls flushNow directly — exactly as the loop's own flush case does — rather
// than routing through ConversationWorker.FlushPersistence, which would deadlock
// waiting on the same loop to service the flush.
func (r *run) handleFlushPersistence(payload json.RawMessage) {
	ackID := r.ackIDOf("flush-persistence", payload)
	if err := r.flushNow(); err != nil {
		r.log.Error("Failed to flush persistence: %v", err)
	}
	r.send(AckMessage{Type: msgAck, AckID: ackID})
}

// flushNow is the synchronous save behind both flush paths — the run loop's
// flush case (FlushPersistence, from tests and shutdown) and the
// flush-persistence message (the quit handshake). It stops the pending debounce
// timer and saves, unless the conversation is being deleted: the folder is about
// to be removed, and saving would recreate it. Runs on the worker goroutine.
func (r *run) flushNow() error {
	if r.deleting.Load() {
		return nil
	}
	r.saver.holdDebounce()
	return r.saveStateToDisk()
}

// =============================================================================
// OUTBOUND MESSAGES
// =============================================================================

func (w *ConversationWorker) send(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		w.log.Error("Failed to marshal message: %v", err)
		return
	}
	w.sendWS(data)
}

func (w *ConversationWorker) sendWS(data []byte) {
	w.callbacks.broadcast(data)
}

// reply sends a request-scoped response (an ack) to only the client that
// originated the message currently being dispatched. The doc mutations the
// request caused are broadcast separately via Yjs sync, so peers stay
// converged; only the requester needs the ack to resolve its pending call.
// Falls back to a broadcast when the origin is unknown (worker-internal
// messages) so a reply is never silently lost.
func (w *ConversationWorker) reply(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		w.log.Error("Failed to marshal reply: %v", err)
		return
	}
	// The worker's half of every round trip a viewer waits on. The viewer's
	// tape has the send and the arrival; this is the moment between, so an ack
	// timeout reads as a late worker or a late page instead of a guess.
	if ack, ok := msg.(AckMessage); ok {
		w.tape.Record("ack-sent", map[string]any{"ackId": ack.AckID, "to": w.inbox.origin()})
	}
	w.replyWS(data)
}

// replyWS is reply for a payload that is already encoded — the Yjs deltas,
// whose size makes it worth building them without the reflective encoder (see
// marshalYjsSync). Same addressing rule: the originating client, or a broadcast
// when there is no origin to answer.
func (w *ConversationWorker) replyWS(data []byte) {
	if origin := w.inbox.origin(); origin != "" {
		w.callbacks.sendTo(origin, data)
		return
	}
	w.sendWS(data)
}

func (r *run) sendStatus(status, message string) {
	r.sendStatusWithCode(status, message, nil, "")
}

// sendStatusText is sendStatus for a status line the user reads: its English as
// `message`, and the message itself as `text`, for the client to show translated.
func (r *run) sendStatusText(status string, m msg.Message) {
	r.sendStatusWithCode(status, m.English(), &m, "")
}

// sendStatusWithCode is sendStatus plus a machine-readable `code` the client can
// branch on without matching English text, and `text`, the message as a
// msg.Message when there is one (nil for text that is only data). The code is
// used for the model-validation errors so the client can tell a recoverable
// divergence (code "no-model" — self-heal by re-broadcasting its own config)
// apart from a genuinely unusable model (code "provider-unavailable" — never
// auto-retry). An empty code and a nil text are omitted on the wire.
func (r *run) sendStatusWithCode(status, message string, text *msg.Message, code string) {
	r.updateElapsedAnchor(status)
	r.writeProcessingState(status, message, text, code)
	if status == "idle" {
		if r.sched.owns(r.t) {
			// A turn goroutine's idle edge is finalized by the actor as it retires
			// the turn (finishRetiredTurn).
			r.t.completedIdle = true
		} else {
			// Reducer/cancel cleanup can publish an idle edge from the ambient actor
			// without a turn goroutine to retire. Finalize that edge here; waiting for
			// the turn's retirement would strand the completed-turn fence forever.
			r.bumpTurnCounterAtIdle()
			if r.sched.hasLive() {
				r.batcher.Flush()
			} else {
				r.finishIdleTransition()
			}
		}
	}

	// The transition as an event, beside the frame. It is the only record of a
	// resting status written while a sibling run is still live: that run's
	// entry leaves the registry and the frame's top level is republished from
	// the sibling, so the client takes notices (validation-error) from here.
	r.send(StatusMessage{
		Type:         msgStatus,
		Status:       status,
		Message:      message,
		ThreadItemID: r.t.thread.itemID,
		Code:         code,
		Text:         text,
	})
}

// updateElapsedAnchor maintains the in-memory base for the spinner's elapsed-time
// digit as `status` changes: a busy status lazily starts it, a resting one clears
// it so the next turn counts from zero.
func (r *run) updateElapsedAnchor(status string) {
	// `startedAt` is the shared timer base every client uses to render
	// the spinner's elapsed-time digit (see web/js/services/llm-state.js).
	// It must come from the doc so all clients agree: a client falling back
	// to its local Date.now() at the moment its Yjs observer fired would
	// disagree by sync latency. Lazy-init here so any path that calls
	// sendStatus(non-idle) without having set processingStartedAt still gets
	// a single shared anchor written to the doc.
	if statusHoldsClaim(status) {
		if r.t.processingStartedAt.Load() == 0 {
			r.t.processingStartedAt.Store(time.Now().UnixMilli())
		}
	} else {
		// Resting transition (idle, or a terminal-error status): clear the
		// in-memory elapsed anchor so the NEXT turn starts its timer from zero.
		// The doc's processingState already omits startedAt for resting statuses
		// (writeProcessingState); mirroring that in memory keeps the two in
		// lockstep. The
		// runStrategyLoop defer also zeroes the anchor on the normal end-of-turn,
		// but handleCancel's real-work-in-flight park branch rests via
		// sendStatus("idle") WITHOUT going through that defer — without this reset
		// the stale anchor survives, and the next Continue's dispatchCallLLMOnThread
		// sees processingStartedAt != 0, preserves it, and the spinner counts from
		// the cancelled turn's start.
		r.t.processingStartedAt.Store(0)
	}
}

// writeProcessingState publishes the frame every client renders the spinner
// from: the doc-native `processingState` blob, rebuilt from scratch on each
// call, and this run's own entry in the registry underneath it, rebuilt with it.
func (r *run) writeProcessingState(status, message string, text *msg.Message, code string) {
	// Include threadItemId so frontend knows which column to target
	stateMap := map[string]any{
		"status":       status,
		"message":      message,
		"threadItemId": r.t.thread.itemID,
	}
	if code != "" {
		stateMap["code"] = code
	}
	if text != nil {
		stateMap["text"] = *text
	}
	holdsClaim := statusHoldsClaim(status)
	if holdsClaim {
		stateMap["startedAt"] = r.t.processingStartedAt.Load()
	}

	// Terminal-error statuses release only this thread; live siblings retain their
	// claims and remain visible through the projection.
	r.replaceProcessingState(stateMap, r.t.thread.itemID, func(runs runRegistry) {
		key := runKey(r.t.thread.itemID)
		if !holdsClaim {
			delete(runs, key)
			return
		}
		entry, ok := runs[key]
		if !ok {
			entry = runEntry{}
			entry.setThreadItemID(r.t.thread.itemID)
		}
		entry.setActivity(ActivityCallingLLM)
		entry.setClaimedAt(time.Now().UnixMilli())
		entry.setStatus(processingStatus(status))
		entry.setMessage(message)
		entry.setCode(code)
		entry.setText(text)
		entry.setStartedAt(r.t.processingStartedAt.Load())
		entry.dropPhaseProgress()
		runs[key] = entry
	})
}

// bumpTurnCounterAtIdle advances the monotonic turn fence observers use to detect
// that a turn happened even when Yjs sync batching merged the whole non-idle
// window into a single update.
func (r *run) bumpTurnCounterAtIdle() {
	// Seed from the doc's current value first so the counter stays MONOTONIC
	// across a worker restart on a reloaded conversation: a fresh worker starts
	// at 0 but the persisted doc may already carry a higher count (handleInit's
	// first frame is idle, so this seed runs before any non-idle frame could
	// regress it). Without the seed the counter would go backwards and break
	// every fence observing it.
	if docTC := r.docTurnCounter(); docTC > r.turnCounter.Load() {
		r.turnCounter.Store(docTC)
	}
	next := r.turnCounter.Add(1)
	// Persist the bumped counter to its own durable top-level metadata key,
	// OUTSIDE the ephemeral processingState blob (whose other fields —
	// startedAt, live token counts, status — are rebuilt from scratch on
	// every load by handleInit). completedTurns is the one value read back
	// across a load (the monotonic turn fence), so it gets a clean key.
	r.doc.SetMetadata(keyCompletedTurns, next)
}

// finishIdleTransition closes out a completed run: it collapses any in-flight
// compaction into one undo group, ends the undo capture window so the next
// browser-originated action is its own group, and flushes the batcher so the
// browser sees the operation result AND the idle transition in one sync batch.
// Without that flush the idle metadata sits in the buffer while the browser waits
// for it, stalling strategy hooks like onWorkerIdle that drive the next phase.
//
// Called only once no turn is live, so it also hands back the App Nap defeat the
// first live turn took — including for a run that was registered and then
// abandoned before it started.
func (w *ConversationWorker) finishIdleTransition() {
	w.sched.releaseActivity()
	// If a compaction was in flight, collapse every undo group the
	// strategy added during the run into the single stack item that
	// holds the viewer's compact insert — so the user undoes the
	// whole compaction in one press. See checkForNewThreads for the
	// snapshot that captured the start index.
	if idx, ok := w.undo.takeCompactionMerge(); ok {
		w.tracker.MergeFromIndex(idx)
	}
	// Close the current undo capture window so the next browser-originated
	// action (e.g. /thread command) is recorded as a separate undo group
	// rather than being coalesced with the just-completed turn's operations.
	w.tracker.StopCapturing()
	w.batcher.Flush()
}

// sendReady answers the init being dispatched. It is addressed to the client
// that sent that init, not broadcast: "ready" means "the state you asked for
// has been sent to you", and every client's init is answered by its own. A
// broadcast ready is a foreign answer that resolves a peer's still-outstanding
// init before the delta addressed to that peer has gone out, leaving it holding
// an empty document it believes is loaded.
//
// So an init no client sent — the server's seed of a new conversation, which
// waits on its ack channel — is answered by that ack and nothing else. reply's
// broadcast fallback would otherwise send its ready to every client, and the
// engine creating that conversation is one of them, mid-init.
func (w *ConversationWorker) sendReady() {
	if w.inbox.answeredByAckAlone() {
		return
	}
	w.reply(ReadyMessage{Type: msgReady, SummarizationPrompt: DefaultSummarizationPrompt})
}

func (w *ConversationWorker) sendReadyWithMetadata(metadata map[string]any) {
	if w.inbox.answeredByAckAlone() {
		return
	}
	w.reply(ReadyMessage{Type: msgReady, Metadata: metadata, SummarizationPrompt: DefaultSummarizationPrompt})
}

// sendError reports an error Juggler words itself into the run's own thread.
func (r *run) sendError(m msg.Message) {
	r.sendErrorWithData(m.English(), &m, "", nil)
}

// sendErrorWithData reports an error into the run's own thread; see sendErrorTo.
func (r *run) sendErrorWithData(message string, text *msg.Message, stack string, data map[string]any) {
	r.sendErrorTo(r.t.thread, message, text, stack, data)
}

// sendErrorTo appends an error item to dest (visible in the UI via Yjs sync)
// and sends the same error on the wire, with its stack, for logging. message is
// the English the item stores as Content; text is the message it was rendered
// from, stored in Data as "message" for the transcript to show translated, or
// nil for text that is only data (a provider's or the OS's own words).
func (r *run) sendErrorTo(dest threadContext, message string, text *msg.Message, stack string, data map[string]any) {
	summary := extractErrorSummary(message)
	msg := ConversationItem{
		Type:      ItemTypeError,
		ItemID:    generateItemID(),
		Content:   message,
		Summary:   summary,
		Timestamp: time.Now().Format(time.RFC3339),
	}
	if text != nil {
		withText := make(map[string]any, len(data)+1)
		for k, v := range data {
			withText[k] = v
		}
		withText["message"] = *text
		data = withText
	}
	if data != nil {
		msg.Data, _ = json.Marshal(data)
	}
	r.appendMessageTo(dest, msg)

	r.send(ErrorMessage{
		Type:    msgError,
		Message: message,
		Summary: summary,
		Stack:   stack,
	})
}

// sendYjsSync broadcasts one Yjs update — the single funnel for both the
// streaming path (the batcher, many frames per second) and full-state
// broadcasts, which is why its payload is built by marshalYjsSync rather than
// by the reflective encoder in send.
func (w *ConversationWorker) sendYjsSync(update []byte) {
	w.sendWS(marshalYjsSync(update, false))
}

func (w *ConversationWorker) sendUndoState(canUndo, canRedo bool) {
	// Store undo state in Yjs metadata for reactive UI updates (no messages).
	// The map is replaced wholesale, so seq must ride along unchanged
	// (SCHEMA.md: undoState is {canUndo, canRedo, seq}): omitting it would
	// erase the sequence the tracker's emitUndoState stamped, breaking every
	// reader that keys on seq to tell "the stack moved" from a re-emit.
	w.doc.SetMetadata(keyUndoState, map[string]any{
		"canUndo": canUndo,
		"canRedo": canRedo,
		"seq":     w.tracker.UndoSeq(),
	})
}

func (w *ConversationWorker) sendRenderContextItemsRequest(requestID string, itemIDs []string) {
	w.send(RenderContextItemsRequest{
		Type:      msgRenderContextItemsRequest,
		RequestID: requestID,
		ItemIDs:   itemIDs,
		SentAt:    time.Now().UnixMilli(),
	})
}

// =============================================================================
// DOCUMENT OBSERVER (Pure Document-Driven Approval Flow)
// =============================================================================

// setupDocumentObserver registers the items array observer for approval flow.
// This enables pure document-driven state transitions with no polling.
func (w *ConversationWorker) setupDocumentObserver() {
	// The observer fires on whichever goroutine did the Transact(), which may not
	// be the run() goroutine, so it only signals.
	w.doc.RegisterItemsObserver(w.signalItemsChange)
}

// signalItemsChange asks the run loop for an items-change pass. Callable from
// any goroutine, and never blocks: a signal already pending covers this one.
func (w *ConversationWorker) signalItemsChange() {
	select {
	case w.docChangeChan <- struct{}{}:
	default:
	}
}

// handleItemsChange reacts to document state changes.
// Called automatically after any items mutation.
//
// CRITICAL: This is the core of the document-driven approval flow.
// All state transitions happen through observation, not polling.
func (r *run) handleItemsChange() {
	// Suppressed while applying an undo/redo: the UndoManager's mutations
	// arrive through the same observer that drives the reducer, and we must
	// not let those mutations re-trigger the strategy loop (e.g. by
	// re-firing on a restored thread + trailing user message). See
	// handleUndoOrRedo's wrapping.
	if r.undo.observerIsMuted() {
		return
	}

	// History navigation is a user-directed rollback/replay, not a request to
	// advance the LLM state machine. Browser/engine Yjs echoes can arrive after
	// the synchronous UndoManager transaction and reintroduce stale
	// activity="awaiting_llm"; clear it and skip the reducer until an explicit
	// user action (send/continue/approve/retry/rerun) starts a new LLM intent.
	if r.undo.inNavRecoil(time.Now()) {
		r.releaseAllLLM()
		r.sched.dropReconcile()
		return
	}
	r.tape.Record("items-change", map[string]any{
		"itemCount": r.doc.GetItemsLength(),
		"state":     string(r.loadState()),
	})
	// Cancel any turn whose thread the browser deleted: every live run, since this
	// observer usually runs on the run loop, whose ambient turn reads Idle while
	// the turns stream on goroutines of their own; then the ambient turn itself.
	r.stopLiveRunsWhere(cancelReasonThreadDeleted, func(threadID string) bool {
		return threadID != "" && r.doc.GetThreadYMap(threadID) == nil
	})
	if r.loadState() == StateProcessing && r.t.thread.itemID != "" {
		if r.doc.GetThreadYMap(r.t.thread.itemID) == nil {
			r.handleCancel(cancelReasonThreadDeleted)
		}
	}

	// DOCUMENT-DRIVEN THREAD PROCESSING: When a thread is inserted with
	// items (including a user message) and no result, automatically process it.
	// This enables compact commands and plugins to be pure yjs mutations.
	r.checkForNewThreads()

	// Signal the reducer to evaluate the thread state. The reducer is the
	// sole dispatcher for all LLM calls — tool completions, thread
	// completions, user messages, and new threads all flow through here.
	r.reconcileThread()

	// Drive any strategy-written pendingRequests entries one step forward
	// (including starting/cancelling task-output delivery pumps). Cheap no-op if
	// no entries are pending.
	r.scanPendingRequests()
}

// checkForNewThreads scans root items for threads marked with needsStrategyRun=true
// that need processing (no result yet). This enables doc-driven thread processing:
// plugins set needsStrategyRun on the thread, the worker picks it up.
//
// Double-dispatch is prevented by the activity claim: claimLLM fails if any
// operation is already in flight (including a previous call to this function
// that returned with activity="awaiting_llm" while tools execute).
//
// Only threads with needsStrategyRun=true are auto-processed. User-created threads
// (via /thread command) and LLM-created threads (via create_thread tool) are
// NOT auto-processed — they go through handleSendMessage or the strategy loop.
//
// Returns true when it picked a thread up — claimed it, marked the conversation
// busy and handed the run to the run() loop — so the reducer can re-evaluate
// from a clean state rather than continuing a walk-down built on stale data.
func (r *run) checkForNewThreads() bool {
	// Read the root's threads straight from the CRDT, once, under one lock. This
	// runs on every items change and every reducer pass, and only the thread
	// maps' own flags matter here — converting the root items would copy every
	// sub-thread's whole transcript to answer that.
	type rootThread struct {
		itemID       string
		noAutoSelect bool
	}
	var candidates []rootThread
	withYDoc(func() {
		if root := r.doc.getItems(); root != nil {
			for _, raw := range root.ToArray() {
				threadYMap, ok := raw.(*ycrdt.YMap)
				if !ok {
					continue
				}
				if itemType := yMapString(threadYMap, keyType); itemType != ItemTypeThread {
					continue
				}
				itemID := yMapString(threadYMap, keyItemID)
				needsStrategyRun := yMapBool(threadYMap, keyNeedsStrategyRun)
				if itemID == "" || !needsStrategyRun || threadRunSettledLocked(threadYMap) {
					continue
				}
				noAutoSelect := yMapBool(threadYMap, keyNoAutoSelect)
				candidates = append(candidates, rootThread{itemID: itemID, noAutoSelect: noAutoSelect})
			}
		}
	})

	for _, candidate := range candidates {
		threadID := candidate.itemID

		// Polite stop (Pause): a mark stands over this thread, so the pickup leaves
		// it exactly as it is. `continue` rather than `return`, because a mark is
		// scoped — an uncovered thread further down the array is still eligible.
		//
		// This is the one gate that has to be read BEFORE the claim rather than at
		// the turn's own boundary. Claiming publishes a busy frame naming a paused
		// thread (so every column swaps "Paused" back for "Pausing…" and spins) and
		// consumes needsStrategyRun below, which is a ONE-SHOT trigger: the run it
		// licenses then rests at runOneTurn's gate having done nothing, and the
		// reducer will not re-drive a thread whose trigger is spent. Resting here
		// instead leaves the trigger armed, which is what handleUnpause resumes.
		if r.politeStopCovers(threadID) {
			continue
		}

		// A thread with no items array has nothing to run. beginTurn re-resolves
		// the array the run actually runs against, and startPreparedThreadRun
		// abandons a run whose array has gone by the time the loop starts it.
		if r.doc.GetThreadItemsArray(threadID) == nil {
			continue
		}

		modelConfig := r.doc.ResolveEffectiveModelConfig(threadID)
		if modelConfig == nil || modelConfig.Model == "" {
			continue
		}

		// Reserve the thread's capability slot before claiming it. Re-tickle on
		// failure: needsStrategyRun is consumed only after both checks succeed, and
		// releasing another thread's claim does not fire the items observer.
		if !r.canAdmitThread(threadID) || !r.claimLLM(threadID) {
			r.sched.markReconcile()
			return false
		}

		r.log.Debug("Auto-processing thread %s (doc-driven)", threadID)
		// Compaction-style threads (noAutoSelect) must undo as a single
		// atomic operation from the user's perspective — they didn't
		// author the LLM turns inside the sub-thread, only the act of
		// asking for the compaction. The viewer's compact insert has
		// already been captured as the top of the UndoStack by the time
		// we get here (handleYjsSync ran first); snapshot that index so
		// every group the strategy adds during the run can be collapsed
		// back into it on idle. Regular sub-threads (the user typed
		// /thread, or the LLM did create_thread) DO get their natural
		// per-turn grouping — we only merge for noAutoSelect.
		if candidate.noAutoSelect {
			r.undo.markCompactionStart(r.tracker.UndoStackLen() - 1)
		}
		// Consume the one-shot trigger before running. Completion is tracked by
		// the thread result; cancellation must not leave a persistent trigger that
		// restarts the thread immediately on the next observer tick.
		r.clearThreadNeedsStrategyRun(threadID)

		// Publish the busy frame HERE, not in startPreparedThreadRun — the pickup,
		// not the start, is the moment this conversation became busy, and the run
		// loop starts the run as a later iteration. Every dispatch gate reads this
		// state, so leaving it idle across the hand-off would let the reducer keep
		// evaluating a conversation whose next run is already decided. It is also
		// what the UI renders: the claim is doc-native state it does not show, so
		// without this the conversation reads as idle — no spinner, no status — for
		// the whole window before the run writes a status of its own.
		//
		// Turn-scoped anchor (see dispatchCallLLMOnThread): set once at turn start,
		// preserved across re-dispatches so the elapsed digit spans the whole turn.
		if r.t.processingStartedAt.Load() == 0 {
			r.t.processingStartedAt.Store(time.Now().UnixMilli())
		}
		r.storeState(StateProcessing)
		r.sendStatus("preparing", "")
		r.batcher.Flush()

		r.dispatchThreadRun(threadID)
		return true // Process one thread at a time
	}
	return false
}

// dispatchThreadRun hands a thread checkForNewThreads has claimed and marked
// busy to the run() loop, which starts its run as its own loop iteration. The
// pickup is reachable from inside a turn (promotePendingItems →
// handleItemsChange), and a run started there would execute underneath the turn
// that noticed it; posting makes the loop the only place a doc-driven run
// begins.
//
// The claim and the busy state are what make the gap between post and start
// safe: every dispatch gate refuses while they hold, so nothing else can start a
// run in the window, and the buffered slot cannot be contended.
func (r *run) dispatchThreadRun(threadItemID string) {
	tr := r.beginTurn(threadItemID)
	if !r.sched.postDispatch(tr.t) {
		r.log.Error("Thread dispatch queue full, re-arming pickup for %s", threadItemID)
		r.sched.unregister(tr.t)
		r.setThreadNeedsStrategyRun(threadItemID)
		r.abandonThreadRun(threadItemID)
	}
}

// startPreparedThreadRun starts a claimed thread whose admission reservation is
// already present in the live-run registry. Run goroutine only: the run loop's
// sched.dispatches() case. A thread deleted since it was claimed is abandoned.
func (r *run) startPreparedThreadRun(t *turnState) {
	tr := r.runFor(t)
	threadItemID := tr.t.thread.itemID
	if threadItemID == "" || !r.doc.HasThread(threadItemID) {
		r.sched.unregister(tr.t)
		r.abandonThreadRun(threadItemID)
		return
	}
	tr.storeState(StateProcessing)
	r.runTurn(tr, func(tr *run) { tr.runStrategyLoop("", true) })
}

// abandonThreadRun undoes the pickup for a thread whose run never started: it
// hands back the claim and the busy frame checkForNewThreads published, so the
// conversation rests rather than reporting a turn that will never write to it,
// and asks the reducer for the pass that settles what is left.
func (r *run) abandonThreadRun(threadItemID string) {
	r.releaseLLM(threadItemID)
	r.storeState(StateIdle)
	r.t.processingStartedAt.Store(0)
	r.sendStatus("idle", "")
	r.requestReconcile()
}

// setThreadNeedsStrategyRun re-arms the one-shot doc-driven run trigger on a
// thread, so checkForNewThreads picks it up and runs it again.
func (w *ConversationWorker) setThreadNeedsStrategyRun(threadItemID string) {
	w.writeThreadNeedsStrategyRun(threadItemID, true)
}

// rearmPausedFold re-arms the run trigger on a fold a pause stopped before its
// summary, and reports whether the thread was such a fold. Decided and written
// in one hold (setFlagOnUnfinishedFold); tracked like writeThreadNeedsStrategyRun.
func (w *ConversationWorker) rearmPausedFold(threadItemID string) bool {
	return w.doc.setFlagOnUnfinishedFold(threadItemID, keyNeedsStrategyRun, w.doc.transactTracked)
}

// clearThreadNeedsStrategyRun consumes the one-shot trigger, so a run that is
// cancelled or completed isn't restarted on the next observer tick.
//
// One-shot means exactly that: nothing re-arms it, and the reducer's walk will
// not stand in for it, so a run this licenses that then rests without finishing
// leaves a thread nothing can start again. That is why the pickup asks about the
// pause BEFORE consuming it, and why the paused settle re-arms it for a fold
// (polite_stop.go).
func (w *ConversationWorker) clearThreadNeedsStrategyRun(threadItemID string) {
	w.writeThreadNeedsStrategyRun(threadItemID, false)
}

// writeThreadNeedsStrategyRun writes the trigger through setThreadFlag, which
// owns the one-hold resolve-and-write rule. The write is tracked (undoable)
// because arming a run is a document edit, not display state.
func (w *ConversationWorker) writeThreadNeedsStrategyRun(threadItemID string, needed bool) {
	w.doc.setThreadFlag(threadItemID, keyNeedsStrategyRun, needed, w.doc.transactTracked)
}

// markFoldUnsummarized records that a folded-compaction thread's summarizer run
// ended without writing a summary, and reports whether the thread was still such
// a fold. It asks that of the thread in the same hold as the write
// (setFlagOnUnfinishedFold), so a summary committed or a refold applied after
// the run ended is answered for rather than marked over.
//
// This state has to be explicit because the fold has already committed by the
// time the summarizer runs: the transcript is inside the sub-thread and the
// parent holds nothing but the fold tile, so a summarizer that stops without a
// result leaves a conversation that reads as empty. Nothing retries it — the
// one-shot needsStrategyRun trigger is deliberately consumed before the run
// (see clearThreadNeedsStrategyRun) so a cancelled run cannot restart itself on
// the next observer tick — and cancellation writes no error item either. Without
// this flag the outcome is indistinguishable from a fold whose summarizer never
// started, and the viewer's Re-summarise affordance has nothing to key on.
//
// Written untracked, as is its clearing: this is derived state about a run's
// outcome, not an edit the user made, so it must not be what an undo peels off.
func (w *ConversationWorker) markFoldUnsummarized(threadItemID string) bool {
	return w.doc.setFlagOnUnfinishedFold(threadItemID, keyCompactionUnsummarized, w.doc.transactInternal)
}

// clearCompactionUnsummarized drops the marker once a summary exists again, or
// when one is about to be attempted.
func (w *ConversationWorker) clearCompactionUnsummarized(threadItemID string) {
	w.doc.setThreadFlag(threadItemID, keyCompactionUnsummarized, false, w.doc.transactInternal)
}

// hasIncompleteThreads returns true if any thread item in the current target
// has a run still going (child thread in progress, or not yet started).
//
// Asked per ITEM, not per thread: a call into a session that has already been
// called before stands as its own alias item, and each item is parked on the one
// run it made rather than on whatever that thread most recently did.
func (r *run) hasIncompleteThreads() bool {
	items := r.getTargetItems()
	for _, item := range items {
		if item.Type == ItemTypeThread && !itemRunSettled(items, item) {
			return true
		}
	}
	return false
}

// hasIncompleteTools returns true if any tool-action in the run's own thread
// hasn't finished.
func (r *run) hasIncompleteTools() bool {
	return r.hasIncompleteToolsIn(r.t.thread)
}

// hasIncompleteToolsIn returns true if any tool-action in dest hasn't finished.
func (w *ConversationWorker) hasIncompleteToolsIn(dest threadContext) bool {
	for _, item := range w.itemsIn(dest) {
		if item.Type != ItemTypeToolAction {
			continue
		}
		if !isToolTerminal(item) {
			return true
		}
	}
	return false
}
