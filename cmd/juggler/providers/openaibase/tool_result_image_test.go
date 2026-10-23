//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package openaibase

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestToolResultImageBecomesTrailingUserMessage: role="tool" messages are
// text-only, so a tool-result image is carried by a following user message with
// an image_url part — emitted AFTER the tool message (Chat Completions path).
func TestToolResultImageBecomesTrailingUserMessage(t *testing.T) {
	data := []byte{1, 2, 3, 4, 5}
	msgs := []provider.Message{
		{Type: "assistant", Content: "looking"},
		{Type: "tool-use", ToolUseID: "t1", ToolName: "read", ToolInput: map[string]any{}},
		{Type: "tool-result", ToolUseID: "t1", Content: "Read image", Parts: []provider.MediaPart{
			{Type: "image", Mime: "image/png", Data: data},
		}},
	}

	out := transformMessages(msgs, false, ReasoningReplay{}, "", "")
	blob, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	s := string(blob)

	wantURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
	if !strings.Contains(s, wantURI) {
		t.Fatalf("image data URI missing from request: %s", s)
	}
	// The tool message (identified by tool_call_id) must precede the image turn.
	ti := strings.Index(s, "tool_call_id")
	ii := strings.Index(s, wantURI)
	if ti < 0 || ii < 0 || ti > ii {
		t.Fatalf("expected tool message before image turn (tool=%d image=%d): %s", ti, ii, s)
	}
}

// TestResponsesToolResultImageBecomesTrailingUserMessage: the Responses API
// path (function_call_output is text-only) carries the image in a following
// user input message.
func TestResponsesToolResultImageBecomesTrailingUserMessage(t *testing.T) {
	data := []byte{9, 9, 9, 8}
	msgs := []provider.Message{
		{Type: "tool-use", ToolUseID: "t1", ToolName: "read", ToolInput: map[string]any{}},
		{Type: "tool-result", ToolUseID: "t1", Content: "Read image", Parts: []provider.MediaPart{
			{Type: "image", Mime: "image/png", Data: data},
		}},
	}

	in := transformMessagesToResponsesInput(msgs)
	blob, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(blob), "data:image/png;base64,"+base64.StdEncoding.EncodeToString(data)) {
		t.Fatalf("image data URI missing from responses input: %s", string(blob))
	}
}
