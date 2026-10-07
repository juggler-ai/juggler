//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/core"
)

// forkFakeWM is a WorkerManager stub for the duplicate-doc-source decision. Only
// SnapshotParkedState / FlushConversation matter here; the rest are no-ops.
type forkFakeWM struct {
	snapshot      []byte // returned by SnapshotParkedState when snapshotOK
	snapshotOK    bool
	flushed       bool
	snapshotCalls int
}

func (f *forkFakeWM) SnapshotParkedState(string) ([]byte, bool) {
	f.snapshotCalls++
	return f.snapshot, f.snapshotOK
}
func (f *forkFakeWM) FlushConversation(string) error { f.flushed = true; return nil }
func (f *forkFakeWM) Remove(string)                  {}
func (f *forkFakeWM) ConversationRestored(string)    {}
func (f *forkFakeWM) RemoveAndPurgeLogs(string)      {}
func (f *forkFakeWM) RenameLog(string)               {}
func (f *forkFakeWM) SeedNewConversation(string, string, string, string, *core.ModelRef) error {
	return nil
}

// TestCloneDocSource_LiveWorkerUsesSnapshot: when the source worker is loaded
// (possibly mid-turn), the clone's doc.yjs is the in-memory parked snapshot —
// NOT a copy of the on-disk file, and no flush is attempted (flushing would
// block on the run loop during a turn).
func TestCloneDocSource_LiveWorkerUsesSnapshot(t *testing.T) {
	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	dstDir := filepath.Join(dir, "dst")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// On-disk source doc is STALE relative to the live worker's in-memory state.
	if err := os.WriteFile(filepath.Join(srcDir, "doc.yjs"), []byte("stale-on-disk"), 0o644); err != nil {
		t.Fatal(err)
	}

	snap := []byte("live-parked-snapshot-\x00\x01")
	fake := &forkFakeWM{snapshot: snap, snapshotOK: true}
	api := &SessionAPI{workerManager: fake}

	doc, err := api.cloneDocSource("src")
	if err != nil {
		t.Fatalf("cloneDocSource: %v", err)
	}
	if err := core.CloneConvFolder(srcDir, dstDir, doc); err != nil {
		t.Fatalf("CloneConvFolder: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(dstDir, "doc.yjs"))
	if err != nil {
		t.Fatalf("read clone doc.yjs: %v", err)
	}
	if string(got) != string(snap) {
		t.Errorf("clone doc = %q, want the live snapshot %q", got, snap)
	}
	if fake.flushed {
		t.Error("must NOT flush when a live snapshot is available (would block mid-turn)")
	}
}

// TestCloneDocSource_NoWorkerFlushesAndCopies: with no loaded worker, the on-disk
// doc is authoritative — flush (no-op) then byte-copy it into the clone.
func TestCloneDocSource_NoWorkerFlushesAndCopies(t *testing.T) {
	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	dstDir := filepath.Join(dir, "dst")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		t.Fatal(err)
	}
	want := []byte("on-disk-authoritative")
	if err := os.WriteFile(filepath.Join(srcDir, "doc.yjs"), want, 0o644); err != nil {
		t.Fatal(err)
	}

	fake := &forkFakeWM{snapshotOK: false} // unloaded → fall back to file copy
	api := &SessionAPI{workerManager: fake}

	doc, err := api.cloneDocSource("src")
	if err != nil {
		t.Fatalf("cloneDocSource: %v", err)
	}
	if err := core.CloneConvFolder(srcDir, dstDir, doc); err != nil {
		t.Fatalf("CloneConvFolder: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(dstDir, "doc.yjs"))
	if err != nil {
		t.Fatalf("read clone doc.yjs: %v", err)
	}
	if string(got) != string(want) {
		t.Errorf("clone doc = %q, want on-disk copy %q", got, want)
	}
	if !fake.flushed {
		t.Error("expected a flush before copying the on-disk doc")
	}
}
