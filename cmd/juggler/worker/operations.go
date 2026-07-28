//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"sort"

	ycrdt "github.com/skyterra/y-crdt"
)

// OperationTracker provides undo/redo via ycrdt.UndoManager.
// UndoManager automatically observes the items Y.Array and records
// all inserts/deletes without manual snapshotting or recording.
//
// All public methods acquire ycrdtMu — callers must not hold it.
// The private emitUndoState is called under ycrdtMu from Yjs callbacks.
//
// The UndoManager is lazily initialized on first use so that
// NewOperationTracker can be called before state is loaded from disk
// without creating a competing empty items Y.Array that would conflict
// with the loaded state during Yjs merge.
type OperationTracker struct {
	doc         *ConversationDocument
	undoManager *ycrdt.UndoManager
	maxGroups   int
}

// auxiliaryTypes are inserted without starting a new undo group —
// they attach to whatever turn is currently being captured.
// Any type NOT listed here is treated as user-facing and starts a new group.
var auxiliaryTypes = map[string]bool{
	"thinking":         true,
	"tool-use":         true,
	"tool-action":      true,
	"tool-result":      true,
	"meta-tool-result": true,
	"guidance":         true,
	"system-reminder":  true,
}

// NewOperationTracker creates a tracker. The UndoManager is NOT initialized
// here — it is deferred to first use (or EnsureInitialized) to avoid calling
// doc.ensureItems() before loadStateFromDisk, which would create a competing
// empty Y.Array that could win the Yjs Y.Map conflict and discard loaded items.
func NewOperationTracker(doc *ConversationDocument) *OperationTracker {
	return &OperationTracker{doc: doc, maxGroups: 100}
}

// EnsureInitialized creates the UndoManager if it hasn't been created yet.
// Called explicitly after loadStateFromDisk so the UndoManager observes the
// correct (loaded) items Y.Array. Also called lazily on first mutation.
// Must be called while ycrdtMu is NOT held (it acquires the lock internally).
func (t *OperationTracker) EnsureInitialized() {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	t.ensureUndoManager()
}

// RefreshScope checks whether the UndoManager's scope Y.Array still matches
// the document's current items array, and re-creates the manager if they differ.
//
// This handles the Yjs Y.Map conflict that occurs on first sync: Go calls
// ensureItems() (creating array A) before the browser's initial state arrives.
// When the browser sends its own items array (B) and B wins the conflict
// (~50% of the time), root["items"] is replaced. The old UndoManager scope
// pointing at A becomes stale — subsequent browser operations modify B but
// the manager's afterTransaction hook checks ChangedParentTypes[A], which is
// never set, so nothing gets tracked and canUndo stays false.
// Must be called while ycrdtMu is NOT held (it acquires the lock internally).
func (t *OperationTracker) RefreshScope() {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	t.refreshScopeIfNeeded()
}

// refreshScopeIfNeeded is the lock-held implementation of RefreshScope.
func (t *OperationTracker) refreshScopeIfNeeded() {
	if t.undoManager == nil {
		t.ensureUndoManager()
		return
	}
	currentItems := t.doc.getItems()
	if currentItems == nil {
		return
	}
	if len(t.undoManager.Scopes) > 0 && t.undoManager.Scopes[0] == currentItems {
		return // scope is still valid
	}
	// Scope is stale — the browser's Y.Array won the conflict. The old
	// manager's afterTransaction handler will become a permanent no-op since
	// the old array is tombstoned. Re-create with the current array.
	t.undoManager = nil
	t.ensureUndoManager()
}

