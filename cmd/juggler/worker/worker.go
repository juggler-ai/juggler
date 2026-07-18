//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/mailbox"
	"juggler/cmd/juggler/osactivity"
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

// threadContext holds the execution context for the currently-running thread.
// Zero value means we are executing in the root conversation scope.
type threadContext struct {
	itemID     string
	itemsArray *ycrdt.YArray
}

// ConversationWorker handles conversation orchestration.
// All state is owned by a single goroutine - no mutexes needed.
// Messages come in via the inbound channel and are processed sequentially.
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

	// pathProvider resolves convID → on-disk folder path. Used for reads
	// and to locate the per-conversation transaction folder. Set at
	// construction by the Manager; called on every load so a rename
	// mid-life is naturally seen on the next I/O.
	pathProvider PathProviderFunc

	// saveBinary persists the Yjs doc. The implementation creates the
	// conversation folder if it doesn't exist (e.g. brand-new convs and
	// duplicates) and writes atomically. Set at construction by the Manager.
	saveBinary SaveBinaryFunc

	state   atomic.Value // stores WorkerState
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

	// Response channels for request/response correlation
	llmResponseChan        chan llmCallResult
	contextResultChan      chan json.RawMessage
	toolsResultChan        chan json.RawMessage
	strategyHookResultChan chan json.RawMessage
	// Subthread-delegation round-trips (engine-targeted): the worker asks the
	// engine to build a SubthreadSpec for a delegating tool, and to run the
	// tool's onSubthreadError fallback when a delegated child ends open.
	subthreadSpecResultChan  chan json.RawMessage
	subthreadErrorResultChan chan json.RawMessage
	// turnDelegatingTools is the set of tool names offered this turn whose item
	// declared delegatesToSubthread. Rebuilt each iteration from the tools list
	// and read by processLLMResponse to route a call to the delegation path.
	turnDelegatingTools map[string]bool

	// requestId of the in-flight render-context-items request, or "" when none.
	// The worker broadcasts the request to every connected client and may receive
	// several replies — and late replies from earlier turns. Set/cleared on the
	// worker's single event-loop goroutine (no lock needed); read by
	// handleRenderContextItemsResponse to drop any reply that isn't this request's.
	expectedContextRequestID string

	// Streaming state — accumulated chunks for the current turn's text/thinking messages.
	// Zeroed by finalizeStreaming at iteration boundaries.
	streaming streamingState

	// Per-client outbound callbacks. Owned by a dedicated actor goroutine
	// (see callback_registry.go); all ops route through callbacks.ch.
	callbacks *callbackRegistry

	// Persistence
	saveTimer *time.Timer
	saveChan  chan struct{} // Timer goroutine signals here; run loop does the actual save
	dirty     atomic.Bool   // true when doc has unsaved changes since last successful save
	// flushReq lets tests (or shutdown) force-save synchronously without
	// waiting on the SaveDebounceTime timer. Each request carries a reply
	// chan that the run loop signals after the save completes.
	flushReq chan chan error

	// LLM calling
	llmCallFunc LLMCallFunc
	// engineReadyFunc brings the on-demand engine WebView up and waits until it
	// is connected, returning false if it could not. Used by the worker to
	// guarantee the engine is present before dispatching a strategy hook to it
	// at turn-start (the LLM-call gate runs too late for onActivate, whose
	// guidance must be in the doc before the turn's messages are built). Nil in
	// tests / the test-pool, where the engine is an always-on iframe — treated
	// as always-ready.
	engineReadyFunc func() bool
	// llmCancelFunc is the cancel func for the in-flight LLM context, or nil
	// when idle. Stored via atomic.Pointer so Stop() (running on a different
	// goroutine) can safely cancel the call to unblock waitForLLMResponse.
	llmCancelFunc atomic.Pointer[context.CancelFunc]
	// llmWakeInterrupt is set by interruptInFlightLLMForWake just before it
	// cancels the in-flight LLM context on a system-wake. callLLM reads it
	// when its call returns an error so it can surface a clear "interrupted
	// by sleep" message instead of the raw "context canceled". Reset at the
	// top of every callLLM so it never leaks into an unrelated turn.
	llmWakeInterrupt atomic.Bool
	// cancelLLMSession releases provider-side LLM session state for this
	// conversation, preserving the resume token + prompt-cache anchor so the
	// next turn stays warm. Today only the claudecode provider has anything to
	// do here (kill its parked CLI subprocess; the warm session survives).
	cancelLLMSession CancelLLMSessionFunc

	// politeStop is the "Pause" latch: a non-destructive stop that lets all
	// in-flight work (the current LLM stream, running tools, pending approvals)
	// finish and record its real result, then rests at idle at the next
	// boundary — before the model is invoked again. Set by a "pause" message
	// (handlePause / handleMessageInWait); consumed with Swap(false) at whichever
	// boundary drives the worker to idle (dispatchCallLLMOnThread or the strategy
	// loop's top-of-turn check). Nothing is marked Interrupted or Cancelled. It is
	// cleared by an "unpause" message (the Pause button toggled back off before the
	// latch was consumed — handleUnpause / handleMessageInWait), cleared defensively
	// by an explicit send (resume), and superseded by a hard cancel. Atomic so a
	// pause arriving on the worker goroutine mid-wait is visible to the
	// reducer/strategy boundaries without a lock. Mirrored into the synced
	// processingState.politePending (via setPolitePending / clearPolitePending /
	// consumePolitePending, re-emitted by sendStatus) so a client reloading
	// mid-pause restores the "Pausing…" cue — the atomic is the source of truth,
	// the published field its projection.
	politeStop atomic.Bool

	// mock is non-nil iff this worker is under test with scripted LLM
	// responses installed. See mock_llm.go. Production binaries leave it nil.
	mock *mockLLMCaller

	// Whether handleInit has been called at least once (first-init vs reconnect)
	initialized bool

	// Thread execution context — set when running inside a child thread; zero value = root conversation.
	thread threadContext

	// Per-conversation transaction blob store (input/output context for each
	// LLM round-trip). Initialized in handleInit once projectPath is known.
	txnStore *TransactionStore

	// Per-conversation content-addressed asset store (attached images, etc.).
	// Bytes live out-of-doc under <convDir>/assets/; the doc holds only refs.
	// Initialized in handleInit once projectPath is known.
	assetStore *AssetStore

	// currentTxnID is the transaction id of the LLM round-trip currently in
	// flight (set at iteration start, cleared on iteration end). insertTargetMessage
	// stamps this onto every newly inserted item, so any item produced during
	// the round-trip carries the id without each call site having to plumb it.
	currentTxnID string

	// processingStartedAt is the single anchor every client renders the spinner's
	// elapsed digit against (mirrored into processingState.startedAt). The whole
	// timer is just this one number: clients show `now - startedAt`, or nothing
	// when it is absent. It is TURN-scoped (set once when a turn begins from idle,
	// preserved across re-dispatches so the digit spans the whole turn, 0 = idle)
	// and it is pushed FORWARD by each approval wait (see updateApprovalWaitAnchor)
	// so the deliberation at a prompt is excluded from active-work time. The
	// deduction is computed from in-memory state alone — no second doc field.
	processingStartedAt int64

	// approvalWaitStartedAt is the wall-clock millis at which the current turn
	// parked PURELY on a human approval (a tool awaiting manual approval, nothing
	// executing); 0 when not parked. It is in-memory turn bookkeeping, never
	// persisted. On the resume edge the worker advances processingStartedAt by
	// (now - approvalWaitStartedAt) so the wait is excluded. While parked the
	// startedAt field is removed from the doc, so clients show no elapsed digit.
	approvalWaitStartedAt int64

	// wasBlockedOnApprovals is the previous reconcile tick's blockedOnlyByApprovals()
	// value, so updateApprovalWaitAnchor can detect the park/resume edges. Auto-
	// approved tools go Unevaluated→Approved without ever sitting pending, so this
	// never goes true for them and their timer is left running untouched.
	wasBlockedOnApprovals bool

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

	// activityAsserted tracks whether this worker is currently holding an
	// osactivity assertion (App Nap defeat). Set on the first non-idle
	// sendStatus; cleared on the idle transition. Per-worker bool because
	// each conversation has its own busy span; the osactivity package
	// itself refcounts across multiple workers concurrently busy.
	activityAsserted bool

	// lastProgressWriteMs throttles the rate at which mid-stream "progress"
	// chunks update processingState.outputTokens. Without it every text
	// delta would trigger a Yjs metadata write + broadcast + observer fire
	// on every peer. Zeroed at idle transitions.
	lastProgressWriteMs int64

	// turnCounter is incremented on every transition to idle. It is written
	// into the durable `completedTurns` metadata key (NOT the ephemeral
	// processingState blob) so the browser (and test harness) can observe that
	// a turn has completed even if the status transitions were merged by Yjs
	// sync batching, and so it survives a reload. Monotonic, never resets.
	turnCounter int64

	// Thread reducer dispatch state. The reducer is called from the
	// document observer (handleItemsChange) which fires synchronously —
	// it cannot run the LLM inline. Instead it sets needsReconcile=true;
	// the main event loop calls tryReconcile() after every event and
	// dispatches the action at the top level.
	needsReconcile bool

	// tools consolidates all per-toolUseId tool-command bookkeeping — the dedup
	// latch (positively-acked state), the in-flight latch and its dispatch stamp,
	// and the negative-ack / silent-ack escalation counts — into one map of
	// *toolCommandState (see tool_command_state.go). Consulted by driveToolActions
	// (dedup), handleToolCommandAck (promote/re-drive), and sweepStaleToolCommands
	// (silent-ack recovery). The struct keeps the fields that must move together in
	// lockstep, so a partial reset can't wedge the re-drive.
	tools *toolCommandTracker

	// ackWatchdog fires ackTimeout after a tool-command goes in-flight, waking the
	// run loop (via ackWatchdogC) to sweepStaleToolCommands. nil when nothing is in
	// flight. Touched only on the run goroutine (no mutex); the timer callback only
	// signals the channel, exactly like saveTimer → saveChan.
	ackWatchdog  *time.Timer
	ackWatchdogC chan struct{}

	// ackTimeout is how long the worker waits for the engine to acknowledge a
	// tool-command before treating it as silently dropped. A field (defaulting to
	// defaultAckTimeout) so tests can shrink it.
	ackTimeout time.Duration

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

	// Dedicated channel for stream chunks from the provider goroutine.
	// Separate from inbound so streaming can't be starved or dropped.
	streamChunkChan chan StreamChunk

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

	w := &ConversationWorker{
		conversationID:            conversationID,
		authorID:                  authorID,
		doc:                       doc,
		tracker:                   tracker,
		tape:                      NewEventTape(),
		callbacks:                 newCallbackRegistry(),
		streamChunkChan:           make(chan StreamChunk, 4096),
		done:                      make(chan struct{}),
		stopped:                   make(chan struct{}),
		llmResponseChan:           make(chan llmCallResult, 1),
		contextResultChan:         make(chan json.RawMessage, 1),
		toolsResultChan:           make(chan json.RawMessage, 1),
		strategyHookResultChan:    make(chan json.RawMessage, 1),
		subthreadSpecResultChan:   make(chan json.RawMessage, 1),
		subthreadErrorResultChan:  make(chan json.RawMessage, 1),
		tools:                     newToolCommandTracker(),
		ackWatchdogC:              make(chan struct{}, 1),
		ackTimeout:                defaultAckTimeout,
		deliveryPumps:             make(map[string]*taskDeliveryPump),
		lastReconciledStrategyIDs: make(map[string]string),
		saveChan:                  make(chan struct{}, 1),
		flushReq:                  make(chan chan error, 4),
		docChangeChan:             make(chan struct{}, 1),
		compactionMergeFromIdx:    -1,
		undoCoalesceFromIdx:       -1,
	}
	// Unbounded, order-preserving intake. Created after w.done so the pump's
	// lifetime is tied to the worker; Send enqueues here so it never drops.
	w.inboundQ = mailbox.NewQueue[workerMessage](w.done)
	w.inbound = w.inboundQ.Out()
	w.batcher = newSyncBatcher(doc, time.Duration(SyncThrottleMs)*time.Millisecond)
	w.storeState(StateIdle)

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
func (w *ConversationWorker) Start(ctx context.Context) {
	go w.run(ctx)
}

