//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// Deterministic concurrency tests for the multi-client sync fan-out — the path
// that carries a doc change from the worker out to every connected client
// (viewer + engine). Run with `go test -race`: the value is not only the
// assertions but the race detector exercising the real broadcast actor
// (callback_registry.go), the worker's single-goroutine run loop, the
// sync batcher, and the ycrdtMu-serialised document under many clients.
//
// Pins invariants the integration suite only catches statistically:
//   - no broadcast is lost: every client converges to the worker's doc
//     (the deterministic "lost vs slow" oracle — a real fan-out loss fails here
//     every run, not 1-in-N);
//   - test-harness acks fan out to ALL clients (handleGet* → w.send →
//     callbacks.broadcast), so concurrent requests with unique ackIds are each
//     delivered and none are dropped — the server-side counterpart to the
//     browser ackId namespacing that fixed the ack-correlation race;
//   - a request-scoped production ack (undo/redo/duplicate → w.reply →
//     callbacks.sendTo) reaches ONLY the client that issued it, not every
//     connected client — the bandwidth fix that keeps a remote tunnel viewer
//     from receiving acks meant for the engine or other viewers;
//   - a yjs-sync delivered to one worker never reaches another worker's clients
//     (multi-tab cross-conversation isolation; each worker is its own registry).

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// itemKey is a comparable projection of a ConversationItem, used to assert that
// two documents hold the same items in the same CRDT-resolved order.
type itemKey struct {
	Type    string
	ItemID  string
	Content string
}

func projectItems(items []ConversationItem) []itemKey {
	out := make([]itemKey, 0, len(items))
	for _, it := range items {
		out = append(out, itemKey{Type: string(it.Type), ItemID: it.ItemID, Content: it.Content})
	}
	return out
}

// fanoutClient simulates one connected client: an inbound channel fed by its
// worker callback (push-only, so a slow consumer never stalls the broadcast
// actor) and a shadow Yjs doc it rebuilds by applying every yjs-sync it gets.
type fanoutClient struct {
	id     string
	in     chan []byte
	shadow *ConversationDocument
}

// applyYjsSync applies a single raw frame to the shadow if it is a yjs-sync;
// every other frame type (status, undoState, ack, …) is ignored.
func applyYjsSync(raw []byte, shadow *ConversationDocument) {
	var m YjsSyncMessage
	if json.Unmarshal(raw, &m) != nil {
		return
	}
	if m.Type == "yjs-sync" && len(m.Bytes) > 0 {
		_ = shadow.ApplySyncUpdate(m.Bytes)
	}
}

// drainApply non-blockingly applies every queued frame to the shadow.
func drainApply(in chan []byte, shadow *ConversationDocument) {
	for {
		select {
		case raw := <-in:
			applyYjsSync(raw, shadow)
		default:
			return
		}
	}
}

func allConverged(clients []*fanoutClient, want []itemKey) bool {
	for _, c := range clients {
		if !reflect.DeepEqual(projectItems(c.shadow.GetItems()), want) {
			return false
		}
	}
	return true
}

func reportDivergence(t *testing.T, clients []*fanoutClient, want []itemKey, total int) {
	t.Helper()
	var b strings.Builder
	fmt.Fprintf(&b, "convergence timeout: worker has %d items (want %d)\n", len(want), total)
	wantIDs := map[string]bool{}
	for _, k := range want {
		wantIDs[k.ItemID] = true
	}
	for _, c := range clients {
		gotIDs := map[string]bool{}
		for _, k := range projectItems(c.shadow.GetItems()) {
			gotIDs[k.ItemID] = true
		}
		var missing []string
		for id := range wantIDs {
			if !gotIDs[id] {
				missing = append(missing, id)
			}
		}
		sort.Strings(missing)
		fmt.Fprintf(&b, "  %s: %d items, missing %d: %v\n", c.id, len(gotIDs), len(missing), missing)
	}
	t.Fatal(b.String())
}

