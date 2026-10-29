//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
	"juggler/tests/integration/helpers"
)

// waitForLLMCall polls until the mock sequence has recorded at least `want`
// calls (i.e. the worker dispatched the turn), or the timeout elapses.
func waitForLLMCall(seq *helpers.LLMSequence, want int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if seq.CallCount() >= want {
			return nil
		}
		time.Sleep(5 * time.Millisecond)
	}
	return fmt.Errorf("LLM call count never reached %d (got %d)", want, seq.CallCount())
}

// TestImageAttachmentReachesProviderRequest is B1: a user message sent with an
// image attachment must (a) reach the provider as an image "part" referencing
// the asset by id+mime, and (b) carry the attachment ref on the user item in
// the doc. The capturing mock LLM (LLMSequence.LastRequest) records the exact
// request the worker built, so this asserts the real buildMessages → parts
// path end-to-end without a live provider.
func TestImageAttachmentReachesProviderRequest(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

	seq := ts.SetLLMSequence(helpers.TextResponse("Got the image."))

	// A model must be set or send-message bails on validation. Capability
	// gating lives in the UI, not the worker — buildMessages emits parts for
	// any model — so a bare test model is sufficient to prove the wire shape.
	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	att := worker.AssetRef{
		ID:       "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		Mime:     "image/png",
		Filename: "pixel.png",
		Bytes:    95,
		Width:    1,
		Height:   1,
	}

	send, _ := json.Marshal(worker.SendMessageMessage{
		Type:        "send-message",
		Text:        "describe this image",
		Attachments: []worker.AssetRef{att},
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", send, nil)

	// Dispatch is async (requestLLM sets activity; the reducer picks it up a
	// tick later), so fence on the LLM call actually happening rather than on
	// a worker state that is still idle the instant send returns.
	if err := waitForLLMCall(seq, 1, 5*time.Second); err != nil {
		t.Fatalf("LLM was never called after send: %v", err)
	}

	// (a) The captured provider request must carry the image part.
	req := seq.LastRequest()
	if req == nil {
		t.Fatal("no request captured by the mock LLM")
	}
	parts := helpers.ImagePartsInRequest(req)
	if len(parts) != 1 {
		t.Fatalf("expected exactly 1 image part in the request, got %d (req=%s)", len(parts), string(req))
	}
	if got, _ := parts[0]["assetId"].(string); got != att.ID {
		t.Errorf("image part assetId = %q, want %q", got, att.ID)
	}
	if got, _ := parts[0]["mime"].(string); got != att.Mime {
		t.Errorf("image part mime = %q, want %q", got, att.Mime)
	}

	// (b) The user item in the doc must carry the attachment ref.
	items := ts.GetDocument().GetItems()
	var user *worker.ConversationItem
	for i := range items {
		if items[i].Type == worker.ItemTypeUser {
			user = &items[i]
			break
		}
	}
	if user == nil {
		t.Fatalf("no user item in doc; items=%+v", items)
	}
	if len(user.Attachments) != 1 {
		t.Fatalf("user item carries %d attachments, want 1", len(user.Attachments))
	}
	if user.Attachments[0].ID != att.ID || user.Attachments[0].Mime != att.Mime {
		t.Errorf("doc attachment ref = %+v, want id=%q mime=%q",
			user.Attachments[0], att.ID, att.Mime)
	}
}

// imagePartsInToolResults extracts image parts from tool-result messages in the
// captured request. ImagePartsInRequest scans only user messages; a tool-result
// wire message has type "tool-result" (it still maps to the user role, and the
// providers emit its images), so this sibling walks that message type.
func imagePartsInToolResults(t *testing.T, req json.RawMessage) []map[string]any {
	t.Helper()
	var parsed struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal(req, &parsed); err != nil {
		t.Fatalf("unmarshal request: %v", err)
	}
	var out []map[string]any
	for _, msg := range parsed.Messages {
		if tp, _ := msg["type"].(string); tp != "tool-result" {
			continue
		}
		rawParts, ok := msg["parts"].([]any)
		if !ok {
			continue
		}
		for _, p := range rawParts {
			if part, ok := p.(map[string]any); ok {
				if pt, _ := part["type"].(string); pt == "image" {
					out = append(out, part)
				}
			}
		}
	}
	return out
}

// TestReadImageToolResultReachesProviderRequest is the read-tool analogue of the
// user-attachment path: a completed read tool-action that returned an image
// carries the AssetRef at the item level (same field user attachments use), and
// the worker must replay it as an image "part" on the tool-result message. The
// capturing mock records the exact request built from the real buildMessages →
// tool-action → tool-result path.
func TestReadImageToolResultReachesProviderRequest(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

	seq := ts.SetLLMSequence(helpers.TextResponse("I can see the image."))

	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	att := worker.AssetRef{
		ID:     "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		Mime:   "image/png",
		Width:  1,
		Height: 1,
		Bytes:  95,
	}

	// A completed read tool-action whose result was an image. The AssetRef rides
	// at the item level exactly like a user attachment.
	ts.GetDocument().AppendMessage(
		worker.ConversationItem{Type: worker.ItemTypeUser, ItemID: "u1", Content: "read pixel.png"},
		worker.ConversationItem{Type: worker.ItemTypeAssistant, ItemID: "a1", Content: "reading it"},
		worker.ConversationItem{
			Type:        worker.ItemTypeToolAction,
			ItemID:      "ta1",
			ToolUseID:   "tool_1",
			ToolName:    "read",
			ToolInput:   json.RawMessage(`{"file_path":"pixel.png"}`),
			State:       worker.StateCompleted,
			Result:      json.RawMessage(`{"content":"Read image pixel.png","isError":false}`),
			Attachments: []worker.AssetRef{att},
		},
	)

	// A follow-up send triggers a turn whose request replays the tool-result.
	send, _ := json.Marshal(worker.SendMessageMessage{Type: "send-message", Text: "what is it?"})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", send, nil)

	if err := waitForLLMCall(seq, 1, 5*time.Second); err != nil {
		t.Fatalf("LLM was never called after send: %v", err)
	}

	req := seq.LastRequest()
	if req == nil {
		t.Fatal("no request captured by the mock LLM")
	}
	parts := imagePartsInToolResults(t, req)
	if len(parts) != 1 {
		t.Fatalf("expected exactly 1 image part in the tool-result, got %d (req=%s)", len(parts), string(req))
	}
	if got, _ := parts[0]["assetId"].(string); got != att.ID {
		t.Errorf("tool-result image part assetId = %q, want %q", got, att.ID)
	}
	if got, _ := parts[0]["mime"].(string); got != att.Mime {
		t.Errorf("tool-result image part mime = %q, want %q", got, att.Mime)
	}
}

// TestTextMessageEmitsNoParts guards the backward-compatible path: a plain
// user message (no attachments) must produce a request with no image parts and
// a doc item with no attachment refs — byte-for-byte the legacy shape.
func TestTextMessageEmitsNoParts(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

	seq := ts.SetLLMSequence(helpers.TextResponse("OK."))
	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	send, _ := json.Marshal(worker.SendMessageMessage{Type: "send-message", Text: "hello"})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", send, nil)

	if err := waitForLLMCall(seq, 1, 5*time.Second); err != nil {
		t.Fatalf("LLM was never called after send: %v", err)
	}

	if parts := helpers.ImagePartsInRequest(seq.LastRequest()); len(parts) != 0 {
		t.Fatalf("plain text message produced %d image parts, want 0", len(parts))
	}
	for _, it := range ts.GetDocument().GetItems() {
		if it.Type == worker.ItemTypeUser && len(it.Attachments) != 0 {
			t.Fatalf("plain text user item carries attachments: %+v", it.Attachments)
		}
	}
}
