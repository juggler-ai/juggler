//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// msgChan wraps a buffered channel for use as a worker send callback.
// It provides deterministic waiting without sleeps.
type msgChan struct {
	ch chan []byte
}

func newMsgChan() *msgChan { return &msgChan{ch: make(chan []byte, 1000)} }

func (m *msgChan) callback(msg []byte) { m.ch <- msg }

// frameLog is the sequence of message types one client received.
type frameLog []string

// saw reports whether a frame of this type is in the log.
func (f frameLog) saw(msgType string) bool {
	for _, frame := range f {
		if frame == msgType {
			return true
		}
	}
	return false
}

// barrierSeq numbers the barriers. A barrier's ack is broadcast to every
// client, so a stream can hold acks belonging to barriers run against another
// client, and a drain that stopped at the first ack it saw would stop short of
// the traffic it was there to read.
var barrierSeq atomic.Int64

const barrierAckPrefix = "test-barrier-"

// barrierBudget bounds how long a barrier waits for its own ack. The ack is
// produced by the run loop and the batcher on their own goroutines, so the wait
// measures the scheduler, not the worker: on a CI box running every package's
// tests at once under -race, losing those goroutines the CPU for several
// seconds is ordinary. It is spent only by a run that is already failing, and
// stays well inside the package's `-timeout 5m` so a blown barrier is reported
// as the named test it belongs to rather than as a killed package.
const barrierBudget = 20 * time.Second

// framesUntilBarrier returns the type of every frame a client received up to
// the point where the worker had dealt with everything queued before this call
// — the frames the test's last action caused, and nothing else. It drains the
// traffic still owed to that client, so the next call reports only what
// happened after this one.
//
// The barrier is the test-harness ping: it runs on the run loop behind every
// message queued ahead of it, flushes the outbound sync batcher inline, and
// only then sends its ack, which each client's mailbox delivers in that same
// order. So what a client did or did not receive is decided by ordering. A
// quiet window cannot decide it: the broadcast a client is owed is produced by
// the run loop and the batcher on their own goroutines, and a loaded machine
// starves those for longer than any window worth waiting for — which is how a
// document push that never happened came to be reported as one that did.
func framesUntilBarrier(t *testing.T, w *ConversationWorker, mc *msgChan) frameLog {
	t.Helper()
	ackID := fmt.Sprintf("%s%d", barrierAckPrefix, barrierSeq.Add(1))
	payload, err := json.Marshal(map[string]string{"ackId": ackID})
	if err != nil {
		t.Fatalf("marshalling the barrier ping: %v", err)
	}
	w.Send("ping", payload)

	var seen frameLog
	deadline := time.After(barrierBudget)
	for {
		select {
		case raw := <-mc.ch:
			var msg struct {
				Type  string `json:"type"`
				AckID string `json:"ackId"`
			}
			if json.Unmarshal(raw, &msg) != nil {
				continue
			}
			switch {
			case msg.AckID == ackID:
				return seen
			case strings.HasPrefix(msg.AckID, barrierAckPrefix):
				// Another client's barrier passing through this stream.
			default:
				seen = append(seen, msg.Type)
			}
		case <-deadline:
			t.Fatalf("barrier %s never came back; the worker's outbound path is stuck", ackID)
			return nil
		}
	}
}

// quiesce drains every named client of the traffic already owed to it, so a
// later assertion cannot be answered by a frame from before it.
func quiesce(t *testing.T, w *ConversationWorker, clients ...*msgChan) {
	t.Helper()
	for _, mc := range clients {
		framesUntilBarrier(t, w, mc)
	}
}

// waitForType blocks until a message with the given "type" field arrives or timeout.
func (m *msgChan) waitForType(t *testing.T, msgType string) map[string]any {
	t.Helper()
	deadline := time.NewTimer(barrierBudget)
	defer deadline.Stop()
	for {
		select {
		case raw := <-m.ch:
			var msg map[string]any
			if json.Unmarshal(raw, &msg) == nil && msg["type"] == msgType {
				return msg
			}
		case <-deadline.C:
			t.Fatalf("timeout waiting for message type %q", msgType)
			return nil
		}
	}
}

