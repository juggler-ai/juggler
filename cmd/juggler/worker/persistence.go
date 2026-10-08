//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"os"

	"juggler/cmd/juggler/core"
	"juggler/internal/logpaths"
)

// loadStateFromDisk loads the Yjs state from the per-conversation folder.
// When mustExist is true (loading an existing conversation), a missing file
// is an error; when false (new conversation) it's expected.
func (w *ConversationWorker) loadStateFromDisk(mustExist bool) error {
	if w.projectPath == "" {
		return nil // New conversation, no state to load
	}

	statePath, err := w.docPathFor(w.conversationID)
	if err != nil {
		if mustExist {
			return err
		}
		return nil // unknown conv = brand-new
	}

	data, err := os.ReadFile(statePath)
	if err != nil {
		if os.IsNotExist(err) {
			if mustExist {
				return fmt.Errorf("conversation state file not found: %s", statePath)
			}
			return nil
		}
		return fmt.Errorf("failed to read state file: %w", err)
	}

	if len(data) > 0 {
		if err := w.doc.ApplySyncUpdate(data); err != nil {
			return fmt.Errorf("failed to apply state: %w", err)
		}
	}
	return nil
}

// docPathFor resolves a conversation id to its <dir>/doc.yjs path. Returns
// an error if no path provider is set or the conversation is unknown.
func (w *ConversationWorker) docPathFor(convID string) (string, error) {
	if w.pathProvider == nil {
		return "", fmt.Errorf("no path provider set")
	}
	dir, ok := w.pathProvider(convID)
	if !ok {
		return "", fmt.Errorf("conversation folder not found: %s", convID)
	}
	return core.ConvDocPath(dir), nil
}

// repairDuplicateItemIds scans items for duplicate itemIds and assigns new unique IDs.
// Returns the number of duplicates repaired. This handles corruption from undo/redo bugs.
func (w *ConversationWorker) repairDuplicateItemIds() int {
	items := w.doc.GetItems()
	seen := make(map[string]int) // itemId -> first index
	var toRepair []int

	// Find duplicates (keeping first occurrence)
	for i, item := range items {
		if item.ItemID == "" {
			continue
		}
		if _, exists := seen[item.ItemID]; exists {
			toRepair = append(toRepair, i)
		} else {
			seen[item.ItemID] = i
		}
	}

	if len(toRepair) == 0 {
		return 0
	}

	// Log details for debugging
	w.log.Info("REPAIR: Found %d duplicate itemIds, repairing...", len(toRepair))
	for _, idx := range toRepair {
		oldID := items[idx].ItemID
		w.log.Info("REPAIR: Item[%d] has duplicate itemId: %s", idx, oldID)
	}

	// Repair duplicates with new unique IDs
	for _, idx := range toRepair {
		newID := generateItemID()
		if err := w.doc.UpdateItemID(idx, newID); err != nil {
			w.log.Error("REPAIR: Failed to update itemId at index %d: %v", idx, err)
		} else {
			w.log.Info("REPAIR: Assigned new itemId %s to item[%d]", newID, idx)
		}
	}

	return len(toRepair)
}

// writeStateToDisk writes the Yjs document via the saveBinary callback, which
// handles folder creation and atomic write inside the session store. It reports
// whether a write actually happened (false when the worker has no store wiring
// or the document is empty).
//
// This is the whole of what persistence owes the user. Everything else a save
// does is housekeeping, which is why the shutdown path calls this directly.
func (r *run) writeStateToDisk() (bool, error) {
	if r.projectPath == "" || r.saveBinary == nil {
		return false, nil // Can't save without store wiring
	}

	// The single point where the document becomes the file on disk, so the
	// single place persistence has to care about the streaming write throttle:
	// content it is still holding back would be missing from the saved state.
	// Every caller runs on the worker goroutine, so this is the same actor that
	// owns the streaming state.
	r.flushPendingStreamWrites()

	state := r.doc.ToState()
	if len(state) == 0 {
		return false, nil // Nothing to save
	}

	if err := r.saveBinary(r.conversationID, state); err != nil {
		return false, fmt.Errorf("save conversation binary: %w", err)
	}

	r.saver.markSaved()
	return true, nil
}

