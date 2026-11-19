//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// unguarded is a sweep guard with nothing to wait for.
func unguarded() (release func()) { return func() {} }

// A transaction blob as written by the worker: the round-trip's input (system
// prompt, the whole message history replayed that turn, and the tool schemas)
// plus the far smaller record of what came back and what it cost.
//
// The input is the part that scales with the square of a conversation's length
// — turn N carries turns 1..N-1 — and the part already held, once, in doc.yjs.
const sampleTxnBlob = `{
  "id": "txn_1",
  "timestamp": 1788873515499,
  "duration": 4210,
  "modelConfig": {"model": "claude-sonnet-4-5", "provider": "anthropic"},
  "input": {
    "systemPrompt": "You are a helpful assistant.",
    "messages": [{"role": "user", "content": "hello"}],
    "tools": [{"name": "read", "description": "Reads a file"}],
    "toolChoice": "auto"
  },
  "output": {"blocks": [{"type": "text", "content": "Hi."}]},
  "inputTokens": 1200,
  "outputTokens": 34,
  "cachedTokens": 900,
  "cacheWriteTokens": 300,
  "stopReason": "end_turn"
}`

// writeTxnBlobs creates <convDir>/txns/ and fills it with named blobs.
func writeTxnBlobs(t *testing.T, convDir string, blobs map[string]string) string {
	t.Helper()
	txnsDir := ConvTxnsDir(convDir)
	if err := os.MkdirAll(txnsDir, 0o755); err != nil {
		t.Fatalf("mkdir txns dir: %v", err)
	}
	for name, body := range blobs {
		if err := os.WriteFile(filepath.Join(txnsDir, name), []byte(body), 0o644); err != nil {
			t.Fatalf("write blob %s: %v", name, err)
		}
	}
	return txnsDir
}

// readBlob parses one blob back into a map.
func readBlob(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read blob %s: %v", path, err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse blob %s: %v", path, err)
	}
	return m
}

// Stripping drops the replayed input and leaves every other key exactly as it
// was — the metadata the transaction panel renders (time, duration, tokens,
// stop reason, model) and the model's own output, which together are ~0.3% of
// the bytes.
func TestStripConvTxnInputsRemovesOnlyInput(t *testing.T) {
	convDir := t.TempDir()
	txnsDir := writeTxnBlobs(t, convDir, map[string]string{"txn_1.json": sampleTxnBlob})
	blobPath := filepath.Join(txnsDir, "txn_1.json")

	before := readBlob(t, blobPath)

	stripConvTxnInputs(convDir)

	after := readBlob(t, blobPath)

	if _, present := after["input"]; present {
		t.Fatalf("expected input to be stripped, got %v", after["input"])
	}

	delete(before, "input")
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("expected every other key untouched\n before: %v\n  after: %v", before, after)
	}
}

// The strip is idempotent: a blob with no input is left byte-for-byte alone, so
// re-running it over a bin that has already been stripped rewrites nothing.
func TestStripConvTxnInputsIsIdempotent(t *testing.T) {
	convDir := t.TempDir()
	txnsDir := writeTxnBlobs(t, convDir, map[string]string{"txn_1.json": sampleTxnBlob})
	blobPath := filepath.Join(txnsDir, "txn_1.json")

	stripConvTxnInputs(convDir)
	first, err := os.ReadFile(blobPath)
	if err != nil {
		t.Fatalf("read after first strip: %v", err)
	}

	stripConvTxnInputs(convDir)
	second, err := os.ReadFile(blobPath)
	if err != nil {
		t.Fatalf("read after second strip: %v", err)
	}

	if string(first) != string(second) {
		t.Fatalf("expected the second strip to be a no-op\n first: %s\nsecond: %s", first, second)
	}
}