func TestConversationDocument(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")

	// Test inserting messages
	msg := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "msg1",
		Content: "Hello",
	}
	doc.InsertMessage(0, msg)

	items := doc.GetItems()
	if len(items) != 1 {
		t.Errorf("Expected 1 item, got %d", len(items))
	}
	if items[0].Content != "Hello" {
		t.Errorf("Expected content 'Hello', got '%s'", items[0].Content)
	}

	// Test appending
	msg2 := ConversationItem{
		Type:    ItemTypeAssistant,
		ItemID:  "msg2",
		Content: "Hi there!",
	}
	doc.AppendMessage(msg2)

	items = doc.GetItems()
	if len(items) != 2 {
		t.Errorf("Expected 2 items, got %d", len(items))
	}

	// Test deleting
	doc.DeleteMessages([]int{0})
	items = doc.GetItems()
	if len(items) != 1 {
		t.Errorf("Expected 1 item after delete, got %d", len(items))
	}
	if items[0].Content != "Hi there!" {
		t.Errorf("Expected remaining content 'Hi there!', got '%s'", items[0].Content)
	}

	// Test context items (items with an itemId in items array)
	contextItem := ConversationItem{
		Type:   "rule",
		ItemID: "ci1",
		Data:   []byte(`{"type":"test"}`),
	}
	doc.AppendMessage(contextItem)

	items = doc.GetItems()
	if len(items) != 2 {
		t.Errorf("Expected 2 items (message + context item), got %d", len(items))
	}
	if items[1].ItemID != "ci1" {
		t.Errorf("Expected context item with ID 'ci1', got '%s'", items[1].ItemID)
	}

	doc.Destroy()
}

func TestOperationTracker(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	tracker := NewOperationTracker(doc)

	// Insert a message via tracker
	msg := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "msg1",
		Content: "Test message",
	}
	tracker.InsertMessage(0, msg)

	// Verify message was inserted
	items := doc.GetItems()
	if len(items) != 1 {
		t.Errorf("Expected 1 item, got %d", len(items))
	}

	// Test undo
	if !tracker.CanUndo() {
		t.Error("Expected to be able to undo")
	}

	tracker.Undo()
	items = doc.GetItems()
	if len(items) != 0 {
		t.Errorf("Expected 0 items after undo, got %d", len(items))
	}

	// Test redo
	if !tracker.CanRedo() {
		t.Error("Expected to be able to redo")
	}

	tracker.Redo()
	items = doc.GetItems()
	if len(items) != 1 {
		t.Errorf("Expected 1 item after redo, got %d", len(items))
	}

	doc.Destroy()
}

func TestWorkerManager(t *testing.T) {
	manager := NewManager()

	// Create an init message
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:   "conv1",
			Name: "Test",
		},
		Config: WorkerConfig{
			ProjectPath: "/test",
		},
	})

	// Track sent messages
	var sentMessages [][]byte
	sendCallback := func(msg []byte) {
		sentMessages = append(sentMessages, msg)
	}

	// Handle init message - should create worker
	handled := manager.HandleMessage("conv1", "init", initPayload, sendCallback)
	if !handled {
		t.Error("Expected message to be handled")
	}

	// HandleMessage is synchronous with the manager; Count/Get are also serialized
	// through the manager ops channel, so they reflect the current state immediately.
	if manager.Count() != 1 {
		t.Errorf("Expected 1 worker, got %d", manager.Count())
	}

	// Get the worker
	w := manager.Get("conv1")
	if w == nil {
		t.Error("Expected to get worker")
	}

	// Shutdown
	manager.Shutdown()
	if manager.Count() != 0 {
		t.Errorf("Expected 0 workers after shutdown, got %d", manager.Count())
	}
}

func TestYjsDocument(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")

	// Test state encoding/decoding
	msg := ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "msg1",
		Content: "Test",
	}
	doc.InsertMessage(0, msg)

	state := doc.ToState()
	if len(state) == 0 {
		t.Error("Expected non-empty state")
	}

	// Create new doc and load state
	doc2 := NewConversationDocument("test-conv2", "user:test")
	err := doc2.LoadFromState(state)
	if err != nil {
		t.Errorf("LoadFromState failed: %v", err)
	}

	items := doc2.GetItems()
	if len(items) != 1 {
		t.Errorf("Expected 1 item in loaded doc, got %d", len(items))
	}

	doc.Destroy()
	doc2.Destroy()
}

