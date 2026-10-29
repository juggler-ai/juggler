//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package peer

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"
)

// maxFrameBytes bounds one frame a guest sends, joined from its chunks. The
// largest a guest sends on purpose is a request carrying a session's largest
// body (maxRequestBodyBytes, 32 MiB) as base64 — 42.7 MiB — in its JSON
// envelope; a WebSocket message (a yjs update runs to tens of megabytes) fits
// too. 64 MiB covers both with room for the envelope's headers.
const maxFrameBytes = 64 << 20

// maxAssemblies bounds the frames a link has part-received at once. A guest's
// one sender (the bootstrap's sendFrame) sends every chunk of a frame before
// the next frame, on an ordered channel, so it never has more than one; the
// rest is room for a sender that interleaves a few.
const maxAssemblies = 4

// maxHeldBytes bounds the chunk data a link holds across all its
// part-received frames: one largest frame, which is all an ordered sender
// that finishes each frame before the next can ever have in flight.
const maxHeldBytes = maxFrameBytes

// A binary WebSocket message crosses the channel as binary messages, every one
// of them a piece of it, a message that fits being one piece of one:
//
//	magic  4 bytes  "JDB1"
//	id     4 bytes  uint32 BE, unique among its sender's messages on a link
//	index  4 bytes  uint32 BE
//	total  4 bytes  uint32 BE
//	data   the rest, at most piecePayload bytes
//
// Joining the pieces' data in index order gives the message byte for byte.
// Text keeps to text frames and binary to binary ones, so a message arrives as
// the type it was sent: JSON chunks would carry bytes only as base64, a third
// larger, and the binary a session sends is its largest messages (a split
// resync, server/ws_chunk.go).
const pieceHeaderSize = 16

// piecePayload is the most message data one piece carries, so that a piece,
// header and all, is no larger than a whole frame (chunkSize).
const piecePayload = chunkSize - pieceHeaderSize

var pieceMagic = [4]byte{'J', 'D', 'B', '1'}

// pieces splits a binary message into the channel's binary messages under id.
func pieces(id uint32, payload []byte) [][]byte {
	total := max(1, (len(payload)+piecePayload-1)/piecePayload)
	out := make([][]byte, total)
	for i := range out {
		data := payload[i*piecePayload : min((i+1)*piecePayload, len(payload))]
		p := make([]byte, pieceHeaderSize+len(data))
		copy(p, pieceMagic[:])
		binary.BigEndian.PutUint32(p[4:], id)
		binary.BigEndian.PutUint32(p[8:], uint32(i))
		binary.BigEndian.PutUint32(p[12:], uint32(total))
		copy(p[pieceHeaderSize:], data)
		out[i] = p
	}
	return out
}

// chunk is one piece of a frame larger than chunkSize.
type chunk struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Index int    `json:"index"`
	Total int    `json:"total"`
	Data  string `json:"data"`
}

// assembly collects the pieces of one chunked frame. Its parts are keyed by
// index as they arrive, so what it holds is what the sender sent, never what
// its total claims.
type assembly struct {
	total int
	parts map[int]string
	bytes int
}

// reassembler joins one channel's chunked frames, refusing any that break the
// protocol or the bounds above. The channel's read loop is its only user.
type reassembler struct {
	frames map[string]*assembly
	held   int // chunk data bytes across frames
	// The limits, set by newReassembler; a test's guest reads the server's
	// answers, which interleave, with wider ones.
	maxAssemblies, maxHeldBytes, maxFrameBytes int
}

func newReassembler() *reassembler {
	return &reassembler{
		frames:        map[string]*assembly{},
		maxAssemblies: maxAssemblies,
		maxHeldBytes:  maxHeldBytes,
		maxFrameBytes: maxFrameBytes,
	}
}

// errChunk marks a chunk that breaks the protocol or a bound; the link that
// sent it ends.
var errChunk = errors.New("bad chunk")

// chunkBounds splits payload into [start, end) spans of at most chunkSize
// bytes, each ending on a UTF-8 rune boundary.
//
// Chunk data rides in a JSON string field, and json.Marshal coerces its input
// to valid UTF-8 — every byte of a truncated rune becomes U+FFFD — so a rune
// straddling a boundary would arrive corrupted in both halves, and nothing
// downstream would notice: U+FFFD is legal in a JSON string, so the joined
// frame still parses and the damage shows only as mangled text. Receivers join
// the parts in order and never inspect the split points, so choosing them here
// needs nothing from the far end.
func chunkBounds(payload []byte) [][2]int {
	bounds := make([][2]int, 0, len(payload)/chunkSize+1)
	for start := 0; start < len(payload); {
		end := start + chunkSize
		if end >= len(payload) {
			end = len(payload)
		} else {
			// Walk back over continuation bytes (0b10xxxxxx) to the start of the
			// rune spanning the boundary: three steps at worst.
			for end > start && payload[end]&0xC0 == 0x80 {
				end--
			}
			// A whole chunk of continuation bytes is not UTF-8 and has no
			// boundary to find; split at full width so the loop advances.
			if end == start {
				end = start + chunkSize
			}
		}
		bounds = append(bounds, [2]int{start, end})
		start = end
	}
	return bounds
}

