//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside wire_typedefs_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"reflect"
	"slices"
	"testing"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/wireschema"
)

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

// TestWireTypedefs holds web/js/protocol/worker-wire-types.gen.js to the
// structs the worker sends and decodes. An outbound message gets a typedef
// only if the wire fixture says JS handles it (jsHandler): one nothing in JS
// reads (pong, which only Go tests wait for) would be a type nothing uses.
// UPDATE=1 rewrites the file.
func TestWireTypedefs(t *testing.T) {
	jsHandles := map[string]bool{}
	for _, o := range loadWireManifest(t).Worker.Outbound {
		jsHandles[o.Type] = o.JSHandler
	}
	var entries []wireschema.Entry
	for _, e := range workerOutboundTypedefs {
		if slices.ContainsFunc(e.Types, func(typ string) bool { return jsHandles[typ] }) {
			entries = append(entries, e)
		}
	}
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
