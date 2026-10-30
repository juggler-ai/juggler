//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

// TestToolCommandsCarryWorkerStateVector holds every tool command to carrying
// the worker's Yjs state vector as it stood when the command went out. The
// engine compares it with its own to tell a command that is merely stale (the
// worker already holds everything the engine wrote, and is only slow to act on
// it) from a worker that genuinely lacks an engine write — and repairs only the
// second, with just the ops it lacks.
func TestToolCommandsCarryWorkerStateVector(t *testing.T) {
	const convID = "conv-command-vector"
	w := NewConversationWorker(convID, "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: convID},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)

	commands := make(chan map[string]any, 64)
	flushed := make(chan struct{}, 1)
	w.SetCallback("engine", func(b []byte) {
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		switch m["type"] {
		case "flush-sentinel":
			select {
			case flushed <- struct{}{}:
			default:
			}
		case "evaluate-tool", "execute-tool", "cancel-tool":
			commands <- m
		}
	})
	w.SetEngineClientID("engine")
	flush := func() {
		t.Helper()
		b, _ := json.Marshal(ToolCommand{Type: "flush-sentinel"})
		w.callbacks.sendToEngine(b)
		select {
		case <-flushed:
		case <-time.After(flushBarrierWait):
			t.Fatal("flush barrier timed out")
		}
	}
	// next returns the one command sent since the last call, and the worker's
	// vector at that moment: nothing writes the doc between dispatch and here.
	next := func(wantType string) (map[string]any, []byte) {
		t.Helper()
		flush()
		var got []map[string]any
		for len(commands) > 0 {
			got = append(got, <-commands)
		}
		if len(got) != 1 || got[0]["type"] != wantType {
			t.Fatalf("want exactly one %s command, got %+v", wantType, got)
		}
		return got[0], w.doc.GetStateVector()
	}
	assertVector := func(cmd map[string]any, want []byte) {
		t.Helper()
		raw, ok := cmd["stateVector"].(string)
		if !ok {
			t.Fatalf("%s must carry the worker's state vector as a base64 string, got %#v", cmd["type"], cmd["stateVector"])
		}
		got, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			t.Fatalf("%s stateVector is not base64: %v", cmd["type"], err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("%s must carry the worker's current state vector:\n  got  %x\n  want %x", cmd["type"], got, want)
		}
	}

	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeToolAction, ItemID: "ta-eval", ToolUseID: "tu-eval", ToolName: "bash"})
	w.driveToolActions()
	cmd, vector := next("evaluate-tool")
	assertVector(cmd, vector)

	// A later write moves the vector on; the next command must carry the new one.
	w.doc.UpdateToolActionFieldsRecursive("tu-eval", map[string]any{"state": StateApproved})
	w.driveToolActions()
	cmd, vector = next("execute-tool")
	assertVector(cmd, vector)

	w.doc.UpdateToolActionFieldsRecursive("tu-eval", map[string]any{"state": StateRunning, "runningEpoch": 2})
	w.CancelInFlightToolActions("")
	cmd, vector = next("cancel-tool")
	assertVector(cmd, vector)
}
