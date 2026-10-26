//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// The Y.Map keys the worker reads and writes, grouped as the wire manifest
// (web/js-tests/fixtures/wire-protocol.json, worker.docKeys) groups them. A key
// that several groups share is declared once, in the first group that has it.
//
// Every key a Get/Set/Delete/Has, metadata accessor, yMap* reader or key
// forwarder is handed must be one of these constants
// (TestWireParityDocKeysAreConstants), and TestWireParityDocKeys holds them to
// the manifest. Two kinds live elsewhere: a processing-state key is a runField
// constant (run_entry.go), and a metadata key owned by one feature is a meta*
// constant declared beside that feature (spend.go, fork.go, auto_name_flag.go,
// workspace_binding.go), where its meaning is documented.

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