func (w *ConversationWorker) Stop() {
	// Cancel any in-flight LLM call first so waitForLLMResponse returns
	// promptly instead of parking on the LLMTimeout backstop.
	if p := w.llmCancelFunc.Load(); p != nil {
		(*p)()
	}
	close(w.done)
	<-w.stopped
}

// StopForRemoval tears the worker down when its conversation is being removed
// (binned or deleted). Beyond Stop's per-turn ctx-cancel, it releases the
// provider-side LLM session, so a warm or mid-turn claudecode CLI for the
// now-gone conversation is torn down rather than orphaned. Without this, a CLI
// that streams a tool_use just as its conversation is binned parks the
// tools/call with no worker left to drive execution — the tool wedges at
// "running" until a manual cancel.
//
// The release is unconditional: it must not depend on llmCancelFunc being set,
// since the original wedge landed in the turn-boundary window where the
// in-flight ctx had already cleared but the provider's warm CLI had not. It is
// warm-preserving (handleCancel uses the same hook) — moot for a permanent
// delete and harmless for a bin, where the resume anchor survives — and a no-op
// when no provider session exists.
func (w *ConversationWorker) StopForRemoval() {
	if w.cancelLLMSession != nil {
		w.cancelLLMSession(w.conversationID)
	}
	w.Stop()
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
	w.callbacks.setEngine(clientID)
}

