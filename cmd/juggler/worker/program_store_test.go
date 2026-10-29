//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/atomicio"

	ycrdt "github.com/skyterra/y-crdt"
)

func testProgramStore(t *testing.T) (*ProgramStore, string) {
	t.Helper()
	dir := t.TempDir()
	return NewProgramStore(func(string) (string, bool) { return dir, true }), dir
}

// TestProgramStore_RoundTrip pins that a saved snapshot reads back byte for
// byte, is replaced by a later save, and is gone once deleted — and that
// deleting one that is not there is not an error.
func TestProgramStore_RoundTrip(t *testing.T) {
	store, _ := testProgramStore(t)
	if _, err := store.Get("conv", "toolu_01"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Get before any save: err=%v, want os.ErrNotExist", err)
	}
	for _, body := range []string{`{"journal":[1]}`, `{"journal":[1,2]}`} {
		if err := store.Save("conv", "toolu_01", []byte(body)); err != nil {
			t.Fatalf("Save: %v", err)
		}
		got, err := store.Get("conv", "toolu_01")
		if err != nil || string(got) != body {
			t.Fatalf("Get = %q, %v; want %q", got, err, body)
		}
	}
	if err := store.Delete("conv", "toolu_01"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := store.Get("conv", "toolu_01"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Get after Delete: err=%v, want os.ErrNotExist", err)
	}
	if err := store.Delete("conv", "toolu_01"); err != nil {
		t.Fatalf("Delete of a missing snapshot must be a no-op, got %v", err)
	}
}

// TestProgramStore_RefusesKeysThatAreNotNames pins the path guard: the tool-use
// id becomes a file name, so one that could name anything else — another
// directory, a parent, nothing — is refused before any path is built.
func TestProgramStore_RefusesKeysThatAreNotNames(t *testing.T) {
	store, dir := testProgramStore(t)
	for _, id := range []string{"", ".", "..", "../escape", "a/b", `a\b`, "x\x00y", strings.Repeat("a", 201)} {
		if err := store.Save("conv", id, []byte("{}")); !errors.Is(err, ErrBadProgramKey) {
			t.Errorf("Save(%q): err=%v, want ErrBadProgramKey", id, err)
		}
		if _, err := store.Get("conv", id); !errors.Is(err, ErrBadProgramKey) {
			t.Errorf("Get(%q): err=%v, want ErrBadProgramKey", id, err)
		}
	}
	// A refused id is refused before the programs directory is even made, so
	// the conversation folder is still empty — nothing written in it or, via
	// a "..", beside it.
	if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
		t.Errorf("a refused save must write nothing: entries=%v err=%v", entries, err)
	}
	for _, id := range []string{"toolu_01ABC", "call_1", "rc12_1791799526314", "code_x-y.z"} {
		if err := store.Save("conv", id, []byte("{}")); err != nil {
			t.Errorf("Save(%q): %v", id, err)
		}
	}
}

// TestProgramStore_RefusesWhatIsTooBig pins the cap: a snapshot past it is
// refused and nothing is left on disk, so a program that holds that much
// fails on a restart as it would with no snapshot at all.
func TestProgramStore_RefusesWhatIsTooBig(t *testing.T) {
	store, _ := testProgramStore(t)
	big := make([]byte, MaxProgramSnapshotBytes+1)
	if err := store.Save("conv", "toolu_big", big); !errors.Is(err, ErrProgramTooLarge) {
		t.Fatalf("Save past the cap: err=%v, want ErrProgramTooLarge", err)
	}
	if _, err := store.Get("conv", "toolu_big"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("nothing may be stored past the cap: err=%v", err)
	}
}

// TestSweepPrograms_KeepsOnlyUnsettledItems pins the GC rule: a snapshot is
// kept while its tool-action is unsettled — at root or in a thread — and
// dropped once it has settled or is gone from the document.
func TestSweepPrograms_KeepsOnlyUnsettledItems(t *testing.T) {
	w := NewConversationWorker("conv-programs", "user:test")
	store, _ := testProgramStore(t)
	w.programStore = store

	w.doc.AppendMessage(ConversationItem{Type: ItemTypeToolAction, ItemID: "a1", ToolUseID: "call_pending", State: StatePending})
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeToolAction, ItemID: "a2", ToolUseID: "call_done", State: StateCompleted})
	nested, _ := json.Marshal([]map[string]any{
		{"type": ItemTypeToolAction, "itemId": "a3", "toolUseId": "call_thread_running", "state": StateRunning},
		{"type": ItemTypeToolAction, "itemId": "a4", "toolUseId": "call_thread_denied", "state": StateCancelled},
	})
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeThread, ItemID: "t1", Items: nested})

	for _, id := range []string{"call_pending", "call_done", "call_thread_running", "call_thread_denied", "call_gone"} {
		if err := store.Save(w.conversationID, id, []byte("{}")); err != nil {
			t.Fatalf("Save(%s): %v", id, err)
		}
	}
	if err := w.sweepPrograms(); err != nil {
		t.Fatalf("sweepPrograms: %v", err)
	}
	left, err := store.List(w.conversationID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	sort.Strings(left)
	if want := []string{"call_pending", "call_thread_running"}; strings.Join(left, ",") != strings.Join(want, ",") {
		t.Fatalf("after the sweep: %v, want %v", left, want)
	}
}