// Unknown keys survive. The blob's shape is the worker's to change, and a strip
// that silently dropped a key it had not heard of would lose data every time
// the writer gained a field.
func TestStripConvTxnInputsPreservesUnknownKeys(t *testing.T) {
	convDir := t.TempDir()
	txnsDir := writeTxnBlobs(t, convDir, map[string]string{
		"txn_1.json": `{"input": {"messages": []}, "somethingNew": {"nested": [1, 2, 3]}}`,
	})

	stripConvTxnInputs(convDir)

	after := readBlob(t, filepath.Join(txnsDir, "txn_1.json"))
	if _, present := after["input"]; present {
		t.Fatal("expected input to be stripped")
	}
	want := map[string]any{"nested": []any{1.0, 2.0, 3.0}}
	if !reflect.DeepEqual(after["somethingNew"], want) {
		t.Fatalf("expected unknown key preserved, got %v", after["somethingNew"])
	}
}

// Best-effort: a blob that cannot be parsed is left alone rather than deleted or
// truncated, and its neighbours are still stripped.
func TestStripConvTxnInputsSkipsUnparseableBlobs(t *testing.T) {
	convDir := t.TempDir()
	const garbage = "{not json"
	txnsDir := writeTxnBlobs(t, convDir, map[string]string{
		"txn_bad.json":  garbage,
		"txn_good.json": sampleTxnBlob,
	})

	stripConvTxnInputs(convDir)

	bad, err := os.ReadFile(filepath.Join(txnsDir, "txn_bad.json"))
	if err != nil {
		t.Fatalf("read unparseable blob: %v", err)
	}
	if string(bad) != garbage {
		t.Fatalf("expected the unparseable blob untouched, got %s", bad)
	}

	good := readBlob(t, filepath.Join(txnsDir, "txn_good.json"))
	if _, present := good["input"]; present {
		t.Fatal("expected the neighbouring blob to still be stripped")
	}
}

// Non-blob entries are not the strip's business. Only *.json is rewritten, so a
// leftover .tmp from an interrupted atomic write is not resurrected as a blob.
func TestStripConvTxnInputsIgnoresNonJSONEntries(t *testing.T) {
	convDir := t.TempDir()
	const tmpBody = `{"input": {"messages": []}}`
	txnsDir := writeTxnBlobs(t, convDir, map[string]string{"txn_1.json.tmp": tmpBody})

	stripConvTxnInputs(convDir)

	got, err := os.ReadFile(filepath.Join(txnsDir, "txn_1.json.tmp"))
	if err != nil {
		t.Fatalf("read tmp file: %v", err)
	}
	if string(got) != tmpBody {
		t.Fatalf("expected the .tmp entry untouched, got %s", got)
	}
}

// A conversation that never reached the model has no txns/ at all. That is the
// common case for the bin, and it must not be an error.
func TestStripConvTxnInputsToleratesMissingDir(t *testing.T) {
	convDir := t.TempDir()
	stripConvTxnInputs(convDir) // must not panic
	if _, err := os.Stat(ConvTxnsDir(convDir)); !os.IsNotExist(err) {
		t.Fatalf("expected no txns dir to be created, stat err = %v", err)
	}
}

