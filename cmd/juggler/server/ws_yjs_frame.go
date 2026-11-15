//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math"

	"juggler/cmd/juggler/worker"

	"github.com/buger/jsonparser"
)

// Yjs sync rides the socket as a binary frame for a client that asks for it
// (sync=binary on the upgrade, answered by binarySync in the session frame).
// Its JSON form carries the update as base64 inside a worker-message envelope,
// which adds a third to every sync — and sync is the bulk of a conversation's
// traffic. The frame carries the same message with the bytes raw:
//
//	magic        4 bytes  "JYS1"
//	kind         1 byte   yjsFrameKind* — also the worker message type
//	flags        1 byte   yjsFlag*
//	convLen      2 bytes  uint16 BE, then the conversation id, UTF-8
//	sinceEditMs  4 bytes  int32 BE, present when yjsFlagSinceEdit is set
//	svLen        4 bytes  uint32 BE, then the state vector, present when
//	                      yjsFlagStateVector is set
//	update       remainder, the raw Yjs update (empty stands for none)
//
// web/js/utils/yjs-sync-frame.js is the browser's half. A client that did not
// ask is sent the JSON envelope as ever, and the server always accepts JSON, so
// either end can fall back. A frame over the chunk threshold is split like any
// other message, as wsChunkKindBinary. "JYS1" cannot begin a JSON text, so the
// read loop tells a frame from JSON by its first bytes.
const (
	// yjsFrameKindSync is a yjs-sync: both directions.
	yjsFrameKindSync byte = 1
	// yjsFrameKindResyncResponse is a resync-response: server to client only.
	yjsFrameKindResyncResponse byte = 2

	yjsFlagEngineDerived byte = 1 << 0
	yjsFlagSinceEdit     byte = 1 << 1
	yjsFlagStateVector   byte = 1 << 2
	yjsFlagsKnown             = yjsFlagEngineDerived | yjsFlagSinceEdit | yjsFlagStateVector

	// yjsFrameFixedHeader is magic, kind, flags and convLen.
	yjsFrameFixedHeader = 8
)

var yjsFrameMagic = [4]byte{'J', 'Y', 'S', '1'}

// yjsFrame is one decoded frame. update and stateVector alias the bytes it was
// parsed from. A nil stateVector is an absent one.
type yjsFrame struct {
	kind          byte
	convID        string
	engineDerived bool
	sinceEditMs   *int
	stateVector   []byte
	update        []byte
}

// yjsFrameMsgType is the worker message type each kind stands for.
var yjsFrameMsgType = map[byte]string{
	yjsFrameKindSync:           "yjs-sync",
	yjsFrameKindResyncResponse: "resync-response",
}

// isYjsFrame reports whether b opens with the frame's magic.
func isYjsFrame(b []byte) bool {
	return len(b) >= len(yjsFrameMagic) && [4]byte(b[:4]) == yjsFrameMagic
}

// yjsFrameHeaderSize is how many bytes precede the update.
func yjsFrameHeaderSize(f yjsFrame) int {
	n := yjsFrameFixedHeader + len(f.convID)
	if f.sinceEditMs != nil {
		n += 4
	}
	if f.stateVector != nil {
		n += 4 + len(f.stateVector)
	}
	return n
}

// appendYjsFrameHeader appends everything but the update to dst.
func appendYjsFrameHeader(dst []byte, f yjsFrame) []byte {
	var flags byte
	if f.engineDerived {
		flags |= yjsFlagEngineDerived
	}
	if f.sinceEditMs != nil {
		flags |= yjsFlagSinceEdit
	}
	if f.stateVector != nil {
		flags |= yjsFlagStateVector
	}
	dst = append(dst, yjsFrameMagic[:]...)
	dst = append(dst, f.kind, flags)
	dst = binary.BigEndian.AppendUint16(dst, uint16(len(f.convID)))
	dst = append(dst, f.convID...)
	if f.sinceEditMs != nil {
		dst = binary.BigEndian.AppendUint32(dst, uint32(int32(*f.sinceEditMs)))
	}
	if f.stateVector != nil {
		dst = binary.BigEndian.AppendUint32(dst, uint32(len(f.stateVector)))
		dst = append(dst, f.stateVector...)
	}
	return dst
}

// encodeYjsFrame writes f in one exactly-sized allocation.
func encodeYjsFrame(f yjsFrame) []byte {
	buf := make([]byte, 0, yjsFrameHeaderSize(f)+len(f.update))
	return append(appendYjsFrameHeader(buf, f), f.update...)
}

// parseYjsFrame reads a frame, refusing anything malformed rather than reading
// past its end.
func parseYjsFrame(b []byte) (yjsFrame, error) {
	var f yjsFrame
	if !isYjsFrame(b) {
		return f, errors.New("not a JYS1 frame")
	}
	if len(b) < yjsFrameFixedHeader {
		return f, errors.New("frame shorter than its header")
	}
	f.kind = b[4]
	if _, ok := yjsFrameMsgType[f.kind]; !ok {
		return f, fmt.Errorf("unknown frame kind %d", f.kind)
	}
	flags := b[5]
	if flags&^yjsFlagsKnown != 0 {
		return f, fmt.Errorf("unknown frame flags %#x", flags)
	}
	if flags&yjsFlagStateVector != 0 && f.kind != yjsFrameKindResyncResponse {
		return f, errors.New("a state vector on a frame that carries none")
	}
	convLen := int(binary.BigEndian.Uint16(b[6:8]))
	rest := b[yjsFrameFixedHeader:]
	if convLen == 0 || convLen > len(rest) {
		return f, fmt.Errorf("conversation id of %d bytes in a frame of %d", convLen, len(b))
	}
	f.convID = string(rest[:convLen])
	rest = rest[convLen:]
	f.engineDerived = flags&yjsFlagEngineDerived != 0
	if flags&yjsFlagSinceEdit != 0 {
		if len(rest) < 4 {
			return f, errors.New("frame ends inside sinceEditMs")
		}
		n := int(int32(binary.BigEndian.Uint32(rest[:4])))
		f.sinceEditMs = &n
		rest = rest[4:]
	}
	if flags&yjsFlagStateVector != 0 {
		if len(rest) < 4 {
			return f, errors.New("frame ends inside the state vector length")
		}
		svLen := binary.BigEndian.Uint32(rest[:4])
		rest = rest[4:]
		if uint64(svLen) > uint64(len(rest)) {
			return f, fmt.Errorf("state vector of %d bytes with %d left", svLen, len(rest))
		}
		f.stateVector = rest[:svLen:svLen]
		rest = rest[svLen:]
	}
	f.update = rest
	return f, nil
}

