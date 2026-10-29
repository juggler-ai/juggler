//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package integration_test

// The tests beside image_attachment_test.go that need a test-capable build:
// they wait on the worker's pending queue through HasPendingItems.

import (
	"context"
	"encoding/json"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
	"juggler/tests/integration/helpers"
)

// waitForPendingItems polls until the thread ("" => root) has a queued message
// parked in pendingItems, or the timeout elapses. Lets a test deterministically
// wait for a busy-time send to land in the queue before releasing the in-flight
// turn (so the turn promotes the queued message rather than racing it in fresh).
func waitForPendingItems(ts *helpers.TestSession, threadItemID string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ts.Worker.HasPendingItems(threadItemID) {
			return nil
		}
		time.Sleep(5 * time.Millisecond)
	}
	return fmt.Errorf("pending items never appeared for thread %q", threadItemID)
}

// TestQueuedImageAttachmentReachesProviderRequest is the regression for the
// dropped-queued-image bug: a message sent with an image WHILE A TURN IS IN
// FLIGHT is queued ("type while busy") and promoted at the next boundary. The
// promoted turn must reach the provider carrying its image part — the queue
// path must not split the text from its attachments.
//
// The first LLM call is gated so the worker stays busy while the image message
// is sent; releasing it promotes the queued message and dispatches a second
// call, whose captured request must carry the image part.
func TestQueuedImageAttachmentReachesProviderRequest(t *testing.T) {
	t.Parallel()
	ts := helpers.SetupTestSession(t)
	ts.SetupMockEngine()

	ts.GetDocument().SetMetadata("defaultModelConfig", map[string]any{
		"provider": "test",
		"model":    "test-model",
	})

	// Two responses: the in-flight turn, then the promoted queued turn.
	seq := helpers.NewLLMSequence(
		helpers.TextResponse("working on the first message"),
		helpers.TextResponse("got the queued image"),
	)
	base := seq.AsCallFunc()

	// Gate the FIRST LLM call so the worker is genuinely busy when the image
	// message arrives. firstSeen fires once the turn is in flight; release lets
	// it complete.
	firstSeen := make(chan struct{})
	release := make(chan struct{})
	var gated int32
	gatedFn := func(ctx context.Context, req json.RawMessage, cb func(worker.StreamChunk)) (*worker.LLMResponse, error) {
		if atomic.CompareAndSwapInt32(&gated, 0, 1) {
			close(firstSeen)
			<-release
		}
		return base(ctx, req, cb)
	}
	ts.Manager.SetLLMCaller(gatedFn)
	ts.Worker.SetLLMCaller(gatedFn)

	// 1. Plain first message → starts a turn that blocks in the gated call.
	send1, _ := json.Marshal(worker.SendMessageMessage{Type: "send-message", Text: "first message"})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", send1, nil)
	select {
	case <-firstSeen:
	case <-time.After(5 * time.Second):
		t.Fatal("first LLM call never started; worker never became busy")
	}

	// 2. While busy, send a second message carrying an image — must be QUEUED.
	att := worker.AssetRef{
		ID:       "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		Mime:     "image/png",
		Filename: "pixel.png",
		Bytes:    95,
		Width:    1,
		Height:   1,
	}
	send2, _ := json.Marshal(worker.SendMessageMessage{
		Type:        "send-message",
		Text:        "describe this queued image",
		Attachments: []worker.AssetRef{att},
	})
	ts.Manager.HandleMessage(ts.ConvID, "send-message", send2, nil)

	// Fence on the message actually landing in the queue, so releasing the turn
	// promotes it rather than racing it in as a fresh (non-busy) send.
	if err := waitForPendingItems(ts, "", 5*time.Second); err != nil {
		t.Fatalf("second send never queued: %v", err)
	}

	// 3. Release the first turn → worker promotes the queued message and
	//    dispatches a second LLM call for it.
	close(release)
	if err := waitForLLMCall(seq, 2, 5*time.Second); err != nil {
		t.Fatalf("queued message never drove a second LLM call: %v", err)
	}

	// The promoted turn's request MUST carry the image part. Before the fix,
	// enqueuePendingMessage built the queued item from bare text, so the
	// promoted item — and this request — had no attachment at all.
	reqs := seq.Requests()
	if len(reqs) < 2 {
		t.Fatalf("expected at least 2 captured requests, got %d", len(reqs))
	}
	parts := helpers.ImagePartsInRequest(reqs[1])
	if len(parts) != 1 {
		t.Fatalf("queued turn's request carried %d image parts, want 1 (req=%s)", len(parts), string(reqs[1]))
	}
	if got, _ := parts[0]["assetId"].(string); got != att.ID {
		t.Errorf("image part assetId = %q, want %q", got, att.ID)
	}

	// And the promoted user item in the doc must carry the attachment ref.
	var queued *worker.ConversationItem
	for _, it := range ts.GetDocument().GetItems() {
		if it.Type == worker.ItemTypeUser && it.Content == "describe this queued image" {
			item := it
			queued = &item
		}
	}
	if queued == nil {
		t.Fatal("promoted queued user item not found in doc")
	}
	if len(queued.Attachments) != 1 || queued.Attachments[0].ID != att.ID {
		t.Fatalf("promoted user item attachments = %+v, want one ref id=%q", queued.Attachments, att.ID)
	}
}
