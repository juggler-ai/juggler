//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// readSpill reads a spill file, failing the test if the path is empty or unreadable.
func readSpill(t *testing.T, path string) []byte {
	t.Helper()
	if path == "" {
		t.Fatalf("expected a spill-file path, got empty")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read spill file %s: %v", path, err)
	}
	return data
}

// TestSpill_UnderBudgetNoFile: output under budget writes no file and is byte-identical.
func TestSpill_UnderBudgetNoFile(t *testing.T) {
	dir := t.TempDir()
	sf := newSpillFile(dir, "exec-a")
	b := newCappedBuffer(outputHeadLimit, outputTailLimit).withSpill(dir, sf)

	msg := "small output\nsecond line\n"
	_, _ = b.Write([]byte(msg))

	if b.spilled() {
		t.Fatalf("spilled() true for under-budget output")
	}
	if got := b.String(); got != msg {
		t.Fatalf("under-budget output altered: got %q want %q", got, msg)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".log") {
			t.Fatalf("unexpected spill file written: %s", e.Name())
		}
	}
}

// TestSpill_MiddleRecoverableFromFile: the dropped middle is absent from the
// head+tail result but present in the complete on-disk spill file.
func TestSpill_MiddleRecoverableFromFile(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "conv1")
	sf := newSpillFile(sub, "exec-b")
	b := newCappedBuffer(outputHeadLimit, outputTailLimit).withSpill(dir, sf)

	const sentinel = "MIDDLE_SENTINEL_QZ"
	_, _ = b.Write(bytes.Repeat([]byte("H"), outputHeadLimit)) // fills head
	_, _ = b.Write([]byte(sentinel))                           // lands in the dropped middle
	_, _ = b.Write(bytes.Repeat([]byte("M"), 200*1024))
	_, _ = b.Write(bytes.Repeat([]byte("T"), outputTailLimit)) // tail

	s := b.String()
	if strings.Contains(s, sentinel) {
		t.Fatalf("sentinel should be dropped from the head+tail result")
	}
	if !strings.Contains(s, "truncated") {
		t.Fatalf("truncation marker missing: %.80q", s)
	}
	data := readSpill(t, b.spillPath())
	if !bytes.Contains(data, []byte(sentinel)) {
		t.Fatalf("sentinel not recoverable from spill file")
	}
}

// TestSpill_ByteExactThroughForward: the complete stream captured through the
// UTF-8-splitting forward path equals the concatenated input byte-for-byte.
func TestSpill_ByteExactThroughForward(t *testing.T) {
	dir := t.TempDir()
	sf := newSpillFile(dir, "exec-c")
	var sink strings.Builder
	f := newCappedForwarder(outputHeadLimit, outputTailLimit,
		func(s string) { sink.WriteString(s) }).withSpill(dir, sf)

	// 60000 copies of the 3-byte rune 世 = 180000 bytes: past spillThreshold and
	// across many 4096-byte read boundaries, so runes straddle them.
	input := strings.Repeat("世", 60000)
	f.drain(strings.NewReader(input), nil)
	_ = f.suffix() // flushes and closes the spill

	data := readSpill(t, f.spillPath())
	if string(data) != input {
		t.Fatalf("on-disk bytes != input: got %d bytes, want %d", len(data), len(input))
	}
}

// TestSpill_FileLimitOverflow: the spill file is bounded at spillFileLimit, and
// the overflow is reported both structurally and in the marker.
func TestSpill_FileLimitOverflow(t *testing.T) {
	dir := t.TempDir()
	sf := newSpillFile(dir, "exec-d")
	b := newCappedBuffer(outputHeadLimit, outputTailLimit).withSpill(dir, sf)

	chunk := bytes.Repeat([]byte("x"), 1<<20) // 1 MiB
	for i := 0; i < 65; i++ {                 // 65 MiB total, past the 64 MiB cap
		_, _ = b.Write(chunk)
	}
	s := b.String()

	info, err := os.Stat(b.spillPath())
	if err != nil {
		t.Fatalf("stat spill file: %v", err)
	}
	if info.Size() != spillFileLimit {
		t.Fatalf("spill file size = %d, want %d", info.Size(), int64(spillFileLimit))
	}
	if !b.spillTrunc {
		t.Fatalf("expected spillTrunc true after overflow")
	}
	if !strings.Contains(s, "not saved") {
		t.Fatalf("marker missing the file-truncation notice: %.200q", s)
	}
}