// decodeBase64Field reads one []byte field of a worker payload: nil for an
// absent or null field, ok=false for one that is not base64.
func decodeBase64Field(payload []byte, key string) (out []byte, present, ok bool) {
	value, typ, _, err := jsonparser.Get(payload, key)
	if err != nil || typ == jsonparser.Null {
		return nil, false, true
	}
	if typ != jsonparser.String {
		return nil, false, false
	}
	out = make([]byte, base64.StdEncoding.DecodedLen(len(value)))
	n, err := base64.StdEncoding.Decode(out, value)
	if err != nil {
		return nil, false, false
	}
	return out[:n], true, true
}

// yjsFrameFromWorkerPayload turns one worker payload bound for convID into a
// frame, or returns nil for a payload the frame does not carry — every type
// but yjs-sync and resync-response, and anything malformed — which then goes
// as the JSON envelope.
//
// The update is base64-decoded straight into the frame's own buffer, so a sync
// costs one allocation per recipient, as the JSON envelope did.
// TestYjsFrameCoversWorkerFields holds the fields read here to the structs.
func yjsFrameFromWorkerPayload(convID string, payload []byte) []byte {
	if len(convID) == 0 || len(convID) > math.MaxUint16 {
		return nil
	}
	msgType, err := jsonparser.GetString(payload, "type")
	if err != nil {
		return nil
	}
	f := yjsFrame{convID: convID}
	switch msgType {
	case "yjs-sync":
		f.kind = yjsFrameKindSync
		if derived, err := jsonparser.GetBoolean(payload, "engineDerived"); err == nil {
			f.engineDerived = derived
		}
		if since, err := jsonparser.GetInt(payload, "sinceEditMs"); err == nil {
			if since < math.MinInt32 || since > math.MaxInt32 {
				return nil
			}
			n := int(since)
			f.sinceEditMs = &n
		}
	case "resync-response":
		f.kind = yjsFrameKindResyncResponse
		sv, present, ok := decodeBase64Field(payload, "stateVector")
		if !ok {
			return nil
		}
		if present {
			f.stateVector = sv
		}
	default:
		return nil
	}

	value, typ, _, err := jsonparser.Get(payload, "bytes")
	if err != nil || typ == jsonparser.Null {
		return encodeYjsFrame(f)
	}
	if typ != jsonparser.String {
		return nil
	}
	header := yjsFrameHeaderSize(f)
	buf := make([]byte, header+base64.StdEncoding.DecodedLen(len(value)))
	appendYjsFrameHeader(buf[:0], f)
	n, err := base64.StdEncoding.Decode(buf[header:], value)
	if err != nil {
		return nil
	}
	return buf[:header+n]
}

// workerMessageFromYjsFrame turns a client's frame into the worker message its
// JSON envelope would have been, so it is routed exactly as that would be. A
// client sends only yjs-sync.
func workerMessageFromYjsFrame(b []byte) (worker.WorkerMessage, error) {
	f, err := parseYjsFrame(b)
	if err != nil {
		return worker.WorkerMessage{}, err
	}
	if f.kind != yjsFrameKindSync {
		return worker.WorkerMessage{}, fmt.Errorf("a client may not send a %s frame", yjsFrameMsgType[f.kind])
	}
	return worker.WorkerMessage{
		Type:           string(frameWorkerMessage),
		ConversationID: f.convID,
		WorkerMsgType:  yjsFrameMsgType[f.kind],
		Payload:        worker.MarshalYjsSyncMessage(f.update, f.engineDerived, f.sinceEditMs),
	}, nil
}

// binarySyncSender is a client that can be sent sync as frames, when it asked.
type binarySyncSender interface {
	AcceptsBinarySync() bool
	SendBinary(data []byte) bool
}

// sendWorkerMessage delivers one worker message for convID to client: as a
// frame when the client asked for binary and the message is one the frame
// carries, otherwise as the JSON envelope. Both go through the client's one
// write queue, so a frame keeps its place among the JSON around it.
func sendWorkerMessage(client RealtimeClient, convID string, msg []byte) {
	if b, ok := client.(binarySyncSender); ok && b.AcceptsBinarySync() {
		if frame := yjsFrameFromWorkerPayload(convID, msg); frame != nil {
			b.SendBinary(frame)
			return
		}
	}
	if envelope := worker.FormatWorkerMessage(convID, msg); envelope != nil {
		client.SendRaw(envelope)
	}
}

// describeYjsFrame names a frame for a log line or the bandwidth stats.
func describeYjsFrame(b []byte) string {
	f, err := parseYjsFrame(b)
	if err != nil {
		return "malformed sync frame"
	}
	return fmt.Sprintf("%s (%s, binary)", yjsFrameMsgType[f.kind], f.convID)
}