// TestSyncFanoutConvergence is the no-loss / lost-vs-slow oracle for the
// broadcast path. Many writer goroutines concurrently mutate the worker's doc
// (the same observer → sync-batcher → callbacks.broadcast path a yjs-sync from a
// tab drives). N receiving clients rebuild a shadow doc from the broadcasts they
// get. The test asserts every client's shadow converges to the worker's doc —
// i.e. no broadcast was lost. A genuine fan-out loss fails here on every run;
// the wait is value-independent and never passes on timeout.
//
// Items are assistant-typed so the strategy reducer (which only acts on a
// trailing user turn / threads / tools) never mutates the doc out from under
// the assertion.
func TestSyncFanoutConvergence(t *testing.T) {
	const (
		numClients = 8
		numWriters = 8
		perWriter  = 15
	)
	w := NewConversationWorker("conv-fanout", "user:test")
	w.currentRun().Start(context.Background())
	defer w.currentRun().Stop()

	// progress wakes the settle waiter whenever any client receives a frame, so
	// it blocks instead of busy-spinning — and a true stall (loss) starves it,
	// falling through to the deadline.
	progress := make(chan struct{}, 1<<16)

	clients := make([]*fanoutClient, numClients)
	for i := range clients {
		c := &fanoutClient{
			id:     fmt.Sprintf("client-%d", i),
			in:     make(chan []byte, 1<<16),
			shadow: NewConversationDocument("conv-fanout", fmt.Sprintf("user:c%d", i)),
		}
		clients[i] = c
		ch := c.in
		w.SetCallback(c.id, func(msg []byte) {
			ch <- msg
			select {
			case progress <- struct{}{}:
			default:
			}
		})
	}

	var wg sync.WaitGroup
	for g := 0; g < numWriters; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for k := 0; k < perWriter; k++ {
				w.Document().AppendMessage(ConversationItem{
					Type:    ItemTypeAssistant,
					ItemID:  fmt.Sprintf("w%d-item-%d", g, k),
					Content: fmt.Sprintf("w%d payload %d", g, k),
				})
			}
		}(g)
	}
	wg.Wait()

	totalItems := numWriters * perWriter

	deadline := time.After(15 * time.Second)
	var want []itemKey
	for {
		for _, c := range clients {
			drainApply(c.in, c.shadow)
		}
		// Worker doc is the source of truth for what was broadcast.
		want = projectItems(w.Document().GetItems())
		if len(want) == totalItems && allConverged(clients, want) {
			return
		}
		select {
		case <-progress:
		case <-deadline:
			reportDivergence(t, clients, want, totalItems)
			return
		}
	}
}

// TestSyncFanoutIntakeNoLoss pins that worker intake never silently drops a
// message. The worker's Send queues onto the inbound path; a fixed-capacity
// buffer would drop under burst (a dropped yjs-sync carrying an approval is a
// permanent loss, never re-requested). To make the drop deterministic rather
// than timing-dependent, the burst is enqueued BEFORE Start() — an un-started
// worker never drains, so a cap-N buffer retains exactly N and discards the
// rest. After Start(), every enqueued request must produce its ack.
func TestSyncFanoutIntakeNoLoss(t *testing.T) {
	const numMsgs = 500 // >> any small fixed inbound buffer
	w := NewConversationWorker("conv-intake", "user:test")
	defer w.currentRun().Stop()

	mc := newMsgChan()
	w.SetCallback("client-0", mc.callback)

	// Enqueue the whole burst while the run loop is NOT draining.
	ackIDs := make([]string, numMsgs)
	for i := 0; i < numMsgs; i++ {
		ackIDs[i] = fmt.Sprintf("intake-%d", i)
		payload, _ := json.Marshal(map[string]string{"ackId": ackIDs[i]})
		w.Send("get-yjs-state", payload)
	}

	// Now let the worker process them all.
	w.currentRun().Start(context.Background())

	seen := collectAcks(mc, numMsgs, 15*time.Second)
	if len(seen) != numMsgs {
		var missing []string
		for _, id := range ackIDs {
			if !seen[id] {
				missing = append(missing, id)
			}
		}
		sort.Strings(missing)
		shown := missing
		if len(shown) > 10 {
			shown = shown[:10]
		}
		t.Fatalf("intake dropped messages: got %d of %d acks; %d missing (first: %v)",
			len(seen), numMsgs, len(missing), shown)
	}
}

