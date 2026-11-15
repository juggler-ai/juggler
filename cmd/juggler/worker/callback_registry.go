//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "juggler/cmd/juggler/mailbox"

// callbackRegistry owns the per-client outbound callback map for a single
// worker. All ops are serialized through a single goroutine so the map needs
// no mutex, and each client gets its own ordered mailbox.Mailbox so a slow
// client only delays itself: the registry actor never invokes a callback
// inline, so one client blocked in WSClient.Send with a full send buffer
// cannot stall broadcasts or acks to any other client, nor the worker's send
// path. A callback set before a broadcast is guaranteed to receive that
// broadcast (set and broadcast serialize through the actor), and each client
// observes broadcasts and targeted sends in exactly the order the worker
// issued them (single delivery goroutine draining a FIFO).
type callbackRegistry struct {
	ch chan cbOp
}

type cbOpKind int

const (
	cbSet cbOpKind = iota
	cbRemove
	cbBroadcast
	cbSendTo
	cbSetEngine
	cbSendToEngine
	cbHasEngine
	cbEngineID
	cbGet
	cbStop
)

type cbOp struct {
	kind       cbOpKind
	clientID   string
	fn         func([]byte)
	data       []byte
	result     chan func([]byte)
	boolResult chan bool
	strResult  chan string
}

// cbMsg is one unit of work queued to a client's mailbox: a payload to
// deliver, or (when swapFn is non-nil) a replacement callback taking effect
// for all later payloads. Routing the swap through the same queue as the
// payloads keeps re-set semantics exact: payloads accepted before the swap
// reach the old callback, later ones the new — nothing is dropped or
// reordered when the manager re-registers a live client.
type cbMsg struct {
	data   []byte
	swapFn func([]byte)
}

// newCbMailbox builds one client's ordered delivery pipeline. The deliver
// closure is the mailbox's single delivery goroutine, so mutating its
// captured fn on a swap message is race-free; payloads enqueued before the
// swap reach the old callback, later ones the new.
func newCbMailbox(fn func([]byte)) *mailbox.Mailbox[cbMsg] {
	return mailbox.NewMailbox(func(msg cbMsg) {
		if msg.swapFn != nil {
			fn = msg.swapFn
		} else {
			fn(msg.data)
		}
	})
}

func newCallbackRegistry() *callbackRegistry {
	r := &callbackRegistry{ch: make(chan cbOp, 100)}
	go r.run()
	return r
}

func (r *callbackRegistry) run() {
	fns := map[string]func([]byte){}
	boxes := map[string]*mailbox.Mailbox[cbMsg]{}
	var engineID string // the engine client, if one is attached ("" = none)
	for op := range r.ch {
		switch op.kind {
		case cbSet:
			fns[op.clientID] = op.fn
			if box := boxes[op.clientID]; box != nil {
				box.Enqueue(cbMsg{swapFn: op.fn})
			} else {
				boxes[op.clientID] = newCbMailbox(op.fn)
			}
		case cbRemove:
			delete(fns, op.clientID)
			if box := boxes[op.clientID]; box != nil {
				box.Stop()
				delete(boxes, op.clientID)
			}
			if op.clientID == engineID {
				engineID = ""
			}
		case cbBroadcast:
			// clientID, when set, is the one client left out.
			for id, box := range boxes {
				if op.clientID != "" && id == op.clientID {
					continue
				}
				box.Enqueue(cbMsg{data: op.data})
			}
		case cbSendTo:
			// Targeted reply: deliver to one client, or silently drop if it has
			// already disconnected (nobody is waiting on the reply).
			if box := boxes[op.clientID]; box != nil {
				box.Enqueue(cbMsg{data: op.data})
			}
		case cbSetEngine:
			engineID = op.clientID
		case cbSendToEngine:
			// Deliver to the attached engine client, if any. Ordered behind any
			// prior broadcasts to the engine (same mailbox), so the engine sees
			// the doc state that includes the just-created tool-action.
			if engineID != "" {
				if box := boxes[engineID]; box != nil {
					box.Enqueue(cbMsg{data: op.data})
				}
			}
		case cbHasEngine:
			op.boolResult <- (engineID != "")
		case cbEngineID:
			op.strResult <- engineID
		case cbGet:
			op.result <- fns[op.clientID]
		case cbStop:
			for _, box := range boxes {
				box.Stop()
			}
			return
		}
	}
}

func (r *callbackRegistry) set(id string, fn func([]byte)) {
	r.ch <- cbOp{kind: cbSet, clientID: id, fn: fn}
}

func (r *callbackRegistry) remove(id string) {
	r.ch <- cbOp{kind: cbRemove, clientID: id}
}

func (r *callbackRegistry) broadcast(data []byte) {
	r.ch <- cbOp{kind: cbBroadcast, data: data}
}

// broadcastExcept delivers data to every client but one, in the same order as
// broadcast relative to every other send ("" leaves nobody out).
func (r *callbackRegistry) broadcastExcept(except string, data []byte) {
	r.ch <- cbOp{kind: cbBroadcast, clientID: except, data: data}
}

func (r *callbackRegistry) sendTo(id string, data []byte) {
	r.ch <- cbOp{kind: cbSendTo, clientID: id, data: data}
}

// setEngine marks which client is the engine (the single tool executor), so the
// worker can push state to it directly. "" detaches.
func (r *callbackRegistry) setEngine(id string) {
	r.ch <- cbOp{kind: cbSetEngine, clientID: id}
}

// sendToEngine delivers data to the attached engine client (no-op if none).
func (r *callbackRegistry) sendToEngine(data []byte) {
	r.ch <- cbOp{kind: cbSendToEngine, data: data}
}

// engineAttached reports whether an engine client is currently registered. Used
// by driveToolActions to skip dispatching tool commands when no engine exists to
// execute them (e.g. Go unit tests with no engine peer).
func (r *callbackRegistry) engineAttached() bool {
	result := make(chan bool, 1)
	r.ch <- cbOp{kind: cbHasEngine, boolResult: result}
	return <-result
}

// engineClientID returns the currently-attached engine client ID, or "" if none.
// The tool-execution-report accept-gate uses it to reject reports whose
// OriginClient is not the current engine (a viewer, or a superseded engine
// connection) — the identity fence that makes stale reports inadmissible.
func (r *callbackRegistry) engineClientID() string {
	result := make(chan string, 1)
	r.ch <- cbOp{kind: cbEngineID, strResult: result}
	return <-result
}

func (r *callbackRegistry) get(id string) func([]byte) {
	result := make(chan func([]byte), 1)
	r.ch <- cbOp{kind: cbGet, clientID: id, result: result}
	return <-result
}

func (r *callbackRegistry) stop() {
	r.ch <- cbOp{kind: cbStop}
}
