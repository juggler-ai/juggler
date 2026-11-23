//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"testing"
	"time"
)

// trimTestBlob is a blob as SaveBlob writes it, plus a key the trim has never
// heard of, which has to survive it.
func trimTestBlob(id string) string {
	return fmt.Sprintf(`{
  "id": %q,
  "input": {"systemPrompt": "sys", "messages": [{"role": "user", "content": "hi"}], "tools": [{"name": "read"}]},
  "output": {"blocks": [{"type": "text", "content": "Hi."}]},
  "inputTokens": 1200,
  "outputTokens": 34,
  "stopReason": "end_turn",
  "somethingNew": [1, 2, 3]
}`, id)
}

// The input of a long conversation's round-trips is what grows with the square
// of its length, so only the newest round-trips keep it — those, and whichever
// round-trip a keep set names however old it is. Every other blob loses its
// input and nothing else.
func TestTrimTransactionInputs(t *testing.T) {
	dir := t.TempDir()
	s := NewTransactionStore(func(string) (string, bool) { return dir, true })
	const conv = "conv-trim"

	total := txnInputKeepNewest + 5
	ids := make([]string, total)
	for i := range ids {
		// The worker's own id shape: millisecond stamp, then a sequence number.
		ids[i] = fmt.Sprintf("txn_%d_%09d", 1792078000000+int64(i)*1000, i)
		if err := s.Save(conv, ids[i], []byte(trimTestBlob(ids[i]))); err != nil {
			t.Fatalf("Save(%s): %v", ids[i], err)
		}
	}
	keptOld := ids[1] // a sub-thread's newest round-trip, long since passed by the root

	if err := s.TrimInputs(conv, map[string]bool{keptOld: true}, 0); err != nil {
		t.Fatalf("TrimInputs: %v", err)
	}

	for i, id := range ids {
		blob := loadBlobMap(t, s, conv, id)
		_, hasInput := blob["input"]
		wantInput := i >= total-txnInputKeepNewest || id == keptOld
		if hasInput != wantInput {
			t.Errorf("%s (#%d): input present = %v, want %v", id, i, hasInput, wantInput)
		}
		if blob["outputTokens"] != float64(34) || blob["stopReason"] != "end_turn" || blob["output"] == nil {
			t.Errorf("%s: metadata or output lost: %v", id, blob)
		}
		if !reflect.DeepEqual(blob["somethingNew"], []any{float64(1), float64(2), float64(3)}) {
			t.Errorf("%s: unknown key lost: %v", id, blob["somethingNew"])
		}
	}

	// Repeating it changes nothing.
	if err := s.TrimInputs(conv, map[string]bool{keptOld: true}, 0); err != nil {
		t.Fatalf("second TrimInputs: %v", err)
	}
	if _, ok := loadBlobMap(t, s, conv, keptOld)["input"]; !ok {
		t.Errorf("%s lost its input on a repeat trim", keptOld)
	}
}

// With an age limit set, a record older than it is deleted outright — unless
// the keep set names it, or its id carries no time to judge it by. Records
// inside the limit are left to the input trim alone.
func TestTrimTransactionRecordsByAge(t *testing.T) {
	dir := t.TempDir()
	s := NewTransactionStore(func(string) (string, bool) { return dir, true })
	const conv = "conv-age"

	now := time.Now()
	stamp := func(age time.Duration, seq int) string {
		return fmt.Sprintf("txn_%d_%09d", now.Add(-age).UnixMilli(), seq)
	}
	oldGone, oldKept, recent := stamp(10*24*time.Hour, 1), stamp(9*24*time.Hour, 2), stamp(time.Hour, 3)
	const legacy = "txn-legacy" // an id with no timestamp in it
	for _, id := range []string{oldGone, oldKept, recent, legacy} {
		if err := s.Save(conv, id, []byte(trimTestBlob(id))); err != nil {
			t.Fatalf("Save(%s): %v", id, err)
		}
	}

	if err := s.TrimInputs(conv, map[string]bool{oldKept: true}, 7*24*time.Hour); err != nil {
		t.Fatalf("TrimInputs: %v", err)
	}

	ids, err := s.List(conv)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(ids)
	want := []string{legacy, oldKept, recent}
	sort.Strings(want)
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("records left = %v, want %v", ids, want)
	}
}

// The keep set names each thread's newest round-trip — the one the tool-drift
// check reads the offered tools from — at the root and in every nested thread,
// counting only the items a round-trip produced, not the user message that
// opened it.
func TestCollectRefsLatestRoundTrips(t *testing.T) {
	nested, err := json.Marshal([]ConversationItem{
		{Type: ItemTypeAssistant, TransactionID: "sub-old"},
		{Type: ItemTypeToolAction, TransactionID: "sub-new"},
	})
	if err != nil {
		t.Fatal(err)
	}
	doc := NewConversationDocument("conv-trim-keep", "user:test")
	defer doc.Destroy()
	for _, it := range []ConversationItem{
		{Type: ItemTypeAssistant, ItemID: "a1", TransactionID: "root-old"},
		{Type: ItemTypeThread, ItemID: "t1", Items: nested},
		{Type: ItemTypeThinking, ItemID: "k1", TransactionID: "root-new"},
		{Type: "user", ItemID: "u1", TransactionID: "root-input-side"},
	} {
		doc.AppendMessage(it)
	}

	got := doc.collectRefs().latestTxns
	want := map[string]bool{"root-new": true, "sub-new": true}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
