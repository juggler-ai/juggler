//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"sort"
	"sync"

	ycrdt "github.com/skyterra/y-crdt"
)

// SyncThrottleMs is the minimum interval between Yjs sync broadcasts.
// During streaming, many small updates are batched into fewer broadcasts.
//
// Why 10ms: matches one 100Hz frame, the rate at which Y.Doc emits delta
// events during fast streaming. Lower would saturate the WS with sub-frame
// updates the UI can't observe anyway; higher would visibly chunk tokens
// in the rendered text.
const SyncThrottleMs = 10

// docInternalOrigin is used as the transaction origin for document mutations that
// should NOT be tracked by UndoManager. Only OperationTracker methods wrap their
// calls with the authorID origin to make them undoable.
const docInternalOrigin = "doc-internal"

// ycrdtMu serialises all y-crdt operations because the upstream y-crdt library
// has a package-level mutable variable (GlobalSearchMarkerTimestamp in
// abstract_type.go) that is read+written without synchronisation, producing a
// real data race across separate Doc instances. Every y-crdt call in this
// package must go through this lock.
//
// All ConversationDocument methods take this lock internally. Callers within
// this package that touch y-crdt outside a ConversationDocument method (e.g.
// OperationTracker) take the lock directly — see worker.go / strategy.go.
//
// Note: the lock is intentionally not exposed publicly — leaking a process-wide
// mutex on the API would invite callers to compose locks and deadlock.
var ycrdtMu sync.Mutex //nolint:forbidigo // Required for y-crdt library thread safety

// ConversationDocument wraps a Yjs document for conversation state management.
// Thread-safe: a mutex serialises all y-crdt access so test goroutines
// can call methods concurrently with the worker's run() goroutine.
//
// Unified storage architecture:
// - items: Y.Array of all conversation items (ordered conversation flow)
// - metadata: Y.Map for model config, strategy, etc.
// - Context items are stored in the items array with their actual type and inline data
type ConversationDocument struct {
	conversationID string
	authorID       string

	doc      *ycrdt.Doc
	root     *ycrdt.YMap
	items    *ycrdt.YArray // cached ref to root.Get("items")
	metadata *ycrdt.YMap
	authors  *ycrdt.YMap

	// Sync callbacks
	onSyncBroadcast   func(update []byte)
	onUndoStateChange func(canUndo, canRedo bool)

	// Item change observer (called after any items mutation)
	onItemsChange func()

	// Outbound Yjs updates. The doc "update" observer appends each delta to
	// pendingUpdates and coalesces a wake-up on updateSignal; the worker run
	// loop (and streaming wait loops) drain via DrainUpdates. A slice, not a
	// fixed-capacity channel, so a delta is never dropped — a lost delta would
	// diverge every peer permanently. pendingUpdates is guarded by ycrdtMu: the
	// observer already holds it (it fires inside Transact), and DrainUpdates
	// takes it to swap. Blocking the observer on a channel instead is not an
	// option — it runs under ycrdtMu, so waiting on a consumer that also needs
	// ycrdtMu would deadlock.
	pendingUpdates [][]byte
	updateSignal   chan struct{}
}

// txOrigin returns the transaction origin to use for document mutations.
// Returns docInternalOrigin so that direct doc.* calls are not tracked by
// UndoManager. OperationTracker wraps its calls in an outer authorID transaction;
// nested Transact calls inherit the outer origin via doc.Trans.
func (cd *ConversationDocument) txOrigin() interface{} {
	return docInternalOrigin
}

// NewConversationDocument creates a new conversation document.
func NewConversationDocument(conversationID, authorID string) *ConversationDocument {
	doc := ycrdt.NewDoc("", true, ycrdt.DefaultGCFilter, nil, false)

	root := doc.GetMap("root").(*ycrdt.YMap)

	cd := &ConversationDocument{
		conversationID: conversationID,
		authorID:       authorID,
		doc:            doc,
		root:           root,
		metadata:       doc.GetMap("metadata").(*ycrdt.YMap),
		authors:        doc.GetMap("authors").(*ycrdt.YMap),
		updateSignal:   make(chan struct{}, 1), // coalesced wake-up; updates buffer in pendingUpdates
	}

	return cd
}

