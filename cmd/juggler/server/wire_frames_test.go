//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"reflect"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/workspace"
)

// asJSONObject marshals v and decodes it back as a generic object, so a map and
// a struct compare by content, not by key order.
func asJSONObject(t *testing.T, v any) map[string]any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// frameMap is a sent message as a client decodes it. Frames are structs and
// maps alike on the Go side, so a test asserting on a frame's keys reads its
// JSON; ok is false for a message that is not a JSON object.
func frameMap(v any) (map[string]any, bool) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, false
	}
	var m map[string]any
	if json.Unmarshal(data, &m) != nil {
		return nil, false
	}
	return m, m != nil
}

// TestFramesKeepTheirShape pins each typed frame to the JSON the server sent
// before it had a type: the map each site built, beside the struct that
// replaced it, compared decoded. Presence is what is pinned — a key an
// omitempty drops or a field that adds one shows here as a difference.
func TestFramesKeepTheirShape(t *testing.T) {
	notice := msg.New("Couldn't name this conversation")
	pins := []core.Pin{{}}
	cases := []struct {
		name   string
		before map[string]any
		after  any
	}{
		{"clients-changed", map[string]any{"type": "clients-changed", "count": 1, "clients": []clientDescriptor{{}}},
			clientsChangedFrame{Type: frameClientsChanged, Count: 1, Clients: []clientDescriptor{{}}}},
		{"server-shutdown", map[string]any{"type": "server-shutdown", "message": "Server is shutting down"},
			messageFrame{Type: frameServerShutdown, Message: "Server is shutting down"}},
		{"session-changed", map[string]any{"type": "session-changed"}, bareFrame{Type: frameSessionChanged}},
		{"session-metadata-changed", map[string]any{"type": "session-metadata-changed", "metadata": map[string]any{"k": "v"}},
			sessionMetadataChangedFrame{Type: frameSessionMetadataChanged, Metadata: map[string]any{"k": "v"}}},
		{"workspaces-changed, none", map[string]any{"type": "workspaces-changed", "workspaces": []workspace.Row{}},
			workspacesChangedFrame{Type: frameWorkspacesChanged, Workspaces: []workspace.Row{}}},
		{"pinboard-changed", map[string]any{"type": "pinboard-changed", "board": "b", "pins": pins},
			pinboardChangedFrame{Type: framePinboardChanged, Board: "b", Pins: pins}},
		{"pinboard-reveal", map[string]any{"type": "pinboard-reveal", "board": "b", "pin": "p"},
			pinboardRevealFrame{Type: framePinboardReveal, Board: "b", Pin: "p"}},
		{"pinboard-reveal from", map[string]any{"type": "pinboard-reveal", "board": "b", "pin": "p", "from": "c"},
			pinboardRevealFrame{Type: framePinboardReveal, Board: "b", Pin: "p", From: "c"}},
		{"conversations-changed", map[string]any{"type": "conversations-changed", "op": "deleted", "id": "c1"},
			conversationsChangedFrame{Type: frameConversationsChanged, Op: "deleted", ID: "c1"}},
		{"conversations-changed named", map[string]any{"type": "conversations-changed", "op": "renamed", "id": "c1", "name": "n"},
			conversationsChangedFrame{Type: frameConversationsChanged, Op: "renamed", ID: "c1", Name: "n"}},
		{"conversations-changed focus from", map[string]any{"type": "conversations-changed", "op": "focus", "id": "c1", "from": "c2"},
			conversationsChangedFrame{Type: frameConversationsChanged, Op: "focus", ID: "c1", From: "c2"}},
		{"conversations-changed reordered", map[string]any{"type": "conversations-changed", "op": "reordered", "order": []string{}},
			conversationsReorderedFrame{Type: frameConversationsChanged, Op: "reordered", Order: []string{}}},
		{"notice", map[string]any{"type": "notice", "message": notice.English(), "text": notice},
			textFrame{Type: frameNotice, Message: notice.English(), Text: notice}},
		{"providers-update", map[string]any{"type": "providers-update", "providers": []ProviderStatus{{}}, "ready": true},
			providersUpdateFrame{Type: frameProvidersUpdate, Providers: []ProviderStatus{{}}, Ready: true}},
		{"file-change", map[string]any{"type": "file-change", "changes": []core.FileChange{{}}},
			fileChangeFrame{Type: frameFileChange, Changes: []core.FileChange{{}}}},
		{"plugin-changed", map[string]any{"type": "plugin-changed", "path": "config/plugins"},
			pluginChangedFrame{Type: framePluginChanged, Path: "config/plugins"}},
		{"settings-changed", map[string]any{"type": "settings-changed", "settings": core.GlobalSettings{}},
			settingsChangedFrame{Type: frameSettingsChanged, Settings: core.GlobalSettings{}}},
		{"run-one-shot", map[string]any{"type": "run-one-shot", "requestId": "r", "prompt": "p", "strategyId": "", "name": "n", "timeoutMs": int64(5000)},
			runOneShotFrame{Type: frameRunOneShot, RequestID: "r", Prompt: "p", StrategyID: "", Name: "n", TimeoutMs: 5000}},
		{"shell-output refused", map[string]any{"type": "shell-output", "shellId": "s", "done": true, "error": "no"},
			shellRefusedFrame("s", "no")},
		{"session", map[string]any{"type": "session", "clientId": "c", "viewerId": "", "bootId": "b"},
			sessionFrame{Type: frameSession, ClientID: "c", ViewerID: "", BootID: "b"}},
		{"server-full", map[string]any{"type": "server-full", "message": "Too many clients are connected"},
			messageFrame{Type: frameServerFull, Message: "Too many clients are connected"}},
		{"viewer-relay", map[string]any{"type": "viewer-relay", "from": "v1", "payload": json.RawMessage(`{"k":1}`)},
			viewerRelayFrame{Type: frameViewerRelay, From: "v1", Payload: json.RawMessage(`{"k":1}`)}},
		{"viewer-relay, no payload", map[string]any{"type": "viewer-relay", "from": "v1", "payload": json.RawMessage(nil)},
			viewerRelayFrame{Type: frameViewerRelay, From: "v1"}},
		{"error", map[string]any{"type": "error", "message": notice.English(), "text": notice},
			textFrame{Type: frameError, Message: notice.English(), Text: notice}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if before, after := asJSONObject(t, c.before), asJSONObject(t, c.after); !reflect.DeepEqual(before, after) {
				t.Errorf("shape changed:\n  map:    %v\n  struct: %v", before, after)
			}
		})
	}
}