// Binning strips the conversation's transaction inputs, on the same reasoning
// that already removes its spill files: the replayed history is recoverable
// context, not conversation state, and doc.yjs holds every byte of it.
func TestBinConversationStripsTxnInputs(t *testing.T) {
	store, dir := newStoreForTest(t)

	id, _, _, err := store.CreateConversationFolder("Alpha", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	convDir, ok := store.ConvDir(id)
	if !ok {
		t.Fatalf("no conv dir for %s", id)
	}
	writeTxnBlobs(t, convDir, map[string]string{"txn_1.json": sampleTxnBlob})

	if err := store.BinConversation(id); err != nil {
		t.Fatalf("BinConversation: %v", err)
	}

	blob := readBlob(t, filepath.Join(ConvTxnsDir(binnedDirFor(t, dir, id)), "txn_1.json"))
	if _, present := blob["input"]; present {
		t.Fatal("expected the binned conversation's txn input to be stripped")
	}
	// What the transaction panel still renders survives the strip.
	for _, key := range []string{"output", "inputTokens", "outputTokens", "stopReason", "modelConfig", "duration", "timestamp"} {
		if _, present := blob[key]; !present {
			t.Errorf("expected %q to survive binning", key)
		}
	}
}

// The backlog: conversations already sitting in the bin, put there before
// binning stripped anything, or by a strip that a crash cut short. The sweep is
// what reclaims them, and it has to find them without consulting the in-memory
// bin index — it runs off the actor goroutine.
func TestSweepBinTxnInputsStripsAlreadyBinnedConversations(t *testing.T) {
	store, dir := newStoreForTest(t)

	id, _, _, err := store.CreateConversationFolder("Alpha", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	convDir, ok := store.ConvDir(id)
	if !ok {
		t.Fatalf("no conv dir for %s", id)
	}
	writeTxnBlobs(t, convDir, map[string]string{"txn_1.json": sampleTxnBlob})

	// binConversationDeferred is the bin without the strip — exactly the state an
	// older build left behind.
	if _, err := store.binConversationDeferred(id); err != nil {
		t.Fatalf("binConversationDeferred: %v", err)
	}
	blobPath := filepath.Join(ConvTxnsDir(binnedDirFor(t, dir, id)), "txn_1.json")
	if _, present := readBlob(t, blobPath)["input"]; !present {
		t.Fatal("precondition: the deferred bin should leave the input in place")
	}

	store.sweepBinTxnInputs(unguarded)

	if _, present := readBlob(t, blobPath)["input"]; present {
		t.Fatal("expected the sweep to strip a conversation already in the bin")
	}
	if _, present := readBlob(t, blobPath)["output"]; !present {
		t.Fatal("expected the sweep to leave the output alone")
	}
}

// An empty or absent bin is the common case and must not be an error.
func TestSweepBinTxnInputsToleratesNoBin(t *testing.T) {
	store, _ := newStoreForTest(t)
	store.sweepBinTxnInputs(unguarded) // must not panic
}

// The transcript is untouched by the strip, and a restored conversation comes
// back whole — that is the line between recoverable context and conversation
// state.
func TestBinAndRestorePreservesDoc(t *testing.T) {
	store, dir := newStoreForTest(t)

	id, _, _, err := store.CreateConversationFolder("Alpha", "")
	if err != nil {
		t.Fatalf("CreateConversationFolder: %v", err)
	}
	convDir, ok := store.ConvDir(id)
	if !ok {
		t.Fatalf("no conv dir for %s", id)
	}
	doc := []byte("yjs-document-bytes")
	if err := store.SaveConversationBinary(id, doc); err != nil {
		t.Fatalf("SaveConversationBinary: %v", err)
	}
	writeTxnBlobs(t, convDir, map[string]string{"txn_1.json": sampleTxnBlob})

	if err := store.BinConversation(id); err != nil {
		t.Fatalf("BinConversation: %v", err)
	}
	binned, err := os.ReadFile(ConvDocPath(binnedDirFor(t, dir, id)))
	if err != nil {
		t.Fatalf("read binned doc: %v", err)
	}
	if string(binned) != string(doc) {
		t.Fatalf("expected doc.yjs untouched by the strip, got %q", binned)
	}

	if err := store.RestoreConversation(id); err != nil {
		t.Fatalf("RestoreConversation: %v", err)
	}
	restoredDir, ok := store.ConvDir(id)
	if !ok {
		t.Fatalf("expected %s back in the active index after restore", id)
	}
	restored, err := os.ReadFile(ConvDocPath(restoredDir))
	if err != nil {
		t.Fatalf("read restored doc: %v", err)
	}
	if string(restored) != string(doc) {
		t.Fatalf("expected the restored doc.yjs intact, got %q", restored)
	}
}
