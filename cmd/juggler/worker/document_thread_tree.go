//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"

	ycrdt "github.com/skyterra/y-crdt"
)

// walkThreads visits every thread CONTAINER Y.Map in arr, depth-first. The
// visitor receives the thread Y.Map, its nested "items" Y.Array (may be nil),
// and the itemId of the enclosing parent thread ("" at root level). Return true
// to stop early. walkThreads itself returns true if walking was stopped early by
// the visitor.
//
// An alias item is skipped: it is a second view of a thread standing earlier in
// the same array, not a container of its own. Every question this walk answers —
// which array holds a thread, how deep it is nested, how many are in flight — is
// a question about containers, and an alias holds no transcript to answer with.
// walkAllItems still visits aliases; they are items, and id lookups must find
// them.
func walkThreads(arr *ycrdt.YArray, visit func(m *ycrdt.YMap, nested *ycrdt.YArray, parentThreadID string) bool) bool {
	return walkThreadsWithParent(arr, "", visit)
}

func walkThreadsWithParent(arr *ycrdt.YArray, parentID string, visit func(m *ycrdt.YMap, nested *ycrdt.YArray, parentThreadID string) bool) bool {
	if arr == nil {
		return false
	}
	for i := range int(arr.GetLength()) {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if itemType := yMapString(m, keyType); itemType != ItemTypeThread {
			continue
		}
		if aliasOf := yMapString(m, keyAliasOf); aliasOf != "" {
			continue
		}
		nested, _ := yMapArray(m, keyItems)
		if visit(m, nested, parentID) {
			return true
		}
		myID := yMapString(m, keyItemID)
		if walkThreadsWithParent(nested, myID, visit) {
			return true
		}
	}
	return false
}

// walkAllItems visits every Y.Map in arr (regardless of type), depth-first, and
// recurses into thread children. The visitor receives the Y.Map and the itemId
// of the enclosing thread ("" at root level). Return true to stop early.
func walkAllItems(arr *ycrdt.YArray, currentThreadID string, visit func(m *ycrdt.YMap, currentThreadID string) bool) bool {
	if arr == nil {
		return false
	}
	for i := range int(arr.GetLength()) {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if visit(m, currentThreadID) {
			return true
		}
		if itemType := yMapString(m, keyType); itemType == ItemTypeThread {
			if nested, _ := yMapArray(m, keyItems); nested != nil {
				myID := yMapString(m, keyItemID)
				if walkAllItems(nested, myID, visit) {
					return true
				}
			}
		}
	}
	return false
}

// GetThreadItemsArray finds a thread Y.Map by itemId and returns its nested
// "items" Y.Array. Searches recursively through nested threads.
//
// The handle is only good inside the hold it was found in. y-crdt does not
// cascade a delete into the types nested under the deleted item, so an array
// whose thread a viewer has since deleted or replaced never reads as gone: it
// keeps returning the old transcript, and writes into it vanish. Code that
// reads or writes a thread later asks by id — HasThread, GetThreadItems,
// GetThreadItemsLength, UpdateItemByIDInThread,
// OperationTracker.AppendMessageToThread — each resolving where it acts.
func (cd *ConversationDocument) GetThreadItemsArray(threadItemID string) *ycrdt.YArray {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return findThreadItemsArray(cd.getItems(), threadItemID)
}

// threadItemsArrayLocked is the items array threadItemID names: the root's for
// "", the thread's own otherwise, nil when no thread has the id. Callers MUST
// hold ycrdtMu, and use the result only inside that hold.
func (cd *ConversationDocument) threadItemsArrayLocked(threadItemID string) *ycrdt.YArray {
	if threadItemID == "" {
		return cd.getItems()
	}
	return findThreadItemsArray(cd.getItems(), threadItemID)
}

// HasThread reports whether a thread with this itemId is in the document.
func (cd *ConversationDocument) HasThread(threadItemID string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return findThreadItemsArray(cd.getItems(), threadItemID) != nil
}

// GetThreadItems returns a thread's items, found by itemId in the same hold
// that reads them; nil when no thread has the id.
func (cd *ConversationDocument) GetThreadItems(threadItemID string) []ConversationItem {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := findThreadItemsArray(cd.getItems(), threadItemID)
	if arr == nil {
		return nil
	}
	return cd.getItemsFromArrayLocked(arr)
}

// GetThreadItemsLength returns a thread's item count, 0 when no thread has the
// id.
func (cd *ConversationDocument) GetThreadItemsLength(threadItemID string) int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := findThreadItemsArray(cd.getItems(), threadItemID)
	if arr == nil {
		return 0
	}
	return int(arr.GetLength())
}