// pushStateToEngine sends the full Yjs document state directly to the attached
// engine, guaranteeing the engine becomes a loaded peer of THIS conversation.
//
// The engine is the single place that executes tool-actions (via its reactive
// reducer), which requires the conversation to be loaded there. Relying on the
// engine to auto-load reactively on an incidental yjs-sync is racy and timing-
// dependent: a conversation that gains tool work while the engine is up but
// hasn't loaded it leaves the approved tool-action unobserved forever — the
// "tools stuck" wedge. So the worker (the authority) drives the load: whenever a
// turn produces tool-actions, it pushes full state to the engine. Idempotent —
// if the engine already has the conversation the update merges as a no-op. No-op
// when no engine is attached or the doc isn't loaded yet.
func (w *ConversationWorker) pushStateToEngine() {
	if !w.initialized {
		return
	}
	state := w.doc.ToState()
	if len(state) == 0 {
		return
	}
	data, err := json.Marshal(YjsSyncMessage{Type: "yjs-sync", Bytes: state})
	if err != nil {
		w.log.Error("pushStateToEngine: marshal failed: %v", err)
		return
	}
	w.callbacks.sendToEngine(data)
}

// SetLLMCaller sets the function used to call the LLM provider directly.
func (w *ConversationWorker) SetLLMCaller(fn LLMCallFunc) {
	w.llmCallFunc = fn
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
// Safe to call from the Manager goroutine: llmCancelFunc is an atomic
// pointer and the cancel func itself is goroutine-safe and idempotent, so
// this composes with callLLM's defer and handleCancel's swap without locks.
func (w *ConversationWorker) interruptInFlightLLMForWake() {
	if p := w.llmCancelFunc.Swap(nil); p != nil {
		w.llmWakeInterrupt.Store(true)
		w.log.Info("☀️ system wake: cancelling in-flight LLM request conv=%s (connection likely dropped during sleep)", w.conversationID)
		(*p)()
	}
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
// why it doesn't hook the sleep/wake notification. Runs only on the run() goroutine, so
// the in-memory anchor reads are race-free.
func (w *ConversationWorker) detectFrozenGap() {
	now := time.Now().UnixMilli()
	last := w.lastLivenessMs
	w.lastLivenessMs = now
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
	if w.processingStartedAt == 0 || w.approvalWaitStartedAt != 0 {
		return
	}
	w.log.Info("⏱️ excluding %ds of frozen time from elapsed (process was suspended) conv=%s", excess/1000, w.conversationID)
	w.advanceElapsedAnchor(excess)
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

// loadState reads the current worker state atomically.
func (w *ConversationWorker) loadState() WorkerState {
	return w.state.Load().(WorkerState)
}

// storeState writes the worker state atomically.
func (w *ConversationWorker) storeState(s WorkerState) {
	prev := w.state.Load()
	w.state.Store(s)
	if prev != nil {
		w.tape.Record("state", map[string]any{
			"from": string(prev.(WorkerState)),
			"to":   string(s),
		})
	}
}

// State returns the current worker state (for testing and monitoring).
func (w *ConversationWorker) State() WorkerState {
	return w.loadState()
}

// Tracker returns the operation tracker (for testing).
func (w *ConversationWorker) Tracker() *OperationTracker {
	return w.tracker
}

// resolveModelConfig returns the effective model config for the current thread context.
// Resolves from the Yjs document (thread → parent chain → conversation metadata).
func (w *ConversationWorker) resolveModelConfig() *ModelConfig {
	return w.doc.ResolveEffectiveModelConfig(w.thread.itemID)
}

// run is the main message processing loop. All state access happens here.
func (w *ConversationWorker) run(ctx context.Context) {
	defer close(w.stopped)
	defer w.onShutdown()
	w.livenessTicker = time.NewTicker(livenessInterval)
	defer w.livenessTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.done:
			return
		case msg := <-w.inbound:
			w.handleMessage(msg)
		case chunk := <-w.streamChunkChan:
			w.processCoalescedStreamChunks(chunk)
		case <-w.doc.UpdateSignal():
			w.batcher.Schedule()
		case <-w.batcher.TimerChan():
			w.batcher.Flush()
		case <-w.saveChan:
			// Skip if marked for deletion — the folder is about to be
			// removed, and saving would recreate it as "Untitled--<id>",
			// which reconcileConversationOrder would then ghost back into
			// the tab bar on the next session load.
			if !w.deleting.Load() {
				if err := w.saveStateToDisk(); err != nil {
					w.log.Error("Failed to save state: %v", err)
				}
			}
		case ack := <-w.flushReq:
			var err error
			if !w.deleting.Load() {
				if w.saveTimer != nil {
					w.saveTimer.Stop()
				}
				err = w.saveStateToDisk()
			}
			ack <- err
		case <-w.docChangeChan:
			w.handleItemsChange()
		case <-w.ackWatchdogC:
			w.sweepStaleToolCommands()
		case <-w.livenessC():
			w.detectFrozenGap()
		}
		// After every event, drain the reducer. A dispatch may complete
		// and set needsReconcile again (e.g., child thread completes →
		// parent needs dispatch). Loop until the reducer is quiet.
		// Bounded to prevent spin loops from observer re-triggering.
		w.drainReconcile()
	}
}

// recoverWorkerPanic is the shared deferred-recover for handleMessage and
// handleMessageInWait. On panic it marks the active thread (if any) as
// failed, resets thread context, and sends an error to the UI.
func (w *ConversationWorker) recoverWorkerPanic(msgType string) {
	r := recover()
	if r == nil {
		return
	}
	w.log.Error("Panic handling message %s: %v", msgType, r)

	// If panic occurred while in a thread context, mark the thread as failed
	// so the frontend doesn't get stuck in "active" limbo.
	if w.thread.itemID != "" {
		threadYMap := w.doc.GetThreadYMap(w.thread.itemID)
		if threadYMap != nil {
			ycrdtMu.Lock()
			existingResult, _ := threadYMap.Get("result").(string)
			if existingResult == "" {
				w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
					threadYMap.Set("result", fmt.Sprintf("Thread failed: %v", r))
				}, w.doc.authorID)
			}
			ycrdtMu.Unlock()
		}
	}

	// Reset thread context so the error appears in the root conversation,
	// not inside the failed thread.
	w.resetThreadContext()

	w.sendError(fmt.Sprintf("Internal error: %v", r), "")
}

