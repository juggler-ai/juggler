//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/binary"
	"time"

	"github.com/gorilla/websocket"
)

// A WebSocket message has no size limit on the wire, but every client library
// imposes one on what it will accept, and the server has no way to discover it.
// Node's built-in WebSocket (undici, which is what the headless engine host
// runs on) defaults to 128 MiB and answers anything larger with a close 1009
// before it has read a single byte of the payload. Nothing recovers from that
// on its own: the client reconnects, the server re-sends the same message, and
// the conversation is unusable for as long as it stays that size.
//
// So a message that is too big for any plausible client is split here, and the
// client puts it back together. The frames are binary because the payload being
// carried is UTF-8 text: slicing text into JSON string fields would mean
// respecting rune boundaries and re-escaping every slice — a second full pass
// over a payload whose size is the entire problem — where raw bytes need
// neither, and the client decodes UTF-8 once at the end.
//
//	magic   4 bytes   "JGC1"
//	kind    1 byte    what the reassembled bytes are (see wsChunkKind*)
//	id      8 bytes   uint64 BE, unique per connection
//	index   4 bytes   uint32 BE
//	total   4 bytes   uint32 BE
//	data    remainder
//
// Concatenating every frame's data in index order reproduces the original
// payload byte for byte.
const (
	wsChunkHeaderSize = 21

	// wsChunkKindText marks reassembled bytes that are a UTF-8 text message —
	// what an unchunked send would have written as websocket.TextMessage.
	wsChunkKindText byte = 0

	// wsChunkKindBinary marks reassembled bytes that are themselves a binary
	// message and must not be decoded as text.
	wsChunkKindBinary byte = 1

	// wsChunkThreshold is the largest message written whole. Above it the
	// message is split into pieces of this size.
	//
	// Ordinary traffic is nowhere near it — sync deltas, status, tool output
	// chunks are kilobytes — so nothing on the hot path pays for this at all.
	// What it has to clear is the full-state resync of a large conversation,
	// which runs to megabytes and has no upper bound but the document's size.
	//
	// 8 MiB is chosen from both ends: far enough above ordinary traffic that
	// chunking stays an exceptional path worth logging when it happens, and far
	// enough below the smallest client ceiling known (undici's 128 MiB) that a
	// client with a stricter limit still has an order of magnitude of headroom.
	// It also keeps the frame count sane — a 100 MB document is 13 frames, not
	// the thousands a 16 KiB chunker would produce.
	wsChunkThreshold = 8 * 1024 * 1024
)

var wsChunkMagic = [4]byte{'J', 'G', 'C', '1'}

// wsChunkHeader is the fixed part of a chunk frame.
type wsChunkHeader struct {
	kind  byte
	id    uint64
	index uint32
	total uint32
}

// encodeWSChunkHeader writes h into dst, which must be at least
// wsChunkHeaderSize long.
func encodeWSChunkHeader(dst []byte, h wsChunkHeader) {
	copy(dst[0:4], wsChunkMagic[:])
	dst[4] = h.kind
	binary.BigEndian.PutUint64(dst[5:13], h.id)
	binary.BigEndian.PutUint32(dst[13:17], h.index)
	binary.BigEndian.PutUint32(dst[17:21], h.total)
}

// wsChunkCount is how many frames a payload of this size splits into.
func wsChunkCount(payloadLen int) int {
	if payloadLen <= 0 {
		return 1
	}
	return (payloadLen + wsChunkThreshold - 1) / wsChunkThreshold
}

// writeChunked writes one oversized payload as a run of chunk frames.
//
// Only writePump calls it (through writeOne), so the one-writer-per-connection
// rule gorilla requires still holds, and the run is contiguous: no other
// message can interleave with it and the client can rely on the frames arriving
// in order. The id rides along regardless so that if that ever stops being true
// the client can detect it rather than silently splice two messages together.
//
// Each frame is written through NextWriter and two Writes — the header, then a
// slice of the caller's payload — so nothing the size of the payload is copied
// or allocated on the way out. The write deadline is armed per frame rather
// than once for the whole run: a run is exactly as many independent writes as
// it has frames, and holding one deadline across all of them would give a large
// document less time per byte the larger it got.
func (c *WSClient) writeChunked(payload []byte, kind byte) error {
	c.chunkSeq++
	id := c.chunkSeq
	total := wsChunkCount(len(payload))

	var header [wsChunkHeaderSize]byte
	for index := 0; index < total; index++ {
		start := index * wsChunkThreshold
		end := start + wsChunkThreshold
		if end > len(payload) {
			end = len(payload)
		}
		encodeWSChunkHeader(header[:], wsChunkHeader{
			kind:  kind,
			id:    id,
			index: uint32(index),
			total: uint32(total),
		})

		_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
		w, err := c.conn.NextWriter(websocket.BinaryMessage)
		if err != nil {
			return err
		}
		if _, err = w.Write(header[:]); err != nil {
			_ = w.Close()
			return err
		}
		if _, err = w.Write(payload[start:end]); err != nil {
			_ = w.Close()
			return err
		}
		if err = w.Close(); err != nil {
			return err
		}
	}
	return nil
}
