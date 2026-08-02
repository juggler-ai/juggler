//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"

	"github.com/buger/jsonparser"
)

// WorkerMessage is the format for messages to/from Go worker via WebSocket.
type WorkerMessage struct {
	Type           string          `json:"type"`           // "worker-message"
	ConversationID string          `json:"conversationId"` // Target conversation
	WorkerMsgType  string          `json:"workerMsgType"`  // Actual worker message type
	Payload        json.RawMessage `json:"payload"`        // Message payload
}

// The envelope's literal segments. Concatenated with the two quoted strings and
// the payload they spell exactly what marshalling WorkerMessage produces —
// same fields, same order — so the wire format is unchanged.
const (
	envelopeHead    = `{"type":"worker-message","conversationId":`
	envelopeMsgType = `,"workerMsgType":`
	envelopePayload = `,"payload":`
)

// FormatWorkerMessage creates a worker message for sending to browser.
//
// This is the server's hottest function: every worker message bound for a
// viewer passes through it, once per recipient. It used to build the envelope
// with encoding/json, which walked the entire payload TWICE just to add a
// ~90-byte wrapper:
//
//   - json.Unmarshal(workerMsg, &generic) to read one field, "type" — but
//     Unmarshal runs checkValid over the whole document first.
//   - json.Marshal(msg) with Payload as a json.RawMessage — the encoder runs
//     appendCompact over the whole payload again, copying it into a growing
//     bytes.Buffer.
//
// Profiling a viewer sync on a large conversation (a ~55MB Yjs doc) put this
// one function at 64% of all server CPU — appendCompact 39%, checkValid 23% —
// and a heap profile attributed 290MB of live heap to its envelope buffers,
// against only ~76MB of actual CRDT data.
//
// Neither pass buys anything. The payload is ALWAYS the output of a successful
// json.Marshal in this same process: its only producers are
// ConversationWorker.send and ConversationWorker.reply, which both marshal and
// return early if that fails (see worker.go), so nothing else can reach here.
// The bytes are therefore already valid and already compact, and re-validating
// then re-compacting them is pure overhead.
//
// So the envelope is assembled by appending into one exactly-sized buffer with
// the payload copied verbatim — a single memmove, no scan, no reallocation.
func FormatWorkerMessage(conversationID string, workerMsg []byte) []byte {
	// Cheapest possible sanity check on the payload, in O(1): every producer
	// marshals a struct or map, so the bytes must open and close a JSON object.
	// This is not validation — that is the pass being removed — but it costs two
	// byte comparisons and still rejects the one corruption that would otherwise
	// put malformed JSON on the wire: a truncated payload, whose "type" is
	// readable even though the document never closes. Anything subtler cannot
	// occur, because the only producers marshal with encoding/json and drop the
	// message if that fails.
	if len(workerMsg) < 2 || workerMsg[0] != '{' || workerMsg[len(workerMsg)-1] != '}' {
		return nil
	}

	// Read "type" without validating the whole document. Every producer declares
	// Type as its first struct field, so encoding/json emits it first and this
	// stops after a few bytes. An error — a missing or non-string "type", or
	// JSON too broken to reach it — means the envelope can't be labelled, which
	// is the same nil the old Unmarshal failure returned.
	msgType, err := jsonparser.GetString(workerMsg, "type")
	if err != nil {
		return nil
	}

	// Both are short identifiers, so marshalling them individually is cheap and
	// escapes them exactly as encoding/json would inside the struct.
	convIDJSON, err := json.Marshal(conversationID)
	if err != nil {
		return nil
	}
	msgTypeJSON, err := json.Marshal(msgType)
	if err != nil {
		return nil
	}

	buf := make([]byte, 0,
		len(envelopeHead)+len(convIDJSON)+
			len(envelopeMsgType)+len(msgTypeJSON)+
			len(envelopePayload)+len(workerMsg)+1)
	buf = append(buf, envelopeHead...)
	buf = append(buf, convIDJSON...)
	buf = append(buf, envelopeMsgType...)
	buf = append(buf, msgTypeJSON...)
	buf = append(buf, envelopePayload...)
	buf = append(buf, workerMsg...)
	return append(buf, '}')
}
