//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

import (
	"reflect"
	"testing"

	"juggler/cmd/juggler/msg"
)

// TestWireRepliesKeepTheirShape pins each typed reply to the JSON the worker
// sent before it had a type: the map each site built, beside the struct that
// replaced it. Compared decoded, because a map marshals its keys sorted and a
// struct in field order — byte order was never the contract — but presence
// was: an omitempty that drops a key the client reads, or a field that adds
// one, shows here as a difference.
func TestWireRepliesKeepTheirShape(t *testing.T) {
	text := msg.New("Working")
	cases := []struct {
		name   string
		before map[string]any
		after  any
	}{
		{"ack", map[string]any{"type": "ack", "ackId": "a1"},
			AckMessage{Type: msgAck, AckID: "a1"}},
		{"ack with a false result",
			map[string]any{"type": "ack", "ackId": "a1", "result": false},
			AckMessage{Type: msgAck, AckID: "a1", Result: false}},
		{"ack with a true result",
			map[string]any{"type": "ack", "ackId": "a1", "result": true},
			AckMessage{Type: msgAck, AckID: "a1", Result: true}},
		{"status, root thread, no code or text",
			map[string]any{"type": "status", "status": "idle", "message": "", "threadItemId": ""},
			StatusMessage{Type: msgStatus, Status: "idle", Message: "", ThreadItemID: ""}},
		{"status with code and text",
			map[string]any{"type": "status", "status": "validation-error", "message": "m", "threadItemId": "t1", "code": "c", "text": text},
			StatusMessage{Type: msgStatus, Status: "validation-error", Message: "m", ThreadItemID: "t1", Code: "c", Text: &text}},
		{"mock-paused status",
			map[string]any{"type": "status", "status": "mock-paused", "message": ""},
			mockPausedStatus{Type: msgStatus, Status: "mock-paused", Message: ""}},
		{"ready", map[string]any{"type": "ready", "summarizationPrompt": "p"},
			ReadyMessage{Type: msgReady, SummarizationPrompt: "p"}},
		{"ready with metadata",
			map[string]any{"type": "ready", "metadata": map[string]any{"k": "v"}, "summarizationPrompt": "p"},
			ReadyMessage{Type: msgReady, Metadata: map[string]any{"k": "v"}, SummarizationPrompt: "p"}},
		{"ready with empty metadata",
			map[string]any{"type": "ready", "metadata": map[string]any{}, "summarizationPrompt": "p"},
			ReadyMessage{Type: msgReady, Metadata: map[string]any{}, SummarizationPrompt: "p"}},
		{"create-thread-response, failed",
			map[string]any{"type": "create-thread-response", "requestId": "r1", "error": "boom"},
			CreateThreadResponse{Type: msgCreateThreadResponse, RequestID: "r1", Error: "boom"}},
		{"create-thread-response, created",
			map[string]any{"type": "create-thread-response", "requestId": "r1", "threadItemId": "t1"},
			CreateThreadResponse{Type: msgCreateThreadResponse, RequestID: "r1", ThreadItemID: "t1"}},
		{"cancel-strategy-execution", map[string]any{"type": "cancel-strategy-execution"},
			bareMessage{Type: msgCancelStrategyExecution}},
		{"pong", map[string]any{"type": "pong"}, bareMessage{Type: msgPong}},
		{"request-tools, root thread",
			map[string]any{"type": "request-tools", "requestId": "q1", "threadItemId": "", "sentAt": int64(1729000000000)},
			RequestToolsMessage{Type: msgRequestTools, RequestID: "q1", ThreadItemID: "", SentAt: 1729000000000}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if before, after := asJSONObject(t, c.before), asJSONObject(t, c.after); !reflect.DeepEqual(before, after) {
				t.Errorf("shape changed:\n  map:    %v\n  struct: %v", before, after)
			}
		})
	}
}
