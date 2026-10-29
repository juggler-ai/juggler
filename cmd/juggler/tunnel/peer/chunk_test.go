//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package peer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"
)

// marshalChunks models the wire trip a chunked frame makes: each span becomes
// the Data field of a chunk envelope, which is where json.Marshal's UTF-8
// coercion would damage a rune split across a boundary.
func marshalChunks(t *testing.T, payload []byte) [][]byte {
	t.Helper()
	bounds := chunkBounds(payload)
	frames := make([][]byte, 0, len(bounds))
	for i, b := range bounds {
		frame, err := json.Marshal(chunk{Type: chunkType, ID: "chunk-test", Index: i, Total: len(bounds), Data: string(payload[b[0]:b[1]])})
		if err != nil {
			t.Fatalf("marshal chunk %d: %v", i, err)
		}
		frames = append(frames, frame)
	}
	return frames
}

// TestChunkingPreservesMultibyteRunes: a multi-byte rune placed across every
// offset spanning the first boundary survives the trip, which a split that
// ignores rune boundaries cannot manage.
func TestChunkingPreservesMultibyteRunes(t *testing.T) {
	for offset := -3; offset <= 3; offset++ {
		payload := []byte(strings.Repeat("a", chunkSize+offset) + "…" + strings.Repeat("b", chunkSize))
		frames := marshalChunks(t, payload)
		if len(frames) < 2 {
			t.Fatalf("offset %d: expected a split payload, got %d chunk(s)", offset, len(frames))
		}
		chunks := newReassembler()
		var whole []byte
		for _, f := range frames {
			out, isChunk, err := chunks.take(f)
			if err != nil || !isChunk {
				t.Fatalf("offset %d: frame not taken as a chunk (%v)", offset, err)
			}
			if out != nil {
				whole = out
			}
		}
		if string(whole) != string(payload) {
			t.Errorf("offset %d: reassembled payload differs (%d bytes in, %d out); a rune was split and coerced to U+FFFD",
				offset, len(payload), len(whole))
		}
	}
}

// jsChunks splits text as the bootstrap's sendFrame does (splitText): chunkSize
// UTF-16 code units per chunk, one fewer where the last would be the first half
// of a surrogate pair.
func jsChunks(t *testing.T, id, text string) [][]byte {
	t.Helper()
	units := utf16.Encode([]rune(text))
	var spans [][2]int
	for start := 0; start < len(units); {
		end := min(start+chunkSize, len(units))
		if end < len(units) && utf16.IsSurrogate(rune(units[end-1])) && units[end-1] < 0xDC00 && end-1 > start {
			end--
		}
		spans = append(spans, [2]int{start, end})
		start = end
	}
	frames := make([][]byte, 0, len(spans))
	for i, s := range spans {
		frame, err := json.Marshal(chunk{Type: chunkType, ID: id, Index: i, Total: len(spans), Data: string(utf16.Decode(units[s[0]:s[1]]))})
		if err != nil {
			t.Fatal(err)
		}
		frames = append(frames, frame)
	}
	return frames
}

// takeAll feeds frames to r and returns the frame they complete, failing on
// any refusal.
func takeAll(t *testing.T, r *reassembler, frames [][]byte) []byte {
	t.Helper()
	var whole []byte
	for i, f := range frames {
		out, _, err := r.take(f)
		if err != nil {
			t.Fatalf("chunk %d of %d refused: %v", i, len(frames), err)
		}
		if out != nil {
			whole = out
		}
	}
	return whole
}

// TestTheLargestLegitimateFramesReassemble: a frame of maxFrameBytes, sent the
// way either sender sends it — Go's rune-aligned chunks, or the bootstrap's
// UTF-16 ones of three-byte runes (the most bytes a chunk can carry) — joins
// within every bound, and the reassembler is left holding nothing.
func TestTheLargestLegitimateFramesReassemble(t *testing.T) {
	// Go's sender, at its worst for the chunk count: a rune that pushes
	// every boundary back by three bytes.
	unit := strings.Repeat("a", chunkSize-3) + "😀"
	goFrame := []byte(strings.Repeat(unit, maxFrameBytes/len(unit)))
	goFrame = append(goFrame, strings.Repeat("b", maxFrameBytes-len(goFrame))...)
	r := newReassembler()
	if whole := takeAll(t, r, marshalChunks(t, goFrame)); len(whole) != maxFrameBytes {
		t.Fatalf("Go's chunks joined to %d bytes, want %d", len(whole), maxFrameBytes)
	}
	if len(r.frames) != 0 || r.held != 0 {
		t.Fatalf("after a whole frame %d frames and %d bytes are still held", len(r.frames), r.held)
	}

	jsFrame := strings.Repeat("€", maxFrameBytes/3)
	if whole := takeAll(t, r, jsChunks(t, "js", jsFrame)); string(whole) != jsFrame {
		t.Fatalf("the bootstrap's chunks joined to %d bytes, want %d", len(whole), len(jsFrame))
	}
	// Astral runes, the first boundary falling inside a pair, which the
	// bootstrap holds back for the next chunk.
	astral := strings.Repeat("a", chunkSize-1) + strings.Repeat("😀", (maxFrameBytes-chunkSize)/4)
	if whole := takeAll(t, r, jsChunks(t, "js-astral", astral)); string(whole) != astral {
		t.Fatalf("the bootstrap's astral chunks joined to %d bytes, want %d", len(whole), len(astral))
	}
}