// itemsArrayReachableFromRoot reports whether arr is a thread `items` Y.Array
// reachable from the root items array through nested thread Y.Maps at any depth.
// It climbs arr → wrapping item → thread map → wrapping item → containing array,
// repeating until it reaches root (allow) or hits a boundary it cannot traverse
// (reject). The ParentSub == "items" guard excludes sibling arrays such as
// pendingItems, whose elements must never be tombstoned by undo/redo.
func itemsArrayReachableFromRoot(arr ycrdt.IAbstractType, root *ycrdt.YArray) bool {
	for {
		arrItem := arr.GetItem() // Y.Item wrapping this nested array
		if arrItem == nil {
			return false
		}
		if arrItem.ParentSub != "items" {
			return false // e.g. a pendingItems array — not conversation content
		}
		ownerMap, ok := arrItem.Parent.(ycrdt.IAbstractType) // the thread Y.Map
		if !ok {
			return false
		}
		mapItem := ownerMap.GetItem() // Y.Item wrapping the thread Y.Map
		if mapItem == nil {
			return false
		}
		grand, ok := mapItem.Parent.(ycrdt.IAbstractType) // array holding the thread map
		if !ok {
			return false
		}
		if grand == root {
			return true // thread map sits directly in the root items array
		}
		next, ok := grand.(*ycrdt.YArray)
		if !ok {
			return false
		}
		arr = next // climb one level and repeat
	}
}

// ensureUndoManager initializes the UndoManager if needed. Called under ycrdtMu.
func (t *OperationTracker) ensureUndoManager() *ycrdt.UndoManager {
	if t.undoManager != nil {
		return t.undoManager
	}

	items := t.doc.ensureItems()

	origins := ycrdt.NewSet()
	origins.Add(t.doc.authorID)

	um := ycrdt.NewUndoManager(
		items,
		// captureTimeout ms: changes landing within this window of the previous
		// one merge into the same undo group. Measured by the UndoManager's own
		// wall clock at the moment each browser-originated transaction is applied
		// here on the worker — NOT when the browser issued it. So the window must
		// comfortably exceed worst-case WS+apply jitter, or two operations the
		// browser issued back-to-back (e.g. two rapid thread-item deletes) land
		// >window apart on the worker and wrongly split into separate groups.
		// Logical boundaries are still explicit: StopCapturing() fires at every turn-idle,
		// slash command, context-item change, and undo/redo (which zeroes
		// LastChange), so a larger window never over-merges distinct user actions —
		// it only makes genuinely-rapid sequences group deterministically. Streaming
		// token updates (many rapid writes) likewise want to coalesce into one undo.
		250,
		func(item *ycrdt.Item) bool {
			// Only allow tombstoning items that live within the conversation
			// `items` scope:
			// (a) elements of the root items Y.Array,
			// (b) elements of a nested thread.items Y.Array at any depth, and
			// (c) Y.Map field entries (e.g. resultSpec, data.content) inside
			//     a root- or thread-level item at any depth.
			// Everything else — notably elements of sibling arrays such as
			// pendingItems — must not be tombstoned by undo/redo.
			parent, ok := item.Parent.(ycrdt.IAbstractType)
			if !ok {
				return true
			}
			if parent == items {
				return true // (a) element of the root items array
			}
			if item.ParentSub == "" {
				// (b) element of a nested Y.Array. Allow iff that array is a
				// thread.items array reachable from root items through nested
				// thread maps at any depth.
				return itemsArrayReachableFromRoot(parent, items)
			}
			// (c) Y.Map field entry. Walk up through containing Y.Maps until we
			// reach the root items Y.Array (allow) or a Y.Array boundary. A
			// Y.Array boundary is allowed iff it is a thread.items array
			// reachable from root — so fields inside sub-thread items at any
			// depth are reversible, but fields inside non-items arrays are not.
			cur := parent
			for {
				parentItem := cur.GetItem()
				if parentItem == nil {
					return false
				}
				gp, ok2 := parentItem.Parent.(ycrdt.IAbstractType)
				if !ok2 {
					return false
				}
				if gp == items {
					return true
				}
				if arr, isArr := gp.(*ycrdt.YArray); isArr {
					return itemsArrayReachableFromRoot(arr, items)
				}
				cur = gp
			}
		},
		origins,
	)
	t.undoManager = um

	um.On("stack-item-added", ycrdt.NewObserverHandler(func(_ ...interface{}) {
		// Prune oldest group when stack grows beyond limit
		for len(um.UndoStack) > t.maxGroups {
			um.UndoStack = um.UndoStack[1:]
		}
		t.emitUndoState()
	}))

	return um
}

// =============================================================================
// MUTATIONS (record + apply in one step via UndoManager)
// =============================================================================