// UpdateItemByIDInThread sets one field of the item itemID in the thread
// threadItemID, finding both in one hold. It fails, and writes nothing, when
// either has gone.
func (cd *ConversationDocument) UpdateItemByIDInThread(threadItemID, itemID, field string, value any) error {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := findThreadItemsArray(cd.getItems(), threadItemID)
	if arr == nil {
		return fmt.Errorf("thread item %s not found", threadItemID)
	}
	return cd.updateItemByIDInArray(arr, itemID, field, value)
}

// findThreadItemsArray returns the nested "items" Y.Array for the thread with the given itemId.
func findThreadItemsArray(arr *ycrdt.YArray, threadItemID string) *ycrdt.YArray {
	var result *ycrdt.YArray
	walkThreads(arr, func(m *ycrdt.YMap, nested *ycrdt.YArray, _ string) bool {
		if id := yMapString(m, keyItemID); id == threadItemID {
			result = nested
			return true
		}
		return false
	})
	return result
}

// GetThreadYMap finds a thread Y.Map by itemId. Searches recursively.
// Returns the Y.Map container for the thread, or nil if not found.
func (cd *ConversationDocument) GetThreadYMap(threadItemID string) *ycrdt.YMap {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return findThreadYMap(cd.getItems(), threadItemID)
}

// threadFlag reads one boolean field off a thread's Y.Map, false when the thread
// or the field is absent. Exists so callers asking "is this thread delegated /
// spawn-capable" need no y-crdt handle and no lock of their own: reaching for
// GetThreadYMap and then locking around a .Get is what puts ycrdtMu into
// business logic, where the next helper it calls may take the lock again and
// deadlock (see the ycrdt watchdog's report).
func (cd *ConversationDocument) threadFlag(threadItemID, field string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	m := findThreadYMap(cd.getItems(), threadItemID)
	if m == nil {
		return false
	}
	v, _ := m.Get(field).(bool)
	return v
}

// threadString is threadFlag for a string field, "" when the thread or the
// field is absent.
func (cd *ConversationDocument) threadString(threadItemID, field string) string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	m := findThreadYMap(cd.getItems(), threadItemID)
	if m == nil {
		return ""
	}
	v, _ := m.Get(field).(string)
	return v
}

// settledLLMChildParent reports whether threadItemID is a create_thread child
// whose run has settled and, if so, the itemId of the thread containing it (""
// at root level). Resolve, decide and parent walk share one hold, so a viewer's
// delete or refold between them cannot answer for a thread no longer there.
func (cd *ConversationDocument) settledLLMChildParent(threadItemID string) (parentID string, ok bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	m := findThreadYMap(cd.getItems(), threadItemID)
	if m == nil {
		return "", false
	}
	if llmCreated := yMapBool(m, keyLLMCreated); !llmCreated || !threadRunSettledLocked(m) {
		return "", false
	}
	return cd.findParentThreadID(threadItemID), true
}

// findThreadYMap returns the Y.Map for the thread with the given itemId.
func findThreadYMap(arr *ycrdt.YArray, threadItemID string) *ycrdt.YMap {
	var result *ycrdt.YMap
	walkThreads(arr, func(m *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
		if id := yMapString(m, keyItemID); id == threadItemID {
			result = m
			return true
		}
		return false
	})
	return result
}

// ParentThreadID returns the itemId of the parent thread containing
// threadItemID, "" when it stands at root level or is not found. Takes ycrdtMu,
// for callers holding nothing — which is every turn goroutine, since the actor
// walks the same document beside them and a walk WRITES y-crdt's position
// cache.
func (cd *ConversationDocument) ParentThreadID(threadItemID string) string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.findParentThreadID(threadItemID)
}

// findParentThreadID returns the itemId of the parent thread containing threadItemID.
// Returns "" if the thread is at root level or not found. Caller MUST hold
// ycrdtMu: the walk is not read-only underneath — y-crdt caches the position it
// searched from — so an unlocked call races every other walk in the process.
// Use ParentThreadID when holding nothing.
func (cd *ConversationDocument) findParentThreadID(threadItemID string) string {
	var result string
	walkThreads(cd.getItems(), func(m *ycrdt.YMap, _ *ycrdt.YArray, parent string) bool {
		if id := yMapString(m, keyItemID); id == threadItemID {
			result = parent
			return true
		}
		return false
	})
	return result
}