// =============================================================================
// SYNC
// =============================================================================

// RegisterSyncCallbacks registers callbacks for sync and undo state changes.
// Updates are batched by the worker goroutine — no separate batching goroutine needed.
func (cd *ConversationDocument) RegisterSyncCallbacks(
	onSyncBroadcast func(update []byte),
	onUndoStateChange func(canUndo, canRedo bool),
) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	cd.onSyncBroadcast = onSyncBroadcast
	cd.onUndoStateChange = onUndoStateChange

	cd.doc.On("update", &ycrdt.ObserverHandler{
		Callback: func(v ...any) {
			if len(v) > 0 {
				if update, ok := v[0].([]byte); ok {
					// Fires inside Transact, so ycrdtMu is already held —
					// append directly (unbounded, never dropped) and nudge the
					// coalesced wake-up.
					cd.pendingUpdates = append(cd.pendingUpdates, update)
					select {
					case cd.updateSignal <- struct{}{}:
					default:
					}
				}
			}
		},
	})
}

// UpdateSignal returns the coalesced wake-up channel. The doc "update" observer
// nudges it whenever new deltas are pending; the worker run loop selects on it
// and then calls DrainUpdates. Selecting on a stale signal is harmless —
// DrainUpdates simply returns nil.
func (cd *ConversationDocument) UpdateSignal() <-chan struct{} {
	return cd.updateSignal
}

// DrainUpdates returns and clears every Yjs delta accumulated since the last
// drain, in order. Holds ycrdtMu — the same lock the observer holds when it
// appends — so producer and consumer never race and no delta is lost.
func (cd *ConversationDocument) DrainUpdates() [][]byte {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if len(cd.pendingUpdates) == 0 {
		return nil
	}
	out := cd.pendingUpdates
	cd.pendingUpdates = nil
	return out
}

// RegisterItemsObserver registers an observer for items changes.
// Uses a doc-level "update" observer so it survives items pointer changes
// (e.g., when state is loaded and root.items is replaced by the loaded Y.Array).
func (cd *ConversationDocument) RegisterItemsObserver(observer func()) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	cd.onItemsChange = observer

	cd.doc.On("update", &ycrdt.ObserverHandler{
		Callback: func(v ...any) {
			if cd.onItemsChange != nil {
				cd.onItemsChange()
			}
		},
	})
}

// getItems returns the items Y.Array from root (cached).
// Returns nil if items don't exist yet (before sync from client).
func (cd *ConversationDocument) getItems() *ycrdt.YArray {
	if cd.items != nil {
		return cd.items
	}
	if arr, ok := cd.root.Get("items").(*ycrdt.YArray); ok {
		cd.items = arr
		return arr
	}
	return nil
}

// ensureItems returns the items Y.Array, creating it on root if absent.
func (cd *ConversationDocument) ensureItems() *ycrdt.YArray {
	if items := cd.getItems(); items != nil {
		return items
	}
	items := ycrdt.NewYArray()
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		cd.root.Set("items", items)
	}, cd.txOrigin())
	cd.items = items
	return items
}

// refreshItemsCache invalidates the cached items pointer so next access re-reads from root.
func (cd *ConversationDocument) refreshItemsCache() {
	cd.items = nil
}

// ApplySyncUpdate applies a sync update from remote.
// The ycrdt observer registered in RegisterItemsObserver will fire automatically
// if items changed, so we don't need to manually trigger it here.
func (cd *ConversationDocument) ApplySyncUpdate(update []byte) error {
	return cd.applySyncUpdateWithOrigin(update, nil)
}

// EngineDerivedOrigin is the transaction origin used when applying sync
// updates that the browser engine flagged as engine-derived (see
// YjsSyncMessage.EngineDerived). The string is non-nil and not in the
// UndoManager's trackedOrigins set, so y-crdt's UndoManager skips those
// transactions (per its `Origin == nil` special-case in undo_manager.go).
const EngineDerivedOrigin = "engine-derived"