// The intake primitive's own FIFO/no-drop contract is pinned in
// cmd/juggler/mailbox (TestQueue_NeverDrops), where the queue lives.

// TestDocUpdateNoLoss pins that the doc's outbound update path never drops a
// delta. Many thousands of transacts are applied while nothing drains
// UpdateSignal; DrainUpdates must then return every delta, in
// order. A dropped delta would diverge every peer permanently.
func TestDocUpdateNoLoss(t *testing.T) {
	const n = 5000 // far more than any plausible fixed buffer
	doc := NewConversationDocument("conv-updates", "user:test")
	doc.RegisterSyncCallbacks(func([]byte, string) {}, func(bool, bool) {})

	for i := 0; i < n; i++ {
		doc.AppendMessage(ConversationItem{
			Type:    ItemTypeAssistant,
			ItemID:  fmt.Sprintf("item-%d", i),
			Content: fmt.Sprintf("payload %d", i),
		})
	}

	// Reassemble a fresh doc purely from the drained deltas; if any were
	// dropped, it can't reconstruct the full item set.
	got := doc.DrainUpdates()
	if len(got) < n {
		t.Fatalf("doc dropped updates: drained %d deltas for %d transacts", len(got), n)
	}
	replay := NewConversationDocument("conv-updates", "user:replay")
	for _, u := range got {
		if err := replay.ApplySyncUpdate(u); err != nil {
			t.Fatalf("replaying delta failed: %v", err)
		}
	}
	if items := replay.GetItems(); len(items) != n {
		t.Fatalf("delta replay lost items: reconstructed %d of %d", len(items), n)
	}
}

// collectAcks drains a client stream until it has seen `expected` distinct ack
// ids or the deadline passes; returns the set observed.
func collectAcks(mc *msgChan, expected int, timeout time.Duration) map[string]bool {
	seen := map[string]bool{}
	deadline := time.After(timeout)
	for len(seen) < expected {
		select {
		case raw := <-mc.ch:
			var m struct {
				Type  string `json:"type"`
				AckID string `json:"ackId"`
			}
			if json.Unmarshal(raw, &m) == nil && m.Type == "ack" && m.AckID != "" {
				seen[m.AckID] = true
			}
		case <-deadline:
			return seen
		}
	}
	return seen
}

// TestSyncFanoutAckBroadcastCorrelation pins the broadcast-ack invariant. Every
// client fires a request carrying a UNIQUE ackId at the same time; the worker
// replies via w.send → callbacks.broadcast, so each ack reaches every client.
// Correctness therefore depends on globally-unique ackIds — the server-side
// reason the browser namespaces ack ids per iframe (project_ack_correlation_race).
// The test asserts no concurrent request's ack is dropped and each requester
// observes its own.
func TestSyncFanoutAckBroadcastCorrelation(t *testing.T) {
	const numClients = 12
	w := NewConversationWorker("conv-ack", "user:test")
	w.currentRun().Start(context.Background())
	defer w.currentRun().Stop()

	chans := make([]*msgChan, numClients)
	ackIDs := make([]string, numClients)
	for i := 0; i < numClients; i++ {
		mc := newMsgChan()
		chans[i] = mc
		ackIDs[i] = fmt.Sprintf("ack-%d", i)
		w.SetCallback(fmt.Sprintf("client-%d", i), mc.callback)
	}

	var wg sync.WaitGroup
	for i := 0; i < numClients; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			payload, _ := json.Marshal(map[string]string{"ackId": ackIDs[i]})
			w.Send("get-yjs-state", payload)
		}(i)
	}
	wg.Wait()

	// Client 0 sees every broadcast, so its stream must contain all ackIds.
	seen := collectAcks(chans[0], numClients, 10*time.Second)
	for _, id := range ackIDs {
		if !seen[id] {
			t.Fatalf("ack for %s never delivered (saw %d of %d distinct acks)", id, len(seen), numClients)
		}
	}

	// And each requester observes its own ack in its own stream.
	for i := 1; i < numClients; i++ {
		mine := collectAcks(chans[i], numClients, 10*time.Second)
		if !mine[ackIDs[i]] {
			t.Fatalf("client %d never saw its own ack %s", i, ackIDs[i])
		}
	}
}

