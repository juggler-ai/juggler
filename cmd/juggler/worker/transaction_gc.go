//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"bytes"
	"encoding/json"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// docRefs is everything the document refers to outside itself — transaction
// records, assets, program snapshots — the live sets the sweeps keep. Built by
// collectRefs in one read of the document, so the sweeps after a save cost one
// walk between them, and liveRefs adds what the undo stacks can restore.
type docRefs struct {
	// txns is every transactionId an item names.
	txns map[string]bool
	// latestTxns is the transactionId of each thread's newest round-trip — at
	// the root and in every nested thread — read off the last item a round-trip
	// produced, as the viewer's findLastRoundTripTxnId
	// (web/js/utils/transaction-anchor.js) does: the records the trim keeps
	// whole. The user message that opened a round-trip carries its id too but
	// sits on the input side, and is skipped.
	latestTxns map[string]bool
	// assets is every asset id an item, a draft or a queued message names.
	assets map[string]bool
	// unsettled is the tool-use id of every tool-action not yet settled.
	unsettled map[string]bool
	// unreadable reports a thread whose items could not be read: the sets are
	// then incomplete, and nothing may be swept against them.
	unreadable bool
}

// collectRefs reads the document's references in one hold. A turn promotes a
// queued message from pendingItems to items on its own goroutine while the
// sweeps run on the run loop, so reads in separate holds could each land on the
// wrong side of the move and miss its attachments.
//
// It reads each field it needs straight off the CRDT, and never converts an
// item or serializes a thread's transcript: a conversation compacted many times
// nests its history one thread deeper per fold, and a walk that re-parsed each
// level's transcript would cost the depth times the size, under the lock every
// conversation shares.
func (cd *ConversationDocument) collectRefs() docRefs {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	refs := docRefs{txns: map[string]bool{}, latestTxns: map[string]bool{}, assets: map[string]bool{}, unsettled: map[string]bool{}}
	refs.addDraft(refField(cd.metadata, keyDraft))
	refs.addQueue(refField(cd.root, keyPendingItems))
	if arr := cd.getItems(); arr != nil {
		refs.addItems(arr.ToArray())
	}
	return refs
}

// addItems adds the references of one items array, and of every array nested
// in it. Newest first, so the first round-trip output met is the array's
// latest. An item is a Y.Map, or a plain object where a client wrote one.
//
// It descends into any item's nested items, not only a thread's: a set that
// keeps more than it must costs a few files, one that misses an entry deletes
// one. Caller holds ycrdtMu.
func (refs *docRefs) addItems(items []any) {
	foundLatest := false
	for i := len(items) - 1; i >= 0; i-- {
		it := items[i]
		itemType := refString(refField(it, keyType))
		if txn := refString(refField(it, keyTransactionID)); txn != "" {
			refs.txns[txn] = true
			if !foundLatest && isRoundTripOutput(itemType) {
				refs.latestTxns[txn] = true
				foundLatest = true
			}
		}
		settled := isTerminalToolState(refString(refField(it, keyState)))
		if id := refString(refField(it, keyToolUseID)); id != "" && itemType == ItemTypeToolAction && !settled {
			refs.unsettled[id] = true
		}
		refs.addAttachments(refField(it, keyAttachments))
		// A hold lasts only while the item is at work. One that settled without
		// running again to let go (a denial cancels it from outside the tool)
		// holds nothing, and what a finished item shows is in its attachments,
		// written in the same transaction as its state.
		if !settled {
			held, _ := refElems(refField(it, keyHeldAssets))
			for _, id := range held {
				refs.addAsset(refString(id))
			}
		}
		// An edit's diff names the two sides it stores as assets.
		diff := refField(refField(it, keyDisplayData), keyDiffData)
		refs.addAsset(refString(refField(diff, keyOldRef)))
		refs.addAsset(refString(refField(diff, keyNewRef)))
		// A draft and a queued message live on their thread, not in its items.
		refs.addDraft(refField(it, keyDraft))
		refs.addQueue(refField(it, keyPendingItems))

		nested := refField(it, keyItems)
		if nested == nil {
			continue
		}
		children, ok := refElems(nested)
		if !ok {
			if itemType == ItemTypeThread {
				refs.unreadable = true
			}
			continue
		}
		refs.addItems(children)
	}
}

// addAttachments adds the id of each attachment in an attachments value.
func (refs *docRefs) addAttachments(v any) {
	atts, _ := refElems(v)
	for _, att := range atts {
		refs.addAsset(refString(refField(att, keyID)))
	}
}

// addDraft adds the attachments of an unsent draft ({text, attachments}).
func (refs *docRefs) addDraft(v any) {
	refs.addAttachments(refField(v, keyAttachments))
}

// addQueue adds the attachments of each queued message in a pendingItems value.
func (refs *docRefs) addQueue(v any) {
	queued, _ := refElems(v)
	for _, q := range queued {
		refs.addAttachments(refField(q, keyAttachments))
	}
}

func (refs *docRefs) addAsset(id string) {
	if id != "" {
		refs.assets[id] = true
	}
}

