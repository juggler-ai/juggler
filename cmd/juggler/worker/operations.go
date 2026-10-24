//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
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
	// undoSeq counts undo-stack changes and rides along in the emitted
	// undoState. canUndo/canRedo alone cannot tell a client "the stack moved"
	// from "the same state re-emitted" — both stay true across a new operation —
	// so a UI holding a reference to one particular undo entry (the footer's
	// post-delete Undo offer) has no way to notice that entry is no longer on
	// top. The number changes on every emit, which is exactly that signal.
	undoSeq int
	// threadGroups holds, per thread item id, the undo group the latest message
	// appended to that thread landed in, so the run's settle can join it
	// (settleIntoThreadGroupLocked). Entries are by identity: one whose group has
	// left the stack matches nothing.
	threadGroups map[string]*ycrdt.StackItem
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

// AppendMessage adds messages to the end of the root items array.
//
// It exists rather than leaving callers to write InsertMessage(length, msgs...)
// because that spelling reads the end position under one ycrdtMu hold and writes
// at it under another, and ycrdtMu is a library-safety lock: it promises no two
// y-crdt calls overlap, never that a sequence of holds is atomic. "Append" is a
// single question with a single answer, so it should be a single hold — that is
// what makes the position it writes at the position it measured.
//
// Grouping is InsertMessage's, unchanged.
func (t *OperationTracker) AppendMessage(messages ...ConversationItem) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	t.appendMessageLocked(messages...)
}

// appendMessageLocked is AppendMessage for a caller already holding ycrdtMu.
func (t *OperationTracker) appendMessageLocked(messages ...ConversationItem) {
	um := t.ensureUndoManager()
	if !allAuxiliary(messages) {
		um.StopCapturing()
	}
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		t.doc.insertMessage(t.doc.getItemsLength(), messages...)
	}, t.doc.authorID, true)
}

// AppendMessageToThread adds messages to the end of the thread threadItemID,
// found by id in the same hold as the write, and reports false — writing
// nothing — when no thread has that id. A turn or a send names its thread long
// before it writes, and a viewer may delete the thread or replace it with a
// same-id copy in between; finding it at the write is what lands the messages
// in the thread the document now holds (see GetThreadItemsArray).
//
// The append is appendMessageIntoArrayLocked's.
func (t *OperationTracker) AppendMessageToThread(threadItemID string, messages ...ConversationItem) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := findThreadItemsArray(t.doc.getItems(), threadItemID)
	if arr == nil {
		return false
	}
	t.appendMessageIntoArrayLocked(arr, messages...)
	t.noteThreadGroupLocked(threadItemID)
	return true
}

// noteThreadGroupLocked records the group on top of the undo stack — the one a
// tracked append just landed in — as the thread's latest. Callers MUST hold
// ycrdtMu.
func (t *OperationTracker) noteThreadGroupLocked(threadItemID string) {
	if t.undoManager == nil || len(t.undoManager.UndoStack) == 0 {
		return
	}
	if t.threadGroups == nil {
		t.threadGroups = make(map[string]*ycrdt.StackItem)
	}
	t.threadGroups[threadItemID] = t.undoManager.UndoStack[len(t.undoManager.UndoStack)-1]
}

// settleIntoThreadGroupLocked makes the tracked write in settle one undo step
// with the thread's latest appended message (the reply a settled run
// summarises), so peeling a finished thread takes the same number of undos
// whatever the clock did. Left to the capture window, the settle joined the
// reply only when it landed within captureTimeout of it, and the turn's
// bookkeeping in between (a transaction record written to disk, two batcher
// flushes) sometimes took longer.
//
// A group opened since by anything else — a viewer's edit, a sibling thread's
// reply — is not the run's: the capture window is closed first so the settle
// cannot extend it, and the settle then stays a step of its own. Callers MUST
// hold ycrdtMu.
func (t *OperationTracker) settleIntoThreadGroupLocked(threadItemID string, settle func()) {
	group := t.threadGroups[threadItemID]
	delete(t.threadGroups, threadItemID)
	if t.undoManager == nil || group == nil {
		settle()
		return
	}
	if stack := t.undoManager.UndoStack; len(stack) == 0 || stack[len(stack)-1] != group {
		t.stopCapturingLocked()
		group = nil
	}
	settle()
	if stack := t.undoManager.UndoStack; group != nil && len(stack) >= 2 && stack[len(stack)-2] == group {
		t.mergeFromIndexLocked(len(stack) - 2)
	}
}