// TestCompletedTurnsSurvivesPersistence proves the durable turn fence lives in
// its own top-level `completedTurns` metadata key (not the ephemeral
// processingState blob) and survives a save/load round-trip. The ephemeral
// processingState is left in the persisted bytes by design — handleInit rebuilds
// it to idle on load — so the only correctness requirement here is that the
// counter, the one value deliberately read back across a load, round-trips.
func TestCompletedTurnsSurvivesPersistence(t *testing.T) {
	doc := NewConversationDocument("persist-conv", "user:test")
	defer doc.Destroy()

	doc.SetMetadata("completedTurns", int64(7))

	state := doc.ToState()
	if len(state) == 0 {
		t.Fatal("ToState returned empty bytes")
	}

	fresh := NewConversationDocument("persist-conv2", "user:test")
	defer fresh.Destroy()
	if err := fresh.LoadFromState(state); err != nil {
		t.Fatalf("LoadFromState failed: %v", err)
	}

	switch v := fresh.GetMetadata("completedTurns").(type) {
	case int64:
		if v != 7 {
			t.Errorf("completedTurns = %d, want 7", v)
		}
	case float64:
		if v != 7 {
			t.Errorf("completedTurns = %v, want 7", v)
		}
	case int:
		if v != 7 {
			t.Errorf("completedTurns = %d, want 7", v)
		}
	default:
		t.Errorf("completedTurns did not survive persistence (got %T: %#v)", v, v)
	}
}

// TestClientCallbackCleanup tests the full client lifecycle:
// 1. Single client connects and receives messages
// 2. Client reloads (disconnect + reconnect with new callback) - old callback should stop receiving
// 3. Multiple clients - each should receive messages
// 4. One client disconnects - only that client's callback is removed
//
// This is critical for multi-tab scenarios and page reloads.
func TestClientCallbackCleanup(t *testing.T) {
	manager := NewManager()
	defer manager.Shutdown()

	// Create init message
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:   "conv1",
			Name: "Test",
		},
		Config: WorkerConfig{
			ProjectPath: "/test",
		},
	})

	// --- Scenario 1: Single client connects ---
	recA1 := newMsgChan()
	handled := manager.HandleMessageWithClient("conv1", "client-A", "init", initPayload, recA1.callback)
	if !handled {
		t.Fatal("Expected first init message to be handled")
	}
	// "ready" is the last message sent by init; waiting for it drains all prior messages
	// (yjs-sync, status, undoState) so the channel is empty when we disconnect.
	recA1.waitForType(t, "ready")
	t.Logf("Scenario 1: Client A connected and received messages")

	// --- Scenario 2: Client A reloads (disconnect + reconnect) ---
	// ClientDisconnected is synchronous with the manager ops channel; the callback
	// is removed before HandleMessageWithClient registers the new one, so no
	// messages from the reconnect can reach recA1.
	manager.ClientDisconnected("client-A")

	recA2 := newMsgChan()
	handled = manager.HandleMessageWithClient("conv1", "client-A", "init", initPayload, recA2.callback)
	if !handled {
		t.Fatal("Expected reconnect init to be handled")
	}
	recA2.waitForType(t, "ready") // drain all reconnect messages

	// Old callback must NOT have received "ready" from the reconnect.
	// (Batch-timer yjs-sync messages from before disconnect may still be buffered —
	// they're background noise from the init flow. "ready" is only sent on init, so
	// its presence here means the wrong callback was called.)
	for len(recA1.ch) > 0 {
		raw := <-recA1.ch
		var msg map[string]any
		if json.Unmarshal(raw, &msg) == nil && msg["type"] == "ready" {
			t.Fatal("BUG: old callback received 'ready' from reconnect — callback was not removed")
		}
	}
	t.Logf("Scenario 2: Client A reloaded, old callback got no reconnect messages")

	// --- Scenario 3: Second client connects (multi-tab) ---
	recB := newMsgChan()
	handled = manager.HandleMessageWithClient("conv1", "client-B", "init", initPayload, recB.callback)
	if !handled {
		t.Fatal("Expected client B init to be handled")
	}
	recB.waitForType(t, "ready")
	t.Logf("Scenario 3: Client B connected and received messages")

	// --- Scenario 4: Client A disconnects, Client B should still work ---
	manager.ClientDisconnected("client-A")

	// Trigger a ping; recB must receive the pong
	manager.HandleMessageWithClient("conv1", "client-B", "ping", nil, recB.callback)
	recB.waitForType(t, "pong")

	// Disconnected client-A must NOT have received the pong.
	// Background yjs-sync batch-timer messages may still be buffered from prior inits —
	// those are fine. "pong" is only sent in response to a ping sent AFTER disconnect.
	for len(recA2.ch) > 0 {
		raw := <-recA2.ch
		var msg map[string]any
		if json.Unmarshal(raw, &msg) == nil && msg["type"] == "pong" {
			t.Fatal("BUG: disconnected client received pong — callback was not removed")
		}
	}
	t.Logf("Scenario 4: Client A disconnected, Client B still receiving")

	// Verify worker still exists
	if manager.Count() != 1 {
		t.Errorf("Expected exactly 1 worker, got %d", manager.Count())
	}

	t.Log("SUCCESS: All client lifecycle scenarios passed")
}