// InsertMessage inserts messages at index. Non-auxiliary types start a new undo
// group via StopCapturing so they form an independent undo unit.
func (t *OperationTracker) InsertMessage(index int, messages ...ConversationItem) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	um := t.ensureUndoManager()
	if !allAuxiliary(messages) {
		um.StopCapturing()
	}
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		t.doc.insertMessage(index, messages...)
	}, t.doc.authorID, true)
}

// InsertMessageIntoArray inserts messages at index into a nested thread items
// Y.Array under the tracked (authorID) origin, so sub-thread turn content is
// captured by the UndoManager exactly like root content. Grouping mirrors
// InsertMessage: non-auxiliary types start a new undo group, auxiliary types
// (streaming tool/thinking content) merge with the current group. Thread items
// carrying nested Items are inserted via insertItemWithNested so their child
// array is populated in source order.
func (t *OperationTracker) InsertMessageIntoArray(arr *ycrdt.YArray, index int, messages ...ConversationItem) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	um := t.ensureUndoManager()
	if !allAuxiliary(messages) {
		um.StopCapturing()
	}
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		for i, msg := range messages {
			insertItemWithNested(arr, index+i, msg)
		}
	}, t.doc.authorID, true)
}

// SeedThreadFromParent clones the parent's starting-context items into the head
// of a freshly created child thread's array under the tracked (authorID) origin,
// so the seeded context is captured as part of the create-thread undo group
// (callers collapse the whole creation into one group via MergeFromIndex). No
// StopCapturing: the seed attaches to the surrounding creation group rather than
// forming its own. No-op when the parent has no seed items (an empty transaction
// records no undo entry).
func (t *OperationTracker) SeedThreadFromParent(parentArr, childArr *ycrdt.YArray) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	t.ensureUndoManager()
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		t.doc.seedThreadFromParentInTx(parentArr, childArr)
	}, t.doc.authorID, true)
}

// DeleteMessages deletes messages at the given indices (need not be sorted).
// Each call starts a new undo group so the deletion is independently undoable.
func (t *OperationTracker) DeleteMessages(indices []int) {
	if len(indices) == 0 {
		return
	}
	sorted := make([]int, len(indices))
	copy(sorted, indices)
	sort.Sort(sort.Reverse(sort.IntSlice(sorted)))

	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	t.ensureUndoManager().StopCapturing()
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		t.doc.deleteMessages(sorted)
	}, t.doc.authorID, true)
}

// ReplaceMessage replaces the message at index. Non-auxiliary types start a new
// undo group; auxiliary types (streaming tool content) merge with the current group.
func (t *OperationTracker) ReplaceMessage(index int, message ConversationItem) error {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	um := t.ensureUndoManager()
	if !auxiliaryTypes[message.Type] {
		um.StopCapturing()
	}
	var err error
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		err = t.doc.replaceMessage(index, message)
	}, t.doc.authorID, true)
	return err
}

// InsertThreadIntoArray inserts a thread item with a nested items Y.Array into arr at index.
// Uses authorID as the transaction origin so the insertion is tracked by the UndoManager,
// matching the browser's behaviour when a user or the AI creates a subthread.
// Starts a new undo group so the insertion is independently undoable.
func (t *OperationTracker) InsertThreadIntoArray(arr *ycrdt.YArray, index int, goal string) *ycrdt.YArray {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	t.ensureUndoManager().StopCapturing()
	var nestedItems *ycrdt.YArray
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		nestedItems = t.doc.insertThreadCore(arr, index, goal)
	}, t.doc.authorID, true)
	return nestedItems
}

// DeleteThreadItem deletes the item at index from a thread's nested items array.
// Uses authorID as the transaction origin so the deletion is tracked by the UndoManager,
// matching the browser's behaviour when a user deletes a subthread item.
// Starts a new undo group so the deletion is independently undoable/redoable.
func (t *OperationTracker) DeleteThreadItem(arr *ycrdt.YArray, index int) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	t.ensureUndoManager().StopCapturing()
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		arr.Delete(ycrdt.Number(index), 1)
	}, t.doc.authorID, true)
}

// MoveMessage moves the message at fromIndex to toIndex.
func (t *OperationTracker) MoveMessage(fromIndex, toIndex int) error {
	if fromIndex == toIndex {
		return nil
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	t.ensureUndoManager().StopCapturing()
	var err error
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		err = t.doc.moveMessage(fromIndex, toIndex)
	}, t.doc.authorID, true)
	return err
}

