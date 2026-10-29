//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"reflect"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/wireschema"
	"juggler/cmd/juggler/worker"
	"juggler/cmd/juggler/workspace"
)

// serverTypedefsFile is the JS the realtime socket's frames are typed by.
const serverTypedefsFile = "web/js/protocol/server-wire-types.gen.js"

// frameTypedef is one frame struct and which way it travels.
type frameTypedef struct {
	entry   wireschema.Entry
	out, in bool
}

func frameTypes(types ...frameType) []string {
	out := make([]string, len(types))
	for i, t := range types {
		out[i] = string(t)
	}
	return out
}

// serverFrameTypedefs is every frame with a struct, as that struct. A type
// two structs send (conversations-changed) has an entry for each, and one
// struct sent under several types (a bare frame) is an entry per type.
var serverFrameTypedefs = []frameTypedef{
	{entry: wireschema.Entry{Name: "FileChangeFrame", Value: fileChangeFrame{}, Types: frameTypes(frameFileChange)}, out: true},
	{entry: wireschema.Entry{Name: "PluginChangedFrame", Value: pluginChangedFrame{}, Types: frameTypes(framePluginChanged)}, out: true},
	{entry: wireschema.Entry{Name: "SettingsChangedFrame", Value: settingsChangedFrame{}, Types: frameTypes(frameSettingsChanged)}, out: true},
	{entry: wireschema.Entry{Name: "PinboardChangedFrame", Value: pinboardChangedFrame{}, Types: frameTypes(framePinboardChanged)}, out: true},
	{entry: wireschema.Entry{Name: "PinboardRevealFrame", Value: pinboardRevealFrame{}, Types: frameTypes(framePinboardReveal)}, out: true},
	{entry: wireschema.Entry{Name: "WorkspacesChangedFrame", Value: workspacesChangedFrame{}, Types: frameTypes(frameWorkspacesChanged)}, out: true},
	{entry: wireschema.Entry{Name: "ProcessesChangedFrame", Value: processesChangedFrame{}, Types: frameTypes(frameProcessesChanged)}, out: true},
	{entry: wireschema.Entry{Name: "ViewerRelayFrame", Value: viewerRelayFrame{}, Types: frameTypes(frameViewerRelay)}, out: true},
	{entry: wireschema.Entry{Name: "ProvidersUpdateFrame", Value: providersUpdateFrame{}, Types: frameTypes(frameProvidersUpdate)}, out: true},
	{entry: wireschema.Entry{Name: "UpdateStatusFrame", Value: updateStatusMsg{}, Types: frameTypes(frameUpdateStatus)}, out: true},
	{entry: wireschema.Entry{Name: "ClientsChangedFrame", Value: clientsChangedFrame{}, Types: frameTypes(frameClientsChanged)}, out: true},
	{entry: wireschema.Entry{Name: "ShellOutputFrame", Value: shellOutputFrame{}, Types: frameTypes(frameShellOutput)}, out: true},
	{entry: wireschema.Entry{Name: "HeartbeatFrame", Value: bareFrame{}, Types: frameTypes(frameHeartbeat)}, out: true},
	{entry: wireschema.Entry{Name: "SessionFrame", Value: sessionFrame{}, Types: frameTypes(frameSession)}, out: true},
	{entry: wireschema.Entry{Name: "WorkerMessageFrame", Value: worker.WorkerMessage{}, Types: frameTypes(frameWorkerMessage)}, out: true, in: true},
	{entry: wireschema.Entry{Name: "ConversationsChangedFrame", Value: conversationsChangedFrame{}, Types: frameTypes(frameConversationsChanged)}, out: true},
	{entry: wireschema.Entry{Name: "ConversationsReorderedFrame", Value: conversationsReorderedFrame{}, Types: frameTypes(frameConversationsChanged)}, out: true},
	{entry: wireschema.Entry{Name: "NoticeFrame", Value: textFrame{}, Types: frameTypes(frameNotice)}, out: true},
	{entry: wireschema.Entry{Name: "SessionMetadataChangedFrame", Value: sessionMetadataChangedFrame{}, Types: frameTypes(frameSessionMetadataChanged)}, out: true},
	{entry: wireschema.Entry{Name: "SessionChangedFrame", Value: bareFrame{}, Types: frameTypes(frameSessionChanged)}, out: true, in: true},
	{entry: wireschema.Entry{Name: "RunOneShotFrame", Value: runOneShotFrame{}, Types: frameTypes(frameRunOneShot)}, out: true},
	{entry: wireschema.Entry{Name: "ErrorFrame", Value: textFrame{}, Types: frameTypes(frameError)}, out: true},
	{entry: wireschema.Entry{Name: "ServerFullFrame", Value: messageFrame{}, Types: frameTypes(frameServerFull)}, out: true},
	{entry: wireschema.Entry{Name: "ServerShutdownFrame", Value: messageFrame{}, Types: frameTypes(frameServerShutdown)}, out: true},

	{entry: wireschema.Entry{Name: "EngineHeartbeatFrame", Value: bareFrame{}, Types: frameTypes(frameEngineHeartbeat)}, in: true},
	{entry: wireschema.Entry{Name: "ViewerHeartbeatFrame", Value: bareFrame{}, Types: frameTypes(frameViewerHeartbeat)}, in: true},
	{entry: wireschema.Entry{Name: "ViewerFaultFrame", Value: ViewerFault{}, Types: frameTypes(frameViewerFault)}, in: true},
	{entry: wireschema.Entry{Name: "ShellStartFrame", Value: ShellStartRequest{}, Types: frameTypes(frameShellStart)}, in: true},
	{entry: wireschema.Entry{Name: "ShellCancelFrame", Value: ShellCancelRequest{}, Types: frameTypes(frameShellCancel)}, in: true},
	{entry: wireschema.Entry{Name: "ViewerRelayRequestFrame", Value: ViewerRelay{}, Types: frameTypes(frameViewerRelay)}, in: true},
}