// TestModelValidation verifies that worker rejects messages when modelConfig is nil/empty.
// This test catches Bug 1: "Please choose a model" error even when model is selected.
func TestModelValidation(t *testing.T) {
	manager := NewManager()
	defer manager.Shutdown()

	// Init worker WITHOUT model config
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:   "conv1",
			Name: "Test",
			// ModelConfig is nil - simulating new conversation
		},
		Config: WorkerConfig{
			ProjectPath: "/test",
		},
	})

	rec := newMsgChan()

	// Handle init
	handled := manager.HandleMessage("conv1", "init", initPayload, rec.callback)
	if !handled {
		t.Fatal("Expected init message to be handled")
	}

	// Try to send message without model - should fail validation
	sendPayload, _ := json.Marshal(SendMessageMessage{
		Type:           "send-message",
		Text:           "Test message",
		IsContinuation: false,
	})

	handled = manager.HandleMessage("conv1", "send-message", sendPayload, rec.callback)
	if !handled {
		t.Fatal("Expected send-message to be handled")
	}

	// Wait for the validation-error status message
	msg := rec.waitForType(t, "status")
	for msg["status"] != "validation-error" {
		msg = rec.waitForType(t, "status")
	}
	msgText, ok := msg["message"].(string)
	if !ok {
		t.Fatal("Validation error message should be a string")
	}
	if msgText != "Please select a model before sending a message" {
		t.Errorf("Expected 'Please select a model' error, got: %s", msgText)
	}
	// The recoverable divergence code lets the client self-heal (re-broadcast its
	// own model config + retry once) rather than only surfacing a dead-end warning.
	if code, _ := msg["code"].(string); code != "no-model" {
		t.Errorf("Expected validation code 'no-model', got: %q", code)
	}
	t.Logf("SUCCESS: Got expected validation error: %s", msgText)
}

// TestProviderUnavailableSurfacedAsValidationError verifies Guard B: when the LLM
// dispatch fails because the selected model's provider can't be used (the caller
// wraps ErrProviderUnavailable), the worker surfaces a validation-error with code
// "provider-unavailable" — a user-fixable "pick another model" prompt — and does
// not retry a model that cannot run. It also leaves a durable error item carrying
// the resolver's own explanation, so a credential that lapses mid-loop doesn't
// look like a turn that simply stopped (the status alone is a transient notice
// the client drops when the conversation isn't on screen).
func TestProviderUnavailableSurfacedAsValidationError(t *testing.T) {
	w := NewConversationWorker("conv-pu", "user:test")
	defer w.doc.Destroy()

	// Seed a resolvable default model so the mapped message can name it.
	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:          "conv-pu",
			ModelConfig: &ModelConfig{Provider: "test", Model: "test-model"},
		},
		Config: WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)

	// Real dispatch path (no mock): the caller fails with a wrapped
	// ErrProviderUnavailable, exactly as createLLMCaller does when credentials
	// for the stored provider are missing.
	var calls int32
	w.llmCallFunc = func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		atomic.AddInt32(&calls, 1)
		return nil, fmt.Errorf("%w: no API key configured for provider: test", ErrProviderUnavailable)
	}

	// Capture the worker's broadcast status messages.
	statusCh := make(chan map[string]any, 16)
	w.SetCallback("viewer", func(b []byte) {
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m["type"] == "status" {
			statusCh <- m
		}
	})

	// Feed context/tools so the turn reaches dispatch without a live engine
	// (mirrors TestToolTurnPushesStateToEngine).
	done := make(chan struct{})
	defer close(done)
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{}})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			if !w.engine.contextReply.inject(done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(done, toolsResp) {
				return
			}
		}
	}()

	w.driveStrategyLoop(t, "Hello", false)

	deadline := time.After(2 * time.Second)
	for {
		select {
		case m := <-statusCh:
			if m["status"] != "validation-error" {
				continue
			}
			if code, _ := m["code"].(string); code != "provider-unavailable" {
				t.Fatalf("expected code 'provider-unavailable', got %q (message=%v)", code, m["message"])
			}
			if got := atomic.LoadInt32(&calls); got != 1 {
				t.Fatalf("provider dispatch calls = %d, want 1 (an unusable model must not be retried)", got)
			}
			// The status message and the durable item both keep the resolver's
			// detail; a lead that only says "isn't configured" is unactionable.
			if msg, _ := m["message"].(string); !strings.Contains(msg, "no API key configured for provider: test") {
				t.Errorf("status message dropped the resolver detail: %q", msg)
			}
			var errItem *ConversationItem
			items := w.doc.GetItems()
			for i := range items {
				if items[i].Type == ItemTypeError {
					errItem = &items[i]
					break
				}
			}
			if errItem == nil {
				t.Fatal("no error item in the doc: Guard B must leave a durable record of the ended turn")
			}
			if !strings.Contains(errItem.Content, "no API key configured for provider: test") {
				t.Errorf("error item dropped the resolver detail: %q", errItem.Content)
			}
			if !strings.Contains(errItem.Content, "test-model") {
				t.Errorf("error item doesn't name the model: %q", errItem.Content)
			}
			return
		case <-deadline:
			t.Fatal("timeout waiting for validation-error status with code provider-unavailable")
		}
	}
}

