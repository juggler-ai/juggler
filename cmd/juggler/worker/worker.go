//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime/debug"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/mailbox"
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

// threadContext names one items array a write can land in: a thread's nested
// array, or the root conversation's for the zero value. A turn carries the one it
// writes to (turnState.thread); a handler that writes somewhere else resolves its
// own with resolveThread and passes it, rather than re-pointing a turn.
type threadContext struct {
	itemID     string
	itemsArray *ycrdt.YArray
}

// ConversationWorker handles conversation orchestration.
// All state is owned by a single goroutine - no mutexes needed.
// Messages come in via the inbound channel and are processed sequentially.
// elapsedAnchor is everything behind the spinner's elapsed digit. The whole
// timer is one number the clients subtract from now(); the rest of this group
// exists to keep that number honest — excluding time parked at an approval
// prompt, and excluding wall-clock the process spent frozen.
//
// Its methods are updateElapsedAnchor, updateApprovalWaitAnchor and
// detectFrozenGap. Run goroutine only.
type elapsedAnchor struct {
	// livenessTicker fires ~every livenessInterval while run() executes, giving
	// detectFrozenGap a heartbeat. There is no OS event for "the wall clock jumped
	// while we weren't running", so the only way to notice a suspended process is to
	// observe that an expected tick arrived late. Created in run(), stopped on
	// shutdown; nil in workers that never run (unit tests) — read via livenessC().
	livenessTicker *time.Ticker
	// lastLivenessMs is the wall-clock millis of the previous liveness tick (0 before
	// the first). detectFrozenGap compares each tick against it: a gap far larger than
	// livenessInterval means the process was frozen (sleep, hibernate, VM/host suspend,
	// a stop-the-world pause) and that dead time is excluded from the elapsed digit.
	// Owned solely by the run() goroutine.
	lastLivenessMs int64
}

// undoCoalescer is the undo/history machinery: the two "collapse everything
// added since this index into one entry" marks, and the two suppressions that
// stop a history step from being read as fresh user intent.
//
// Both indices use -1 for "nothing in flight", so a zero value is NOT valid —
// NewConversationWorker sets them explicitly. Run goroutine only.
type undoCoalescer struct {
	// suppressItemsChange, when true, makes handleItemsChange a no-op. Set
	// for the duration of an undo/redo so the document mutations the
	// UndoManager applies don't kick the reducer (which would otherwise see
	// e.g. a restored thread + trailing user message and immediately
	// dispatch ActionCallLLM, undoing the user's undo in front of their
	// eyes). The flag is set on the event-loop goroutine and read on the
	// same goroutine via the items observer, so a plain bool is sufficient.
	suppressItemsChange bool
	// suppressReconcileAfterHistoryNavUntilMs is set briefly after undo/redo.
	// Browser/engine Yjs sync echoes can arrive after the synchronous
	// UndoManager transaction and reintroduce a stale
	// processingState.activity="awaiting_llm" marker. During this short recoil
	// window, doc updates still apply/save, but they must not drive the thread
	// reducer forward from whatever last item shape the history step exposed
	// (user, completed tool, completed thread, meta result, etc.). Explicit
	// send/continue intent clears the window immediately; otherwise it expires
	// so later user actions delivered as Yjs sync (e.g. approval clicks) work.
	suppressReconcileAfterHistoryNavUntilMs int64
	// compactionMergeFromIdx, when >= 0, is the UndoStack index whose entry
	// holds the viewer-side compaction insert. While set, every undo group
	// the strategy adds during the compaction run will be collapsed into
	// that single entry on idle, so the whole compaction (insert + every
	// LLM turn + result) undoes as one user action. -1 means "no
	// compaction in flight."
	compactionMergeFromIdx int
	// undoCoalesceFromIdx, when >= 0, is the UndoStack index captured at the
	// start of a browser-driven multi-step command (e.g. /clear: wipe history +
	// re-seed auto items). On the matching end marker, every undo group added
	// since is collapsed into that single entry so the whole command undoes as
	// one user action. -1 means "no coalescing in flight." Set/read only on the
	// run() goroutine via the begin/end-undo-coalesce handlers.
	undoCoalesceFromIdx int
}