// maxChunks is the most chunks a frame of at most frameBytes is sent in. Every
// chunk but the last carries at least chunkSize-(utf8.UTFMax-1) bytes:
// chunkBounds backs a boundary off by at most three bytes to a rune start, and
// the bootstrap's chunks are chunkSize UTF-16 units, or one fewer to keep a
// surrogate pair whole, each at least one UTF-8 byte.
func maxChunks(frameBytes int) int {
	return frameBytes/(chunkSize-(utf8.UTFMax-1)) + 1
}

// maxPieces is the most pieces a binary message of at most frameBytes is sent
// in: every piece but the last carries piecePayload bytes.
func maxPieces(frameBytes int) int {
	return frameBytes/piecePayload + 1
}

// take takes one text frame from the channel. isChunk says whether it was a
// chunk; whole is the frame a chunk completes, nil until then. An error
// (wrapping errChunk) is a chunk no sender within the protocol makes: a bad
// id, index or total, a total that changes within a frame, a piece sent twice,
// or one past a bound. Every frame part-received is dropped with it, since the
// link ends.
func (r *reassembler) take(data []byte) (whole []byte, isChunk bool, err error) {
	// A field of the wrong type does not stop the decoder, so Type is read
	// even from a frame that fails to decode: one that names itself a chunk is
	// held to being one.
	var c chunk
	decodeErr := json.Unmarshal(data, &c)
	if c.Type != chunkType {
		return nil, false, nil
	}
	if decodeErr != nil {
		return nil, true, r.fail("%v", decodeErr)
	}
	if c.ID == "" {
		return nil, true, r.fail("a chunk with no id")
	}
	whole, err = r.add("t"+c.ID, c.Index, c.Total, maxChunks(r.maxFrameBytes), []byte(c.Data))
	return whole, true, err
}

// takeBinary takes one binary message from the channel: a piece of a binary
// WebSocket message. whole is the message it completes, nil until then. An
// error (wrapping errChunk) is a binary message that is no piece, or a piece
// no sender makes, as for take.
func (r *reassembler) takeBinary(data []byte) (whole []byte, err error) {
	if len(data) < pieceHeaderSize || [4]byte(data[:4]) != pieceMagic {
		return nil, r.fail("a binary message of %d bytes that is not a piece", len(data))
	}
	id := binary.BigEndian.Uint32(data[4:])
	index, total := binary.BigEndian.Uint32(data[8:]), binary.BigEndian.Uint32(data[12:])
	return r.add(fmt.Sprintf("b%d", id), int(index), int(total), maxPieces(r.maxFrameBytes), data[pieceHeaderSize:])
}

// fail refuses a frame: every frame part-received is dropped.
func (r *reassembler) fail(format string, args ...any) error {
	r.frames, r.held = map[string]*assembly{}, 0
	return fmt.Errorf("%w: "+format, append([]any{errChunk}, args...)...)
}

// add holds one part of the frame under key, of at most limit parts, and
// returns the frame it completes.
func (r *reassembler) add(key string, index, total, limit int, data []byte) ([]byte, error) {
	if total <= 0 || index < 0 || index >= total {
		return nil, r.fail("frame %q, index %d of %d", key, index, total)
	}
	if total > limit {
		return nil, r.fail("a total of %d parts, over %d", total, limit)
	}
	entry := r.frames[key]
	if entry == nil {
		if len(r.frames) >= r.maxAssemblies {
			return nil, r.fail("over %d frames part-received at once", r.maxAssemblies)
		}
		entry = &assembly{total: total, parts: map[int]string{}}
		r.frames[key] = entry
	}
	if entry.total != total {
		return nil, r.fail("frame %q's total changed from %d to %d", key, entry.total, total)
	}
	if _, dup := entry.parts[index]; dup {
		return nil, r.fail("frame %q's part %d sent twice", key, index)
	}
	if entry.bytes+len(data) > r.maxFrameBytes {
		return nil, r.fail("frame %q over %d bytes", key, r.maxFrameBytes)
	}
	if r.held+len(data) > r.maxHeldBytes {
		return nil, r.fail("over %d bytes part-received", r.maxHeldBytes)
	}
	entry.parts[index] = string(data)
	entry.bytes += len(data)
	r.held += len(data)
	if len(entry.parts) != entry.total {
		return nil, nil
	}
	delete(r.frames, key)
	r.held -= entry.bytes
	buf := make([]byte, 0, entry.bytes)
	for i := 0; i < entry.total; i++ {
		buf = append(buf, entry.parts[i]...)
	}
	return buf, nil
}