// ClearAll removes all items from the document.
func (t *OperationTracker) ClearAll() {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	t.ensureUndoManager().StopCapturing()
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		t.doc.clearAllMessages()
	}, t.doc.authorID, true)
}

// =============================================================================
// UNDO / REDO
// =============================================================================

// CanUndo reports whether there is an operation to undo.
func (t *OperationTracker) CanUndo() bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if t.undoManager == nil {
		return false
	}
	return len(t.undoManager.UndoStack) > 0
}

// CanRedo reports whether there is an operation to redo.
func (t *OperationTracker) CanRedo() bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if t.undoManager == nil {
		return false
	}
	return len(t.undoManager.RedoStack) > 0
}

// Undo reverses the last recorded operation group. Returns true if anything changed.
func (t *OperationTracker) Undo() bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	um := t.ensureUndoManager()
	result := um.Undo()
	// stack-item-added event (type="redo") fires inside Undo and calls emitUndoState.
	// Call it again in case Undo produced no change (empty stack).
	if result == nil {
		t.emitUndoState()
	}
	return result != nil
}

// Redo re-applies the last undone operation group. Returns true if anything changed.
func (t *OperationTracker) Redo() bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	um := t.ensureUndoManager()
	result := um.Redo()
	if result == nil {
		t.emitUndoState()
	}
	return result != nil
}

// StopCapturing ends the current capture window so the next mutation starts a new undo group.
// Use this to force separate undo groups between operations that would otherwise coalesce.
// No-op if the UndoManager has not been initialized yet (avoids creating a competing
// empty Y.Array before the first browser sync for new conversations).
func (t *OperationTracker) StopCapturing() {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if t.undoManager == nil {
		return
	}
	t.undoManager.StopCapturing()
}

// UndoStackLen returns the current number of undo groups. Used to snapshot
// the stack height before a long-running operation so MergeFromIndex can
// collapse everything added since.
func (t *OperationTracker) UndoStackLen() int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if t.undoManager == nil {
		return 0
	}
	return len(t.undoManager.UndoStack)
}

// MergeFromIndex collapses every UndoStack entry from startIdx onward into
// a single group living at startIdx. Use when a long-running operation
// (e.g. a compaction whose strategy run spans many LLM turns) has added
// several intermediate stack items the user expects to undo as one unit.
//
// The merge is structurally identical to the captureTimeout-driven merge
// inside the UndoManager — same MergeDeleteSets calls, just done after the
// fact across an arbitrary span instead of pairwise during capture.
//
// No-op if startIdx is out of range or there is nothing to merge.
func (t *OperationTracker) MergeFromIndex(startIdx int) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if t.undoManager == nil {
		return
	}
	stack := t.undoManager.UndoStack
	if startIdx < 0 || startIdx >= len(stack)-1 {
		return
	}
	merged := stack[startIdx]
	for i := startIdx + 1; i < len(stack); i++ {
		merged.Deletions = ycrdt.MergeDeleteSets([]*ycrdt.DeleteSet{merged.Deletions, stack[i].Deletions})
		merged.Insertions = ycrdt.MergeDeleteSets([]*ycrdt.DeleteSet{merged.Insertions, stack[i].Insertions})
	}
	t.undoManager.UndoStack = stack[:startIdx+1]
	t.emitUndoState()
}

// ClearHistory clears the undo/redo stacks without modifying document content.
func (t *OperationTracker) ClearHistory() {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if t.undoManager == nil {
		return
	}
	t.undoManager.Clear()
	t.emitUndoState()
}

// =============================================================================
// INTERNAL
// =============================================================================

// emitUndoState writes canUndo/canRedo to document metadata so the browser
// reads it reactively via Yjs sync. Called under ycrdtMu.
func (t *OperationTracker) emitUndoState() {
	var canUndo, canRedo bool
	if t.undoManager != nil {
		canUndo = len(t.undoManager.UndoStack) > 0
		canRedo = len(t.undoManager.RedoStack) > 0
	}
	t.doc.setMetadata("undoState", map[string]any{
		"canUndo": canUndo,
		"canRedo": canRedo,
	})
}

