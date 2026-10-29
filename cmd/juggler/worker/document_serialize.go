//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"

	ycrdt "github.com/skyterra/y-crdt"

	"juggler/internal/jlog"
)

// ToJSON returns the document as JSON (unified storage - context items are in items).
func (cd *ConversationDocument) ToJSON() map[string]any {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	var rawItems []any
	if arr := cd.getItems(); arr != nil {
		rawItems = arr.ToArray()
	}
	items := make([]any, len(rawItems))
	for i, raw := range rawItems {
		if m, ok := raw.(*ycrdt.YMap); ok {
			items[i] = fromYcrdt(m.ToJson())
		} else {
			items[i] = fromYcrdt(raw)
		}
	}

	metadata := make(map[string]any)
	for k, v := range cd.metadata.Entries() {
		metadata[k] = fromYcrdt(v)
	}

	authors := make(map[string]any)
	for k, v := range cd.authors.Entries() {
		authors[k] = fromYcrdt(v)
	}

	return map[string]any{
		"items":    items,
		"metadata": metadata,
		"authors":  authors,
	}
}

// toYcrdt converts a Go value to y-crdt format (Object/ArrayAny).
func toYcrdt(value any) any {
	if value == nil {
		return nil
	}
	data, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var result any
	if err := json.Unmarshal(data, &result); err != nil {
		return value
	}
	return convertToYcrdt(result)
}

// convertToYcrdt recursively converts Go types to y-crdt types.
func convertToYcrdt(value any) any {
	if value == nil {
		return nil
	}

	switch v := value.(type) {
	case map[string]any:
		obj := ycrdt.NewObject()
		for k, val := range v {
			if val == nil {
				continue // y-crdt corrupts nil to {} during encode/decode
			}
			obj[k] = convertToYcrdt(val)
		}
		return obj
	case []any:
		arr := make(ycrdt.ArrayAny, len(v))
		for i, val := range v {
			arr[i] = convertToYcrdt(val)
		}
		return arr
	case float64:
		// JSON unmarshal produces float64 for all numbers, but y-crdt's
		// YMap.Set() only accepts Number (=int), not float64.
		if v == float64(int(v)) {
			return int(v)
		}
		return v
	default:
		return v
	}
}

// fromYcrdt converts a y-crdt value back to standard Go types.
func fromYcrdt(value any) any {
	if value == nil {
		return nil
	}

	switch v := value.(type) {
	case ycrdt.UndefinedType:
		return nil
	case ycrdt.NullType:
		return nil
	case ycrdt.Object:
		m := make(map[string]any)
		for k, val := range v {
			m[k] = fromYcrdt(val)
		}
		return m
	case ycrdt.ArrayAny:
		arr := make([]any, len(v))
		for i, val := range v {
			arr[i] = fromYcrdt(val)
		}
		return arr
	default:
		return v
	}
}

// yMapString reads a string field from a Y.Map, returning "" if absent or wrong type.
func yMapString(m *ycrdt.YMap, key string) string {
	v, _ := yMapStringOK(m, key)
	return v
}

// yMapBool reads a bool field from a Y.Map, returning false if absent or wrong type.
func yMapBool(m *ycrdt.YMap, key string) bool {
	v, _ := yMapBoolOK(m, key)
	return v
}

// The (value, ok) readers below report ok=false alike for a key that is absent
// and one holding another kind, and ok=true for a present zero value. Callers
// that only want the value use yMapString / yMapBool.

// yMapStringOK reads a string field from a Y.Map.
func yMapStringOK(m *ycrdt.YMap, key string) (string, bool) {
	v, ok := m.Get(key).(string)
	return v, ok
}

// yMapBoolOK reads a bool field from a Y.Map.
func yMapBoolOK(m *ycrdt.YMap, key string) (bool, bool) {
	v, ok := m.Get(key).(bool)
	return v, ok
}