// TestSpill_MarkerHasRelativePath: the marker and the trailer both carry the
// spill path rendered relative to the project root.
func TestSpill_MarkerHasRelativePath(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "bash-output", "conv9")
	sf := newSpillFile(sub, "bg-123")
	b := newCappedBuffer(outputHeadLimit, outputTailLimit).withSpill(dir, sf)

	_, _ = b.Write(bytes.Repeat([]byte("a"), 200*1024)) // past threshold
	s := b.String()

	rel := filepath.Join("bash-output", "conv9", "bg-123.log")
	if !strings.Contains(s, rel) {
		t.Fatalf("marker missing relative path %q: %.200q", rel, s)
	}
	if !strings.Contains(s, "[full output: "+rel+"]") {
		t.Fatalf("trailer missing relative path: %.200q", s)
	}
}

// TestSpill_CreateFailureDegrades: when the spill file can't be created the
// command still succeeds and degrades to the plain head+tail+marker output.
func TestSpill_CreateFailureDegrades(t *testing.T) {
	dir := t.TempDir()
	// A regular file where the spill dir should be, so MkdirAll/Create fails.
	blocker := filepath.Join(dir, "blocked")
	if err := os.WriteFile(blocker, []byte("x"), 0644); err != nil {
		t.Fatalf("write blocker: %v", err)
	}
	sf := newSpillFile(blocker, "exec-f")
	b := newCappedBuffer(outputHeadLimit, outputTailLimit).withSpill(dir, sf)

	_, _ = b.Write(bytes.Repeat([]byte("a"), 200*1024)) // crosses threshold → open fails
	s := b.String()

	if b.spilled() {
		t.Fatalf("spilled() should be false after a create failure")
	}
	if !strings.Contains(s, "truncated") {
		t.Fatalf("degraded output must still carry a marker: %.80q", s)
	}
	if strings.Contains(s, "FULL output saved") {
		t.Fatalf("degraded marker must be the plain form, got: %.200q", s)
	}
}

// TestSpill_BandNoMarkerNoFile: output in the (headLimit, spillThreshold] band
// carries no marker, writes no file, and reconstructs byte-exactly.
func TestSpill_BandNoMarkerNoFile(t *testing.T) {
	dir := t.TempDir()
	sf := newSpillFile(dir, "exec-g")
	b := newCappedBuffer(outputHeadLimit, outputTailLimit).withSpill(dir, sf)

	input := bytes.Repeat([]byte("b"), 40*1024) // between 32 KiB and 96 KiB
	_, _ = b.Write(input)
	s := b.String()

	if strings.Contains(s, "truncated") {
		t.Fatalf("band output must not carry a marker: %.60q", s)
	}
	if b.spilled() {
		t.Fatalf("band output must not spill to disk")
	}
	if s != string(input) {
		t.Fatalf("band output not reconstructed byte-exact: got %d, want %d", len(s), len(input))
	}
}