// TestTheLargestLegitimateBinaryMessageReassembles: a binary message of
// maxFrameBytes, in its pieces, joins within every bound, and a piece over its
// total's bound, or one of a message past maxFrameBytes, is refused.
func TestTheLargestLegitimateBinaryMessageReassembles(t *testing.T) {
	payload := make([]byte, maxFrameBytes)
	for i := range payload {
		payload[i] = byte(i)
	}
	r := newReassembler()
	var whole []byte
	for i, p := range pieces(7, payload) {
		out, err := r.takeBinary(p)
		if err != nil {
			t.Fatalf("piece %d refused: %v", i, err)
		}
		if out != nil {
			whole = out
		}
	}
	if !bytes.Equal(whole, payload) {
		t.Fatalf("the pieces joined to %d bytes, not the %d sent", len(whole), len(payload))
	}
	if len(r.frames) != 0 || r.held != 0 {
		t.Fatalf("after a whole message %d frames and %d bytes are still held", len(r.frames), r.held)
	}

	over := pieces(8, make([]byte, maxFrameBytes+1))
	for i, p := range over {
		if _, err := r.takeBinary(p); err != nil {
			if !errors.Is(err, errChunk) || i != len(over)-1 {
				t.Fatalf("piece %d of %d refused (%v); want only the last", i, len(over), err)
			}
			return
		}
	}
	t.Fatal("a binary message past maxFrameBytes was taken")
}

// TestReassemblyRefusesWhatNoSenderSends: each bound refuses the first chunk
// past it, and a refusal drops everything held.
func TestReassemblyRefusesWhatNoSenderSends(t *testing.T) {
	piece := func(id string, index, total int, data string) []byte {
		raw, err := json.Marshal(chunk{Type: chunkType, ID: id, Index: index, Total: total, Data: data})
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	refused := func(name string, r *reassembler, frames ...[]byte) {
		t.Helper()
		var err error
		for _, f := range frames {
			if _, _, err = r.take(f); err != nil {
				break
			}
		}
		if !errors.Is(err, errChunk) {
			t.Errorf("%s: taken (%v)", name, err)
		}
		if len(r.frames) != 0 || r.held != 0 {
			t.Errorf("%s: a refusal left %d frames and %d bytes held", name, len(r.frames), r.held)
		}
	}
	refused("a total past any frame", newReassembler(), piece("a", 0, maxChunks(maxFrameBytes)+1, "x"))
	refused("a total past int", newReassembler(), []byte(`{"type":"`+chunkType+`","id":"a","index":0,"total":1e30,"data":"x"}`))
	refused("a mistyped field", newReassembler(), []byte(`{"type":"`+chunkType+`","id":"a","index":"0","total":2,"data":"x"}`))

	many := newReassembler()
	var starts [][]byte
	for i := 0; i <= maxAssemblies; i++ {
		starts = append(starts, piece(fmt.Sprintf("f%d", i), 0, 2, "x"))
	}
	refused("one frame too many at once", many, starts...)

	// Chunks within their count whose data outgrows the frame.
	big := strings.Repeat("x", 3*chunkSize)
	var over [][]byte
	for i := 0; i*len(big) <= maxFrameBytes; i++ {
		over = append(over, piece("big", i, maxChunks(maxFrameBytes), big))
	}
	refused("a frame past maxFrameBytes", newReassembler(), over...)

	// Two frames that each fit, together holding more than a link may.
	half := strings.Repeat("y", maxHeldBytes/2+1)
	refused("two frames past maxHeldBytes", newReassembler(), piece("p", 0, 2, half), piece("q", 0, 2, half))
}

// TestChunkBoundsStayWithinChunkSize: spans tile the payload in order with no
// gap or overlap, none exceeds chunkSize, and each is valid UTF-8.
func TestChunkBoundsStayWithinChunkSize(t *testing.T) {
	payload := []byte(strings.Repeat("héllo wörld — ", 4000))
	bounds := chunkBounds(payload)
	if len(bounds) < 2 {
		t.Fatalf("expected a split payload, got %d span(s)", len(bounds))
	}
	prevEnd := 0
	for i, b := range bounds {
		if b[0] != prevEnd || b[1] <= b[0] {
			t.Fatalf("span %d is [%d,%d), expected to start at %d and be non-empty", i, b[0], b[1], prevEnd)
		}
		if b[1]-b[0] > chunkSize {
			t.Errorf("span %d is %d bytes, over the %d limit", i, b[1]-b[0], chunkSize)
		}
		if !utf8.Valid(payload[b[0]:b[1]]) {
			t.Errorf("span %d is not valid UTF-8", i)
		}
		prevEnd = b[1]
	}
	if prevEnd != len(payload) {
		t.Errorf("spans cover %d bytes of a %d-byte payload", prevEnd, len(payload))
	}
}

// TestChunkBoundsAdvanceOnInvalidUTF8: a run of continuation bytes offers no
// boundary to back off to, and the split still advances rather than looping.
func TestChunkBoundsAdvanceOnInvalidUTF8(t *testing.T) {
	payload := make([]byte, chunkSize*2+5)
	for i := range payload {
		payload[i] = 0x80
	}
	total := 0
	for _, b := range chunkBounds(payload) {
		if b[1] <= b[0] {
			t.Fatal("produced an empty span")
		}
		total += b[1] - b[0]
	}
	if total != len(payload) {
		t.Errorf("spans cover %d bytes of a %d-byte payload", total, len(payload))
	}
}
