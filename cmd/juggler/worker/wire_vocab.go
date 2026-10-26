//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// The worker's wire vocabulary: the message types it is sent and sends, the
// processing statuses it publishes in processingState, and the statuses and
// kinds a pendingItems entry moves through.
//
// The JS UI mirrors every one of these by hand, so each list here is held to
// web/js-tests/fixtures/wire-protocol.json by TestWireParity* (wire_parity_test.go),
// and the JS tables are held to the same file by unit:wire-protocol-parity.
// Adding a value here means adding it there.

// wireMsgType is the `type` of a message between the worker and its clients.
type wireMsgType string

// Messages the worker is sent: the cases of (*run).dispatchMessage.
const (
	msgInit                        wireMsgType = "init"
	msgSendMessage                 wireMsgType = "send-message"
	msgInjectThreadMessage         wireMsgType = "inject-thread-message"
	msgDeliveryEnded               wireMsgType = "delivery-ended"
	msgCancel                      wireMsgType = "cancel"
	msgPause                       wireMsgType = "pause"
	msgUnpause                     wireMsgType = "unpause"
	msgProviderTurn                wireMsgType = "provider-turn"
	msgRenderContextItemsResponse  wireMsgType = "render-context-items-response"
	msgToolsResult                 wireMsgType = "tools-result"
	msgStrategyHookResponse        wireMsgType = "strategy-hook-response"
	msgBuildSubthreadSpecResponse  wireMsgType = "build-subthread-spec-response"
	msgYjsSync                     wireMsgType = "yjs-sync"
	msgUndo                        wireMsgType = "undo"
	msgRedo                        wireMsgType = "redo"
	msgClearHistory                wireMsgType = "clear-history"
	msgStopUndoCapturing           wireMsgType = "stop-undo-capturing"
	msgBeginUndoCoalesce           wireMsgType = "begin-undo-coalesce"
	msgEndUndoCoalesce             wireMsgType = "end-undo-coalesce"
	msgRetryToolApproval           wireMsgType = "retry-tool-approval"
	msgRetryToolAction             wireMsgType = "retry-tool-action"
	msgRetryTruncatedTurn          wireMsgType = "retry-truncated-turn"
	msgUpdateToolActionForRetry    wireMsgType = "update-tool-action-for-retry"
	msgBackgroundTaskSnapshot      wireMsgType = "background-task-snapshot"
	msgCreateThread                wireMsgType = "create-thread"
	msgResummarizeCompactionThread wireMsgType = "resummarize-compaction-thread"
	msgRequestFullState            wireMsgType = "request-full-state"
	msgResyncRequest               wireMsgType = "resync-request"
	msgResyncToOrigin              wireMsgType = "resync-to-origin"
	msgToolExecutionReport         wireMsgType = "tool-execution-report"
	msgEngineTrace                 wireMsgType = "engine-trace"
	msgRenameLog                   wireMsgType = "rename-log"
	msgRequestAutoName             wireMsgType = "request-auto-name"
	msgClearUndoStacks             wireMsgType = "clear-undo-stacks"
	msgGetTransaction              wireMsgType = "get-transaction"
	msgFlushPersistence            wireMsgType = "flush-persistence"
	msgCompact                     wireMsgType = "compact"
	msgReleaseQueued               wireMsgType = "release-queued"
	msgRemoveQueued                wireMsgType = "remove-queued"
)

// Messages the worker sends. yjs-sync travels both ways and is declared above.
const (
	msgReady                     wireMsgType = "ready"
	msgResyncOffer               wireMsgType = "resync-offer"
	msgResyncResponse            wireMsgType = "resync-response"
	msgRenderContextItemsRequest wireMsgType = "render-context-items-request"
	msgRequestTools              wireMsgType = "request-tools"
	msgBuildSubthreadSpec        wireMsgType = "build-subthread-spec"
	msgRunStrategyHook           wireMsgType = "run-strategy-hook"
	msgRunContextHook            wireMsgType = "run-context-hook"
	msgEvaluateTool              wireMsgType = "evaluate-tool"
	msgExecuteTool               wireMsgType = "execute-tool"
	msgCancelTool                wireMsgType = "cancel-tool"
	msgCancelStrategyExecution   wireMsgType = "cancel-strategy-execution"
	msgCreateThreadResponse      wireMsgType = "create-thread-response"
	msgError                     wireMsgType = "error"
	msgStatus                    wireMsgType = "status"
	msgAck                       wireMsgType = "ack"
	msgPong                      wireMsgType = "pong"
)