// handlePause latches a polite stop when the worker is actually busy. Sent from
// dispatchMessage for a "pause" message that arrives between turns. When the
// worker is already idle it is a no-op: latching then would strand the flag and
// suppress the next user-initiated turn (verification item V3). A pause that
// arrives mid-turn is handled in the wait loop (handleMessageInWait), not here.
func (w *ConversationWorker) handlePause() {
	if w.getActivity() == ActivityNone && w.loadState() == StateIdle {
		return // nothing running — a pause is meaningless, don't strand the latch
	}
	w.setPolitePending()
}

// handleUnpause clears a pending polite stop (Pause) so the current turn carries
// on to its next boundary instead of resting at idle. Sent from dispatchMessage
// for an "unpause" message — the Pause button toggling itself back off while a
// pause is still pending. Idempotent: dropping an already-clear latch is a
// harmless no-op, so an unpause that races past the consuming boundary does
// nothing (the turn was going to continue anyway).
func (w *ConversationWorker) handleUnpause() {
	w.clearPolitePending()
}

// handleMessageInWait processes a message while the worker is blocked in a
// wait loop (e.g. waiting for an LLM response or context items). A cancel
// here cooperatively cancels the LLM call and transitions to Cancelling;
// a pause latches a polite stop without touching the in-flight work; every
// other message routes through the normal dispatch.
func (w *ConversationWorker) handleMessageInWait(msg workerMessage) {
	defer w.recoverWorkerPanic(msg.Type)

	// Polite stop: latch and keep waiting. Deliberately BEFORE the cancel branch
	// and non-destructive — no llmCancelFunc swap, no session release, no state
	// change. The wait loop returns the LLM response normally when it lands; the
	// latch is consumed at the next turn boundary (D5, §10.2).
	if msg.Type == "pause" {
		w.setPolitePending()
		return
	}

	// Un-pause: the user toggled Pause back off before the latch was consumed.
	// Symmetric to the pause branch above and equally non-destructive — just drop
	// the latch and keep waiting; the wait loop returns the in-flight LLM response
	// normally and the turn proceeds to its next boundary.
	if msg.Type == "unpause" {
		w.clearPolitePending()
		return
	}

	if msg.Type == "cancel" {
		if p := w.llmCancelFunc.Swap(nil); p != nil {
			(*p)()
		}
		// Same rationale as handleCancel's StateProcessing branch: release any
		// parked provider subprocess that the ctx-cancel above doesn't reach,
		// while preserving the resume token so the next turn stays cache-warm.
		if w.cancelLLMSession != nil {
			w.cancelLLMSession(w.conversationID)
		}
		w.storeState(StateCancelling)
		return
	}

	w.dispatchMessage(msg)
}