// serverFramesUntyped is the frames with no struct to render. engine-bridge
// is relayed as the bytes the engine wrote, both ways; one-shot-result decodes
// into OneShotResult, which does not carry the frame's type.
var (
	serverOutboundUntyped = []frameType{frameEngineBridge}
	serverInboundUntyped  = []frameType{frameEngineBridge, frameOneShotResult}
)

// TestWireTypedefs holds web/js/protocol/server-wire-types.gen.js to the
// frame structs. UPDATE=1 rewrites the file.
func TestWireTypedefs(t *testing.T) {
	entries := make([]wireschema.Entry, len(serverFrameTypedefs))
	for i, f := range serverFrameTypedefs {
		entries[i] = f.entry
	}
	got, err := wireschema.Render(wireschema.Config{
		Source: "TestWireTypedefs (cmd/juggler/server/wire_typedefs_test.go)",
		// Settings and pins are owned by their own features and extensions;
		// the frame carries them whole.
		Opaque: []reflect.Type{reflect.TypeFor[core.GlobalSettings](), reflect.TypeFor[core.Pin]()},
		Rename: map[reflect.Type]string{
			reflect.TypeFor[msg.Message]():   "ServerText",
			reflect.TypeFor[workspace.Row](): "WorkspaceRow",
		},
	}, entries)
	if err != nil {
		t.Fatal(err)
	}
	wireschema.CompareGolden(t, serverTypedefsFile, got)
}

// TestWireTypedefsCoverTheVocabulary: every frame type, each way, has a
// typedef or is listed as having no struct.
func TestWireTypedefsCoverTheVocabulary(t *testing.T) {
	check := func(what string, all, untyped []frameType, travels func(frameTypedef) bool) {
		got := map[string]bool{}
		for _, f := range serverFrameTypedefs {
			if travels(f) {
				for _, typ := range f.entry.Types {
					got[typ] = true
				}
			}
		}
		for _, typ := range untyped {
			if got[string(typ)] {
				t.Errorf("%s: %q has a typedef and is listed as untyped", what, typ)
			}
			got[string(typ)] = true
		}
		want := map[string]bool{}
		for _, typ := range all {
			want[string(typ)] = true
		}
		if m := missingFrom(want, got); len(m) > 0 {
			t.Errorf("%s: no typedef for %v — add an entry to serverFrameTypedefs, or list it as untyped", what, m)
		}
		if m := missingFrom(got, want); len(m) > 0 {
			t.Errorf("%s: typedefs for %v, which are not in the vocabulary (wire_vocab.go)", what, m)
		}
	}
	check("outbound", allOutboundFrames, serverOutboundUntyped, func(f frameTypedef) bool { return f.out })
	check("inbound", allInboundFrames, serverInboundUntyped, func(f frameTypedef) bool { return f.in })
}
