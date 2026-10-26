//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"reflect"
	"testing"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/wireschema"
)

// workerTypedefsFile is the JS the worker's messages are typed by.
const workerTypedefsFile = "web/js/protocol/worker-wire-types.gen.js"

// workerOutboundTypedefs is every message the worker sends, as the struct that
// sends it. A type two structs send (status) has an entry for each, and one
// struct sent under several types (a tool command) is an entry per type.
var workerOutboundTypedefs = []wireschema.Entry{
	{Value: ReadyMessage{}, Types: wireTypes(msgReady)},
	{Value: YjsSyncMessage{}, Types: wireTypes(msgYjsSync)},
	{Value: ResyncOfferMessage{}, Types: wireTypes(msgResyncOffer)},
	{Value: ResyncResponseMessage{}, Types: wireTypes(msgResyncResponse)},
	{Value: RenderContextItemsRequest{}, Types: wireTypes(msgRenderContextItemsRequest)},
	{Value: RequestToolsMessage{}, Types: wireTypes(msgRequestTools)},
	{Value: BuildSubthreadSpecRequest{}, Types: wireTypes(msgBuildSubthreadSpec)},
	{Value: RunStrategyHookRequest{}, Types: wireTypes(msgRunStrategyHook)},
	{Value: RunContextHookRequest{}, Types: wireTypes(msgRunContextHook)},
	{Name: "EvaluateToolMessage", Value: ToolCommand{}, Types: wireTypes(msgEvaluateTool)},
	{Name: "ExecuteToolMessage", Value: ToolCommand{}, Types: wireTypes(msgExecuteTool)},
	{Name: "CancelToolMessage", Value: ToolCommand{}, Types: wireTypes(msgCancelTool)},
	{Name: "CancelStrategyExecutionMessage", Value: bareMessage{}, Types: wireTypes(msgCancelStrategyExecution)},
	{Value: CreateThreadResponse{}, Types: wireTypes(msgCreateThreadResponse)},
	{Value: ErrorMessage{}, Types: wireTypes(msgError)},
	{Value: StatusMessage{}, Types: wireTypes(msgStatus)},
	{Name: "MockPausedStatusMessage", Value: mockPausedStatus{}, Types: wireTypes(msgStatus)},
	{Value: AckMessage{}, Types: wireTypes(msgAck)},
	{Name: "PongMessage", Value: bareMessage{}, Types: wireTypes(msgPong)},
}

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

// TestWireTypedefs holds web/js/protocol/worker-wire-types.gen.js to the
// structs the worker sends and decodes. UPDATE=1 rewrites the file.
func TestWireTypedefs(t *testing.T) {
	entries := append([]wireschema.Entry{}, workerOutboundTypedefs...)
	seen := map[reflect.Type]bool{}
	for _, e := range entries {
		seen[reflect.TypeOf(e.Value)] = true
	}
	for _, e := range workerInboundTypedefs {
		if !seen[reflect.TypeOf(e.Value)] {
			entries = append(entries, e)
		}
	}
	got, err := wireschema.Render(wireschema.Config{
		Source: "TestWireTypedefs (cmd/juggler/worker/wire_typedefs_test.go)",
		Rename: map[reflect.Type]string{reflect.TypeFor[msg.Message](): "ServerText"},
	}, entries)
	if err != nil {
		t.Fatal(err)
	}
	wireschema.CompareGolden(t, workerTypedefsFile, got)
}

// TestWireTypedefsCoverTheVocabulary: every type the worker sends has a
// typedef, and every type it is sent has one or is listed as having no struct.
func TestWireTypedefsCoverTheVocabulary(t *testing.T) {
	// typed is each type the entries carry, once: status has two structs.
	typed := func(entries []wireschema.Entry) []wireMsgType {
		var out []wireMsgType
		seen := map[string]bool{}
		for _, e := range entries {
			for _, typ := range e.Types {
				if !seen[typ] {
					seen[typ] = true
					out = append(out, wireMsgType(typ))
				}
			}
		}
		return out
	}
	requireSameSet(t, "outbound typedefs", vocabSet(typed(workerOutboundTypedefs)), vocabSet(allWorkerOutbound))

	inbound := typed(workerInboundTypedefs)
	for _, typ := range workerInboundUntyped {
		for _, has := range inbound {
			if has == typ {
				t.Errorf("%q has a typedef and is listed in workerInboundUntyped", typ)
			}
		}
	}
	requireSameSet(t, "inbound typedefs + workerInboundUntyped",
		vocabSet(append(inbound, workerInboundUntyped...)), vocabSet(allWorkerInbound))
}