// allWorkerInbound is every message type the worker dispatches.
var allWorkerInbound = []wireMsgType{
	msgInit, msgSendMessage, msgInjectThreadMessage, msgDeliveryEnded, msgCancel, msgPause, msgUnpause,
	msgProviderTurn, msgRenderContextItemsResponse, msgToolsResult, msgStrategyHookResponse,
	msgBuildSubthreadSpecResponse, msgYjsSync, msgUndo, msgRedo, msgClearHistory, msgStopUndoCapturing,
	msgBeginUndoCoalesce, msgEndUndoCoalesce, msgRetryToolApproval, msgRetryToolAction, msgRetryTruncatedTurn,
	msgUpdateToolActionForRetry, msgBackgroundTaskSnapshot, msgCreateThread,
	msgResummarizeCompactionThread, msgRequestFullState, msgResyncRequest, msgResyncToOrigin,
	msgToolExecutionReport, msgEngineTrace, msgRenameLog, msgRequestAutoName, msgClearUndoStacks,
	msgGetTransaction, msgFlushPersistence, msgCompact, msgReleaseQueued, msgRemoveQueued,
}

// allWorkerOutbound is every message type the worker sends.
var allWorkerOutbound = []wireMsgType{
	msgReady, msgYjsSync, msgResyncOffer, msgResyncResponse, msgRenderContextItemsRequest,
	msgRequestTools, msgBuildSubthreadSpec, msgRunStrategyHook, msgRunContextHook, msgEvaluateTool,
	msgExecuteTool, msgCancelTool, msgCancelStrategyExecution, msgCreateThreadResponse, msgError,
	msgStatus, msgAck, msgPong,
}

// processingStatus is processingState.status: what the spinner says a run is
// doing. statusHoldsClaim divides them into resting and in-flight.
type processingStatus string

const (
	statusIdle            processingStatus = "idle"
	statusValidationError processingStatus = "validation-error"
	statusPreparing       processingStatus = "preparing"
	statusStreaming       processingStatus = "streaming"
	statusProcessingTools processingStatus = "processing_tools"
	statusRetrying        processingStatus = "retrying"
	statusCompacting      processingStatus = "compacting"
	statusMockPaused      processingStatus = "mock-paused"
)

// allProcessingStatuses is every status processingState can carry.
var allProcessingStatuses = []processingStatus{
	statusIdle, statusValidationError, statusPreparing, statusStreaming,
	statusProcessingTools, statusRetrying, statusCompacting, statusMockPaused,
}

// pendingStatus is where a pendingItems entry stands. A client writes it
// requested; the worker claims it and settles it completed, error or cancelled.
type pendingStatus string

const (
	pendingRequested pendingStatus = "requested"
	pendingClaimed   pendingStatus = "claimed"
	pendingCompleted pendingStatus = "completed"
	pendingError     pendingStatus = "error"
	pendingCancelled pendingStatus = "cancelled"
)

// allPendingStatuses is every status a pendingItems entry can carry.
var allPendingStatuses = []pendingStatus{
	pendingRequested, pendingClaimed, pendingCompleted, pendingError, pendingCancelled,
}

// pendingKind is what a pendingItems entry asks the worker to do.
type pendingKind string

const (
	pendingKindCreateThread      pendingKind = "createThread"
	pendingKindContinue          pendingKind = "continue"
	pendingKindDeliverTaskOutput pendingKind = "deliverTaskOutput"
)

// allPendingKinds is every kind a pendingItems entry can carry.
var allPendingKinds = []pendingKind{
	pendingKindCreateThread, pendingKindContinue, pendingKindDeliverTaskOutput,
}