// persistence is how the doc reaches disk: the save debounce, the dirty flag,
// the synchronous flush seam, and the two out-of-doc stores whose bytes live
// beside the doc rather than in it.
//
// txnStore and assetStore are nil until handleInit knows projectPath.
type persistence struct {
	// Persistence
	//
	// saveTimer is the debounce timer, touched ONLY on the run() goroutine (see
	// armSaveDebounce). scheduleSave cannot re-arm it directly: the Yjs sync
	// callback invokes scheduleSave on whichever goroutine did the Transact(),
	// and a turn goroutine writing the document makes that genuinely concurrent
	// with run(). So scheduleSave signals saveRequest and the run loop owns the
	// timer.
	saveTimer *time.Timer
	// saveRequest carries "the document changed, re-arm the debounce" from any
	// goroutine to the run loop. Buffered by one and sent to non-blockingly: a
	// burst coalesces into a single re-arm, which is what a debounce wants
	// anyway.
	saveRequest chan struct{}
	saveChan    chan struct{} // Timer goroutine signals here; run loop does the actual save
	dirty       atomic.Bool   // true when doc has unsaved changes since last successful save
	// flushReq lets tests (or shutdown) force-save synchronously without
	// waiting on the SaveDebounceTime timer. Each request carries a reply
	// chan that the run loop signals after the save completes.
	flushReq chan chan error
	// Per-conversation transaction blob store (input/output context for each
	// LLM round-trip). Initialized in handleInit once projectPath is known.
	txnStore *TransactionStore
	// Per-conversation content-addressed asset store (attached images, etc.).
	// Bytes live out-of-doc under <convDir>/assets/; the doc holds only refs.
	// Initialized in handleInit once projectPath is known.
	assetStore *AssetStore
}

// toolDrive is the state driveToolActions runs on: per-toolUseId delivery
// bookkeeping, how long to wait before re-dispatching a command still stuck at
// the state it was last sent at, the running task-output delivery pumps, and
// the per-thread strategy snapshot that makes a live strategy switch detectable.
//
// Run goroutine only.
type toolDrive struct {
	// tools holds the per-toolUseId tool-command delivery bookkeeping — the state a
	// command was last dispatched at, its dispatch time, and the attempt count (see
	// tool_command_state.go). driveToolActions consults it to re-dispatch only when
	// the doc still demands a command and the last dispatch at that state has aged
	// past redriveInterval, and to escalate past maxToolCommandAttempts. Run
	// goroutine only.
	tools *toolCommandTracker
	// redriveInterval is how long driveToolActions waits before re-dispatching a
	// tool-command still stuck at the state it was last sent at. A field (defaulting
	// to defaultRedriveInterval) so tests can shrink it to force staleness.
	redriveInterval time.Duration
	// deliveryPumps tracks running task-output delivery pumps, keyed by the
	// owning pendingRequests entry id. Each pump polls a background task and
	// injects its new output into a thread as turn-boundary messages (see
	// task_delivery.go) — a generic capability any plugin can request via a
	// `deliverTaskOutput` pending request. Touched only on the run() goroutine
	// (scanPendingRequests / handleDeliveryEnded / onShutdown); the pump goroutines
	// communicate back via w.Send.
	deliveryPumps map[string]*taskDeliveryPump
	// lastReconciledStrategyIDs records each thread's effective strategy as of the
	// last reconcile tick, keyed by threadItemID ("" = root; empty strategy
	// normalized to "default"). Strategy is per-thread, so the switch detection is
	// per-thread: driveToolActions compares each thread's current effective
	// strategy against its recorded value to detect a live switch and re-evaluate
	// that thread's tool-actions parked awaiting approval under the OLD policy (see
	// reevaluatePendingToolsOnStrategyChange). strategyBaselineSet guards the first
	// observation, which only records the baseline — never resetting freshly-loaded
	// tools on startup.
	lastReconciledStrategyIDs map[string]string
	strategyBaselineSet       bool
	// sweptDenials holds the toolUseId of every tool-action observed cancelled as
	// of the last reconcile tick. A denial refuses the whole batch, so a cancelled
	// call that was not in this set is a fresh denial whose unstarted siblings
	// still need refusing (see cascadeBatchDenials). Rebuilt each tick, so it is
	// bounded by the cancelled tools in the doc and a tool reset back out of
	// cancelled (retry-approval) is forgotten and can trigger again. Touched only
	// on the run() goroutine, like the strategy baseline above.
	// denialBaselineSet guards the first observation, which only records: a
	// conversation loaded with a denial already in it is a batch whose cascade
	// happened when it was denied, not one to re-run against a doc whose parked
	// calls may since have been retried.
	sweptDenials      map[string]bool
	denialBaselineSet bool
}