// TestExecuteStreaming_BoundsLargeOutput guards the fix for the server-lock-up /
// performance bug: a command that pumps out far more than the head+tail budget
// must not stream its full output. We assert the streamed total is bounded, the
// head and tail both survive, and a truncation marker is present.
func TestExecuteStreaming_BoundsLargeOutput(t *testing.T) {
	requirePOSIXShell(t)

	root := t.TempDir()
	shellOps := NewShellOperations(NewPathScope(root, nil))
	out := make(chan ShellStreamChunk, 1024)

	var b strings.Builder
	var done ShellStreamChunk
	doneCollecting := make(chan struct{})
	go func() {
		for c := range out {
			b.WriteString(c.Data)
			if c.Done {
				done = c
			}
		}
		close(doneCollecting)
	}()

	// `seq` emits megabytes across millions of lines — well past the 96 KiB
	// head+tail budget. A mid-stream sentinel lands in the dropped middle (so it
	// must be recoverable only from the spill file) and a tail sentinel marks the
	// end of the stream (so we can assert the tail survived). We avoid asserting
	// on seq's own values: BSD seq switches to scientific notation for large
	// numbers.
	const midSentinel = "MIDDLE_SENTINEL_XYZ"
	const tailSentinel = "END_SENTINEL_XYZ"
	const convID = "conv-bounds"
	command := "seq 1 1000000; echo " + midSentinel + "; seq 1000001 2000000; echo " + tailSentinel
	shellOps.ExecuteStreaming(context.Background(), "shell-test", convID, command, "", 60000, out)
	<-doneCollecting

	s := b.String()

	// 1. Bounded: head + tail + a small margin for the marker/trailer.
	limit := outputHeadLimit + outputTailLimit + 4096
	if len(s) > limit {
		t.Fatalf("streamed output not bounded: got %d bytes, want <= %d", len(s), limit)
	}

	// 2. Head survived (output starts at the beginning of the stream).
	if !strings.HasPrefix(s, "1\n2\n3\n") {
		t.Fatalf("head missing: output does not start with the first lines, got %.40q", s)
	}

	// 3. Tail survived (the end of the stream reached the client via the final chunk).
	if !strings.Contains(s, tailSentinel) {
		t.Fatalf("tail missing: sentinel %q not present in streamed output", tailSentinel)
	}

	// 4. Truncation was announced.
	if !strings.Contains(s, "truncated") {
		t.Fatalf("truncation marker missing from streamed output")
	}

	// 5. The mid-stream sentinel was dropped from the streamed head/tail.
	if strings.Contains(s, midSentinel) {
		t.Fatalf("mid-stream sentinel should be dropped from the streamed head/tail")
	}

	// 6. The done chunk carried the spill accounting.
	if done.OutputFile == "" || !done.Truncated {
		t.Fatalf("done chunk missing spill accounting: %+v", done)
	}
	if done.OutputBytes <= int64(len(s)) {
		t.Fatalf("outputBytes %d should exceed the capped stream length %d", done.OutputBytes, len(s))
	}

	// 7. The spill file lives under .juggler/bash-output/<conv>/ and holds the
	// dropped middle.
	wantPrefix := filepath.Join(root, ".juggler", "bash-output", convID) + string(filepath.Separator)
	if !strings.HasPrefix(done.OutputFile, wantPrefix) {
		t.Fatalf("spill file %q not under %q", done.OutputFile, wantPrefix)
	}
	data, err := os.ReadFile(done.OutputFile)
	if err != nil {
		t.Fatalf("read spill file: %v", err)
	}
	if !strings.Contains(string(data), midSentinel) {
		t.Fatalf("dropped mid-stream sentinel not recoverable from spill file")
	}
}

// TestSpillFileReadableInScope guards the §4 containment requirement: a spill
// file under the project's .juggler/ resolves for an LLM-driven read
// (userInitiated=false, approved=false) with no approval error, so the model can
// read the dropped output back without a permission prompt.
func TestSpillFileReadableInScope(t *testing.T) {
	root := t.TempDir()
	spillDir := spillDirFor(root, "conv-read")
	if err := os.MkdirAll(spillDir, 0o755); err != nil {
		t.Fatalf("mkdir spill dir: %v", err)
	}
	spillPath := filepath.Join(spillDir, "bg-1.log")
	if err := os.WriteFile(spillPath, []byte("recoverable output"), 0o644); err != nil {
		t.Fatalf("write spill file: %v", err)
	}

	scope := NewPathScope(root, nil)
	resolved, err := scope.ResolveRead(spillPath, false, false)
	if err != nil {
		t.Fatalf("spill file not readable in scope: %v", err)
	}
	if resolved == "" {
		t.Fatalf("ResolveRead returned an empty path")
	}
}

// TestExecuteStreaming_SmallOutputNotTruncated verifies the common case is
// untouched: output under budget streams verbatim with no marker.
func TestExecuteStreaming_SmallOutputNotTruncated(t *testing.T) {
	requirePOSIXShell(t)

	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	out := make(chan ShellStreamChunk, 64)

	var b strings.Builder
	doneCollecting := make(chan struct{})
	go func() {
		for c := range out {
			b.WriteString(c.Data)
		}
		close(doneCollecting)
	}()

	shellOps.ExecuteStreaming(context.Background(), "shell-test", "", "printf 'hello world\\n'", "", 30000, out)
	<-doneCollecting

	s := b.String()
	if strings.TrimSpace(s) != "hello world" {
		t.Fatalf("small output altered: got %q", s)
	}
	if strings.Contains(s, "truncated") {
		t.Fatalf("small output should not be truncated, got %q", s)
	}
}