// parentArrayOfLocked returns the Y.Array a thread item stands in: the root
// items array for a top-level thread, the holding thread's nested array
// otherwise. That array is where the parent's view of the thread lives — its
// canonical item, its aliases and its receipts are all siblings there. Caller
// MUST hold ycrdtMu.
func (cd *ConversationDocument) parentArrayOfLocked(threadItemID string) *ycrdt.YArray {
	if parentID := cd.findParentThreadID(threadItemID); parentID != "" {
		return findThreadItemsArray(cd.getItems(), parentID)
	}
	return cd.getItems()
}

// threadDepth returns how deeply the given thread is nested: the root level
// ("") is depth 0, a thread directly under root is depth 1, its child depth 2,
// and so on. Walks the parent chain via findParentThreadID under a single lock.
func (cd *ConversationDocument) threadDepth(threadItemID string) int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	depth := 0
	for tid := threadItemID; tid != ""; tid = cd.findParentThreadID(tid) {
		depth++
	}
	return depth
}

// liveThreadCount returns how many create_thread-spawned threads anywhere in the
// document are still in flight — llmCreated, with a run that has not settled.
// Walks the whole tree under one lock (mirrors threadDepth). Where threadDepth
// bounds nesting along a single chain, this counts fan-out across the whole
// tree, so executeCreateThread can stop a model that keeps decomposing work into
// fresh subthreads without ever deepening the chain. Counts only in-flight
// children, so it self-heals as they settle — it never permanently disables
// create_thread the way a monotonic lifetime counter would.
func (cd *ConversationDocument) liveThreadCount() int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	n := 0
	walkThreads(cd.getItems(), func(m *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
		llmCreated := yMapBool(m, keyLLMCreated)
		if llmCreated && !threadRunSettledLocked(m) {
			n++
		}
		return false
	})
	return n
}

// firstLiveThreadID returns the itemId of the first create_thread-spawned thread
// anywhere in the document whose run is still open (llmCreated, unsettled), or ""
// when every run has settled. Same walk and the same notion of live as
// liveThreadCount; where that counts fan-out, this names one — the thread a caller
// holding the LLM claim hands it to when the run it was driving has ended while the
// document still has work in flight (finishStrategyRun's guard against publishing
// idle early). "First" is document order, matching the reducer's walk-down dispatch
// order, so the thread handed the claim is the one the reducer would reach anyway.
//
// excluding names a thread that can never be the answer — the caller's own
// just-finished thread. A run that ends without settling (settleThreadRun writes
// nothing when it has no open message to stamp) still reads as live here, and
// handing the claim back to it would re-dispatch the run that just ended, forever.
func (cd *ConversationDocument) firstLiveThreadID(excluding string) string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	id := ""
	walkThreads(cd.getItems(), func(m *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
		itemID := yMapString(m, keyItemID)
		if itemID == "" || itemID == excluding {
			return false
		}
		llmCreated := yMapBool(m, keyLLMCreated)
		if llmCreated && !threadRunSettledLocked(m) {
			id = itemID
			return true
		}
		return false
	})
	return id
}

// FindThreadIDForToolUseID returns the threadItemID of the thread containing
// the given toolUseId, or "" if it lives in the root array.
// Returns ("", false) if not found anywhere.
func (cd *ConversationDocument) FindThreadIDForToolUseID(toolUseID string) (threadID string, found bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return findThreadIDForToolUseID(cd.getItems(), toolUseID)
}

func findThreadIDForToolUseID(arr *ycrdt.YArray, toolUseID string) (string, bool) {
	var resultThreadID string
	found := walkAllItems(arr, "", func(m *ycrdt.YMap, currentThreadID string) bool {
		if id := yMapString(m, keyToolUseID); id == toolUseID {
			resultThreadID = currentThreadID
			return true
		}
		return false
	})
	return resultThreadID, found
}

// UpdateToolActionFieldsRecursive searches all arrays (root + nested threads)
// for an item with the given toolUseId and updates its fields in one transaction.
// Returns true if the item was found and updated.
func (cd *ConversationDocument) UpdateToolActionFieldsRecursive(toolUseID string, fields map[string]any) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return updateToolActionFieldsInArray(cd.doc, docInternalOrigin, cd.getItems(), toolUseID, fields)
}

