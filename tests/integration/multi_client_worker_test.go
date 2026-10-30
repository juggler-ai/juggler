//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"juggler/cmd/juggler/worker"
	"runtime"
	"sync"
	"testing"
	"time"
)

// TestWorker_MultipleCallbacks verifies that a worker with multiple callbacks
// broadcasts messages to all connected clients.
func TestWorker_MultipleCallbacks(t *testing.T) {
	w := worker.NewConversationWorker("test-conv", "user:main")
	w.Start(context.Background())
	defer w.Stop()

	// Create channels to receive messages from callbacks
	client1Chan := make(chan []byte, 10)
	client2Chan := make(chan []byte, 10)
	client3Chan := make(chan []byte, 10)

	// Add three callbacks with unique client IDs
	w.SetCallback("client1", func(msg []byte) {
		client1Chan <- msg
	})
	w.SetCallback("client2", func(msg []byte) {
		client2Chan <- msg
	})
	w.SetCallback("client3", func(msg []byte) {
		client3Chan <- msg
	})

	defer w.RemoveCallback("client1")
	defer w.RemoveCallback("client2")
	defer w.RemoveCallback("client3")

	// Initialize worker
	initMsg := worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID: "test-conv",
			ModelConfig: &worker.ModelConfig{
				Provider: "anthropic",
				Model:    "claude-sonnet-4-20250514",
			},
		},
		Config: worker.WorkerConfig{
			ProjectPath: t.TempDir(),
		},
	}
	initBytes, _ := json.Marshal(initMsg)
	w.Send("init", initBytes)

	// Wait for ready messages on all clients
	// Note: yjs-sync messages may arrive before 'ready' due to observer firing during init
	waitForReady := func(ch chan []byte, clientName string) {
		timeout := time.After(1 * time.Second)
		for {
			select {
			case msg := <-ch:
				var parsed map[string]string
				_ = json.Unmarshal(msg, &parsed)
				if parsed["type"] == "ready" {
					return // Found ready message
				}
				// Skip other messages (like yjs-sync) and keep looking
			case <-timeout:
				t.Fatalf("%s timeout waiting for ready", clientName)
			}
		}
	}

	waitForReady(client1Chan, "Client 1")
	waitForReady(client2Chan, "Client 2")
	waitForReady(client3Chan, "Client 3")

	// Drain any remaining yjs-sync messages
	drainChannel(client1Chan, 100*time.Millisecond)
	drainChannel(client2Chan, 100*time.Millisecond)
	drainChannel(client3Chan, 100*time.Millisecond)

	// Directly mutate Yjs document - should broadcast to all clients via Pure Yjs
	w.Document().AppendMessage(worker.ConversationItem{
		Type:      worker.ItemTypeUser,
		ItemID:    "msg1",
		Content:   "Hello",
		Timestamp: "2025-01-01T00:00:00Z",
	})

	// All three clients should receive yjs-sync message
	receivedByClient1 := waitForYjsSync(client1Chan, 1*time.Second)
	receivedByClient2 := waitForYjsSync(client2Chan, 1*time.Second)
	receivedByClient3 := waitForYjsSync(client3Chan, 1*time.Second)

	if !receivedByClient1 {
		t.Error("Client 1 did not receive yjs-sync after mutation")
	}
	if !receivedByClient2 {
		t.Error("Client 2 did not receive yjs-sync after mutation")
	}
	if !receivedByClient3 {
		t.Error("Client 3 did not receive yjs-sync after mutation")
	}
}

// TestWorker_AddRemoveCallback verifies callback addition and removal: a pong
// to a ping sent after a removal reaches the client still attached and never
// the one removed.
//
// The pong is the only frame either check reads. Sync batches go out on the
// batcher's own timer, and a ping flushes any still pending just ahead of its
// pong, so the frame before the pong is whatever the machine's speed made it.
func TestWorker_AddRemoveCallback(t *testing.T) {
	w := worker.NewConversationWorker("test-conv", "user:main")
	w.Start(context.Background())
	defer w.Stop()

	// Buffered generously and never blocking, so frames nobody reads cannot
	// stall a client's delivery.
	client1Chan := make(chan []byte, 1024)
	client2Chan := make(chan []byte, 1024)

	// Add two callbacks with unique client IDs
	w.SetCallback("client1", func(msg []byte) {
		select {
		case client1Chan <- msg:
		default:
		}
	})
	w.SetCallback("client2", func(msg []byte) {
		select {
		case client2Chan <- msg:
		default:
		}
	})

	// Initialize worker
	initMsg := worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID: "test-conv",
			ModelConfig: &worker.ModelConfig{
				Provider: "anthropic",
				Model:    "claude-sonnet-4-20250514",
			},
		},
		Config: worker.WorkerConfig{
			ProjectPath: t.TempDir(),
		},
	}
	initBytes, _ := json.Marshal(initMsg)
	w.Send("init", initBytes)

	// Both should receive ready
	waitForReady(client1Chan, t)
	waitForReady(client2Chan, t)

	// Remove client1's callback. The removal and the pong's broadcast serialize
	// through the same callback registry, so the pong is issued after it.
	w.RemoveCallback("client1")
	w.Send("ping", nil)

	// Client 2 gets the pong. The 10s bound only names a wedged worker.
	deadline := time.After(10 * time.Second)
	for gotPong := false; !gotPong; {
		select {
		case msg := <-client2Chan:
			gotPong = isPong(msg)
		case <-deadline:
			t.Fatal("Client 2 never received the pong — the worker's message loop is not running")
		}
	}

	// Client 1 never does. Frames issued before its removal may still be in its
	// queue; a pong cannot be one of them. The window only bounds how long the
	// absence is watched for — on a slow machine it can miss a stray pong, never
	// invent one.
	quiet := time.After(200 * time.Millisecond)