// ApplyEngineDerivedSyncUpdate applies a sync update that the browser
// engine identified as a pure derivation of already-undoable state. The
// update is tagged with EngineDerivedOrigin so the UndoManager does not
// record it.
func (cd *ConversationDocument) ApplyEngineDerivedSyncUpdate(update []byte) error {
	return cd.applySyncUpdateWithOrigin(update, EngineDerivedOrigin)
}

func (cd *ConversationDocument) applySyncUpdateWithOrigin(update []byte, origin any) error {
	if len(update) == 0 {
		return nil
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	ycrdt.ApplyUpdate(cd.doc, update, origin)
	cd.refreshItemsCache()
	return nil
}

// =============================================================================
// MUTATIONS - Items
// =============================================================================

// InsertMessage inserts message(s) at a specific index as Y.Map items.
func (cd *ConversationDocument) InsertMessage(index int, messages ...ConversationItem) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	cd.insertMessage(index, messages...)
}

func (cd *ConversationDocument) insertMessage(index int, messages ...ConversationItem) {
	origin := cd.txOrigin()
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		type pendingNested struct {
			yarr  *ycrdt.YArray
			items json.RawMessage
		}
		var pending []pendingNested

		ymaps := make(ycrdt.ArrayAny, len(messages))
		for i, msg := range messages {
			if msg.Type == ItemTypeThread && msg.Items != nil {
				stripped := msg
				stripped.Items = nil
				ymap := conversationItemToYMap(stripped)
				yarr := ycrdt.NewYArray()
				ymap.Set("items", yarr)
				ymaps[i] = ymap
				pending = append(pending, pendingNested{yarr, msg.Items})
			} else {
				ymaps[i] = conversationItemToYMap(msg)
			}
		}
		cd.ensureItems().Insert(ycrdt.Number(index), ymaps)

		// yarr is now live after insertion — insert nested items one by one to
		// avoid the PrelimContent reversal in YArray.Integrate.
		for _, p := range pending {
			var nested []ConversationItem
			if err := json.Unmarshal(p.items, &nested); err == nil {
				for j, item := range nested {
					p.yarr.Insert(ycrdt.Number(j), ycrdt.ArrayAny{conversationItemToYMap(item)})
				}
			}
		}
	}, origin)
}

// DeleteMessages deletes messages at specific indices.
func (cd *ConversationDocument) DeleteMessages(indices []int) {
	if len(indices) == 0 {
		return
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	cd.deleteMessages(indices)
}

// FoldPrefixIntoSummaryIfUnchanged atomically replaces count items starting at
// index start with one summary item, in a single Yjs transaction, so observers
// never see a half-folded array. Used by context-window recovery on the
// worker's target array (root or a sub-thread's nested array). It deliberately
// bypasses the OperationTracker: the fold is a system-initiated history
// rewrite, not a user edit, and undo/redo semantics for it are out of scope.
//
// The fold commits only if the array's canonical fingerprint still equals
// expectedFingerprint. Crucially, that recheck and the fold happen under a
// single ycrdtMu hold, so a concurrent doc mutation (a browser edit via
// ApplySyncUpdate, a queued-message promotion) cannot slip between the check
// and the write and leave start/count pointing at stale positions — the same
// resolve-and-write-under-one-lock discipline SetThreadField uses. Returns true
// only when the fold committed.
func (cd *ConversationDocument) FoldPrefixIntoSummaryIfUnchanged(arr *ycrdt.YArray, start, count int, summary ConversationItem, promptID, expectedFingerprint string) bool {
	if arr == nil || count <= 0 {
		return false
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	current := cd.getItemsFromArrayLocked(arr)
	records, err := canonicalCompactionRecords(current, promptID)
	if err != nil || compactionSourceFingerprint(records) != expectedFingerprint {
		return false
	}
	if start < 0 || start+count > len(current) {
		return false
	}
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		arr.Delete(ycrdt.Number(start), ycrdt.Number(count))
		arr.Insert(ycrdt.Number(start), ycrdt.ArrayAny{conversationItemToYMap(summary)})
	}, cd.txOrigin())
	return true
}