// yMapInt64 reads a numeric field from a Y.Map as an integer, whichever kind
// the encoding produced (see yNumberInt64).
func yMapInt64(m *ycrdt.YMap, key string) (int64, bool) {
	return yNumberInt64(m.Get(key))
}

// yNumberInt64 reads a number the doc stores, reporting whether v was one. Go
// writes ycrdt.Number (int), and convertToYcrdt narrows an integral float64 to
// it; a JS client's integer past 31 bits decodes as float64, or float32 when
// that is exact, and a bigint as int64.
func yNumberInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case float64:
		return int64(n), true
	case float32:
		return int64(n), true
	case int:
		return int64(n), true
	default:
		return 0, false
	}
}

// yMapArray reads a nested Y.Array field from a Y.Map.
func yMapArray(m *ycrdt.YMap, key string) (*ycrdt.YArray, bool) {
	v, ok := m.Get(key).(*ycrdt.YArray)
	return v, ok && v != nil
}

// yMapMap reads a nested Y.Map field from a Y.Map.
func yMapMap(m *ycrdt.YMap, key string) (*ycrdt.YMap, bool) {
	v, ok := m.Get(key).(*ycrdt.YMap)
	return v, ok && v != nil
}

// yMapRawJSON reads a field from a Y.Map and marshals it to json.RawMessage.
// Returns nil if the field is absent or null.
func yMapRawJSON(m *ycrdt.YMap, key string) json.RawMessage {
	v := m.Get(key)
	if v == nil {
		return nil
	}
	if _, ok := v.(ycrdt.NullType); ok {
		return nil
	}
	if _, ok := v.(ycrdt.UndefinedType); ok {
		return nil
	}
	switch yv := v.(type) {
	case *ycrdt.YMap:
		v = fromYcrdt(yv.ToJson())
	case *ycrdt.YArray:
		v = fromYcrdt(yv.ToJson())
	default:
		v = fromYcrdt(v)
	}
	data, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return data
}

// collectDraftAssetIDsLocked adds every asset id referenced by an UNSENT draft —
// the root draft (conversation metadata) and each thread container's draft — to
// dst. A draft's attachments live on container/metadata state, NOT on a
// committed item, so the item walk in collectAssetIDsFromItems never sees them;
// without this a staged-but-unsent attachment's bytes would be reclaimed by the
// asset sweep and the persisted draft ref would dangle after a restart. Mirrors
// the JS `draft` accessor in web/js/model/message-thread.js. Caller MUST hold
// ycrdtMu.
func (cd *ConversationDocument) collectDraftAssetIDsLocked(dst map[string]bool) {
	addDraftAssetIDs(yMapRawJSON(cd.metadata, keyDraft), dst)
	if arr := cd.getItems(); arr != nil {
		collectDraftAssetIDsFromArray(arr, dst)
	}
}

// collectDraftAssetIDsFromArray walks an items Y.Array (recursing into each
// thread's nested "items") collecting draft attachment ids. Callers MUST hold
// ycrdtMu.
func collectDraftAssetIDsFromArray(arr *ycrdt.YArray, dst map[string]bool) {
	length := int(arr.GetLength())
	for i := 0; i < length; i++ {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		addDraftAssetIDs(yMapRawJSON(m, keyDraft), dst)
		if nested, ok := yMapArray(m, keyItems); ok {
			collectDraftAssetIDsFromArray(nested, dst)
		}
	}
}