// TestAuthErrorSurfacedWithRemediation covers the sibling of Guard B: a provider
// that refused a call it actually made, on authentication grounds. Guard B never
// sees this — it fires when credential resolution fails first, and a CLI-backed
// provider resolves no credential of its own, so the refusal is the first sign
// the login has lapsed.
//
// The turn must end with the provider's remediation leading, the provider's own
// text kept underneath, an errorKind the transcript row can key its action off,
// and no retry: an expired sign-in does not heal by being asked again.
func TestAuthErrorSurfacedWithRemediation(t *testing.T) {
	// The exact failure a user reported, in the shape the claudecode parser now
	// produces for it.
	const cliText = "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue."
	const hint = "Claude Code isn't signed in. Run claude in a terminal and use /login."
	assertUserFixableFailure(t, &provider.AuthError{
		Provider: "claudecode",
		Status:   401,
		Message:  cliText,
		Hint:     hint,
	}, "auth-required", "auth", hint, cliText)
}

// TestSetupErrorSurfacedWithRemediation covers a provider that cannot run on
// this machine at all — the claude CLI not installed, or not where Juggler can
// find it. Reported generically it reached a new user as a PATH search report
// with only a Retry under it, which fails the same way forever. It gets the
// same terminal shape as an auth failure, under its own errorKind so the row
// can offer another model as well as settings.
func TestSetupErrorSurfacedWithRemediation(t *testing.T) {
	const detail = "claude executable not found. Searched $PATH and known install locations."
	const hint = "Claude Code isn't installed, or Juggler can't find it."
	assertUserFixableFailure(t, &provider.SetupError{
		Provider: "claudecode",
		Message:  detail,
		Hint:     hint,
	}, "provider-setup", "setup", hint, detail)
}