// TestProgramStore_UnknownConversation pins that a conversation the path
// provider does not know is reported as ErrUnknownConversation, which the HTTP
// layer answers with a 404 rather than a server error.
func TestProgramStore_UnknownConversation(t *testing.T) {
	store := NewProgramStore(func(string) (string, bool) { return "", false })
	if err := store.Save("gone", "toolu_01", []byte("{}")); !errors.Is(err, ErrUnknownConversation) {
		t.Errorf("Save: err=%v, want ErrUnknownConversation", err)
	}
	if _, err := store.Get("gone", "toolu_01"); !errors.Is(err, ErrUnknownConversation) {
		t.Errorf("Get: err=%v, want ErrUnknownConversation", err)
	}
	if err := store.Delete("gone", "toolu_01"); !errors.Is(err, ErrUnknownConversation) {
		t.Errorf("Delete: err=%v, want ErrUnknownConversation", err)
	}
}

// TestProgramStore_FailedWritePublishesNothing pins the atomic write from the
// failing side: a save that cannot write returns its error and leaves no
// snapshot behind for a later Get to mistake for one.
func TestProgramStore_FailedWritePublishesNothing(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a read-only directory does not refuse new files on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root writes through a read-only directory")
	}
	store, dir := testProgramStore(t)
	programs := core.ConvProgramsDir(dir)
	if err := os.MkdirAll(programs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(programs, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(programs, 0o755) })

	if err := store.Save("conv", "toolu_01", []byte(`{"journal":[]}`)); err == nil {
		t.Fatal("Save into a read-only programs dir: want an error, got nil")
	}
	if _, err := store.Get("conv", "toolu_01"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a failed save must publish nothing: Get err=%v", err)
	}
	if entries, _ := os.ReadDir(programs); len(entries) != 0 {
		t.Fatalf("a failed save must leave nothing in the programs dir: %v", entries)
	}
}

// TestProgramStore_SweepRemovesStaleTemps pins that a temp file left by a
// crash or a failed write is swept once it is past the grace — List never
// reports one, so nothing else would — while one younger than the grace, a
// write that may still be in progress, is left alone.
func TestProgramStore_SweepRemovesStaleTemps(t *testing.T) {
	store, dir := testProgramStore(t)
	if err := store.Save("conv", "toolu_live", []byte("{}")); err != nil {
		t.Fatal(err)
	}
	programs := core.ConvProgramsDir(dir)
	stale := filepath.Join(programs, "toolu_crashed.json.tmp")
	fresh := filepath.Join(programs, "toolu_writing.json.tmp")
	for _, p := range []string{stale, fresh} {
		if err := os.WriteFile(p, []byte("{"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * programTmpGrace)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}

	if err := store.Sweep("conv", map[string]bool{"toolu_live": true}); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a temp file past the grace must be swept: stat err=%v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("a temp file within the grace must be kept: %v", err)
	}
	if _, err := store.Get("conv", "toolu_live"); err != nil {
		t.Errorf("a live snapshot must be kept: %v", err)
	}
}

// TestProgramStore_SweepOutlastsOneFailedDelete pins that a snapshot the sweep
// cannot remove — on Windows, one a reader holds open at that moment — costs
// only itself: every other settled program's snapshot is still removed, and
// the failure is reported. The sweep rides the next document save, so a
// snapshot it gave up on early would stay until something else changed.
func TestProgramStore_SweepOutlastsOneFailedDelete(t *testing.T) {
	store, _ := testProgramStore(t)
	for _, id := range []string{"toolu_a", "toolu_b", "toolu_live"} {
		if err := store.Save("conv", id, []byte("{}")); err != nil {
			t.Fatal(err)
		}
	}
	held := errors.New("held open")
	store.remove = func(path string) error {
		if filepath.Base(path) == "toolu_a"+programExt {
			return held
		}
		return atomicio.RobustRemoveAll(path)
	}

	if err := store.Sweep("conv", map[string]bool{"toolu_live": true}); !errors.Is(err, held) {
		t.Fatalf("Sweep must report the snapshot it could not remove: err=%v", err)
	}
	if _, err := store.Get("conv", "toolu_b"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a settled snapshot listed after the one that failed must still be swept: Get err=%v", err)
	}
	if _, err := store.Get("conv", "toolu_live"); err != nil {
		t.Errorf("a live snapshot must be kept: %v", err)
	}
}

// TestSweepPrograms_UnreadableThreadKeepsAll pins the escape: a thread whose
// items cannot be read may hold an unsettled program, so the sweep deletes
// nothing rather than drop a snapshot a pending program still needs.
func TestSweepPrograms_UnreadableThreadKeepsAll(t *testing.T) {
	w := NewConversationWorker("conv-programs-keepall", "user:test")
	store, _ := testProgramStore(t)
	w.programStore = store

	w.doc.AppendMessage(ConversationItem{Type: ItemTypeToolAction, ItemID: "a1", ToolUseID: "call_done", State: StateCompleted})
	// A thread whose items value is not an array — written as one would be by a
	// viewer that got it wrong; the document API itself only writes arrays.
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		m := conversationItemToYMap(ConversationItem{Type: ItemTypeThread, ItemID: "t1"})
		m.Set("items", "not an array")
		w.doc.ensureItems().Push(ycrdt.ArrayAny{m})
	}, w.doc.authorID)
	if !collectUnsettledToolUseIDs(w.doc.GetItems(), map[string]bool{}) {
		t.Fatal("fixture: the thread's items must read back unreadable")
	}

	for _, id := range []string{"call_done", "call_in_unreadable_thread"} {
		if err := store.Save(w.conversationID, id, []byte("{}")); err != nil {
			t.Fatalf("Save(%s): %v", id, err)
		}
	}
	if err := w.sweepPrograms(); err != nil {
		t.Fatalf("sweepPrograms: %v", err)
	}
	left, err := store.List(w.conversationID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	sort.Strings(left)
	if want := []string{"call_done", "call_in_unreadable_thread"}; strings.Join(left, ",") != strings.Join(want, ",") {
		t.Fatalf("after the sweep: %v, want %v — nothing may be swept past an unreadable thread", left, want)
	}
}