// RemoveItemsByID deletes the items whose ids are in ids from the thread
// threadItemID, or from the root when threadItemID is "", and reports how many
// it removed. It is the undo-tracked counterpart of AppendMessage and
// AppendMessageToThread — same origin, and no new undo group, so removing what
// a turn appended stays part of that turn's group. A thread that has gone
// removes nothing.
func (t *OperationTracker) RemoveItemsByID(threadItemID string, ids []string) int {
	if len(ids) == 0 {
		return 0
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := t.doc.getItems()
	if threadItemID != "" {
		arr = findThreadItemsArray(arr, threadItemID)
	}
	if arr == nil {
		return 0
	}
	removing := make(map[string]bool, len(ids))
	for _, id := range ids {
		removing[id] = true
	}
	removed := 0
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		for i := int(arr.GetLength()) - 1; i >= 0; i-- {
			if m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap); ok && removing[yMapString(m, keyItemID)] {
				arr.Delete(ycrdt.Number(i), 1)
				removed++
			}
		}
	}, t.doc.authorID, true)
	return removed
}

// AppendRunStarterToThread appends starter to the thread threadItemID unless a
// run is already open there, reporting whether it wrote. The thread is found,
// its trailing run read, and the starter appended in one hold: a send into the
// thread opens a run of its own, and one landing between a separate check and
// the append would leave two open records where the run has one.
func (t *OperationTracker) AppendRunStarterToThread(threadItemID string, starter ConversationItem) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := findThreadItemsArray(t.doc.getItems(), threadItemID)
	if arr == nil {
		return false
	}
	if settled, hasRuns := runSettlementLocked(arr); hasRuns && !settled {
		return false
	}
	t.appendMessageIntoArrayLocked(arr, starter)
	return true
}

// appendMessageIntoArrayLocked adds messages to the end of a nested thread
// items Y.Array under the tracked (authorID) origin, so sub-thread turn content
// is captured by the UndoManager exactly like root content. Grouping mirrors
// AppendMessage: non-auxiliary types start a new undo group, auxiliary types
// (streaming tool/thinking content) merge with the current group. Thread items
// carrying nested Items go in via insertItemWithNested so their child array is
// populated in source order. The end position is read inside the same hold as
// the write, for the reason given on AppendMessage. Callers MUST hold ycrdtMu.
func (t *OperationTracker) appendMessageIntoArrayLocked(arr *ycrdt.YArray, messages ...ConversationItem) {
	um := t.ensureUndoManager()
	if !allAuxiliary(messages) {
		um.StopCapturing()
	}
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		index := int(arr.GetLength())
		for i, msg := range messages {
			insertItemWithNested(arr, index+i, msg)
		}
	}, t.doc.authorID, true)
}

// PromotePending moves every queued message for the thread ("" => root) to the
// end of its items array and empties the queue, returning what it moved. The
// promoted items are left unstamped (no transactionId), since they are the next
// turn's input, not part of the round-trip that was running when they queued.
//
// The whole move is one ycrdtMu hold. The thread's turn runs on a goroutine of
// its own, and the run loop's save sweeps assets and applies viewer syncs
// concurrently, so a move made in two holds would leave the messages in neither
// array for a moment: long enough for a sweep to reclaim a queued attachment,
// or for a deleted thread to take the messages with it. A thread with no items
// array to receive them keeps its queue.
//
// The append is tracked, so a promotion is undoable like a normal user send;
// emptying the queue is not, since queuing is not conversation content.
func (t *OperationTracker) PromotePending(threadItemID string) []ConversationItem {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	queue := t.doc.getPendingArrayLocked(threadItemID)
	if queue == nil || queue.GetLength() == 0 {
		return nil
	}
	var target *ycrdt.YArray
	if threadItemID != "" {
		if target = findThreadItemsArray(t.doc.getItems(), threadItemID); target == nil {
			return nil
		}
	}

	pending := t.doc.getItemsFromArrayLocked(queue)
	for i := range pending {
		pending[i].TransactionID = ""
	}
	// What is written is the queued maps themselves, read before the queue is
	// emptied — not pending, which went through ConversationItem and carries
	// only the fields it declares. A queued context item holds whatever the
	// browser or its plugin put there, and arrives with all of it.
	length := int(queue.GetLength())
	moved := make([]yNode, 0, length)
	for i := 0; i < length; i++ {
		n := snapshotYValue(queue.Get(ycrdt.Number(i)))
		if n.isMap {
			delete(n.entries, "transactionId")
		}
		moved = append(moved, n)
	}
	t.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		queue.Delete(ycrdt.Number(0), length)
	}, t.doc.txOrigin())

	if target == nil {
		target = t.doc.ensureItems()
	}
	um := t.ensureUndoManager()
	if !allAuxiliary(pending) {
		um.StopCapturing()
	}
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		for _, n := range moved {
			appendYNode(target, n)
		}
	}, t.doc.authorID, true)
	return pending
}