type ConversationWorker struct {
	// Grouped state, embedded so every call site still reads w.<field>.
	// See each type for what it owns and which goroutine may touch it.
	elapsedAnchor
	undoCoalescer
	persistence
	toolDrive

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

	// pathProvider resolves convID → on-disk folder path. Used for reads
	// and to locate the per-conversation transaction folder. Set at
	// construction by the Manager; called on every load so a rename
	// mid-life is naturally seen on the next I/O.
	pathProvider PathProviderFunc

	// nameProvider resolves convID → the conversation's human-readable name.
	// Set at construction by the Manager; called on every use so a rename
	// mid-life is seen immediately. nil until then, and the worker treats an
	// unresolved name as "not known" rather than guessing at one.
	nameProvider NameProviderFunc

	// saveBinary persists the Yjs doc. The implementation creates the
	// conversation folder if it doesn't exist (e.g. brand-new convs and
	// duplicates) and writes atomically. Set at construction by the Manager.
	saveBinary SaveBinaryFunc

	doc     *ConversationDocument
	tracker *OperationTracker

	// tape is a per-worker ring buffer that records timestamped events when
	// JUGGLER_TRACE is set. Used by the test runner's failure-dump endpoint
	// to splice the worker's view alongside JS-side iframe tapes so cross-
	// process races become visible at the failure site. No-op when tracing
	// is off (single boolean test in Record).
	tape *EventTape

	// Channels for message passing. inbound is the consumer end of inboundQ,
	// an unbounded FIFO; Send enqueues via inboundQ so intake never drops (see
	// inbound_queue.go). The run loop and the streaming wait loops are the sole
	// consumers and read inbound directly.
	inboundQ *mailbox.Queue[workerMessage]
	inbound  <-chan workerMessage
	done     chan struct{}
	stopped  chan struct{}

	// turn is the run currently in flight: the thread it writes to, the
	// round-trip in flight, and the accumulators that outlive a chunk but not the
	// run. Always non-nil; see turn.go for why these live together.
	turn *turnState

	// Per-client outbound callbacks. Owned by a dedicated actor goroutine
	// (see callback_registry.go); all ops route through callbacks.ch.
	callbacks *callbackRegistry

	// LLM calling
	llmCallFunc LLMCallFunc
	// windowResolver maps the conversation's effective model to its context
	// window and output reserve. Nil (tests / not wired) ⇒ unknown window. See
	// WindowResolverFunc.
	windowResolver WindowResolverFunc
	// autoCompactGate reports whether automatic compaction is enabled. Nil
	// (tests / not wired) ⇒ enabled, preserving the default-on behavior. Note
	// the polarity is the inverse of windowResolver (nil there means unknown).
	// See AutoCompactGateFunc.
	autoCompactGate AutoCompactGateFunc
	// autoNameFunc is the injected server callback fired once, on the first user
	// message of the root conversation, to auto-name the tab out-of-band. Nil
	// (tests / not wired) ⇒ no auto-naming. See AutoNameFunc.
	autoNameFunc AutoNameFunc
	// engineReadyFunc brings the on-demand engine WebView up and waits until it
	// is connected, returning false if it could not. Used by the worker to
	// guarantee the engine is present before dispatching a strategy hook to it
	// at turn-start (the LLM-call gate runs too late for onActivate, whose
	// guidance must be in the doc before the turn's messages are built). Nil in
	// tests / the test-pool, where the engine is an always-on iframe — treated
	// as always-ready.
	engineReadyFunc func() bool
	// cancelLLMSession releases provider-side LLM session state for this
	// conversation, preserving the resume token + prompt-cache anchor so the
	// next turn stays warm. Today only the claudecode provider has anything to
	// do here (kill its parked CLI subprocess; the warm session survives).
	cancelLLMSession CancelLLMSessionFunc

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

	// mock is non-nil iff this worker is under test with scripted LLM
	// responses installed. See mock_llm.go. Production binaries leave it nil.
	mock *mockLLMCaller

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

	// The conversation's cumulative token spend — new input, and billed output —
	// and the resolver for the ceiling that stops delegated work past it. See
	// spend.go, which owns every rule here.
	//
	// Atomic for the same reason turnCounter is, only more so: sibling threads
	// stream side by side on their own goroutines (canAdmitThread), so several
	// runs record into these at once. Each is advanced by a compare-and-swap that
	// also folds in the persisted figure (addSpendFloored), which is what keeps
	// the count both lossless under that concurrency and monotonic across a
	// reload.
	spendInput  atomic.Int64
	spendOutput atomic.Int64
	spendLimit  SpendLimitFunc

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

	// replyTo is the client ID that originated the message currently being
	// dispatched, or "" for worker-internal messages. Set at the top of
	// dispatchMessage and consumed by reply() to route an ack back to only the
	// requester. Safe without a lock: the run loop dispatches one message at a
	// time on a single goroutine, and acks are sent synchronously within that
	// dispatch.
	replyTo string
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
		toolDrive: toolDrive{
			tools:                     newToolCommandTracker(),
			redriveInterval:           defaultRedriveInterval,
			deliveryPumps:             make(map[string]*taskDeliveryPump),
			lastReconciledStrategyIDs: make(map[string]string),
			sweptDenials:              make(map[string]bool),
		},
		persistence: persistence{
			saveChan:    make(chan struct{}, 1),
			saveRequest: make(chan struct{}, 1),
			flushReq:    make(chan chan error, 4),
		},
		// Both marks mean "nothing in flight" at -1, so the zero value would
		// read as "collapse everything from entry 0".
		undoCoalescer: undoCoalescer{
			compactionMergeFromIdx: -1,
			undoCoalesceFromIdx:    -1,
		},
	}
	// Created after w.done, which its reply slots share so a blocked test client
	// is released when the worker stops.
	w.engine = newEngineSession(w.done)

	// Unbounded, order-preserving intake. Created after w.done so the pump's
	// lifetime is tied to the worker; Send enqueues here so it never drops.
	w.inboundQ = mailbox.NewQueue[workerMessage](w.done)
	w.inbound = w.inboundQ.Out()
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