// assertUserFixableFailure runs one turn whose provider call fails with failErr
// and asserts the terminal shape every user-fixable failure shares: one call
// and no retry, a composer warning carrying only the hint under wantCode, and a
// durable error item that leads with the hint, keeps the provider's own text,
// and carries wantKind for the transcript row to key its actions off.
func assertUserFixableFailure(t *testing.T, failErr error, wantCode, wantKind, hint, detail string) {
	t.Helper()
	w := NewConversationWorker("conv-auth", "user:test")
	defer w.doc.Destroy()

	initPayload, _ := json.Marshal(InitMessage{
		Type: "init",
		Conversation: SerializedConversation{
			ID:          "conv-auth",
			ModelConfig: &ModelConfig{Provider: "claudecode", Model: "sonnet"},
		},
		Config: WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)

	var calls int32
	w.llmCallFunc = func(context.Context, json.RawMessage, func(StreamChunk)) (*LLMResponse, error) {
		atomic.AddInt32(&calls, 1)
		return nil, fmt.Errorf("LLM error: %w", failErr)
	}

	statusCh := make(chan map[string]any, 16)
	w.SetCallback("viewer", func(b []byte) {
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m["type"] == "status" {
			statusCh <- m
		}
	})

	done := make(chan struct{})
	defer close(done)
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{}})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			if !w.engine.contextReply.inject(done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(done, toolsResp) {
				return
			}
		}
	}()

	w.driveStrategyLoop(t, "Hello", false)

	deadline := time.After(2 * time.Second)
	for {
		select {
		case m := <-statusCh:
			if m["status"] != "validation-error" {
				continue
			}
			if code, _ := m["code"].(string); code != wantCode {
				t.Fatalf("expected code %q, got %q (message=%v)", wantCode, code, m["message"])
			}
			if got := atomic.LoadInt32(&calls); got != 1 {
				t.Fatalf("provider dispatch calls = %d, want 1 (a user-fixable failure must not be retried)", got)
			}
			// The composer warning gets the lead only — the detail needs room to
			// read, which the transcript has and the warning strip does not.
			if msg, _ := m["message"].(string); msg != hint {
				t.Errorf("status message = %q, want just the hint", msg)
			}

			var errItem *ConversationItem
			items := w.doc.GetItems()
			for i := range items {
				if items[i].Type == ItemTypeError {
					errItem = &items[i]
					break
				}
			}
			if errItem == nil {
				t.Fatal("no error item in the doc: an ended turn must leave a durable record")
			}
			if !strings.HasPrefix(errItem.Content, hint) {
				t.Errorf("error item doesn't lead with the remediation: %q", errItem.Content)
			}
			// Dropping the provider's own words leaves nothing to search for.
			if !strings.Contains(errItem.Content, detail) {
				t.Errorf("error item dropped the provider's own text: %q", errItem.Content)
			}

			var data map[string]any
			if err := json.Unmarshal(errItem.Data, &data); err != nil {
				t.Fatalf("error item data is not decodable: %v", err)
			}
			if data["errorKind"] != wantKind {
				t.Errorf("errorKind = %v, want %q — the transcript row keys its action off this", data["errorKind"], wantKind)
			}
			if data["provider"] != "claudecode" {
				t.Errorf("provider = %v, want \"claudecode\"", data["provider"])
			}
			return
		case <-deadline:
			t.Fatalf("timeout waiting for validation-error status with code %s", wantCode)
		}
	}
}

// TestDeleteRangeBasic verifies delete-range deletes from fromIndex to end.
// This test catches Bug 2: "Revise from here" broken - loop condition bug.
func TestDeleteRangeBasic(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	tracker := NewOperationTracker(doc)

	// Insert 5 messages
	for i := range 5 {
		msg := ConversationItem{
			Type:    ItemTypeUser,
			ItemID:  fmt.Sprintf("msg%d", i),
			Content: fmt.Sprintf("Message %d", i),
		}
		doc.AppendMessage(msg)
	}

	// Verify we have 5 messages
	items := doc.GetItems()
	if len(items) != 5 {
		t.Fatalf("Expected 5 items initially, got %d", len(items))
	}

	// Delete from index 2 onwards (should delete messages 2, 3, 4)
	indices := []int{2, 3, 4}
	tracker.DeleteMessages(indices)

	items = doc.GetItems()
	if len(items) != 2 {
		t.Errorf("Expected 2 items remaining, got %d", len(items))
	}
	if items[0].Content != "Message 0" || items[1].Content != "Message 1" {
		t.Error("Wrong messages remained after delete-range")
	}

	// Verify undo restores all 3 deleted messages
	if !tracker.CanUndo() {
		t.Fatal("Should be able to undo")
	}
	tracker.Undo()
	items = doc.GetItems()
	if len(items) != 5 {
		t.Errorf("Expected 5 items after undo, got %d", len(items))
	}

	doc.Destroy()
}

// TestDeleteRangeEdgeCases tests delete-range edge cases.
func TestDeleteRangeEdgeCases(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	tracker := NewOperationTracker(doc)

	// Insert 3 messages
	for i := range 3 {
		doc.AppendMessage(ConversationItem{
			Type:    ItemTypeUser,
			ItemID:  fmt.Sprintf("msg%d", i),
			Content: fmt.Sprintf("Message %d", i),
		})
	}

	// Test 1: Delete from 0 (delete all)
	tracker.DeleteMessages([]int{0, 1, 2})
	if len(doc.GetItems()) != 0 {
		t.Error("Expected empty after deleting all messages")
	}

	// Undo
	tracker.Undo()
	if len(doc.GetItems()) != 3 {
		t.Error("Expected 3 items after undo")
	}

	// Test 2: Delete empty range (should be no-op)
	tracker.DeleteMessages([]int{})
	if len(doc.GetItems()) != 3 {
		t.Error("Delete empty range should not delete anything")
	}

	doc.Destroy()
}