func (cd *ConversationDocument) deleteMessages(indices []int) {
	sortedIndices := make([]int, len(indices))
	copy(sortedIndices, indices)
	sort.Sort(sort.Reverse(sort.IntSlice(sortedIndices)))

	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		for _, index := range sortedIndices {
			if index >= 0 && index < int(cd.ensureItems().GetLength()) {
				cd.ensureItems().Delete(ycrdt.Number(index), 1)
			}
		}
	}, cd.txOrigin())
}

// UpdateMessage updates a message field at a specific index via direct Y.Map .Set().
func (cd *ConversationDocument) UpdateMessage(index int, field string, value any) error {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.updateMessage(index, field, value)
}

func (cd *ConversationDocument) updateMessage(index int, field string, value any) error {
	length := int(cd.ensureItems().GetLength())
	if index < 0 || index >= length {
		return fmt.Errorf("index %d out of bounds (length: %d)", index, length)
	}

	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		raw := cd.ensureItems().Get(ycrdt.Number(index))
		if m, ok := raw.(*ycrdt.YMap); ok {
			m.Set(field, convertToYcrdt(value))
		}
	}, cd.txOrigin())

	return nil
}

// UpdateMessageFields updates multiple fields on a message in a single transaction.
// This ensures the observer sees all changes atomically — no intermediate states.
func (cd *ConversationDocument) UpdateMessageFields(index int, fields map[string]any) error {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	length := int(cd.ensureItems().GetLength())
	if index < 0 || index >= length {
		return fmt.Errorf("index %d out of bounds (length: %d)", index, length)
	}

	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		raw := cd.ensureItems().Get(ycrdt.Number(index))
		if m, ok := raw.(*ycrdt.YMap); ok {
			for field, value := range fields {
				m.Set(field, convertToYcrdt(value))
			}
		}
	}, cd.txOrigin())

	return nil
}

// MoveMessage moves a message from one index to another.
func (cd *ConversationDocument) MoveMessage(fromIndex, toIndex int) error {
	if fromIndex == toIndex {
		return nil
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.moveMessage(fromIndex, toIndex)
}

func (cd *ConversationDocument) moveMessage(fromIndex, toIndex int) error {
	length := int(cd.ensureItems().GetLength())
	if fromIndex < 0 || fromIndex >= length {
		return fmt.Errorf("from index %d out of bounds", fromIndex)
	}
	if toIndex < 0 || toIndex >= length {
		return fmt.Errorf("to index %d out of bounds", toIndex)
	}

	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		msg := cd.ensureItems().Get(ycrdt.Number(fromIndex))
		cd.ensureItems().Delete(ycrdt.Number(fromIndex), 1)
		cd.ensureItems().Insert(ycrdt.Number(toIndex), ycrdt.ArrayAny{msg})
	}, cd.txOrigin())

	return nil
}

// ReplaceMessage replaces an entire message at an index with a new Y.Map.
func (cd *ConversationDocument) ReplaceMessage(index int, message ConversationItem) error {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.replaceMessage(index, message)
}

func (cd *ConversationDocument) replaceMessage(index int, message ConversationItem) error {
	length := int(cd.ensureItems().GetLength())
	if index < 0 || index >= length {
		return fmt.Errorf("index %d out of bounds (length: %d)", index, length)
	}

	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		cd.ensureItems().Delete(ycrdt.Number(index), 1)
		cd.ensureItems().Insert(ycrdt.Number(index), ycrdt.ArrayAny{conversationItemToYMap(message)})
	}, cd.txOrigin())

	return nil
}

// UpdateItemID updates the itemId field of an item at the given index.
// Used for repairing duplicate itemIds on load.
func (cd *ConversationDocument) UpdateItemID(index int, newID string) error {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.updateMessage(index, "itemId", newID)
}