// updateToolActionsWhere writes fields to every tool-action (root + nested
// threads) that match accepts, and returns the toolUseIds it wrote. The match
// and the write share one ycrdtMu hold, which is the point: a caller that
// checked a tool's state in an earlier hold and then wrote it by id would act on
// what it saw, and a sync update landing in the gap — a result, an approval —
// would be overwritten. match runs under the lock and must only read m.
// Tool-actions without a toolUseId are skipped.
func (cd *ConversationDocument) updateToolActionsWhere(match func(m *ycrdt.YMap, threadID string) bool, fields map[string]any) []string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	var written []string
	walkAllItems(cd.getItems(), "", func(m *ycrdt.YMap, threadID string) bool {
		if t := yMapString(m, keyType); t != ItemTypeToolAction {
			return false
		}
		id := yMapString(m, keyToolUseID)
		if id == "" || !match(m, threadID) {
			return false
		}
		cd.doc.Transact(func(_ *ycrdt.Transaction) {
			for field, value := range fields {
				m.Set(field, convertToYcrdt(value))
			}
		}, docInternalOrigin)
		written = append(written, id)
		return false
	})
	return written
}

// UpdateToolActionDisplayDataRecursive merges one durable display-data value
// without discarding display fields owned by another part of the tool renderer.
func (cd *ConversationDocument) UpdateToolActionDisplayDataRecursive(toolUseID, key string, value any) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return walkAllItems(cd.getItems(), "", func(m *ycrdt.YMap, _ string) bool {
		if id := yMapString(m, keyToolUseID); id != toolUseID {
			return false
		}
		cd.doc.Transact(func(_ *ycrdt.Transaction) {
			if displayData, ok := yMapMap(m, keyDisplayData); ok {
				displayData.Set(key, convertToYcrdt(value))
				return
			}
			m.Set(keyDisplayData, convertToYcrdt(map[string]any{key: value}))
		}, docInternalOrigin)
		return true
	})
}

// updateToolActionFieldsInArray finds the Y.Map whose toolUseId matches and updates all fields atomically.
func updateToolActionFieldsInArray(doc *ycrdt.Doc, origin string, arr *ycrdt.YArray, toolUseID string, fields map[string]any) bool {
	return walkAllItems(arr, "", func(m *ycrdt.YMap, _ string) bool {
		if id := yMapString(m, keyToolUseID); id != toolUseID {
			return false
		}
		doc.Transact(func(_ *ycrdt.Transaction) {
			for field, value := range fields {
				m.Set(field, convertToYcrdt(value))
			}
		}, origin)
		return true
	})
}

// UpdateThreadItemFieldsRecursive searches all arrays (root + nested threads)
// for the THREAD item whose itemId matches and updates its fields in one
// transaction. Returns true if the item was found and updated.
//
// It walks every item rather than every thread (walkThreads skips aliases,
// because container questions are not asked of an item that holds no
// transcript), so it reaches an alias and a receipt as readily as a canonical.
// Those are exactly the items whose per-call bookkeeping — the
// runResultFedTurn stamp, a receipt's run selector — has to be written.
func (cd *ConversationDocument) UpdateThreadItemFieldsRecursive(itemID string, fields map[string]any) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return walkAllItems(cd.getItems(), "", func(m *ycrdt.YMap, _ string) bool {
		if id := yMapString(m, keyItemID); id != itemID {
			return false
		}
		if t := yMapString(m, keyType); t != ItemTypeThread {
			return false
		}
		cd.doc.Transact(func(_ *ycrdt.Transaction) {
			for field, value := range fields {
				m.Set(field, convertToYcrdt(value))
			}
		}, docInternalOrigin)
		return true
	})
}

// extractModelConfigFromMap extracts a concrete {provider, model} ModelConfig
// from a map or Y.Map value. A missing or incomplete pair returns nil so the
// caller's "please select a model" guard still trips, exactly as if no config
// were present.
func (cd *ConversationDocument) extractModelConfigFromMap(raw any) *ModelConfig {
	switch v := raw.(type) {
	case *ycrdt.YMap:
		provider := yMapString(v, keyProvider)
		model := yMapString(v, keyModel)
		thinking := yMapString(v, keyThinking)
		serviceTier := yMapString(v, keyServiceTier)
		if provider != "" && model != "" {
			return &ModelConfig{Provider: provider, Model: model, Thinking: thinking, ServiceTier: serviceTier}
		}
	case map[string]any:
		provider, _ := v[keyProvider].(string)
		model, _ := v[keyModel].(string)
		thinking, _ := v[keyThinking].(string)
		serviceTier, _ := v[keyServiceTier].(string)
		if provider != "" && model != "" {
			return &ModelConfig{Provider: provider, Model: model, Thinking: thinking, ServiceTier: serviceTier}
		}
	}
	return nil
}