watch:
	for {
		select {
		case msg := <-client1Chan:
			if isPong(msg) {
				t.Fatalf("Client 1 received a pong after its callback was removed: %s", string(msg))
			}
		case <-quiet:
			break watch
		}
	}

	w.RemoveCallback("client2")
}

// isPong reports whether a worker frame is a pong.
func isPong(msg []byte) bool {
	var parsed map[string]any
	_ = json.Unmarshal(msg, &parsed)
	return parsed["type"] == "pong"
}

// TestWorker_SendWithNoCallbacks verifies that a worker whose broadcasts reach
// no callback at all — an init processed with nobody connected — is still
// serving afterwards: the first client to attach gets a pong to its ping.
func TestWorker_SendWithNoCallbacks(t *testing.T) {
	w := worker.NewConversationWorker("test-conv", "user:main")
	w.Start(context.Background())
	defer w.Stop()

	// No callbacks added - this should not crash
	initMsg := worker.InitMessage{
		Type: "init",
		Conversation: worker.SerializedConversation{
			ID: "test-conv",
			ModelConfig: &worker.ModelConfig{
				Provider: "anthropic",
				Model:    "claude-sonnet-4-20250514",
			},
		},
		Config: worker.WorkerConfig{
			ProjectPath: t.TempDir(),
		},
	}
	initBytes, _ := json.Marshal(initMsg)
	w.Send("init", initBytes)

	// Messages are handled in order, so a pong to a ping sent after the init
	// is proof the init — and every broadcast it made to nobody — went through.
	expectPong(t, w, "late-client")
}

// TestWorker_CallbackThreadSafety churns callbacks while messages are sent
// concurrently. Under -race (test-all, CI) that is a data-race check on the
// callback set; in every build it then requires the worker to still answer a
// ping, so a churn that wedged or killed its loop fails here too.
func TestWorker_CallbackThreadSafety(t *testing.T) {
	w := worker.NewConversationWorker("test-conv", "user:main")
	w.Start(context.Background())
	defer w.Stop()

	// A fixed amount of work rather than a wall-clock window, so a loaded
	// machine runs the same interleavings more slowly instead of fewer of them.
	const rounds = 500
	var wg sync.WaitGroup

	// Goroutine 1: add and remove callbacks
	wg.Go(func() {
		for i := range rounds {
			clientID := fmt.Sprintf("client-%d", i)
			w.SetCallback(clientID, func(msg []byte) {})
			runtime.Gosched()
			w.RemoveCallback(clientID)
		}
	})

	// Goroutine 2: send messages
	wg.Go(func() {
		for range rounds {
			w.Send("ping", nil)
			runtime.Gosched()
		}
	})

	wg.Wait()
	expectPong(t, w, "after-churn")
}

// expectPong attaches a callback under clientID, sends a ping and requires a
// pong back. The 10s bound only names a wedged worker; a live one answers in
// microseconds, and the pings queued ahead of this one are answered first.
func expectPong(t *testing.T, w *worker.ConversationWorker, clientID string) {
	t.Helper()
	ch := make(chan []byte, 1024)
	w.SetCallback(clientID, func(msg []byte) {
		select {
		case ch <- msg:
		default:
		}
	})
	defer w.RemoveCallback(clientID)
	w.Send("ping", nil)
	deadline := time.After(10 * time.Second)
	for {
		select {
		case msg := <-ch:
			var parsed map[string]any
			_ = json.Unmarshal(msg, &parsed)
			if parsed["type"] == "pong" {
				return
			}
		case <-deadline:
			t.Fatalf("%s: the worker never answered a ping — its message loop is not running", clientID)
		}
	}
}

// Helper functions

func waitForReady(ch chan []byte, t *testing.T) {
	timeout := time.After(1 * time.Second)
	for {
		select {
		case msg := <-ch:
			var parsed map[string]string
			_ = json.Unmarshal(msg, &parsed)
			if parsed["type"] == "ready" {
				return // Found ready message
			}
			// Skip other messages (like yjs-sync) and keep looking
		case <-timeout:
			t.Fatal("Timeout waiting for ready")
		}
	}
}

func waitForYjsSync(ch chan []byte, timeout time.Duration) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case msg := <-ch:
			var parsed map[string]any
			_ = json.Unmarshal(msg, &parsed)
			if parsed["type"] == "yjs-sync" {
				return true
			}
			// Keep waiting for yjs-sync, might get undo-state or other messages
		case <-timer.C:
			return false
		}
	}
}

func drainChannel(ch chan []byte, timeout time.Duration) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case <-ch:
			// Drain message
		case <-timer.C:
			return
		}
	}
}