// UpdateItemByID finds an item by itemId and updates a field via direct Y.Map .Set().
// Used for streaming updates where we need to update content frequently.
func (cd *ConversationDocument) UpdateItemByID(itemID, field string, value any) error {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := cd.getItems()
	if arr == nil {
		return fmt.Errorf("item with id %s not found", itemID)
	}
	return cd.updateItemByIDInArray(arr, itemID, field, value)
}

// FindIndexByItemID finds an item by itemId and returns its current index.
// Returns -1 if not found. Searches backward since recent items are typically at the end.
func (cd *ConversationDocument) FindIndexByItemID(itemID string) int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.findIndexByItemID(itemID)
}

func (cd *ConversationDocument) findIndexByItemID(itemID string) int {
	arr := cd.getItems()
	if arr == nil {
		return -1
	}
	length := int(arr.GetLength())

	for i := length - 1; i >= 0; i-- {
		raw := arr.Get(ycrdt.Number(i))
		if m, ok := raw.(*ycrdt.YMap); ok {
			if id, _ := m.Get("itemId").(string); id == itemID {
				return i
			}
		}
	}

	return -1
}

// ClearAllMessages removes all messages (unified storage includes context items).
func (cd *ConversationDocument) ClearAllMessages() {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	cd.clearAllMessages()
}

func (cd *ConversationDocument) clearAllMessages() {
	arr := cd.getItems()
	if arr == nil {
		return
	}
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		arr.Delete(0, arr.GetLength())
	}, cd.txOrigin())
}

// InsertThread inserts a thread item with a nested items Y.Array at a specific index.
// Returns the nested *ycrdt.YArray for the thread's child conversation.
func (cd *ConversationDocument) InsertThread(index int, goal string) *ycrdt.YArray {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	var nestedItems *ycrdt.YArray
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		nestedItems = cd.insertThreadCore(cd.ensureItems(), index, goal)
	}, cd.txOrigin())
	return nestedItems
}

// insertThreadCore inserts a thread Y.Map with a nested items Y.Array into arr at index.
// Must be called within an active Yjs transaction. Returns the nested Y.Array.
func (cd *ConversationDocument) insertThreadCore(arr *ycrdt.YArray, index int, goal string) *ycrdt.YArray {
	item := ConversationItem{
		Type:   ItemTypeThread,
		ItemID: generateItemID(),
		Goal:   goal,
	}
	ymap := conversationItemToYMap(item)
	yarr := ycrdt.NewYArray()
	ymap.Set("items", yarr)
	arr.Insert(ycrdt.Number(index), ycrdt.ArrayAny{ymap})
	return yarr
}

// InsertThreadIntoArray inserts a thread item with a nested items Y.Array into a given Y.Array.
// Returns the nested *ycrdt.YArray for the thread's child conversation.
func (cd *ConversationDocument) InsertThreadIntoArray(arr *ycrdt.YArray, index int, goal string) *ycrdt.YArray {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	var nestedItems *ycrdt.YArray
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		nestedItems = cd.insertThreadCore(arr, index, goal)
	}, cd.txOrigin())
	return nestedItems
}

// GetItemsFromArray returns all items from a given Y.Array as a slice.
func (cd *ConversationDocument) GetItemsFromArray(arr *ycrdt.YArray) []ConversationItem {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.getItemsFromArrayLocked(arr)
}

// getItemsFromArrayLocked is GetItemsFromArray without the lock; callers MUST
// already hold ycrdtMu. Used by multi-step routines that need a stable view of
// a YArray across resolve→read→write.
func (cd *ConversationDocument) getItemsFromArrayLocked(arr *ycrdt.YArray) []ConversationItem {
	rawItems := arr.ToArray()
	items := make([]ConversationItem, len(rawItems))
	for i, raw := range rawItems {
		if m, ok := raw.(*ycrdt.YMap); ok {
			items[i] = yMapToConversationItem(m)
		} else {
			converted := fromYcrdt(raw)
			data, err := json.Marshal(converted)
			if err != nil {
				continue
			}
			var item ConversationItem
			if err := json.Unmarshal(data, &item); err == nil {
				items[i] = item
			}
		}
	}
	return items
}

