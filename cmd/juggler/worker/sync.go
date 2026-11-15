//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/base64"
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

// The literal segments of a marshalled YjsSyncMessage. Concatenated with the
// base64 of its bytes they spell exactly what json.Marshal produces for one —
// same fields, same order, same encoding — so the wire format is unchanged.
// Type is a constant here because "yjs-sync" is the only value any producer
// sets; EngineDerived is `omitempty`, so false contributes nothing.
const (
	yjsSyncHead      = `{"type":"yjs-sync","bytes":`
	yjsSyncNilBytes  = `null`
	yjsSyncDerived   = `,"engineDerived":true`
	yjsSyncQuoteByte = '"'
)

// marshalYjsSync builds a yjs-sync payload in one exactly-sized allocation,
// with the update base64-encoded straight into it.
//
// This is the same trade FormatWorkerMessage makes one layer out, for the same
// reason and on the same payloads. encoding/json cannot be told how large its
// output will be, so it grows an internal buffer as it goes; the length of a
// base64 encoding, by contrast, is known exactly before a byte is written. On
// a streaming delta the difference is nothing. On a full-state sync it is the
// whole cost: marshalling a 96 MiB update allocates ~224 MB to produce a
// 134 MB result, where sizing it exactly allocates the 134 MB and no more —
// 89 MB less garbage per send, on the path where the result is already the
// largest thing the process is holding. (BenchmarkMarshalYjsSync covers the
// sizes an ordinary session sees, where the two are within a few percent; the
// gap opens well above them.)
//
// The output is byte-identical to json.Marshal of the equivalent
// YjsSyncMessage, which sync_format_test.go pins against the real encoder
// rather than against a hand-written expectation. Base64's alphabet needs no
// JSON escaping and contains none of the characters encoding/json escapes for
// HTML, so "identical" needs no qualification.
func marshalYjsSync(update []byte, engineDerived bool) []byte {
	tail := ""
	if engineDerived {
		tail = yjsSyncDerived
	}

	size := len(yjsSyncHead) + len(tail) + 1 // + the closing brace
	if update == nil {
		size += len(yjsSyncNilBytes)
	} else {
		size += 2 + base64.StdEncoding.EncodedLen(len(update)) // + the quotes
	}

	buf := make([]byte, 0, size)
	buf = append(buf, yjsSyncHead...)
	if update == nil {
		// A nil slice is `null` to encoding/json, an empty one is `""`. The
		// distinction never reaches the wire from a live worker, but matching it
		// is what lets the equivalence test compare the two encoders on every
		// input rather than on the ones we thought of.
		buf = append(buf, yjsSyncNilBytes...)
	} else {
		buf = append(buf, yjsSyncQuoteByte)
		at := len(buf)
		buf = buf[:at+base64.StdEncoding.EncodedLen(len(update))]
		base64.StdEncoding.Encode(buf[at:], update)
		buf = append(buf, yjsSyncQuoteByte)
	}
	buf = append(buf, tail...)
	return append(buf, '}')
}

// MarshalYjsSyncMessage is the yjs-sync payload a client's JSON envelope would
// have carried for these fields. The server builds it for a client that sent
// its sync as a binary frame, so the worker receives the one form whichever
// way the sync travelled.
//
// Only a single local edit carries sinceEditMs, and those are small, so that
// case goes through encoding/json; the rest — full-state pushes and resync
// replies, which can be megabytes — through marshalYjsSync's exact sizing.
func MarshalYjsSyncMessage(update []byte, engineDerived bool, sinceEditMs *int) []byte {
	if sinceEditMs == nil {
		return marshalYjsSync(update, engineDerived)
	}
	data, err := json.Marshal(YjsSyncMessage{Type: msgYjsSync, Bytes: update, EngineDerived: engineDerived, SinceEditMs: sinceEditMs})
	if err != nil {
		// Cannot happen for these field types; the payload without the timing
		// is still the edit.
		return marshalYjsSync(update, engineDerived)
	}
	return data
}

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