// TestMetaToolsContinueLoop verifies that when an LLM response contains ONLY
// meta tools (drop_context_items), the strategy loop continues.
func TestMetaToolsContinueLoop(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")

	// Add a context item so drop_context_items has something to drop
	w.tracker.InsertMessage(0, ConversationItem{
		Type:   "rule",
		ItemID: "ci-test",
		Data:   []byte(`{"type":"test"}`),
	})

	response := &LLMResponse{
		Blocks: []LLMResponseBlock{
			{
				Type:  "tool_use",
				ID:    "tool-1",
				Name:  "drop_context_items",
				Input: json.RawMessage(`{"itemIds": ["ci-test"]}`),
			},
		},
		StopReason: "tool_use",
	}

	shouldContinue, err := w.currentRun().processLLMResponse(response)
	if err != nil {
		t.Fatalf("processLLMResponse failed: %v", err)
	}

	// CRITICAL: Meta tools should continue the loop
	if !shouldContinue {
		t.Error("BUG: processLLMResponse returned false for meta tools - loop stopped!")
	}

	w.doc.Destroy()
}

// TestLLMResponseBlockJSONCompatibility verifies that LLMResponseBlock correctly
// deserializes JSON from the server format (provider.ContentBlock field names).
//
// This is a regression test for a bug where LLMResponseBlock used different JSON
// field names than provider.ContentBlock:
//   - LLMResponseBlock had: json:"id", json:"name", json:"input"
//   - provider.ContentBlock has: json:"toolUseId", json:"toolName", json:"toolInput"
//
// The mismatch caused toolName to be empty when deserializing server responses,
// leading to "Cannot read properties of undefined (reading 'toLowerCase')" errors
// in the frontend action registry.
func TestLLMResponseBlockJSONCompatibility(t *testing.T) {
	// JSON as server sends it (provider.ContentBlock format)
	serverJSON := `{
		"type": "tool_use",
		"toolUseId": "test-id-123",
		"toolName": "read_file",
		"toolInput": {"path": "test.txt"}
	}`

	var block LLMResponseBlock
	if err := json.Unmarshal([]byte(serverJSON), &block); err != nil {
		t.Fatalf("Failed to unmarshal: %v", err)
	}

	if block.Type != "tool_use" {
		t.Errorf("Expected Type 'tool_use', got %q", block.Type)
	}
	if block.ID != "test-id-123" {
		t.Errorf("Expected ID 'test-id-123', got %q (JSON field mismatch?)", block.ID)
	}
	if block.Name != "read_file" {
		t.Errorf("Expected Name 'read_file', got %q (JSON field mismatch?)", block.Name)
	}

	// Verify Input can be parsed
	var input map[string]any
	if err := json.Unmarshal(block.Input, &input); err != nil {
		t.Fatalf("Failed to parse Input: %v", err)
	}
	if input["path"] != "test.txt" {
		t.Errorf("Expected input.path 'test.txt', got %v", input["path"])
	}
}

// TestInjectedSystemReminderReachesMessages pins the worker-path half of the
// strategy message-injection model: a system-reminder item written into the
// conversation doc (e.g. by a strategy's injectGuidance) must be emitted by
// buildMessages so it actually reaches the LLM.
func TestInjectedSystemReminderReachesMessages(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	const reminder = "RESEARCH MODE ACTIVE: read-only this turn."

	w.tracker.InsertMessage(w.doc.GetItemsLength(),
		ConversationItem{Type: ItemTypeUser, Content: "Explain the auth module."},
		ConversationItem{Type: ItemTypeSystemReminder, Content: reminder, Summary: "research-mode"},
	)

	messages := w.currentRun().buildMessages(nil)

	var found bool
	for _, m := range messages {
		if m["type"] == ItemTypeSystemReminder && m["content"] == reminder {
			found = true
		}
	}
	if !found {
		t.Errorf("injected system-reminder did not reach buildMessages output; messages=%+v", messages)
	}
}

// TestInjectedGuidanceReachesMessages is the guidance-typed sibling of the
// above: the worker must also surface a 'guidance' item, matching the
// context-builder fallback which passes both types through.
func TestInjectedGuidanceReachesMessages(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	const guidance = "Choose ONE path per response."

	w.tracker.InsertMessage(w.doc.GetItemsLength(),
		ConversationItem{Type: ItemTypeUser, Content: "Fix the bug."},
		ConversationItem{Type: ItemTypeGuidance, Content: guidance},
	)

	messages := w.currentRun().buildMessages(nil)

	var found bool
	for _, m := range messages {
		if m["type"] == ItemTypeGuidance && m["content"] == guidance {
			found = true
		}
	}
	if !found {
		t.Errorf("injected guidance did not reach buildMessages output; messages=%+v", messages)
	}
}