// SetPathProvider injects the per-conversation path resolver. Idempotent.
// Called by the Manager when the worker is created and again if the
// provider is replaced (e.g. on project switch).
func (w *ConversationWorker) SetPathProvider(fn PathProviderFunc) {
	w.pathProvider = fn
	if w.txnStore != nil {
		w.txnStore.SetPathProvider(fn)
	}
	if w.assetStore != nil {
		w.assetStore.SetPathProvider(fn)
	}
}

// SetNameProvider injects the per-conversation name resolver. Idempotent.
// Called by the Manager when the worker is created and again if the provider
// is replaced (e.g. on project switch).
func (w *ConversationWorker) SetNameProvider(fn NameProviderFunc) {
	w.nameProvider = fn
}

// SetSaveBinary injects the doc-persistence callback. Idempotent.
func (w *ConversationWorker) SetSaveBinary(fn SaveBinaryFunc) {
	w.saveBinary = fn
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

// Start begins the worker's message processing loop.
func (r *run) Start(ctx context.Context) {
	go r.run(ctx)
}

func (r *run) Stop() {
	// Cancel every in-flight LLM call first — this run's and any turn goroutine's
	// — so their wait loops return promptly instead of parking on the LLMTimeout
	// backstop.
	for _, t := range r.allTurnStates() {
		if p := t.cancelLLM.Load(); p != nil {
			(*p)()
		}
	}
	close(r.done)
	<-r.stopped
	// The loop has gone, so nothing more can be dispatched and this snapshot is
	// final. Wait the turns out: they unwind on r.done, and a turn still writing
	// to the document after Stop returns would be writing into a doc the caller
	// is about to destroy.
	for _, e := range r.sched.runs() {
		<-e.t.finished
	}
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
	if r.cancelLLMSession != nil {
		// Every thread: the conversation itself is going, so there is no thread
		// left whose session should survive.
		r.cancelLLMSession(r.conversationID, provider.CancelAllThreads)
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
	w.inboundQ.Push(workerMessage{Type: msgType, Payload: payload, OriginClient: clientID})
}

// SendAndWait queues a worker-internal message and blocks until the run loop has
// processed it. It is for server-side initialization barriers, not normal viewer
// traffic.
func (w *ConversationWorker) SendAndWait(ctx context.Context, msgType string, payload json.RawMessage) error {
	ack := make(chan error, 1)
	w.inboundQ.Push(workerMessage{Type: msgType, Payload: payload, Ack: ack})
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

// SetLLMCaller sets the function used to call the LLM provider directly.
func (w *ConversationWorker) SetLLMCaller(fn LLMCallFunc) {
	w.llmCallFunc = fn
}

// SetWindowResolver injects the read-only context-window resolver. See
// WindowResolverFunc.
func (w *ConversationWorker) SetWindowResolver(fn WindowResolverFunc) {
	w.windowResolver = fn
}

// resolveContextWindow maps the conversation's effective model to its context
// window and output reserve (tokens) via the injected resolver. Returns the
// zero value when no resolver is wired (tests) or the model is unknown; callers
// read a non-positive window as "unknown".
func (r *run) resolveContextWindow() ContextWindowInfo {
	if r.windowResolver == nil {
		return ContextWindowInfo{}
	}
	mc := r.resolveModelConfig()
	if mc == nil {
		return ContextWindowInfo{}
	}
	return r.windowResolver(*mc)
}

// SetAutoCompactGate injects the gate that governs whether automatic proactive
// and reactive compaction runs. See AutoCompactGateFunc.
func (w *ConversationWorker) SetAutoCompactGate(fn AutoCompactGateFunc) {
	w.autoCompactGate = fn
}

// autoCompactEnabled reports whether automatic compaction is enabled. A nil gate
// (tests / not wired) is treated as enabled, preserving default-on behavior.
func (w *ConversationWorker) autoCompactEnabled() bool {
	return w.autoCompactGate == nil || w.autoCompactGate()
}

// SetAutoNamer registers the out-of-band tab auto-naming callback. See
// autoNameFunc / AutoNameFunc.
func (w *ConversationWorker) SetAutoNamer(fn AutoNameFunc) {
	w.autoNameFunc = fn
}

// SetEngineReadyFunc registers the gate that brings the on-demand engine up and
// waits for it to connect. The worker calls it before dispatching a strategy
// hook to the engine at turn-start. See engineReadyFunc.
func (w *ConversationWorker) SetEngineReadyFunc(fn func() bool) {
	w.engineReadyFunc = fn
}

// SetCancelLLMSession registers the provider-side cancellation hook used by
// handleCancel when the worker is waiting for a tool result and there is no
// in-flight LLM ctx to cancel.
func (w *ConversationWorker) SetCancelLLMSession(fn CancelLLMSessionFunc) {
	w.cancelLLMSession = fn
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

// livenessC returns the liveness ticker's channel, or nil when there is no ticker
// (a worker that never entered run(), e.g. a unit test driving callLLM directly).
// A nil channel simply never fires, so the select cases degrade to no-ops.
func (w *ConversationWorker) livenessC() <-chan time.Time {
	if w.livenessTicker == nil {
		return nil
	}
	return w.livenessTicker.C
}

// detectFrozenGap keeps the elapsed-time digit counting only wall-clock time this
// process was actually running. Clients render the digit as (now - startedAt) against
// one shared anchor, so any span the machine spent frozen — system sleep, hibernation,
// a suspended VM, a stop-the-world pause — would otherwise inflate it even though no
// work happened. There is no event for "the wall clock jumped", so we poll: the
// liveness ticker fires ~every livenessInterval while run() executes, and a tick that
// lands far later than that interval measures how long we were frozen. We push the
// anchor forward by that excess (the same exclusion the approval-wait path applies via
// advanceElapsedAnchor), so the digit resumes with the dead time removed.
//
// Deliberately not sleep-specific: it corrects for ANY cause of missed ticks, which is
// why it doesn't hook the sleep/wake notification. Runs only on the run() goroutine;
// the anchor it corrects belongs to the turn that is streaming, which is why that
// field is atomic.
func (r *run) detectFrozenGap() {
	now := time.Now().UnixMilli()
	last := r.lastLivenessMs
	r.lastLivenessMs = now
	if last == 0 {
		return // first tick of the run — nothing to compare against yet
	}
	excess := now - last - livenessInterval.Milliseconds()
	if excess < frozenGapThresholdMs {
		return // normal cadence (or a backward clock step) — not a freeze
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
	case w.flushReq <- ack:
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

// SweepTransactionsForTest synchronously runs the transaction blob GC sweep.
// Test-only: production GC piggy-backs on the 2s debounced save (and on
// shutdown). Tests use this to assert the live-set + undoLog contract without
// waiting for the debounce timer.
func (w *ConversationWorker) SweepTransactionsForTest() error {
	return w.sweepTransactions()
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

// anyRunState reports the state of the busiest run this worker owns: any turn on
// a goroutine of its own that is not idle, else the ambient turn — which is what
// carries the busy frame across the moment a pickup hands a thread to the loop.
// It is the question every conversation-wide gate asks ("is anything in flight
// in this conversation?"), spelled apart from threadRunState so the two are
// never confused.
func (w *ConversationWorker) anyRunState() WorkerState {
	for _, e := range w.sched.runs() {
		if state, ok := e.t.state.Load().(WorkerState); ok && state != StateIdle {
			return state
		}
	}
	return w.currentRun().loadState()
}

// threadRunState reports the state of the run writing to threadItemID, and
// StateIdle when no run is on that thread. This is the per-thread half of the
// intake gates: a send, an injected message or a fold each concern ONE thread,
// and a run streaming on a sibling is not a reason to refuse them.
func (w *ConversationWorker) threadRunState(threadItemID string) WorkerState {
	for _, e := range w.sched.runs() {
		if e.threadItemID != threadItemID {
			continue
		}
		if state, ok := e.t.state.Load().(WorkerState); ok {
			return state
		}
	}
	r := w.currentRun()
	if r.t.thread.itemID != threadItemID {
		return StateIdle
	}
	return r.loadState()
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
	defer close(r.stopped)
	defer r.onShutdown()
	r.livenessTicker = time.NewTicker(livenessInterval)
	defer r.livenessTicker.Stop()
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
		case msg := <-r.inbound:
			event, started = "message "+msg.Type, time.Now()
			r.handleMessage(msg)
		case <-r.doc.UpdateSignal():
			event, started = "doc update signal", time.Now()
			r.batcher.Schedule()
		case <-r.saveRequest:
			event, started = "save request", time.Now()
			r.armSaveDebounce()
		case <-r.saveChan:
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
		case ack := <-r.flushReq:
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
		case <-r.livenessC():
			event, started = "liveness tick", time.Now()
			r.detectFrozenGap()
			liveThreads := r.sched.liveThreads()
			// Periodic recovery remains actor-owned and skips only the subtrees whose
			// live run goroutines currently own their tool state.
			r.finalizeToolsAbsentFromExecReportExcept(liveThreads)
			r.driveToolActionsExcept(liveThreads)
		}
		handled := time.Since(started)
		// After every event, drain the reducer. A dispatch may complete
		// and raise the reconcile bit again (e.g., child thread completes →
		// parent needs dispatch). Loop until the reducer is quiet.
		// Bounded to prevent spin loops from observer re-triggering.
		reconcileStarted := time.Now()
		passes := r.drainReconcile()
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
	r.sendError(fmt.Sprintf("Internal error: %v", panicValue), "")
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
	r.replyTo = msg.OriginClient
	defer func() { r.replyTo = "" }()

	if r.handleTestMessage(msg) {
		return
	}

	// An op added here that starts work — requestLLM, setThreadNeedsStrategyRun,
	// checkForNewThreads — owes an answer to the pause: it either lifts the marks
	// covering the thread it runs on (a human asked for it) or leaves them
	// standing and waits (the conversation carrying on by itself). The
	// classification is in polite_stop.go; the choice is enforced by
	// TestEveryWorkStartingOpClassifiesItselfAgainstThePause, which reads this
	// switch to find the ops.
	switch msg.Type {
	case "init":
		r.handleInit(msg.Payload)

	case "send-message":
		r.handleSendMessage(msg.Payload)

	case "inject-thread-message":
		r.handleInjectThreadMessage(msg.Payload)

	case "delivery-ended":
		r.handleDeliveryEnded(msg.Payload)

	case "cancel":
		r.handleCancel(cancelReasonFromPayload(msg.Payload))

	case "pause":
		r.handlePause(threadItemIDFromPayload(msg.Payload))

	case "unpause":
		r.handleUnpause(threadItemIDFromPayload(msg.Payload))

	case "provider-turn":
		r.handleProviderTurn(msg.Payload)

	case "render-context-items-response":
		r.handleRenderContextItemsResponse(msg.Payload)

	case "tools-result":
		r.handleToolsResult(msg.Payload)

	case "strategy-hook-response":
		r.handleStrategyHookResponse(msg.Payload)

	case "build-subthread-spec-response":
		r.handleBuildSubthreadSpecResponse(msg.Payload)

	case "yjs-sync":
		r.handleYjsSync(msg.Payload)

	case "undo":
		r.handleUndo(msg.Payload)

	case "redo":
		r.handleRedo(msg.Payload)

	case "clear-history":
		r.handleClearHistory()

	case "stop-undo-capturing":
		// Browser-driven mutations bypass the OperationTracker, so the
		// UndoManager only auto-closes its capture window on the 250 ms
		// timeout. Multiple browser actions issued within that window get
		// merged into one undo group — undoing then unexpectedly reverses
		// all of them. The browser sends this message at user-action
		// boundaries (slash commands, context-item add/remove, etc.) to
		// force a fresh undo group.
		r.tracker.StopCapturing()

	case "begin-undo-coalesce":
		r.handleBeginUndoCoalesce()

	case "end-undo-coalesce":
		r.handleEndUndoCoalesce(msg.Payload)

	case "retry-tool-approval":
		r.handleRetryToolApproval(msg.Payload)

	case "update-and-reposition-tool-actions":
		r.handleUpdateAndRepositionToolActions(msg.Payload)

	case "retry-tool-action":
		r.handleRetryToolAction(msg.Payload)

	case "update-tool-action-for-retry":
		r.handleUpdateToolActionForRetry(msg.Payload)

	case "background-task-snapshot":
		r.handleBackgroundTaskSnapshot(msg.Payload)

	case "reposition-context-item-placeholder":
		r.handleRepositionContextItemPlaceholder(msg.Payload)

	case "create-thread":
		r.handleCreateThread(msg.Payload)

	case "resummarize-compaction-thread":
		r.handleResummarizeCompactionThread(msg.Payload)

	case "request-full-state":
		r.broadcastFullState()

	case "resync-request":
		r.handleResyncRequest(msg.Payload)

	case "resync-to-origin":
		r.handleResyncToOrigin()

	case "tool-execution-report":
		r.handleToolExecutionReport(msg.Payload, msg.OriginClient)

	case "engine-trace":
		r.handleEngineTrace(msg.Payload)

	case "rename-log":
		r.handleRenameLog()

	case "request-auto-name":
		r.handleRequestAutoName(msg.Payload)

	case "clear-undo-stacks":
		r.handleClearUndoStacks(msg.Payload)

	case "get-transaction":
		r.handleGetTransaction(msg.Payload)

	case "flush-persistence":
		r.handleFlushPersistence(msg.Payload)

	case "compact":
		r.handleCompact(msg.Payload)

	default:
		r.log.Error("Unknown message type: %s", msg.Type)
	}
}

// handleClearUndoStacks wipes the conversation's undo/redo history. The browser
// sends this after seeding a new conversation's auto-items (memory, AI-assistant
// files) and after duplicating a conversation, so those non-user edits aren't
// undoable. Runtime feature — must stay outside the test-only handler gate.
func (w *ConversationWorker) handleClearUndoStacks(payload json.RawMessage) {
	ackID := w.ackIDOf("clear-undo-stacks", payload)

	w.tracker.ClearHistory()
	w.reply(map[string]any{
		"type":  "ack",
		"ackId": ackID,
	})
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

	ack := AckMessage{Type: "ack", AckID: msg.AckID}
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
// calls flushNow directly — exactly as the loop's own flushReq case does —
// rather than routing through ConversationWorker.FlushPersistence, which would
// deadlock waiting on the same loop to service flushReq.
func (r *run) handleFlushPersistence(payload json.RawMessage) {
	ackID := r.ackIDOf("flush-persistence", payload)
	if err := r.flushNow(); err != nil {
		r.log.Error("Failed to flush persistence: %v", err)
	}
	r.send(map[string]any{
		"type":  "ack",
		"ackId": ackID,
	})
}

// flushNow is the synchronous save behind both flush paths — the run loop's
// flushReq case (FlushPersistence, from tests and shutdown) and the
// flush-persistence message (the quit handshake). It stops the pending debounce
// timer and saves, unless the conversation is being deleted: the folder is about
// to be removed, and saving would recreate it. Runs on the worker goroutine.
func (r *run) flushNow() error {
	if r.deleting.Load() {
		return nil
	}
	if r.saveTimer != nil {
		r.saveTimer.Stop()
	}
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
	w.replyWS(data)
}

// replyWS is reply for a payload that is already encoded — the Yjs deltas,
// whose size makes it worth building them without the reflective encoder (see
// marshalYjsSync). Same addressing rule: the originating client, or a broadcast
// when there is no origin to answer.
func (w *ConversationWorker) replyWS(data []byte) {
	if w.replyTo != "" {
		w.callbacks.sendTo(w.replyTo, data)
		return
	}
	w.sendWS(data)
}

func (r *run) sendStatus(status, message string) {
	r.sendStatusWithCode(status, message, "")
}

// sendStatusWithCode is sendStatus plus a machine-readable `code` the client can
// branch on without matching English text. Used for the model-validation errors
// so the client can tell a recoverable divergence (code "no-model" — self-heal
// by re-broadcasting its own config) apart from a genuinely unusable model
// (code "provider-unavailable" — never auto-retry). Empty code ⇒ omitted, so
// every existing sendStatus caller is unchanged on the wire.
func (r *run) sendStatusWithCode(status, message, code string) {
	r.updateElapsedAnchor(status)
	r.writeProcessingState(status, message, code)
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

	// Also send direct WebSocket message for logging/debugging
	wsMsg := map[string]any{
		"type":    "status",
		"status":  status,
		"message": message,
	}
	if code != "" {
		wsMsg["code"] = code
	}
	r.send(wsMsg)
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
func (r *run) writeProcessingState(status, message, code string) {
	// Include threadItemId so frontend knows which column to target
	stateMap := map[string]any{
		"status":       status,
		"message":      message,
		"threadItemId": r.t.thread.itemID,
	}
	if code != "" {
		stateMap["code"] = code
	}
	holdsClaim := statusHoldsClaim(status)
	if holdsClaim {
		stateMap["startedAt"] = r.t.processingStartedAt.Load()
	}

	// Terminal-error statuses release only this thread; live siblings retain their
	// claims and remain visible through the projection.
	r.replaceProcessingState(stateMap, r.t.thread.itemID, func(runs map[string]any) {
		key := runKey(r.t.thread.itemID)
		if !holdsClaim {
			delete(runs, key)
			return
		}
		entry, ok := runs[key].(map[string]any)
		if !ok {
			entry = map[string]any{"threadItemId": r.t.thread.itemID}
		}
		entry["activity"] = ActivityCallingLLM
		entry["claimedAt"] = time.Now().UnixMilli()
		entry["status"] = status
		entry["message"] = message
		if code != "" {
			entry["code"] = code
		} else {
			delete(entry, "code")
		}
		entry["startedAt"] = r.t.processingStartedAt.Load()
		// The mid-stream progress fields belong to the phase that produced them:
		// a token count from the last stream means nothing beside "Running
		// tools", and a provider activity line describes a call that has ended.
		// Each new frame drops them.
		for _, field := range []string{"description", "phase", "inputTokens", "outputTokens", "cachedTokens"} {
			delete(entry, field)
		}
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
	r.doc.SetMetadata("completedTurns", next)
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
	if w.compactionMergeFromIdx >= 0 {
		w.tracker.MergeFromIndex(w.compactionMergeFromIdx)
		w.compactionMergeFromIdx = -1
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
func (w *ConversationWorker) sendReady() {
	w.reply(map[string]any{
		"type":                "ready",
		"summarizationPrompt": DefaultSummarizationPrompt,
	})
}

func (w *ConversationWorker) sendReadyWithMetadata(metadata map[string]any) {
	msg := map[string]any{
		"type":                "ready",
		"metadata":            metadata,
		"summarizationPrompt": DefaultSummarizationPrompt,
	}
	w.reply(msg)
}

func (r *run) sendError(message, stack string) {
	r.sendErrorWithData(message, stack, nil)
}

// sendErrorWithData reports an error into the run's own thread; see sendErrorTo.
func (r *run) sendErrorWithData(message, stack string, data map[string]any) {
	r.sendErrorTo(r.t.thread, message, stack, data)
}

// sendErrorTo appends an error item to dest (visible in the UI via Yjs sync)
// and sends the same error on the wire, with its stack, for logging.
func (r *run) sendErrorTo(dest threadContext, message, stack string, data map[string]any) {
	summary := extractErrorSummary(message)
	msg := ConversationItem{
		Type:      ItemTypeError,
		ItemID:    generateItemID(),
		Content:   message,
		Summary:   summary,
		Timestamp: time.Now().Format(time.RFC3339),
	}
	if data != nil {
		msg.Data, _ = json.Marshal(data)
	}
	r.appendMessageTo(dest, msg)

	r.send(ErrorMessage{
		Type:    "error",
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
	w.doc.SetMetadata("undoState", map[string]any{
		"canUndo": canUndo,
		"canRedo": canRedo,
		"seq":     w.tracker.UndoSeq(),
	})
}

func (w *ConversationWorker) sendRenderContextItemsRequest(requestID string, itemIDs []string) {
	w.send(RenderContextItemsRequest{
		Type:      "render-context-items-request",
		RequestID: requestID,
		ItemIDs:   itemIDs,
		SentAt:    time.Now().UnixMilli(),
	})
}

func (w *ConversationWorker) sendCorruptionRepaired(repairedCount int) {
	w.send(CorruptionRepairedMessage{
		Type:          "corruption-repaired",
		RepairedCount: repairedCount,
	})
}

// =============================================================================
// DOCUMENT OBSERVER (Pure Document-Driven Approval Flow)
// =============================================================================

// setupDocumentObserver registers the items array observer for approval flow.
// This enables pure document-driven state transitions with no polling.
func (w *ConversationWorker) setupDocumentObserver() {
	w.doc.RegisterItemsObserver(func() {
		// Non-blocking signal: the observer fires on whichever goroutine
		// did the Transact(), which may not be the run() goroutine.
		// Move the actual work onto run() via a channel signal.
		select {
		case w.docChangeChan <- struct{}{}:
		default:
			// Already signaled, run() will pick it up
		}
	})
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
	if r.suppressItemsChange {
		return
	}

	// History navigation is a user-directed rollback/replay, not a request to
	// advance the LLM state machine. Browser/engine Yjs echoes can arrive after
	// the synchronous UndoManager transaction and reintroduce stale
	// activity="awaiting_llm"; clear it and skip the reducer until an explicit
	// user action (send/continue/approve/retry/rerun) starts a new LLM intent.
	if r.suppressReconcileAfterHistoryNavUntilMs > 0 {
		if time.Now().UnixMilli() < r.suppressReconcileAfterHistoryNavUntilMs {
			r.releaseAllLLM()
			r.sched.dropReconcile()
			return
		}
		r.suppressReconcileAfterHistoryNavUntilMs = 0
	}
	r.tape.Record("items-change", map[string]any{
		"itemCount": r.doc.GetItemsLength(),
		"state":     string(r.loadState()),
	})
	// Cancel if the browser deleted the thread we're currently processing.
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
	ycrdtMu.Lock()
	if root := r.doc.getItems(); root != nil {
		for _, raw := range root.ToArray() {
			threadYMap, ok := raw.(*ycrdt.YMap)
			if !ok {
				continue
			}
			if itemType, _ := threadYMap.Get("type").(string); itemType != ItemTypeThread {
				continue
			}
			itemID, _ := threadYMap.Get("itemId").(string)
			needsStrategyRun, _ := threadYMap.Get("needsStrategyRun").(bool)
			if itemID == "" || !needsStrategyRun || threadRunSettledLocked(threadYMap) {
				continue
			}
			noAutoSelect, _ := threadYMap.Get("noAutoSelect").(bool)
			candidates = append(candidates, rootThread{itemID: itemID, noAutoSelect: noAutoSelect})
		}
	}
	ycrdtMu.Unlock()

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
			r.compactionMergeFromIdx = r.tracker.UndoStackLen() - 1
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
// sched.dispatches() case.
func (r *run) startPreparedThreadRun(t *turnState) {
	tr := r.runFor(t)
	threadItemID := tr.t.thread.itemID
	if tr.t.thread.itemsArray == nil {
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
	w.doc.setThreadFlag(threadItemID, "needsStrategyRun", needed, w.doc.transactTracked)
}

// setCompactionUnsummarized records that a folded-compaction thread's
// summarizer run ended without writing a summary.
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
func (w *ConversationWorker) setCompactionUnsummarized(threadItemID string) {
	w.writeCompactionUnsummarized(threadItemID, true)
}

// clearCompactionUnsummarized drops the marker once a summary exists again, or
// when one is about to be attempted.
func (w *ConversationWorker) clearCompactionUnsummarized(threadItemID string) {
	w.writeCompactionUnsummarized(threadItemID, false)
}

// writeCompactionUnsummarized writes the marker through setThreadFlag. Written
// untracked: this is derived state about a run's outcome, not an edit the user
// made, so it must not be what an undo peels off.
func (w *ConversationWorker) writeCompactionUnsummarized(threadItemID string, unsummarized bool) {
	w.doc.setThreadFlag(threadItemID, "compactionUnsummarized", unsummarized, w.doc.transactInternal)
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