// addDraftAssetIDs parses a draft record's attachment ids out of its raw JSON
// ({text, attachments}) and adds the non-empty ones to dst.
func addDraftAssetIDs(raw json.RawMessage, dst map[string]bool) {
	if len(raw) == 0 {
		return
	}
	var d struct {
		Attachments []AssetRef `json:"attachments"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return
	}
	for _, a := range d.Attachments {
		if a.ID != "" {
			dst[a.ID] = true
		}
	}
}

// threadResultString extracts the plain string from a thread item's Result field.
// Thread results are stored as JSON-encoded strings in ConversationItem.Result.
func threadResultString(item ConversationItem) string {
	var s string
	if json.Unmarshal(item.Result, &s) == nil {
		return s
	}
	return ""
}

// conversationItemToYMap converts a ConversationItem to a *ycrdt.YMap for Y.Array insertion.
// Uses JSON round-trip for field iteration, then converts values to y-crdt types.
// For thread items with nested "items", creates a proper Y.Array of Y.Maps.
func conversationItemToYMap(item ConversationItem) *ycrdt.YMap {
	data, err := json.Marshal(item)
	if err != nil {
		return ycrdt.NewYMap(nil)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return ycrdt.NewYMap(nil)
	}
	return itemMapToYMap(m)
}

// nestedItemYMap builds the Y.Map for one of a thread's nested items, given as
// JSON. An item that fits ConversationItem goes through it, as every item
// written from the struct does. One that does not — a field holding another
// kind, which a client or plugin can write — is converted as it stands rather
// than dropped, and logged: losing an item from a transcript is worse than
// keeping one whose odd field readers will see as unset. ok is false only for
// an entry that is not a JSON object at all.
func nestedItemYMap(raw json.RawMessage) (m *ycrdt.YMap, ok bool) {
	var item ConversationItem
	err := json.Unmarshal(raw, &item)
	if err == nil {
		return conversationItemToYMap(item), true
	}
	var fields map[string]any
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		jlog.Error("[doc] dropped a nested item that is not a JSON object: %.80s", raw)
		return nil, false
	}
	id, _ := fields[keyItemID].(string)
	jlog.Error("[doc] nested item %q does not fit ConversationItem (%v); kept as written", id, err)
	return itemMapToYMap(fields), true
}

// itemMapToYMap builds an item's Y.Map from its JSON form, giving a thread's
// nested items a Y.Array of their own.
func itemMapToYMap(m map[string]any) *ycrdt.YMap {
	// Extract nested items before converting; threads need a Y.Array, not raw slice.
	var nestedItems []any
	if itemType, _ := m[keyType].(string); itemType == ItemTypeThread {
		if rawItems, ok := m[keyItems]; ok {
			if arr, ok := rawItems.([]any); ok {
				nestedItems = arr
			}
			delete(m, keyItems)
		}
	}

	entries := make(map[string]any)
	for k, v := range m {
		if v == nil {
			continue
		}
		entries[k] = convertToYcrdt(v)
	}
	ymap := ycrdt.NewYMap(entries)

	if nestedItems != nil {
		// One Push of the whole transcript. yarr is not in the document yet, and
		// Push on such an array inserts at its integrated length, which stays 0
		// until it is — so pushing item by item would store the transcript
		// reversed.
		children := make(ycrdt.ArrayAny, 0, len(nestedItems))
		for _, rawItem := range nestedItems {
			itemData, err := json.Marshal(rawItem)
			if err != nil {
				continue
			}
			if child, ok := nestedItemYMap(itemData); ok {
				children = append(children, child)
			}
		}
		yarr := ycrdt.NewYArray()
		yarr.Push(children)
		ymap.Set(keyItems, yarr)
	}

	return ymap
}

// cloneContextItemYMap deep-clones a context-item Y.Map via the generic
// ToJson round-trip, assigning newID as its itemId. Unlike
// yMapToConversationItem/conversationItemToYMap — which carry only the named
// ConversationItem struct fields — this preserves arbitrary plugin `data`,
// preventUserDeletion, itemType, and any other keys, so a seeded system-prompt/
// memory/agents-file item keeps its full payload. The round-trip drops
// nil-valued fields (convertToYcrdt) — harmless, since y-crdt corrupts nils on
// encode anyway. Callers MUST hold ycrdtMu.
func cloneContextItemYMap(src *ycrdt.YMap, newID string) *ycrdt.YMap {
	raw, ok := fromYcrdt(src.ToJson()).(map[string]any)
	if !ok {
		return ycrdt.NewYMap(nil)
	}
	raw[keyItemID] = newID
	entries := make(map[string]any)
	for k, v := range raw {
		if v == nil {
			continue
		}
		entries[k] = convertToYcrdt(v)
	}
	return ycrdt.NewYMap(entries)
}

// yNode is a value read out of the document with its shape remembered: a Y.Map,
// a Y.Array, or a plain value. It is how a range of items is moved without
// passing through ConversationItem, which carries only the fields it declares —
// so a key a plugin or the browser wrote, or a draft held as a Y.Map, comes out
// the other side as it went in. A snapshot holds copies only, so the items it
// was read from can be deleted before it is written back.
type yNode struct {
	isMap, isArray bool
	entries        map[string]yNode // a Y.Map's entries
	elems          []yNode          // a Y.Array's elements
	plain          any              // anything else, deep-copied
}

// snapshotYValue reads v, and everything under it, into a yNode. Callers MUST
// hold ycrdtMu.
func snapshotYValue(v any) yNode {
	switch t := v.(type) {
	case *ycrdt.YMap:
		n := yNode{isMap: true, entries: map[string]yNode{}}
		t.ForEach(func(key string, val any, _ *ycrdt.YMap) {
			n.entries[key] = snapshotYValue(val)
		})
		return n
	case *ycrdt.YArray:
		n := yNode{isArray: true}
		for _, el := range t.ToArray() {
			n.elems = append(n.elems, snapshotYValue(el))
		}
		return n
	default:
		return yNode{plain: convertToYcrdt(fromYcrdt(v))}
	}
}

// appendYNode writes n at the end of the live array arr. Shared-type children
// are written only once their parent is in the document, the order
// insertItemWithNested keeps for the reason it gives. A nil plain value is
// skipped: y-crdt corrupts nil on encode. Callers must be inside an active
// Transact and hold ycrdtMu.
func appendYNode(arr *ycrdt.YArray, n yNode) {
	end := arr.GetLength()
	switch {
	case n.isMap:
		m := prelimYMap(n)
		arr.Insert(end, ycrdt.ArrayAny{m})
		fillYMap(m, n)
	case n.isArray:
		child := ycrdt.NewYArray()
		arr.Insert(end, ycrdt.ArrayAny{child})
		for _, el := range n.elems {
			appendYNode(child, el)
		}
	case n.plain != nil:
		arr.Insert(end, ycrdt.ArrayAny{n.plain})
	}
}

// prelimYMap is a new Y.Map holding n's plain entries; fillYMap writes the rest
// once it is in the document.
func prelimYMap(n yNode) *ycrdt.YMap {
	entries := map[string]any{}
	for key, child := range n.entries {
		if !child.isMap && !child.isArray && child.plain != nil {
			entries[key] = child.plain
		}
	}
	return ycrdt.NewYMap(entries)
}

// fillYMap writes n's shared-type entries into m, which is in the document.
func fillYMap(m *ycrdt.YMap, n yNode) {
	for key, child := range n.entries {
		switch {
		case child.isMap:
			c := prelimYMap(child)
			m.Set(key, c)
			fillYMap(c, child)
		case child.isArray:
			c := ycrdt.NewYArray()
			m.Set(key, c)
			for _, el := range child.elems {
				appendYNode(c, el)
			}
		}
	}
}

// yMapToConversationItem converts a *ycrdt.YMap back to a ConversationItem.
func yMapToConversationItem(m *ycrdt.YMap) ConversationItem {
	item := ConversationItem{
		Type:                   yMapString(m, keyType),
		ItemID:                 yMapString(m, keyItemID),
		Content:                yMapString(m, keyContent),
		Source:                 yMapString(m, keySource),
		Summary:                yMapString(m, keySummary),
		Timestamp:              yMapString(m, keyTimestamp),
		ToolUseID:              yMapString(m, keyToolUseID),
		ToolName:               yMapString(m, keyToolName),
		ToolInput:              yMapRawJSON(m, keyToolInput),
		State:                  yMapString(m, keyState),
		Category:               yMapString(m, keyCategory),
		IsError:                yMapBool(m, keyIsError),
		Cancelled:              yMapBool(m, keyCancelled),
		Result:                 yMapRawJSON(m, keyResult),
		Hooks:                  yMapRawJSON(m, keyHooks),
		Goal:                   yMapString(m, keyGoal),
		Items:                  yMapRawJSON(m, keyItems),
		BoundedCompaction:      yMapBool(m, keyBoundedCompaction),
		CompactionPromptItemID: yMapString(m, keyCompactionPromptItemID),
		ContextSeeded:          yMapBool(m, keyContextSeeded),
		SessionName:            yMapString(m, keySessionName),
		AliasOf:                yMapString(m, keyAliasOf),
		NeedsStrategyRun:       yMapBool(m, keyNeedsStrategyRun),
		NoAutoSelect:           yMapBool(m, keyNoAutoSelect),
		NoContextSeed:          yMapBool(m, keyNoContextSeed),
		ForceTool:              yMapString(m, keyForceTool),
		HandoffPromote:         yMapBool(m, keyHandoffPromote),
		RunToolUseID:           yMapString(m, keyRunToolUseID),
		RunToolName:            yMapString(m, keyRunToolName),
		RunToolInput:           yMapRawJSON(m, keyRunToolInput),
		RunGoal:                yMapString(m, keyRunGoal),
		RunStatus:              yMapString(m, keyRunStatus),
		RunResult:              yMapString(m, keyRunResult),
		Continuation:           yMapBool(m, keyContinuation),
		RunItemID:              yMapString(m, keyRunItemID),
		RecoversError:          yMapBool(m, keyRecoversError),
		RunResultFed:           yMapBool(m, keyRunResultFed),

		LLMCreated:      yMapBool(m, keyLLMCreated),
		StrategyCreated: yMapBool(m, keyStrategyCreated),
		CanSpawnThreads: yMapBool(m, keyCanSpawnThreads),
		Delegated:       yMapBool(m, keyDelegated),
		ReadOnly:        yMapBool(m, keyReadOnly),
		ResultSpec:      yMapString(m, keyResultSpec),
		Draft:           yMapRawJSON(m, keyDraft),
		Executor:        yMapString(m, keyExecutor),

		PreventUserDeletion: yMapBool(m, keyPreventUserDeletion),
		IsNew:               yMapBool(m, keyIsNew),
		Error:               yMapString(m, keyError),

		TransactionID: yMapString(m, keyTransactionID),

		ApprovalOptions: yMapRawJSON(m, keyApprovalOptions),
		DisplayData:     yMapRawJSON(m, keyDisplayData),
		Data:            yMapRawJSON(m, keyData),
	}

	if raw := yMapRawJSON(m, keyProviderData); raw != nil {
		var pd map[string]any
		if json.Unmarshal(raw, &pd) == nil {
			item.ProviderData = pd
		}
	}

	if raw := yMapRawJSON(m, keyAttachments); raw != nil {
		var atts []AssetRef
		if json.Unmarshal(raw, &atts) == nil {
			item.Attachments = atts
		}
	}

	if raw := yMapRawJSON(m, keyHeldAssets); raw != nil {
		var held []string
		if json.Unmarshal(raw, &held) == nil {
			item.HeldAssets = held
		}
	}

	if raw := yMapRawJSON(m, keyFoldedRuns); raw != nil {
		var runs []FoldedRun
		if json.Unmarshal(raw, &runs) == nil {
			item.FoldedRuns = runs
		}
	}

	if raw := yMapRawJSON(m, keyTaskSource); raw != nil {
		var ts TaskSourceRef
		if json.Unmarshal(raw, &ts) == nil && ts.TaskID != "" {
			item.TaskSource = &ts
		}
	}

	return item
}