// GetItemsLengthFromArray returns the number of items in a given Y.Array.
func (cd *ConversationDocument) GetItemsLengthFromArray(arr *ycrdt.YArray) int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return int(arr.GetLength())
}

// InsertMessageIntoArray inserts message(s) at a specific index in a given Y.Array.
func (cd *ConversationDocument) InsertMessageIntoArray(arr *ycrdt.YArray, index int, messages ...ConversationItem) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		items := make(ycrdt.ArrayAny, len(messages))
		for i, msg := range messages {
			items[i] = conversationItemToYMap(msg)
		}
		arr.Insert(ycrdt.Number(index), items)
	}, cd.txOrigin())
}

// DeleteMessageFromArray deletes one item at index from a given Y.Array.
func (cd *ConversationDocument) DeleteMessageFromArray(arr *ycrdt.YArray, index int) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		arr.Delete(ycrdt.Number(index), 1)
	}, cd.txOrigin())
}

// UpdateItemByIDInArray finds an item by itemId in a given Y.Array and updates a field.
func (cd *ConversationDocument) UpdateItemByIDInArray(arr *ycrdt.YArray, itemID, field string, value any) error {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.updateItemByIDInArray(arr, itemID, field, value)
}

func (cd *ConversationDocument) updateItemByIDInArray(arr *ycrdt.YArray, itemID, field string, value any) error {
	length := int(arr.GetLength())
	for i := length - 1; i >= 0; i-- {
		raw := arr.Get(ycrdt.Number(i))
		if m, ok := raw.(*ycrdt.YMap); ok {
			if id, _ := m.Get("itemId").(string); id == itemID {
				cd.doc.Transact(func(_ *ycrdt.Transaction) {
					m.Set(field, convertToYcrdt(value))
				}, cd.txOrigin())
				return nil
			}
		}
	}
	return fmt.Errorf("item with id %s not found in array", itemID)
}

// UpdateItemByToolUseIDInArray finds an item by toolUseId in a Y.Array and updates a field.
func (cd *ConversationDocument) UpdateItemByToolUseIDInArray(arr *ycrdt.YArray, toolUseID, field string, value any) error {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.updateItemByToolUseIDInArray(arr, toolUseID, field, value)
}

func (cd *ConversationDocument) updateItemByToolUseIDInArray(arr *ycrdt.YArray, toolUseID, field string, value any) error {
	length := int(arr.GetLength())
	for i := length - 1; i >= 0; i-- {
		raw := arr.Get(ycrdt.Number(i))
		if m, ok := raw.(*ycrdt.YMap); ok {
			if id, _ := m.Get("toolUseId").(string); id == toolUseID {
				cd.doc.Transact(func(_ *ycrdt.Transaction) {
					m.Set(field, convertToYcrdt(value))
				}, cd.txOrigin())
				return nil
			}
		}
	}
	return fmt.Errorf("item with toolUseId %s not found in array", toolUseID)
}

// UpdateItemByToolUseID finds an item by toolUseId in root items and updates a field.
func (cd *ConversationDocument) UpdateItemByToolUseID(toolUseID, field string, value any) error {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := cd.getItems()
	if arr == nil {
		return fmt.Errorf("item with toolUseId %s not found", toolUseID)
	}
	return cd.updateItemByToolUseIDInArray(arr, toolUseID, field, value)
}

// AppendMessage appends message(s) to the end of the items array as Y.Map items.
func (cd *ConversationDocument) AppendMessage(messages ...ConversationItem) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	cd.appendMessage(messages...)
}

func (cd *ConversationDocument) appendMessage(messages ...ConversationItem) {
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		items := make(ycrdt.ArrayAny, len(messages))
		for i, msg := range messages {
			items[i] = conversationItemToYMap(msg)
		}
		cd.ensureItems().Push(items)
	}, cd.txOrigin())
}