// TestAckTargetsOriginatingClient pins that a request-scoped production ack
// (here, undo) routes to ONLY the client that issued the request, not every
// connected client. This is the bandwidth fix: a remote tunnel viewer no longer
// receives acks meant for the engine or other viewers. The doc mutations the
// request caused still broadcast via yjs-sync, so peers stay converged — only
// the ack is targeted.
func TestAckTargetsOriginatingClient(t *testing.T) {
	const numClients = 5
	w := NewConversationWorker("conv-ack-target", "user:test")
	w.currentRun().Start(context.Background())
	defer w.currentRun().Stop()

	chans := make([]*msgChan, numClients)
	for i := 0; i < numClients; i++ {
		mc := newMsgChan()
		chans[i] = mc
		w.SetCallback(fmt.Sprintf("client-%d", i), mc.callback)
	}

	// client-2 issues an undo carrying a unique ackId. (A fresh doc has nothing
	// to undo, so undo() returns false, but the ack is sent regardless — which is
	// exactly the routing we want to assert.)
	const origin = 2
	const ackID = "ack-undo-only-mine"
	payload, _ := json.Marshal(map[string]string{"ackId": ackID})
	w.SendFromClient(fmt.Sprintf("client-%d", origin), "undo", payload)

	// The originator must receive its ack.
	if !collectAcks(chans[origin], 1, 5*time.Second)[ackID] {
		t.Fatalf("originating client-%d never received its ack %q", origin, ackID)
	}

	// No other client may receive it. A short window is enough: had it been
	// broadcast, the ack would have been enqueued to every channel before the
	// originator's arrived (same registry goroutine, same op).
	for i := 0; i < numClients; i++ {
		if i == origin {
			continue
		}
		if collectAcks(chans[i], 1, 200*time.Millisecond)[ackID] {
			t.Fatalf("client-%d received an ack meant only for the originator (client-%d)", i, origin)
		}
	}
}

// TestSyncFanoutCrossConversationIsolation pins that a yjs-sync delivered to one
// worker never reaches another worker's clients. Each ConversationWorker owns
// its own callbackRegistry, so isolation is structural — this locks it against a
// regression that routed broadcasts across workers. Two bare workers model the
// Manager's per-conversation worker map faithfully (the Manager is the router;
// the registry that fans out is per-worker).
func TestSyncFanoutCrossConversationIsolation(t *testing.T) {
	wA := NewConversationWorker("conv-A", "user:test")
	wA.Start(context.Background())
	defer wA.Stop()
	wB := NewConversationWorker("conv-B", "user:test")
	wB.Start(context.Background())
	defer wB.Stop()

	ca := newMsgChan()
	wA.SetCallback("ca", ca.callback)
	cb := newMsgChan()
	wB.SetCallback("cb", cb.callback)

	// A client on conv-A injects an item via an incremental yjs-sync built from
	// a fresh, self-contained doc (single append, no foreign dependencies).
	probe := NewConversationDocument("conv-A", "user:probe")
	before := probe.GetStateVector()
	probe.AppendMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "leak-probe", Content: "stays in conv-A"})
	syncPayload, _ := json.Marshal(YjsSyncMessage{Type: "yjs-sync", Bytes: probe.GetStateUpdate(before)})
	wA.Send("yjs-sync", syncPayload)

	// Barrier both workers (inbound is FIFO, so an ack proves the prior message
	// on that worker was fully handled) and read what each client got on the way.
	quiesce(t, wA, ca)
	leaked := framesUntilBarrier(t, wB, cb)

	if !workerDocHasItem(wA, "leak-probe") {
		t.Fatal("conv-A worker did not apply the probe item")
	}
	if workerDocHasItem(wB, "leak-probe") {
		t.Fatal("LEAK: conv-B worker doc contains conv-A's item — cross-conversation broadcast")
	}
	if leaked.saw("yjs-sync") {
		t.Fatal("LEAK: conv-B client received a yjs-sync from conv-A's mutation")
	}
}

func workerDocHasItem(w *ConversationWorker, id string) bool {
	if w == nil {
		return false
	}
	for _, it := range w.Document().GetItems() {
		if it.ItemID == id {
			return true
		}
	}
	return false
}
