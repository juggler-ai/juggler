//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"

	ycrdt "github.com/skyterra/y-crdt"
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
	v, _ := m.Get(key).(string)
	return v
}

// yMapBool reads a bool field from a Y.Map, returning false if absent or wrong type.
func yMapBool(m *ycrdt.YMap, key string) bool {
	v, _ := m.Get(key).(bool)
	return v
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

// CollectDraftAssetIDs adds every asset id referenced by an UNSENT draft — the
// root draft (conversation metadata) and each thread container's draft — to
// dst. A draft's attachments live on container/metadata state, NOT on a
// committed item, so the item walk in collectAssetIDsFromItems never sees them;
// without this a staged-but-unsent attachment's bytes would be reclaimed by the
// asset sweep and the persisted draft ref would dangle after a restart. Mirrors
// the JS `draft` accessor in web/js/model/message-thread.js.
func (cd *ConversationDocument) CollectDraftAssetIDs(dst map[string]bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	addDraftAssetIDs(yMapRawJSON(cd.metadata, "draft"), dst)
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
		addDraftAssetIDs(yMapRawJSON(m, "draft"), dst)
		if nested, ok := m.Get("items").(*ycrdt.YArray); ok {
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

	// Extract nested items before converting; threads need a Y.Array, not raw slice.
	var nestedItems []any
	if itemType, _ := m["type"].(string); itemType == ItemTypeThread {
		if rawItems, ok := m["items"]; ok {
			if arr, ok := rawItems.([]any); ok {
				nestedItems = arr
			}
			delete(m, "items")
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
		yarr := ycrdt.NewYArray()
		for _, rawItem := range nestedItems {
			if itemMap, ok := rawItem.(map[string]any); ok {
				itemData, err := json.Marshal(itemMap)
				if err != nil {
					continue
				}
				var nestedItem ConversationItem
				if err := json.Unmarshal(itemData, &nestedItem); err != nil {
					continue
				}
				yarr.Push(ycrdt.ArrayAny{conversationItemToYMap(nestedItem)})
			}
		}
		ymap.Set("items", yarr)
	}

	return ymap
}

// yMapToConversationItem converts a *ycrdt.YMap back to a ConversationItem.
func yMapToConversationItem(m *ycrdt.YMap) ConversationItem {
	item := ConversationItem{
		Type:                   yMapString(m, "type"),
		ItemID:                 yMapString(m, "itemId"),
		Content:                yMapString(m, "content"),
		Summary:                yMapString(m, "summary"),
		Timestamp:              yMapString(m, "timestamp"),
		ToolUseID:              yMapString(m, "toolUseId"),
		ToolName:               yMapString(m, "toolName"),
		ToolInput:              yMapRawJSON(m, "toolInput"),
		State:                  yMapString(m, "state"),
		IsError:                yMapBool(m, "isError"),
		Cancelled:              yMapBool(m, "cancelled"),
		Result:                 yMapRawJSON(m, "result"),
		Goal:                   yMapString(m, "goal"),
		Items:                  yMapRawJSON(m, "items"),
		BoundedCompaction:      yMapBool(m, "boundedCompaction"),
		CompactionPromptItemID: yMapString(m, "compactionPromptItemId"),

		PreventUserDeletion: yMapBool(m, "preventUserDeletion"),
		IsNew:               yMapBool(m, "isNew"),
		Error:               yMapString(m, "error"),

		TransactionID: yMapString(m, "transactionId"),

		ApprovalOptions: yMapRawJSON(m, "approvalOptions"),
		DisplayData:     yMapRawJSON(m, "displayData"),
		Data:            yMapRawJSON(m, "data"),
	}

	if raw := yMapRawJSON(m, "providerData"); raw != nil {
		var pd map[string]any
		if json.Unmarshal(raw, &pd) == nil {
			item.ProviderData = pd
		}
	}

	if raw := yMapRawJSON(m, "attachments"); raw != nil {
		var atts []AssetRef
		if json.Unmarshal(raw, &atts) == nil {
			item.Attachments = atts
		}
	}

	if raw := yMapRawJSON(m, "taskSource"); raw != nil {
		var ts TaskSourceRef
		if json.Unmarshal(raw, &ts) == nil && ts.TaskID != "" {
			item.TaskSource = &ts
		}
	}

	return item
}