// GetItems returns all items as a slice, reading from Y.Map items.
func (cd *ConversationDocument) GetItems() []ConversationItem {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.getConversationItems()
}

func (cd *ConversationDocument) getConversationItems() []ConversationItem {
	arr := cd.getItems()
	if arr == nil {
		return nil
	}
	return cd.getItemsFromArrayLocked(arr)
}

// GetContextItemIDsForThread returns the itemIds whose context must be rendered
// for a turn running in the given thread. Reads directly from Y.Maps without
// converting to structs, avoiding the expensive ToJson+JSON round-trip.
//
// A root turn (threadItemID == "") renders every root item — root owns its own
// conversation. A SUB-THREAD, by contrast, is isolated: it inherits only the
// basic starting context every thread begins with — the system prompt, the
// project's agents files (CLAUDE.md / AGENTS.md …), project memory, and any
// other auto-seeded standing context item — plus its OWN items (context
// produced by tools running inside it). It does NOT inherit the rest of the
// parent/root conversation (files the parent read, plans, tool outputs).
// Inheriting all of it caused sub-threads to redo their parent's work; this is
// the single gate for that isolation.
//
// The "basic starting context" is the LEADING RUN of standing context items at
// root — every item that is not conversation history (isConversationalItemType)
// and was not minted by a tool (no toolUseId), from the top of root up to the
// first conversational item. That run is exactly what the conversation is
// auto-seeded with (system prompt, agents files, memory) before the user says
// anything. preventUserDeletion items (the system prompt) are inherited wherever
// they sit and are transparent to the run. A standing context item pinned
// mid-conversation is history, not starting context, and is excluded.
//
// Keying on the leading run — not on the narrow (preventUserDeletion ||
// file-content) predicate this once used — matters because memory is neither
// tagged preventUserDeletion on its Y.Map nor a file-content type, so the old
// predicate both dropped memory and, by treating it as an ordinary item, ended
// the run early and dropped any agents file positioned after it.
func (cd *ConversationDocument) GetContextItemIDsForThread(threadItemID string) []string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	root := cd.getItems()
	if root == nil {
		return nil
	}
	seen := make(map[string]bool)
	var ids []string
	add := func(id string) {
		if id != "" && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	collectAll := func(arr *ycrdt.YArray) {
		if arr == nil {
			return
		}
		for _, raw := range arr.ToArray() {
			if m, ok := raw.(*ycrdt.YMap); ok {
				id, _ := m.Get("itemId").(string)
				add(id)
			}
		}
	}

	if threadItemID == "" {
		collectAll(root)
		return ids
	}

	// Sub-thread turn: inherit the leading run of standing context items from
	// root, then all of the processing thread's own items. Ancestor
	// conversations are deliberately not walked — they are not inherited.
	inLeadingRun := true
	for _, raw := range root.ToArray() {
		m, ok := raw.(*ycrdt.YMap)
		if !ok {
			continue
		}
		if prevent, _ := m.Get("preventUserDeletion").(bool); prevent {
			// System prompt (and any other sticky item) — position-independent.
			if id, _ := m.Get("itemId").(string); id != "" {
				add(id)
			}
			continue
		}
		itemType, _ := m.Get("type").(string)
		if isConversationalItemType(itemType) {
			// First conversational item ends the starting-context run.
			inLeadingRun = false
			continue
		}
		// A standing context item (memory, agents file, rule, …). One minted by
		// a tool carries a toolUseId and is conversation work, not starting
		// context.
		if inLeadingRun && m.Get("toolUseId") == nil {
			if id, _ := m.Get("itemId").(string); id != "" {
				add(id)
			}
		}
	}
	collectAll(findThreadItemsArray(root, threadItemID))
	return ids
}

// GetItemsLength returns the number of items.
func (cd *ConversationDocument) GetItemsLength() int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.getItemsLength()
}