func TestBuildLLMRequest_ExplicitContinuationIsCallScoped(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	var first map[string]any
	if err := json.Unmarshal(w.currentRun().buildLLMRequestWithIntent(&ContextResult{}, nil, "txn-continue", false, true), &first); err != nil {
		t.Fatalf("unmarshal continuation request: %v", err)
	}
	if got, ok := first["explicitContinuation"].(bool); !ok || !got {
		t.Fatalf("explicitContinuation = %v, want true", first["explicitContinuation"])
	}

	var second map[string]any
	if err := json.Unmarshal(w.currentRun().buildLLMRequest(&ContextResult{}, nil, "txn-next", false), &second); err != nil {
		t.Fatalf("unmarshal next request: %v", err)
	}
	if _, present := second["explicitContinuation"]; present {
		t.Fatalf("explicitContinuation leaked into the next request: %v", second["explicitContinuation"])
	}
}

// The automatic-compaction gate reaches the provider as an admission ceiling,
// not as a worker-side branch: disabling it asks for the hard window so the
// conversation runs to the real wall instead of being summarized silently.
func TestBuildLLMRequest_AutoCompactGateSetsContextCeiling(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	var enabled map[string]any
	if err := json.Unmarshal(w.currentRun().buildLLMRequest(&ContextResult{}, nil, "txn-enabled", false), &enabled); err != nil {
		t.Fatalf("unmarshal request: %v", err)
	}
	if _, present := enabled["contextCeilingFraction"]; present {
		t.Fatalf("contextCeilingFraction = %v, want absent so admission uses its soft default", enabled["contextCeilingFraction"])
	}

	w.autoCompactGate = func() bool { return false }
	var disabled map[string]any
	if err := json.Unmarshal(w.currentRun().buildLLMRequest(&ContextResult{}, nil, "txn-disabled", false), &disabled); err != nil {
		t.Fatalf("unmarshal request: %v", err)
	}
	if got, ok := disabled["contextCeilingFraction"].(float64); !ok || got != 1 {
		t.Fatalf("contextCeilingFraction = %v, want 1 (hard window)", disabled["contextCeilingFraction"])
	}
}

// TestBuildLLMRequest_ForcedToolChoice verifies the generic forced-tool
// mechanism at the worker boundary: a thread carrying a `forceTool` Yjs field
// (set by a plugin) makes buildLLMRequest emit a provider-agnostic toolChoice on
// the request. A thread WITHOUT the field emits no toolChoice (the model
// decides — the normal case), and neither does a close request: a summarise turn
// is an ordinary turn whose trailing text becomes the summary.
func TestBuildLLMRequest_ForcedToolChoice(t *testing.T) {
	tools := []ToolDefinition{
		{Name: "submit_answer", Description: "Submit the answer", InputSchema: json.RawMessage(`{"type":"object"}`)},
	}
	ctxResult := &ContextResult{SystemPrompt: "sys"}

	t.Run("forced", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
		threadID := insertThreadWithOpts(w, threadOpts{goal: "Forced", forceTool: "submit_answer"})
		w.turn.thread.itemID = threadID

		raw := w.currentRun().buildLLMRequest(ctxResult, tools, "txn-1", false)
		var req map[string]any
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatalf("unmarshal request: %v", err)
		}
		tc, ok := req["toolChoice"].(map[string]any)
		if !ok {
			t.Fatalf("expected toolChoice object on forced request, got %v (keys: %v)", req["toolChoice"], req)
		}
		if tc["mode"] != "tool" || tc["name"] != "submit_answer" {
			t.Errorf("toolChoice = %v, want {mode:tool, name:submit_answer}", tc)
		}
	})

	t.Run("not forced", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
		threadID := insertThreadWithOpts(w, threadOpts{goal: "Plain"})
		w.turn.thread.itemID = threadID

		raw := w.currentRun().buildLLMRequest(ctxResult, tools, "txn-2", false)
		var req map[string]any
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatalf("unmarshal request: %v", err)
		}
		if _, present := req["toolChoice"]; present {
			t.Errorf("unforced request must not carry toolChoice, got %v", req["toolChoice"])
		}
	})

}