// TestCappedBuffer_HeadAndTail unit-tests the buffered-path cap directly.
func TestCappedBuffer_HeadAndTail(t *testing.T) {
	b := newCappedBuffer(8, 8)
	// Write 30 bytes: "AAAAAAAA...BBBB...". Head should keep first 8, tail last 8.
	for i := 0; i < 30; i++ {
		_, _ = b.Write([]byte{byte('a' + i%26)})
	}
	got := b.String()
	if !strings.HasPrefix(got, "abcdefgh") {
		t.Fatalf("head wrong: %q", got)
	}
	if !strings.Contains(got, "truncated") {
		t.Fatalf("marker missing: %q", got)
	}
	// Last 8 of 30 chars cycling a..z: indices 22..29 -> w,x,y,z,a,b,c,d
	if !strings.HasSuffix(got, "wxyzabcd") {
		t.Fatalf("tail wrong: %q", got)
	}
}

// TestUTF8SafeChunk_SplitRune verifies a multi-byte rune split across two reads
// is emitted whole: the leading bytes are held back as carry, then completed by
// the next read — never forwarded as two invalid halves.
func TestUTF8SafeChunk_SplitRune(t *testing.T) {
	full := []byte("ab世cd") // 世 = E4 B8 96

	// First read ends one byte into 世 (…a b E4). The E4 must be carried.
	emit1, carry1 := utf8SafeChunk(nil, full[:3], false)
	if string(emit1) != "ab" {
		t.Fatalf("emit1 = %q, want \"ab\"", emit1)
	}
	if len(carry1) != 1 || carry1[0] != 0xE4 {
		t.Fatalf("carry1 = % x, want e4", carry1)
	}

	// Second read supplies the rest (B8 96 c d); the carried E4 completes 世.
	emit2, carry2 := utf8SafeChunk(carry1, full[3:], false)
	if string(emit2) != "世cd" {
		t.Fatalf("emit2 = %q, want \"世cd\"", emit2)
	}
	if len(carry2) != 0 {
		t.Fatalf("carry2 = % x, want empty", carry2)
	}

	if got := string(emit1) + string(emit2); got != string(full) {
		t.Fatalf("reassembled = %q, want %q", got, string(full))
	}
}

// TestUTF8SafeChunk_FlushAtEOF verifies a genuinely-truncated trailing partial
// rune is emitted (not swallowed) once the stream has ended.
func TestUTF8SafeChunk_FlushAtEOF(t *testing.T) {
	in := []byte{'x', 0xE4} // trailing lone start byte of a 3-byte rune
	emit, carry := utf8SafeChunk(nil, in, true)
	if len(carry) != 0 {
		t.Fatalf("carry = % x, want empty at EOF", carry)
	}
	if string(emit) != string(in) {
		t.Fatalf("emit = % x, want % x", emit, in)
	}
}

// TestExecuteStreaming_NoRuneSplitCorruption is the end-to-end regression guard:
// a stream of multi-byte runes long enough to cross many 4096-byte read
// boundaries must arrive intact, with no U+FFFD replacement characters.
func TestExecuteStreaming_NoRuneSplitCorruption(t *testing.T) {
	requirePOSIXShell(t)

	shellOps := NewShellOperations(NewPathScope(t.TempDir(), nil))
	out := make(chan ShellStreamChunk, 4096)

	var b strings.Builder
	doneCollecting := make(chan struct{})
	go func() {
		for c := range out {
			b.WriteString(c.Data)
		}
		close(doneCollecting)
	}()

	// 20000 copies of the 3-byte rune 世 = 60000 bytes: well under the head
	// budget (so nothing is truncated) but far past many 4096-byte read
	// boundaries, and 60000 % 4096 != 0 so runes straddle those boundaries.
	const n = 20000
	shellOps.ExecuteStreaming(context.Background(), "shell-test", "",
		"printf '世%.0s' $(seq 1 20000)", "", 30000, out)
	<-doneCollecting

	got := b.String()
	if strings.ContainsRune(got, '\uFFFD') {
		t.Fatalf("output contains U+FFFD — a rune was split across a read boundary")
	}
	if want := strings.Repeat("世", n); got != want {
		t.Fatalf("output mismatch: got %d bytes, want %d", len(got), len(want))
	}
}