// refField reads key off a Y.Map or a plain object, or nil from anything else.
func refField(v any, key string) any {
	switch t := v.(type) {
	case *ycrdt.YMap:
		if t == nil {
			return nil
		}
		return t.Get(key)
	case map[string]any:
		return t[key]
	}
	return nil
}

// refElems returns the elements of a Y.Array or a plain array, and false for
// anything else.
func refElems(v any) ([]any, bool) {
	switch t := v.(type) {
	case *ycrdt.YArray:
		if t == nil {
			return nil, false
		}
		return t.ToArray(), true
	case []any:
		return t, true
	}
	return nil, false
}

// refString is v when it is a string, else "".
func refString(v any) string {
	s, _ := v.(string)
	return s
}

// liveRefs is collectRefs plus what the undo/redo stacks can restore: a record
// or an asset a just-deleted item named must outlive it while undo can bring
// the item back. The undo stacks are read after the document: an item a turn
// deletes moves from the one to the other, so reading them in that order sees
// it in at least one.
func (w *ConversationWorker) liveRefs() docRefs {
	refs := w.doc.collectRefs()
	for _, id := range w.tracker.undoableTransactionIDs() {
		if id != "" {
			refs.txns[id] = true
		}
	}
	for _, id := range w.tracker.undoableAssetIDs() {
		if id != "" {
			refs.assets[id] = true
		}
	}
	return refs
}

// sweepTransactions deletes any transaction blob whose id refs does not name.
//
// Run after every persisted save.
func (w *ConversationWorker) sweepTransactions(refs docRefs) error {
	if w.txnStore == nil || refs.unreadable {
		return nil
	}
	return w.txnStore.Sweep(w.conversationID, refs.txns)
}

// sweepAssets reclaims content-addressed asset blobs (attached images, etc.)
// under <convDir>/assets/ that refs does not name.
//
// Run after every persisted save, alongside sweepTransactions.
func (w *ConversationWorker) sweepAssets(refs docRefs) error {
	if w.assetStore == nil || refs.unreadable {
		return nil
	}
	return w.assetStore.Sweep(w.conversationID, refs.assets, AssetStagingGrace)
}

// sweepPrograms drops the snapshot of every program that can no longer resume
// from it: its tool-action has settled (completed, or cancelled — a denial), or
// is gone from the document. One still unsettled — pending on the user, or
// running — keeps its snapshot, at root or in any thread.
//
// Run after every persisted save, alongside sweepAssets.
func (w *ConversationWorker) sweepPrograms(refs docRefs) error {
	if w.programStore == nil || refs.unreadable {
		return nil
	}
	return w.programStore.Sweep(w.conversationID, refs.unsettled)
}

// TxnMaxAgeFunc reports the user's transaction records setting: the age, in
// days, past which a conversation's records are deleted, or 0 to keep them.
// Nil ⇒ 0.
type TxnMaxAgeFunc func() int

// requestTxnTrim asks the transaction store to tidy this conversation's
// records (TransactionStore.RequestTrim): delete those older than the
// transaction records setting allows, and strip the input of every other one
// old enough to have lost it. Each thread's newest round-trip is kept whole
// however old: the footer meter reads its token counts, and the tool-drift
// check the tools it was offered from its input.
//
// Run once a first load has finished, and after every persisted save alongside
// sweepTransactions. The tidying runs in the background; this only reads the
// setting. A thread whose items could not be read may hold a round-trip the keep
// set misses, so then nothing is tidied.
func (w *ConversationWorker) requestTxnTrim(refs docRefs) {
	if w.txnStore == nil || refs.unreadable {
		return
	}
	var maxAge time.Duration
	if fn := w.deps().txnMaxAge; fn != nil {
		if days := fn(); days > 0 {
			maxAge = time.Duration(days) * 24 * time.Hour
		}
	}
	w.txnStore.RequestTrim(w.conversationID, refs.latestTxns, maxAge)
}

// isRoundTripOutput reports whether an item of this type is something a
// round-trip produced.
func isRoundTripOutput(itemType string) bool {
	return itemType == ItemTypeAssistant || itemType == ItemTypeThinking || itemType == ItemTypeToolAction
}

// diffSnapshotAssetIDs returns the asset ids a tool-action's displayData names
// for the two sides of an edit's diff (diffData.oldRef / diffData.newRef). The
// files themselves are stored as text assets, out of the document. Display data
// that names neither costs a byte scan, not a parse.
func diffSnapshotAssetIDs(displayData []byte) []string {
	if !bytes.Contains(displayData, []byte(`"oldRef"`)) && !bytes.Contains(displayData, []byte(`"newRef"`)) {
		return nil
	}
	var parsed struct {
		DiffData struct {
			OldRef string `json:"oldRef"`
			NewRef string `json:"newRef"`
		} `json:"diffData"`
	}
	if json.Unmarshal(displayData, &parsed) != nil {
		return nil
	}
	var ids []string
	for _, id := range []string{parsed.DiffData.OldRef, parsed.DiffData.NewRef} {
		if id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}
