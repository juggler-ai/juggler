//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// The Y.Map keys the worker reads and writes, grouped as the wire manifest
// (web/js-tests/fixtures/wire-protocol.json, worker.docKeys) groups them. A key
// that several groups share is declared once, in the first group that has it.
//
// Every key that names something in the doc must be one of these constants
// (TestWireParityDocKeysAreConstants): a Y.Map key, the key of any Go map that
// is a copy of doc state or will be written into it — a value stored under a
// key included, at any depth — and a key handed on through a function that
// forwards it to one of those. Which maps and functions those are is computed
// from the source (doc_key_flow_test.go), not listed. TestWireParityDocKeys
// holds the constants to the manifest. Two kinds live elsewhere: a run entry's
// key is a runField constant (run_entry.go), and a metadata key owned by one
// feature is a meta* constant declared beside that feature (spend.go, fork.go,
// auto_name_flag.go, workspace_binding.go), where its meaning is documented.

// Keys ConversationItem declares (docKeys.item).
const (
	keyType                   = "type"
	keyItemID                 = "itemId"
	keyContent                = "content"
	keySource                 = "source"
	keySummary                = "summary"
	keyTimestamp              = "timestamp"
	keyToolUseID              = "toolUseId"
	keyToolName               = "toolName"
	keyToolInput              = "toolInput"
	keyState                  = "state"
	keyCategory               = "category"
	keyApprovalOptions        = "approvalOptions"
	keyDisplayData            = "displayData"
	keyIsError                = "isError"
	keyData                   = "data"
	keyCancelled              = "cancelled"
	keyResult                 = "result"
	keyHooks                  = "hooks"
	keyGoal                   = "goal"
	keyItems                  = "items"
	keyBoundedCompaction      = "boundedCompaction"
	keyCompactionPromptItemID = "compactionPromptItemId"
	keyContextSeeded          = "contextSeeded"
	keySessionName            = "sessionName"
	keyAliasOf                = "aliasOf"
	keyNeedsStrategyRun       = "needsStrategyRun"
	keyNoAutoSelect           = "noAutoSelect"
	keyNoContextSeed          = "noContextSeed"
	keyForceTool              = "forceTool"
	keyHandoffPromote         = "handoffPromote"
	keyFoldedRuns             = "foldedRuns"
	keyPreventUserDeletion    = "preventUserDeletion"
	keyIsNew                  = "isNew"
	keyError                  = "error"
	keyRunToolUseID           = "runToolUseId"
	keyRunToolName            = "runToolName"
	keyRunToolInput           = "runToolInput"
	keyRunGoal                = "runGoal"
	keyRunStatus              = "runStatus"
	keyRunResult              = "runResult"
	keyContinuation           = "continuation"
	keyRunItemID              = "runItemId"
	keyRecoversError          = "recoversError"
	keyRunResultFed           = "runResultFed"
	keyTransactionID          = "transactionId"
	keyProviderData           = "providerData"
	keyAttachments            = "attachments"
	keyHeldAssets             = "heldAssets"
	keyTaskSource             = "taskSource"
	keyLLMCreated             = "llmCreated"
	keyStrategyCreated        = "strategyCreated"
	keyCanSpawnThreads        = "canSpawnThreads"
	keyDelegated              = "delegated"
	keyReadOnly               = "readOnly"
	keyResultSpec             = "resultSpec"
	keyDraft                  = "draft"
	keyExecutor               = "executor"
)

// Item-map keys ConversationItem does not declare (docKeys.itemUntyped): run-time
// and accounting state, read and written on the live map, never through the
// struct.
const (
	keyCompactionAccounting   = "compactionAccounting"
	keyCompactionUnsummarized = "compactionUnsummarized"
	keyContextTokens          = "contextTokens"
	keyResultFedTurn          = "resultFedTurn"
	keyResultTokens           = "resultTokens"
	keyRunningEpoch           = "runningEpoch"
	keyRunningStartedAt       = "runningStartedAt"
	// A pending-queue entry's hold and its send (pending_hold.go). Stripped
	// when the entry is promoted, so no item in a transcript carries them.
	keyNotBefore = "notBefore"
	keyHold      = "hold"
	keySendID    = "sendId"
	// The answer the browser writes to a tool action's approval form; cleared
	// with the form when the action is asked again (reaskFields).
	keyApprovalResponse = "approvalResponse"
)