// handleMessage processes a single message from the main event loop.
func (w *ConversationWorker) handleMessage(msg workerMessage) {
	defer w.recoverWorkerPanic(msg.Type)
	w.dispatchMessage(msg)
}

// dispatchMessage routes a message to its type-specific handler.
// Shared by handleMessage and handleMessageInWait.
func (w *ConversationWorker) dispatchMessage(msg workerMessage) {
	if msg.Ack != nil {
		defer func() {
			if r := recover(); r != nil {
				msg.Ack <- fmt.Errorf("worker message %s panicked: %v", msg.Type, r)
				panic(r)
			}
			msg.Ack <- nil
		}()
	}
	w.replyTo = msg.OriginClient
	defer func() { w.replyTo = "" }()

	if w.handleTestMessage(msg) {
		return
	}

	switch msg.Type {
	case "init":
		w.handleInit(msg.Payload)

	case "send-message":
		w.handleSendMessage(msg.Payload)

	case "inject-thread-message":
		w.handleInjectThreadMessage(msg.Payload)

	case "delivery-ended":
		w.handleDeliveryEnded(msg.Payload)

	case "cancel":
		w.handleCancel()

	case "pause":
		w.handlePause()

	case "unpause":
		w.handleUnpause()

	case "provider-turn":
		w.handleProviderTurn(msg.Payload)

	case "render-context-items-response":
		w.handleRenderContextItemsResponse(msg.Payload)

	case "tools-result":
		w.handleToolsResult(msg.Payload)

	case "strategy-hook-response":
		w.handleStrategyHookResponse(msg.Payload)

	case "build-subthread-spec-response":
		w.handleBuildSubthreadSpecResponse(msg.Payload)

	case "subthread-error-response":
		w.handleSubthreadErrorResponse(msg.Payload)

	case "yjs-sync":
		w.handleYjsSync(msg.Payload)

	case "undo":
		w.handleUndo(msg.Payload)

	case "redo":
		w.handleRedo(msg.Payload)

	case "clear-history":
		w.handleClearHistory()

	case "stop-undo-capturing":
		// Browser-driven mutations bypass the OperationTracker, so the
		// UndoManager only auto-closes its capture window on the 250 ms
		// timeout. Multiple browser actions issued within that window get
		// merged into one undo group — undoing then unexpectedly reverses
		// all of them. The browser sends this message at user-action
		// boundaries (slash commands, context-item add/remove, etc.) to
		// force a fresh undo group.
		w.tracker.StopCapturing()

	case "begin-undo-coalesce":
		w.handleBeginUndoCoalesce()

	case "end-undo-coalesce":
		w.handleEndUndoCoalesce(msg.Payload)

	case "retry-tool-approval":
		w.handleRetryToolApproval(msg.Payload)

	case "move-context-item-message-to-end":
		w.handleMoveContextItemMessageToEnd(msg.Payload)

	case "update-and-reposition-tool-actions":
		w.handleUpdateAndRepositionToolActions(msg.Payload)

	case "retry-tool-action":
		w.handleRetryToolAction(msg.Payload)

	case "update-tool-action-for-retry":
		w.handleUpdateToolActionForRetry(msg.Payload)

	case "reposition-context-item-placeholder":
		w.handleRepositionContextItemPlaceholder(msg.Payload)

	case "create-thread":
		w.handleCreateThread(msg.Payload)

	case "reopen-thread":
		w.handleReopenThread(msg.Payload)

	case "close-thread-with-last-message":
		w.handleCloseThreadWithLastMessage(msg.Payload)

	case "request-full-state":
		w.broadcastFullState()

	case "resync-request":
		w.handleResyncRequest(msg.Payload)

	case "resync-to-origin":
		w.handleResyncToOrigin()

	case "tool-command-ack":
		w.handleToolCommandAck(msg.Payload)

	case "engine-trace":
		w.handleEngineTrace(msg.Payload)

	case "rename-log":
		w.handleRenameLog()

	case "clear-undo-stacks":
		w.handleClearUndoStacks(msg.Payload)

	case "get-transaction":
		w.handleGetTransaction(msg.Payload)

	default:
		w.log.Error("Unknown message type: %s", msg.Type)
	}
}