// ResolveEffectiveStrategyID resolves the strategy id for a thread by walking up
// the parent chain: thread Y.Map `currentStrategyId` → parent thread → ... → doc
// metadata `currentStrategyId`. A missing/empty value normalizes to
// defaultStrategyID. Mirrors ResolveEffectiveModelConfig — a sub-thread inherits
// the conversation's strategy unless it carries its own override.
func (cd *ConversationDocument) ResolveEffectiveStrategyID(threadItemID string) string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.resolveEffectiveStrategyID(threadItemID)
}

func (cd *ConversationDocument) resolveEffectiveStrategyID(threadItemID string) string {
	if threadItemID != "" {
		if threadMap := findThreadYMap(cd.getItems(), threadItemID); threadMap != nil {
			if s := yMapString(threadMap, keyCurrentStrategyID); s != "" {
				return s
			}
		}
		if parentID := cd.findParentThreadID(threadItemID); parentID != "" {
			return cd.resolveEffectiveStrategyID(parentID)
		}
	}
	if s := yMapString(cd.metadata, keyCurrentStrategyID); s != "" {
		return s
	}
	return defaultStrategyID
}

// GetActivatedStrategyID returns the strategy id whose onActivate hook has
// already run for this thread — the per-thread activation marker. Root uses doc
// metadata (it has no Y.Map of its own); a sub-thread uses its own Y.Map. The
// marker is NOT inherited: each thread activates its own effective strategy
// exactly once.
func (cd *ConversationDocument) GetActivatedStrategyID(threadItemID string) string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if threadItemID == "" {
		s := yMapString(cd.metadata, keyActivatedStrategyID)
		return s
	}
	if m := findThreadYMap(cd.getItems(), threadItemID); m != nil {
		s := yMapString(m, keyActivatedStrategyID)
		return s
	}
	return ""
}

// SetActivatedStrategyID records that this thread has run its onActivate hook for
// strategyID. Root → doc metadata; sub-thread → its own Y.Map. Delegates to the
// self-locking SetMetadata / SetThreadField, so callers must NOT hold ycrdtMu.
func (cd *ConversationDocument) SetActivatedStrategyID(threadItemID, strategyID string) {
	if threadItemID == "" {
		cd.SetMetadata(keyActivatedStrategyID, strategyID)
		return
	}
	cd.SetThreadField(threadItemID, keyActivatedStrategyID, strategyID)
}

// ResolveEffectiveModelConfig resolves the model config for a thread by walking
// up the parent chain. Checks thread Y.Map → parent thread → ... → doc metadata.
func (cd *ConversationDocument) ResolveEffectiveModelConfig(threadItemID string) *ModelConfig {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return cd.resolveEffectiveModelConfig(threadItemID)
}

func (cd *ConversationDocument) resolveEffectiveModelConfig(threadItemID string) *ModelConfig {
	if threadItemID != "" {
		threadMap := findThreadYMap(cd.getItems(), threadItemID)
		if threadMap != nil {
			raw := threadMap.Get(keyModelConfig)
			if mc := cd.extractModelConfigFromMap(raw); mc != nil {
				return mc
			}
		}

		parentID := cd.findParentThreadID(threadItemID)
		if parentID != "" {
			return cd.resolveEffectiveModelConfig(parentID)
		}
	}

	// Conversation-level DEFAULT lives under `defaultModelConfig`; the
	// thread-level override key (read above) stays `modelConfig`. Fall back to
	// the legacy `modelConfig` METADATA key so a pre-rename session whose default
	// was persisted under it still resolves, rather than being stuck on "please
	// select a model" despite holding a real default. The new key wins when both
	// are present, so the fallback never shadows a current default.
	raw := cd.metadata.Get(keyDefaultModelConfig)
	if raw == nil {
		raw = cd.metadata.Get(keyModelConfig)
	}
	if raw == nil {
		return nil
	}
	// Route through the same shape-aware extractor used for thread-level
	// configs so the doc metadata resolves identically.
	if mc := cd.extractModelConfigFromMap(raw); mc != nil {
		return mc
	}
	converted := fromYcrdt(raw)
	if mc, ok := converted.(map[string]any); ok {
		provider, _ := mc[keyProvider].(string)
		model, _ := mc[keyModel].(string)
		thinking, _ := mc[keyThinking].(string)
		serviceTier, _ := mc[keyServiceTier].(string)
		if provider != "" && model != "" {
			return &ModelConfig{Provider: provider, Model: model, Thinking: thinking, ServiceTier: serviceTier}
		}
	}
	return nil
}