// Keys of the processingState frame that are not a run entry's own fields
// (docKeys.processingState; a run's fields are runField constants,
// run_entry.go), and of one polite-stop mark under politeStops.
const (
	keyRuns        = "runs"
	keyPoliteStops = "politeStops"
	keyLanded      = "landed"
)

// Keys of a tool action's result value (docKeys.toolResult): content, isError
// and cancelled are the item keys of the same name, and fullResult carries the
// renderer's own completed state under keyState.
const (
	keyFullResult = "fullResult"
)

// Keys of a terminal-error item's data, and of a notice item's (docKeys.errorData).
// The model an error ran against is keyProvider/keyModel; a failed compaction
// adds its accounting (docKeys.compactionAccounting). message and
// summaryMessage are the messages an item's Content and a notice's Summary
// render from (item_text.go).
const (
	keyDuration         = "duration"
	keyErrorKind        = "errorKind"
	keyResetAt          = "resetAt"
	keyMessage          = "message"
	keySummaryMessage   = "summaryMessage"
	keyCompactionReason = "compactionReason"
	keyCompactionCalls  = "compactionCalls"
	keyCompactionSpend  = "compactionSpend"
	keyCompactionUsage  = "compactionUsage"
)

// Keys of a compaction's durable accounting and of its usage map
// (docKeys.compactionAccounting).
const (
	keyPasses            = "passes"
	keyCalls             = "calls"
	keyEstimatedSpend    = "estimatedSpend"
	keyDurationMs        = "durationMs"
	keyUsage             = "usage"
	keySourceFingerprint = "sourceFingerprint"
	keyInputTokens       = "inputTokens"
	keyOutputTokens      = "outputTokens"
	keyCachedTokens      = "cachedTokens"
	keyCacheWriteTokens  = "cacheWriteTokens"
)

// Keys of the undoState metadata value (docKeys.undoState).
const (
	keyCanUndo = "canUndo"
	keyCanRedo = "canRedo"
	keySeq     = "seq"
)

// Keys of a tool action's input that the worker reads or writes itself
// (docKeys.toolInput): drop_context_items' itemIds, the skill tool's name, and
// the inputs toolSummary probes for its log line — goal among them, declared
// with the item keys.
const (
	keyItemIDs  = "itemIds"
	keyName     = "name"
	keyFilePath = "file_path"
	keyCommand  = "command"
	keyPattern  = "pattern"
	keyQuery    = "query"
	keyURL      = "url"
	keyTitle    = "title"
	keyPath     = "path"
	keySearches = "searches"
	keyFiles    = "files"
	keyEdits    = "edits"
)

// Keys the worker writes into a tool action's displayData (docKeys.displayData).
const (
	keyBackgroundTask = "backgroundTask"
)

// Keys of a model configuration map (docKeys.modelConfig).
const (
	keyModel       = "model"
	keyProvider    = "provider"
	keyServiceTier = "serviceTier"
	keyThinking    = "thinking"
)

// Keys of the document's metadata map (docKeys.metadata). pendingItems and
// pendingRequests are listed here but never live on metadata: both sit beside
// the items they feed (pendingParentMapLocked), on the root map for the root
// thread and on the thread's own map for a sub-thread.
const (
	keyActivatedStrategyID = "activatedStrategyId"
	keyCompletedTurns      = "completedTurns"
	keyCreated             = "created"
	keyCurrentStrategyID   = "currentStrategyId"
	keyDefaultModelConfig  = "defaultModelConfig"
	keyModelConfig         = "modelConfig"
	keyNextSteps           = "nextSteps"
	keyPendingItems        = "pendingItems"
	keyPendingRequests     = "pendingRequests"
	keyProcessingState     = "processingState"
	keyUndoState           = "undoState"
)

// Keys of a pending-request entry and its request map (docKeys.pendingItem).
const (
	keyID                 = "id"
	keyKind               = "kind"
	keyStatus             = "status"
	keyCancelRequested    = "cancelRequested"
	keyCompletedAt        = "completedAt"
	keyThreadItemID       = "threadItemId"
	keyItemsBefore        = "itemsBefore"
	keyRequest            = "request"
	keyPrompt             = "prompt"
	keyParentThreadItemID = "parentThreadItemId"
	keyStrategyID         = "strategyId"
	keyIsContinuation     = "isContinuation"
	keyTaskID             = "taskId"
	keyLabel              = "label"
	keyConvID             = "convId"
	keyClaimedBy          = "claimedBy"
)