// handleClearUndoStacks wipes the conversation's undo/redo history. The browser
// sends this after seeding a new conversation's auto-items (memory, AI-assistant
// files) and after duplicating a conversation, so those non-user edits aren't
// undoable. Runtime feature — must stay outside the test-only handler gate.
func (w *ConversationWorker) handleClearUndoStacks(payload json.RawMessage) {
	var msg ClearUndoStacksMessage
	_ = json.Unmarshal(payload, &msg)

	w.tracker.ClearHistory()
	w.reply(map[string]any{
		"type":  "ack",
		"ackId": msg.AckID,
	})
}

// handleGetTransaction reads an LLM-round-trip blob from disk and returns it
// to the client. The client requests this lazily — when the user opens the
// "View Transaction" panel for an item, and during the auto-compact threshold
// check. Runtime feature — must stay outside the test-only handler gate.
func (w *ConversationWorker) handleGetTransaction(payload json.RawMessage) {
	var msg GetTransactionMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		jlog.Error("Failed to parse get-transaction: %v", err)
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
	if w.replyTo != "" {
		w.callbacks.sendTo(w.replyTo, data)
		return
	}
	w.sendWS(data)
}

func (w *ConversationWorker) sendStatus(status, message string) {
	// `startedAt` is the shared timer base every client uses to render
	// the spinner's elapsed-time digit (see web/js/services/llm-state.js).
	// It must come from the doc so all clients agree: a client falling back
	// to its local Date.now() at the moment its Yjs observer fired would
	// disagree by sync latency. Lazy-init here so any path that calls
	// sendStatus(non-idle) without having set processingStartedAt still gets
	// a single shared anchor written to the doc.
	if statusHoldsClaim(status) {
		if w.processingStartedAt == 0 {
			w.processingStartedAt = time.Now().UnixMilli()
		}
	} else {
		// Resting transition (idle, or a terminal-error status): clear the
		// in-memory elapsed anchor so the NEXT turn starts its timer from zero.
		// The doc's processingState already omits startedAt for resting statuses
		// (see below); mirroring that in memory keeps the two in lockstep. The
		// runStrategyLoop defer also zeroes the anchor on the normal end-of-turn,
		// but handleCancel's real-work-in-flight park branch rests via
		// sendStatus("idle") WITHOUT going through that defer — without this reset
		// the stale anchor survives, and the next Continue's dispatchCallLLMOnThread
		// sees processingStartedAt != 0, preserves it, and the spinner counts from
		// the cancelled turn's start.
		w.processingStartedAt = 0
	}
	// App Nap defeat. Held for the entire busy span (LLM call + tool
	// execution in the engine WebView between LLM calls), released on
	// the idle transition. The osactivity package refcounts internally so
	// multiple workers busy simultaneously compose correctly. Bool guards
	// against double-Begin on repeated non-idle status updates within the
	// same busy span (e.g. status going calling_llm → processing_tools →
	// calling_llm — all non-idle, only one assertion).
	if statusHoldsClaim(status) && !w.activityAsserted {
		osactivity.Begin()
		w.activityAsserted = true
	} else if !statusHoldsClaim(status) && w.activityAsserted {
		osactivity.End()
		w.activityAsserted = false
	}
	// Include threadItemId so frontend knows which column to target
	stateMap := map[string]any{
		"status":       status,
		"message":      message,
		"threadItemId": w.thread.itemID,
	}
	if statusHoldsClaim(status) {
		stateMap["startedAt"] = w.processingStartedAt
		// Mirror the polite-stop (Pause) latch into the synced state so a client
		// reloading mid-pause restores the "Pausing…" cue. Only ever on a busy
		// frame — a pending pause is meaningless at idle, so a latch stranded past
		// a natural turn end (never consumed at a boundary) can't publish a cue on
		// an idle worker. Re-emitting here keeps the flag across status transitions,
		// since stateMap is rebuilt from scratch on every frame.
		if w.politeStop.Load() {
			stateMap["politePending"] = true
		}
	}
	// Mirror the imperative-loop status into the doc-native `activity`
	// claim field. Only active statuses hold the claim; idle AND the
	// terminal-error statuses (error, validation-error) omit it, which
	// reads back as ActivityNone — the operation has ended, so the
	// conversation rests and a new send/continue may start.
	if statusHoldsClaim(status) {
		stateMap["activity"] = ActivityCallingLLM
		stateMap["claimedAt"] = time.Now().UnixMilli()
	} else if status == "idle" {
		// Increment turn counter on every idle transition so observers can
		// detect that a turn happened even when Yjs sync batching merged the
		// non-idle window into a single update. Seed from the doc's current
		// value first so the counter stays MONOTONIC across a worker restart on
		// a reloaded conversation: a fresh worker starts at 0 but the persisted
		// doc may already carry a higher count (handleInit's first frame is
		// idle, so this seed runs before any non-idle frame could regress it).
		// Without the seed the counter would go backwards and break every fence
		// observing it.
		if docTC := w.docTurnCounter(); docTC > w.turnCounter {
			w.turnCounter = docTC
		}
		w.turnCounter++
		// Persist the bumped counter to its own durable top-level metadata key,
		// OUTSIDE the ephemeral processingState blob (whose other fields —
		// startedAt, live token counts, status — are rebuilt from scratch on
		// every load by handleInit). completedTurns is the one value read back
		// across a load (the monotonic turn fence), so it gets a clean key.
		w.doc.SetMetadata("completedTurns", w.turnCounter)
	}
	w.doc.SetMetadata("processingState", stateMap)

	// When transitioning to idle, flush all pending Yjs updates so the
	// browser sees the complete operation result AND the idle transition
	// in the same sync batch. Without this, the idle metadata update sits
	// in the batch buffer while the browser waits for it — breaking
	// strategy hooks like onWorkerIdle that drive the next phase.
	if status == "idle" {
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

	// Also send direct WebSocket message for logging/debugging
	w.send(map[string]any{
		"type":    "status",
		"status":  status,
		"message": message,
	})
}

func (w *ConversationWorker) sendReady() {
	w.send(map[string]string{"type": "ready"})
}

func (w *ConversationWorker) sendReadyWithMetadata(metadata map[string]any) {
	msg := map[string]any{
		"type":     "ready",
		"metadata": metadata,
	}
	w.send(msg)
}

func (w *ConversationWorker) sendError(message, stack string) {
	w.sendErrorWithData(message, stack, nil)
}

func (w *ConversationWorker) sendErrorWithData(message, stack string, data map[string]any) {
	summary := extractErrorSummary(message)

	// Add error message to conversation items (visible in UI via Yjs sync)
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
	w.insertTargetMessage(w.getTargetItemsLength(), msg)

	// Also send as WebSocket message for logging/debugging
	w.send(ErrorMessage{
		Type:    "error",
		Message: message,
		Summary: summary,
		Stack:   stack,
	})
}

func (w *ConversationWorker) sendYjsSync(update []byte) {
	w.send(YjsSyncMessage{
		Type:  "yjs-sync",
		Bytes: update,
	})
}

func (w *ConversationWorker) sendUndoState(canUndo, canRedo bool) {
	// Store undo state in Yjs metadata for reactive UI updates (no messages)
	w.doc.SetMetadata("undoState", map[string]any{
		"canUndo": canUndo,
		"canRedo": canRedo,
	})
}

func (w *ConversationWorker) sendRenderContextItemsRequest(requestID string, itemIDs []string) {
	w.send(RenderContextItemsRequest{
		Type:      "render-context-items-request",
		RequestID: requestID,
		ItemIDs:   itemIDs,
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
func (w *ConversationWorker) handleItemsChange() {
	// Suppressed while applying an undo/redo: the UndoManager's mutations
	// arrive through the same observer that drives the reducer, and we must
	// not let those mutations re-trigger the strategy loop (e.g. by
	// re-firing on a restored thread + trailing user message). See
	// handleUndoOrRedo's wrapping.
	if w.suppressItemsChange {
		return
	}

	// History navigation is a user-directed rollback/replay, not a request to
	// advance the LLM state machine. Browser/engine Yjs echoes can arrive after
	// the synchronous UndoManager transaction and reintroduce stale
	// activity="awaiting_llm"; clear it and skip the reducer until an explicit
	// user action (send/continue/approve/retry/rerun) starts a new LLM intent.
	if w.suppressReconcileAfterHistoryNavUntilMs > 0 {
		if time.Now().UnixMilli() < w.suppressReconcileAfterHistoryNavUntilMs {
			w.releaseLLM()
			w.needsReconcile = false
			return
		}
		w.suppressReconcileAfterHistoryNavUntilMs = 0
	}
	w.tape.Record("items-change", map[string]any{
		"itemCount": w.doc.GetItemsLength(),
		"state":     string(w.loadState()),
	})
	// Cancel if the browser deleted the thread we're currently processing.
	if w.loadState() == StateProcessing && w.thread.itemID != "" {
		if w.doc.GetThreadYMap(w.thread.itemID) == nil {
			w.handleCancel()
		}
	}

	// DOCUMENT-DRIVEN THREAD PROCESSING: When a thread is inserted with
	// items (including a user message) and no result, automatically process it.
	// This enables compact commands and plugins to be pure yjs mutations.
	w.checkForNewThreads()

	// Signal the reducer to evaluate the thread state. The reducer is the
	// sole dispatcher for all LLM calls — tool completions, thread
	// completions, user messages, and new threads all flow through here.
	w.reconcileThread()

	// Drive any strategy-written pendingRequests entries one step forward
	// (including starting/cancelling task-output delivery pumps). Cheap no-op if
	// no entries are pending.
	w.scanPendingRequests()
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
func (w *ConversationWorker) checkForNewThreads() {
	if w.loadState() != StateIdle {
		return
	}

	items := w.doc.GetItems()
	for _, item := range items {
		if item.Type != ItemTypeThread {
			continue
		}

		threadYMap := w.doc.GetThreadYMap(item.ItemID)
		if threadYMap == nil {
			continue
		}

		// Read raw Y.Map fields under the lock
		ycrdtMu.Lock()
		needsStrategyRun, _ := threadYMap.Get("needsStrategyRun").(bool)
		noAutoSelect, _ := threadYMap.Get("noAutoSelect").(bool)
		hasResult := false
		if result, _ := threadYMap.Get("result").(string); result != "" {
			hasResult = true
		}
		ycrdtMu.Unlock()

		if !needsStrategyRun {
			continue
		}
		if hasResult {
			continue
		}

		// Get the thread's items array
		threadItems := w.doc.GetThreadItemsArray(item.ItemID)
		if threadItems == nil {
			continue
		}

		modelConfig := w.doc.ResolveEffectiveModelConfig(item.ItemID)
		if modelConfig == nil || modelConfig.Model == "" {
			continue
		}

		// Claim before setting context — fail fast if activity is non-null
		// (another operation is in flight or tools are awaiting completion).
		if !w.claimLLM(item.ItemID) {
			return
		}

		w.log.Debug("Auto-processing thread %s (doc-driven)", item.ItemID)
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
		if noAutoSelect {
			w.compactionMergeFromIdx = w.tracker.UndoStackLen() - 1
		}
		// Consume the one-shot trigger before running. Completion is tracked by
		// the thread result; cancellation must not leave a persistent trigger that
		// restarts the thread immediately on the next observer tick.
		w.clearThreadNeedsStrategyRun(item.ItemID)
		w.thread.itemID = item.ItemID
		w.thread.itemsArray = threadItems
		// Turn-scoped anchor (see dispatchCallLLMOnThread): set once at turn start,
		// preserved across re-dispatches so the elapsed digit spans the whole turn.
		if w.processingStartedAt == 0 {
			w.processingStartedAt = time.Now().UnixMilli()
		}
		w.storeState(StateProcessing)
		w.runStrategyLoop("", true)
		return // Process one thread at a time
	}
}

func (w *ConversationWorker) clearThreadNeedsStrategyRun(threadItemID string) {
	threadYMap := w.doc.GetThreadYMap(threadItemID)
	if threadYMap == nil {
		return
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	needsStrategyRun, _ := threadYMap.Get("needsStrategyRun").(bool)
	if !needsStrategyRun {
		return
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		threadYMap.Delete("needsStrategyRun")
	}, w.doc.authorID)
}

// hasIncompleteThreads returns true if any thread item in the current target
// has no result yet (child thread still in progress or not yet started).
func (w *ConversationWorker) hasIncompleteThreads() bool {
	for _, item := range w.getTargetItems() {
		if item.Type == ItemTypeThread && !hasThreadResult(item) {
			return true
		}
	}
	return false
}

// hasIncompleteTools returns true if any tool-action in the thread hasn't finished.
func (w *ConversationWorker) hasIncompleteTools() bool {
	for _, item := range w.getTargetItems() {
		if item.Type != ItemTypeToolAction {
			continue
		}
		if item.State != StateCompleted && item.State != StateCancelled {
			return true
		}
	}
	return false
}