func (cd *ConversationDocument) getItemsLength() int {
	items := cd.getItems()
	if items == nil {
		return 0
	}
	return int(items.GetLength())
}

// =============================================================================
// MUTATIONS - Metadata
// =============================================================================

// SetMetadata sets a metadata field.
func (cd *ConversationDocument) SetMetadata(key string, value any) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	cd.setMetadata(key, value)
}

func (cd *ConversationDocument) setMetadata(key string, value any) {
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		cd.metadata.Set(key, toYcrdt(value))
	}, cd.txOrigin())
}

// SetThreadField sets a key on a single thread's own Y.Map — thread-scoped
// state such as the per-thread <plan> next-steps, living alongside goal/result/
// resultSpec. Resolve and write happen under one ycrdtMu critical section so a
// concurrent ApplySyncUpdate can't tombstone the resolved YMap between resolve
// and write. No-op if the thread isn't found. Uses txOrigin (untracked): this
// is transient display state, not an undoable edit.
func (cd *ConversationDocument) SetThreadField(threadItemID, key string, value any) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	m := findThreadYMap(cd.getItems(), threadItemID)
	if m == nil {
		return
	}
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		m.Set(key, toYcrdt(value))
	}, cd.txOrigin())
}

// GetMetadata returns a metadata value.
func (cd *ConversationDocument) GetMetadata(key string) any {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.getMetadataValue(key)
}

func (cd *ConversationDocument) getMetadataValue(key string) any {
	raw := cd.metadata.Get(key)
	if raw == nil {
		return nil
	}
	return fromYcrdt(raw)
}

// RegisterAuthor registers an author.
func (cd *ConversationDocument) RegisterAuthor(author Author) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		cd.authors.Set(author.ID, toYcrdt(author))
	}, cd.txOrigin())
}

// =============================================================================
// STATE & SERIALIZATION (binary)
// =============================================================================

// GetStateVector returns the state vector for syncing.
func (cd *ConversationDocument) GetStateVector() []byte {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	encoder := ycrdt.NewUpdateEncoderV1()
	return ycrdt.EncodeStateVector(cd.doc, nil, encoder)
}

// GetStateUpdate returns the state update since the given vector.
func (cd *ConversationDocument) GetStateUpdate(sinceVector []byte) []byte {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return ycrdt.EncodeStateAsUpdate(cd.doc, sinceVector)
}

// ApplyUpdate applies a binary update to the document.
func (cd *ConversationDocument) ApplyUpdate(update []byte) error {
	if len(update) == 0 {
		return nil
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	ycrdt.ApplyUpdate(cd.doc, update, nil)
	cd.refreshItemsCache()
	return nil
}

// LoadFromState loads document state from binary.
// After applying, refreshes the cached items pointer from root.
func (cd *ConversationDocument) LoadFromState(state []byte) error {
	if len(state) == 0 {
		return nil
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	ycrdt.ApplyUpdate(cd.doc, state, nil)
	cd.refreshItemsCache()
	return nil
}

// ToState returns the full document state as binary.
func (cd *ConversationDocument) ToState() []byte {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return ycrdt.EncodeStateAsUpdate(cd.doc, nil)
}

// =============================================================================
// CLEANUP
// =============================================================================

// Destroy cleans up resources.
func (cd *ConversationDocument) Destroy() {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	cd.onSyncBroadcast = nil
	cd.onUndoStateChange = nil
	cd.doc.Destroy()
}

// ConversationID returns the conversation ID.
func (cd *ConversationDocument) ConversationID() string {
	return cd.conversationID
}

// AuthorID returns the author ID.
func (cd *ConversationDocument) AuthorID() string {
	return cd.authorID
}

// =============================================================================
// Author
// =============================================================================

// Author represents a conversation author.
type Author struct {
	ID          string `json:"id"`          // e.g., "user:jules", "llm:txn_abc123"
	Type        string `json:"type"`        // "user", "llm", "system"
	DisplayName string `json:"displayName"` // Display name for UI
	Color       string `json:"color,omitempty"`
}