// threadCreation is everything CreateThread writes for one new thread.
type threadCreation struct {
	// ParentThreadID names the thread the new one is created in; "" is the root.
	ParentThreadID string
	Goal           string
	// Stamp sets the new thread's own fields. It runs inside a tracked
	// transaction on the thread's Y.Map, and must only write to it.
	Stamp func(m *ycrdt.YMap)
	// Seed clones the parent's standing context (system prompt, agents files,
	// memory) into the head of the child, each with a fresh id.
	Seed bool
	// Invocation, when set, is appended to the child after the seeds, so the
	// starting context reads top-to-bottom ahead of the message that starts the
	// run.
	Invocation *ConversationItem
}

// CreateThread appends a thread to the end of its parent and writes all of it —
// the container, its stamped fields, the seeded context and the invocation
// message — as one undo group, returning the new thread's itemId. It fails, and
// writes nothing, when the parent is no longer in the document.
//
// The whole creation is one ycrdtMu hold. Threads are opened from a turn's own
// goroutine while the run loop applies viewer syncs, so a creation spread over
// several holds could aim its later writes at an array a viewer had deleted in
// between, or at whatever item had slid into the new thread's index.
//
// The undo boundaries are those of the separate calls this replaces: the
// insert starts a group, the seeds join it, and MergeFromIndex folds anything
// that started a group of its own back into the one creation.
func (t *OperationTracker) CreateThread(c threadCreation) (string, error) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	parent := t.doc.getItems()
	if c.ParentThreadID != "" {
		parent = findThreadItemsArray(parent, c.ParentThreadID)
	}
	if parent == nil {
		return "", fmt.Errorf("thread item %q not found", c.ParentThreadID)
	}

	t.stopCapturingLocked()
	mergeFrom := t.undoStackLenLocked()

	t.ensureUndoManager().StopCapturing()
	var threadYMap *ycrdt.YMap
	var nested *ycrdt.YArray
	ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
		threadYMap, nested = t.doc.insertThreadCore(parent, int(parent.GetLength()), c.Goal)
	}, t.doc.authorID, true)
	threadItemID := yMapString(threadYMap, keyItemID)

	if c.Stamp != nil {
		t.doc.transactTracked(func(_ *ycrdt.Transaction) { c.Stamp(threadYMap) })
	}
	if c.Seed {
		ycrdt.Transact(t.doc.doc, func(_ *ycrdt.Transaction) {
			t.doc.seedThreadFromParentInTx(parent, nested, threadYMap)
		}, t.doc.authorID, true)
	}
	if c.Invocation != nil {
		t.appendMessageIntoArrayLocked(nested, *c.Invocation)
	}

	t.mergeFromIndexLocked(mergeFrom)
	t.stopCapturingLocked()
	return threadItemID, nil
}

// threadResume is everything ResumeThread writes when a session is invoked
// again.
type threadResume struct {
	// ThreadID is the session's thread.
	ThreadID string
	// CallerThreadID names the thread making the call; "" is the root.
	CallerThreadID string
	// Goal and ResultSpec replace the thread's own when set and different.
	Goal       string
	ResultSpec string
	// Alias, when set, builds the caller's alias item from the session's goal
	// and handle as they stand after the update above.
	Alias func(goal, sessionName string) ConversationItem
	// Invocation is appended to the end of the session's transcript.
	Invocation ConversationItem
}