// TestShellOutputChunkKeepsItsShape pins the streaming chunk frame, whose keys
// depend on the chunk: status and hint only on a status chunk, exitCode on every
// done chunk (0 included), the spill fields only when output was spilled.
func TestShellOutputChunkKeepsItsShape(t *testing.T) {
	legacy := func(chunk ops.ShellStreamChunk) map[string]any {
		m := map[string]any{"type": "shell-output", "shellId": chunk.ShellID, "data": chunk.Data, "done": chunk.Done}
		if chunk.Status != "" {
			m["status"] = chunk.Status
			if chunk.Hint != "" {
				m["hint"] = chunk.Hint
			}
		}
		if chunk.Done {
			m["exitCode"] = chunk.ExitCode
			if chunk.Error != "" {
				m["error"] = chunk.Error
			}
			if chunk.OutputFile != "" {
				m["outputFile"] = chunk.OutputFile
				m["outputBytes"] = chunk.OutputBytes
				m["truncated"] = chunk.Truncated
			}
		}
		return m
	}
	for name, chunk := range map[string]ops.ShellStreamChunk{
		"data":              {ShellID: "s", Data: "out"},
		"empty data":        {ShellID: "s"},
		"status":            {ShellID: "s", Status: "running"},
		"status with hint":  {ShellID: "s", Status: "awaiting-permission", Hint: "h"},
		"done, exit 0":      {ShellID: "s", Done: true},
		"done with error":   {ShellID: "s", Done: true, ExitCode: 2, Error: "boom"},
		"done, spilled":     {ShellID: "s", Done: true, OutputFile: "/tmp/f", OutputBytes: 10},
		"done, spilled cut": {ShellID: "s", Done: true, OutputFile: "/tmp/f", OutputBytes: 10, Truncated: true},
	} {
		t.Run(name, func(t *testing.T) {
			if before, after := asJSONObject(t, legacy(chunk)), asJSONObject(t, shellOutputFrameOf(chunk)); !reflect.DeepEqual(before, after) {
				t.Errorf("shape changed:\n  map:    %v\n  struct: %v", before, after)
			}
		})
	}
}
