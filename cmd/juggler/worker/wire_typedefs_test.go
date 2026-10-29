//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"juggler/cmd/juggler/wireschema"
)

// workerTypedefsFile is the JS the worker's messages are typed by.
const workerTypedefsFile = "web/js/protocol/worker-wire-types.gen.js"

// workerInboundTypedefs is every message the worker is sent whose payload it
// decodes into a struct carrying the type.
var workerInboundTypedefs = []wireschema.Entry{
	{Value: InitMessage{}, Types: wireTypes(msgInit)},
	{Value: SendMessageMessage{}, Types: wireTypes(msgSendMessage)},
	{Value: CancelMessage{}, Types: wireTypes(msgCancel)},
	{Value: ProviderTurnMessage{}, Types: wireTypes(msgProviderTurn)},
	{Value: RenderContextItemsResponse{}, Types: wireTypes(msgRenderContextItemsResponse)},
	{Value: ToolsResultMessage{}, Types: wireTypes(msgToolsResult)},
	{Value: StrategyHookResponse{}, Types: wireTypes(msgStrategyHookResponse)},
	{Value: BuildSubthreadSpecResponse{}, Types: wireTypes(msgBuildSubthreadSpecResponse)},
	{Value: YjsSyncMessage{}, Types: wireTypes(msgYjsSync)},
	{Value: ResyncRequestMessage{}, Types: wireTypes(msgResyncRequest)},
	{Value: ResummarizeCompactionThreadMessage{}, Types: wireTypes(msgResummarizeCompactionThread)},
	{Value: CreateThreadMessage{}, Types: wireTypes(msgCreateThread)},
	{Value: ClearUndoStacksMessage{}, Types: wireTypes(msgClearUndoStacks)},
	{Value: GetTransactionMessage{}, Types: wireTypes(msgGetTransaction)},
	{Value: CompactMessage{}, Types: wireTypes(msgCompact)},
	{Value: RequestAutoNameMessage{}, Types: wireTypes(msgRequestAutoName)},
	{Value: QueuedEntryMessage{}, Types: wireTypes(msgReleaseQueued, msgRemoveQueued)},
}

// workerInboundUntyped is the inbound messages with no struct to render: the
// handler reads a field or two from the payload, or none, or decodes a payload
// that is not the message (inject-thread-message carries an item). Adding a
// struct for one moves it to workerInboundTypedefs.
var workerInboundUntyped = []wireMsgType{
	msgInjectThreadMessage, msgDeliveryEnded, msgPause, msgUnpause, msgUndo, msgRedo, msgClearHistory,
	msgStopUndoCapturing, msgBeginUndoCoalesce, msgEndUndoCoalesce, msgRetryToolApproval,
	msgRetryToolAction, msgRetryTruncatedTurn, msgUpdateToolActionForRetry, msgBackgroundTaskSnapshot, msgRequestFullState,
	msgResyncToOrigin, msgToolExecutionReport, msgEngineTrace, msgRenameLog, msgFlushPersistence,
}

func wireTypes(types ...wireMsgType) []string {
	out := make([]string, len(types))
	for i, t := range types {
		out[i] = string(t)
	}
	return out
}