// undoableTransactionIDs returns transaction IDs referenced by items that are
// restorable via the active undo/redo stacks. These blobs must not be GC'd.
//
// Walks each StackItem's Deletions (items deleted during a tracked transaction
// that can be restored by undo/redo). Live items are handled by collectTxnIDsFromItems.
// This avoids false positives from items whose redo entry was cleared but whose
// Keep flag was never reset (y-crdt sets RedoStack=nil without calling KeepItem(false)).
func (t *OperationTracker) undoableTransactionIDs() []string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()

	if t.undoManager == nil {
		return nil
	}

	allStacks := append(append([]*ycrdt.StackItem{}, t.undoManager.UndoStack...), t.undoManager.RedoStack...)
	if len(allStacks) == 0 {
		return nil
	}

	seen := map[string]bool{}
	var ids []string

	t.doc.doc.Transact(func(trans *ycrdt.Transaction) {
		for _, stackItem := range allStacks {
			ycrdt.IterateDeletedStructs(trans, stackItem.Deletions, func(s ycrdt.IAbstractStruct) {
				item, ok := s.(*ycrdt.Item)
				if !ok {
					return
				}
				ct, ok := item.Content.(*ycrdt.ContentType)
				if !ok {
					return
				}
				ymap, ok := ct.Type.(*ycrdt.YMap)
				if !ok {
					return
				}
				// Read the map entry directly: ymap.Get() returns nil for deleted fields,
				// but GetMap() exposes the raw item so we can read its content.
				mapItem, ok := ymap.GetMap()["transactionId"]
				if !ok {
					return
				}
				if content := mapItem.Content.GetContent(); len(content) > 0 {
					if txnID, _ := content[len(content)-1].(string); txnID != "" && !seen[txnID] {
						seen[txnID] = true
						ids = append(ids, txnID)
					}
				}
			})
		}
	}, docInternalOrigin)

	return ids
}

// undoableAssetIDs returns asset shas referenced by items that are restorable
// via the active undo/redo stacks. These blobs must not be GC'd.
//
// Mirrors undoableTransactionIDs, but the "attachments" field holds a JSON
// array of AssetRef rather than a scalar string, so each deleted item's
// attachments value is round-tripped through fromYcrdt → JSON → []AssetRef to
// recover the ids.
func (t *OperationTracker) undoableAssetIDs() []string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()

	if t.undoManager == nil {
		return nil
	}

	allStacks := append(append([]*ycrdt.StackItem{}, t.undoManager.UndoStack...), t.undoManager.RedoStack...)
	if len(allStacks) == 0 {
		return nil
	}

	seen := map[string]bool{}
	var ids []string

	t.doc.doc.Transact(func(trans *ycrdt.Transaction) {
		for _, stackItem := range allStacks {
			ycrdt.IterateDeletedStructs(trans, stackItem.Deletions, func(s ycrdt.IAbstractStruct) {
				item, ok := s.(*ycrdt.Item)
				if !ok {
					return
				}
				ct, ok := item.Content.(*ycrdt.ContentType)
				if !ok {
					return
				}
				ymap, ok := ct.Type.(*ycrdt.YMap)
				if !ok {
					return
				}
				mapItem, ok := ymap.GetMap()["attachments"]
				if !ok {
					return
				}
				content := mapItem.Content.GetContent()
				if len(content) == 0 {
					return
				}
				raw, err := json.Marshal(fromYcrdt(content[len(content)-1]))
				if err != nil {
					return
				}
				var atts []AssetRef
				if json.Unmarshal(raw, &atts) != nil {
					return
				}
				for _, att := range atts {
					if att.ID != "" && !seen[att.ID] {
						seen[att.ID] = true
						ids = append(ids, att.ID)
					}
				}
			})
		}
	}, docInternalOrigin)

	return ids
}

// allAuxiliary returns true if every message in the slice is an auxiliary type.
// An empty slice is NOT considered all-auxiliary (returns false).
func allAuxiliary(messages []ConversationItem) bool {
	if len(messages) == 0 {
		return false
	}
	for _, m := range messages {
		if !auxiliaryTypes[m.Type] {
			return false
		}
	}
	return true
}