// ResumeThread writes a session's next invocation — the header update, the
// caller's alias item and the appended message — as one undo group. It fails,
// and writes nothing, when either the session or its caller is no longer in the
// document: an alias with no thread behind it, or a message starting a run no
// caller is waiting for, is a broken document.
//
// One ycrdtMu hold, for the reason CreateThread gives.
func (t *OperationTracker) ResumeThread(res threadResume) error {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	root := t.doc.getItems()
	threadYMap := findThreadYMap(root, res.ThreadID)
	var nested *ycrdt.YArray
	if threadYMap != nil {
		nested, _ = yMapArray(threadYMap, keyItems)
	}
	if nested == nil {
		return fmt.Errorf("session thread %s not found", res.ThreadID)
	}
	caller := root
	if res.CallerThreadID != "" {
		caller = findThreadItemsArray(root, res.CallerThreadID)
	}
	if caller == nil {
		return fmt.Errorf("calling thread %s not found", res.CallerThreadID)
	}

	t.stopCapturingLocked()
	mergeFrom := t.undoStackLenLocked()

	goal := yMapString(threadYMap, keyGoal)
	resultSpec := yMapString(threadYMap, keyResultSpec)
	sessionName := yMapString(threadYMap, keySessionName)
	setGoal := res.Goal != "" && res.Goal != goal
	setResultSpec := res.ResultSpec != "" && res.ResultSpec != resultSpec
	if setGoal || setResultSpec {
		t.doc.transactTracked(func(_ *ycrdt.Transaction) {
			if setGoal {
				threadYMap.Set(keyGoal, res.Goal)
			}
			if setResultSpec {
				threadYMap.Set(keyResultSpec, res.ResultSpec)
			}
		})
		if setGoal {
			goal = res.Goal
		}
	}

	if res.Alias != nil {
		t.appendMessageIntoArrayLocked(caller, res.Alias(goal, sessionName))
	}
	t.appendMessageIntoArrayLocked(nested, res.Invocation)

	t.mergeFromIndexLocked(mergeFrom)
	t.stopCapturingLocked()
	return nil
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

// UndoSeq returns the sequence number of the most recent emitUndoState frame.
// Every writer of the undoState metadata map must carry this along: the map is
// replaced wholesale on each write, so a writer that omits seq erases the
// signal the footer's Undo offer (and any test waiting on a specific frame)
// keys on.
func (t *OperationTracker) UndoSeq() int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return t.undoSeq
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
	t.stopCapturingLocked()
}

// stopCapturingLocked is StopCapturing for a caller already holding ycrdtMu, so
// a decision and the undo-group boundary that precedes its write can share one
// hold. The UndoManager's own StopCapturing only resets its capture clock.
func (t *OperationTracker) stopCapturingLocked() {
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
	return t.undoStackLenLocked()
}

// undoStackLenLocked is UndoStackLen for a caller already holding ycrdtMu.
func (t *OperationTracker) undoStackLenLocked() int {
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
	t.mergeFromIndexLocked(startIdx)
}

// mergeFromIndexLocked is MergeFromIndex for a caller already holding ycrdtMu.
func (t *OperationTracker) mergeFromIndexLocked(startIdx int) {
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
	t.threadGroups = nil
	t.emitUndoState()
}

// =============================================================================
// INTERNAL
// =============================================================================

// emitUndoState writes canUndo/canRedo/seq to document metadata so the browser
// reads it reactively via Yjs sync. Called under ycrdtMu.
func (t *OperationTracker) emitUndoState() {
	var canUndo, canRedo bool
	if t.undoManager != nil {
		canUndo = len(t.undoManager.UndoStack) > 0
		canRedo = len(t.undoManager.RedoStack) > 0
	}
	t.undoSeq++
	t.doc.setMetadata(keyUndoState, map[string]any{
		"canUndo": canUndo,
		"canRedo": canRedo,
		"seq":     t.undoSeq,
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
