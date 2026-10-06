//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"

	ycrdt "github.com/skyterra/y-crdt"
)

// The reducer's view of a thread's items.
//
// tryReconcile runs after every event the run() loop handles, and every reply a
// turn is waiting on queues behind it in the one inbox. Reading its items
// through yMapToConversationItem copies every payload in the thread — message
// text, tool input and output, display data — and, for each child thread, its
// whole transcript serialised to JSON, which the run-record readers then parse
// straight back. That cost grows with everything the conversation's sub-threads
// have said, until each event takes long enough for a context/tools reply to
// miss ContextTimeout waiting its turn.
//
// The reducer decides on none of it. decideNextAction, effectiveItems and the
// walk-down read types, tool states, aliases, run records and the round-trip
// that produced each item (currentBatch's boundary), and the
// run-record readers (threadRunRecords, runSettlement, trailingRunOutcome,
// runRecordByItemID) read a child transcript's items for their own run-record
// fields and a fold's foldedRuns — never a child's grandchildren. This view
// carries exactly that, and leaves every other field empty. A new field the
// reducer comes to depend on must be added here too.

// yMapToReducerItem converts an item for the reducer: every field the thread
// reducer and the run-record readers consult, and none of the payload. A
// thread's Items carries its own transcript in this same form, one level deep.
// Callers MUST hold ycrdtMu.
func yMapToReducerItem(m *ycrdt.YMap) ConversationItem {
	item := yMapToReducerItemShallow(m)
	if item.Type == ItemTypeThread {
		item.Items = reducerTranscriptJSON(m)
	}
	return item
}

// yMapToReducerItemShallow is yMapToReducerItem without the nested transcript.
func yMapToReducerItemShallow(m *ycrdt.YMap) ConversationItem {
	item := ConversationItem{
		Type:              yMapString(m, "type"),
		ItemID:            yMapString(m, "itemId"),
		ToolUseID:         yMapString(m, "toolUseId"),
		ToolName:          yMapString(m, "toolName"),
		State:             yMapString(m, "state"),
		IsError:           yMapBool(m, "isError"),
		Cancelled:         yMapBool(m, "cancelled"),
		Goal:              yMapString(m, "goal"),
		BoundedCompaction: yMapBool(m, "boundedCompaction"),
		SessionName:       yMapString(m, "sessionName"),
		AliasOf:           yMapString(m, "aliasOf"),
		RunToolUseID:      yMapString(m, "runToolUseId"),
		RunToolName:       yMapString(m, "runToolName"),
		RunToolInput:      yMapRawJSON(m, "runToolInput"),
		RunGoal:           yMapString(m, "runGoal"),
		RunStatus:         yMapString(m, "runStatus"),
		RunResult:         yMapString(m, "runResult"),
		Continuation:      yMapBool(m, "continuation"),
		RunItemID:         yMapString(m, "runItemId"),
		RunResultFed:      yMapBool(m, "runResultFed"),
		TransactionID:     yMapString(m, "transactionId"),
	}
	// A thread's result is its run summary, which hasThreadResult reads; any
	// other item's result is tool output, which nothing here does.
	if item.Type == ItemTypeThread {
		item.Result = yMapRawJSON(m, "result")
	}
	if raw := yMapRawJSON(m, "foldedRuns"); raw != nil {
		var runs []FoldedRun
		if json.Unmarshal(raw, &runs) == nil {
			item.FoldedRuns = runs
		}
	}
	return item
}

// reducerTranscriptJSON returns a thread's nested items in reducer form as the
// JSON ConversationItem.Items holds, or nil when it has none.
func reducerTranscriptJSON(threadYMap *ycrdt.YMap) json.RawMessage {
	nested, ok := threadYMap.Get("items").(*ycrdt.YArray)
	if !ok || nested == nil || nested.GetLength() == 0 {
		return nil
	}
	raw := nested.ToArray()
	items := make([]ConversationItem, len(raw))
	for i, v := range raw {
		items[i] = reducerItemFromRaw(v, yMapToReducerItemShallow)
	}
	data, err := json.Marshal(items)
	if err != nil {
		return nil
	}
	return data
}

// reducerItemFromRaw converts one array entry with convert, falling back for an
// entry stored as a plain value rather than a Y.Map exactly as
// getItemsFromArrayLocked does. Such entries carry no nested Y types, so the
// fallback has no transcript to copy.
func reducerItemFromRaw(v any, convert func(*ycrdt.YMap) ConversationItem) ConversationItem {
	if m, ok := v.(*ycrdt.YMap); ok {
		return convert(m)
	}
	var item ConversationItem
	if data, err := json.Marshal(fromYcrdt(v)); err == nil {
		_ = json.Unmarshal(data, &item)
	}
	return item
}

// GetReducerItemsFromArray returns arr's items in the reducer's view.
func (cd *ConversationDocument) GetReducerItemsFromArray(arr *ycrdt.YArray) []ConversationItem {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if arr == nil {
		return nil
	}
	raw := arr.ToArray()
	items := make([]ConversationItem, len(raw))
	for i, v := range raw {
		items[i] = reducerItemFromRaw(v, yMapToReducerItem)
	}
	return items
}

// GetReducerItems returns the root items in the reducer's view.
func (cd *ConversationDocument) GetReducerItems() []ConversationItem {
	ycrdtMu.Lock()
	root := cd.getItems()
	ycrdtMu.Unlock()
	return cd.GetReducerItemsFromArray(root)
}