// saveStateToDisk writes the document, then sweeps the transaction blob store:
// any blob whose id is no longer referenced by either the live items tree OR any
// undoLog entry is deleted, and unreferenced assets go the same way.
// Piggy-backing GC on the debounced save keeps it off the hot path while
// ensuring it runs whenever the doc actually changes.
func (r *run) saveStateToDisk() error {
	wrote, err := r.writeStateToDisk()
	if err != nil || !wrote {
		return err
	}

	if err := r.sweepTransactions(); err != nil {
		r.log.Error("Failed to sweep transaction blobs: %v", err)
	}

	if err := r.sweepAssets(); err != nil {
		r.log.Error("Failed to sweep assets: %v", err)
	}

	return nil
}

// scheduleSave marks the document unsaved and asks the run loop to re-arm the
// save debounce. Callable from ANY goroutine: it is invoked from the Yjs sync
// callback, which fires on whichever goroutine did the Transact() — the run
// loop, the batcher actor's broadcast, or a turn. See docSaver.noteChange.
func (w *ConversationWorker) scheduleSave() {
	w.saver.noteChange()
}

func (r *run) onShutdown() {
	defer r.callbacks.stop()
	// Retires the batcher goroutine, flushing once more on the way out. Ordered
	// after the callbacks defer so it runs BEFORE it (defers unwind LIFO): the
	// final flush broadcasts, and a stopped callback registry would drop it.
	defer r.batcher.stop()
	// Deferred LIFO: r.log.Close() (registered last) runs first to release the
	// file, THEN maybePurgeLogs() removes it — an open file can't be deleted on
	// Windows, so the ordering matters.
	defer r.maybePurgeLogs()
	// Close this conversation's per-conversation log sink (nil-safe).
	defer r.log.Close()

	// Stop every task-output delivery pump and kill its background task so a
	// delivering command doesn't outlive the conversation worker.
	r.pumps.stopAll()

	// Level the document up with any streamed content the write throttle is
	// holding, BEFORE the Yjs flush below, so the final broadcast and the
	// dirty check both see the whole message. This is the only save a
	// mid-turn conversation gets.
	r.flushPendingStreamWrites()

	// Flush any pending Yjs sync updates
	r.batcher.Flush()

	// Cancel any pending save, including a firing already posted.
	r.saver.cancel()
	// Skip final save when the worker is being removed for deletion —
	// otherwise SaveConversationBinary's ensureConvDir would recreate the
	// just-deleted folder as "Untitled--<id>".
	if r.deleting.Load() {
		return
	}
	// Skip if no changes since last successful save.
	if !r.saver.isUnsaved() {
		return
	}
	// Write only — no blob/asset GC. Every worker's shutdown save runs inside
	// one bounded teardown window, and a sweep walks the conversation's whole
	// txns and assets directories: pure latency in front of the only write that
	// still stands between a mid-turn conversation and losing the turn. GC
	// resumes on the next debounced save after the next launch.
	r.log.Info("💾 Saving conversation %s...", r.conversationID)
	if _, err := r.writeStateToDisk(); err != nil {
		r.log.Error("Failed to save state on shutdown: %v", err)
	}
}

// maybePurgeLogs removes this conversation's per-conversation log file(s) when
// the worker is shutting down for a PERMANENT deletion (set via the Manager's
// RemoveAndPurgeLogs). Runs after w.log.Close() so the file is no longer open.
// No-op for a reversible bin or a plain eviction; those logs age out via the
// retention sweep instead.
func (w *ConversationWorker) maybePurgeLogs() {
	if !w.purgeLogs.Load() {
		return
	}
	logpaths.RemoveConversationLogs(w.projectPath, w.conversationID)
}

// broadcastFullState sends the full Yjs document state to the frontend.
func (w *ConversationWorker) broadcastFullState() {
	state := w.doc.ToState()
	if len(state) > 0 {
		w.sendYjsSync(state)
	}
}
