//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package helpers

import (
	"encoding/json"
	"fmt"
	"testing"

	"juggler/cmd/juggler/worker"
)

// DocumentState represents the expected state of a ConversationDocument.
// All pointer fields are optional - if nil, that aspect won't be checked.
type DocumentState struct {
	ItemCount        *int            // Expected number of items in items array
	Items            []ItemAssertion // Expected items (order matters, use Index to specify position)
	ContextItems     map[string]bool // Expected context items (itemId -> should exist)
	ContextItemCount *int            // Expected number of context items
	Metadata         map[string]any  // Expected metadata key-value pairs
	UndoAvailable    *bool           // Whether undo should be available
	RedoAvailable    *bool           // Whether redo should be available
}

// ItemAssertion describes expected properties of an item in the items array.
// All string fields use empty string to mean "don't check this field".
// All pointer fields use nil to mean "don't check this field".
type ItemAssertion struct {
	Index     int    // Expected index in items array
	Type      string // Expected type (e.g., "tool-action", "user", "assistant")
	ToolUseID string // Expected ToolUseID (for tool-action items)
	State     string // Expected State (for tool-action items)
	Content   string // Expected content (exact match)
	ItemID    string // Expected ItemID (for context items)
	IsDeleted *bool  // Whether item should be marked as deleted
}

// AssertDocumentState verifies the worker's document matches the expected state.
// This is the primary assertion function for integration tests.
func AssertDocumentState(t *testing.T, w *worker.ConversationWorker, expected DocumentState) {
	t.Helper()

	doc := w.Document()
	if doc == nil {
		t.Fatal("Worker document is nil")
	}

	// Check item count
	if expected.ItemCount != nil {
		items := doc.GetItems()
		if len(items) != *expected.ItemCount {
			t.Errorf("Expected %d items, got %d", *expected.ItemCount, len(items))
		}
	}

	// Check individual items
	if len(expected.Items) > 0 {
		items := doc.GetItems()
		for _, assertion := range expected.Items {
			if assertion.Index >= len(items) {
				t.Errorf("Item index %d out of range (have %d items)", assertion.Index, len(items))
				continue
			}

			item := items[assertion.Index]
			assertItem(t, item, assertion, assertion.Index)
		}
	}

	// Check context items (unified storage - context items are items with an itemId)
	if expected.ContextItems != nil {
		items := doc.GetItems()
		contextItemIDs := make(map[string]bool)
		for _, item := range items {
			if item.ItemID != "" {
				contextItemIDs[item.ItemID] = true
			}
		}
		for itemID, shouldExist := range expected.ContextItems {
			exists := contextItemIDs[itemID]
			if exists != shouldExist {
				if shouldExist {
					t.Errorf("Expected context item %q to exist, but it doesn't", itemID)
				} else {
					t.Errorf("Expected context item %q to not exist, but it does", itemID)
				}
			}
		}
	}

	// Check context item count (unified storage - context items are items with an itemId)
	if expected.ContextItemCount != nil {
		items := doc.GetItems()
		contextItemCount := 0
		for _, item := range items {
			if item.ItemID != "" {
				contextItemCount++
			}
		}
		if contextItemCount != *expected.ContextItemCount {
			t.Errorf("Expected %d context items, got %d", *expected.ContextItemCount, contextItemCount)
		}
	}

	// Check metadata
	if expected.Metadata != nil {
		for key, expectedValue := range expected.Metadata {
			actualValue := doc.GetMetadata(key)
			if actualValue == nil {
				t.Errorf("Expected metadata key %q to exist", key)
				continue
			}
			if fmt.Sprintf("%v", actualValue) != fmt.Sprintf("%v", expectedValue) {
				t.Errorf("Metadata[%q]: expected %v, got %v", key, expectedValue, actualValue)
			}
		}
	}

	// Check undo/redo availability
	tracker := w.Tracker()
	if tracker != nil {
		if expected.UndoAvailable != nil {
			canUndo := tracker.CanUndo()
			if canUndo != *expected.UndoAvailable {
				t.Errorf("Expected CanUndo()=%v, got %v", *expected.UndoAvailable, canUndo)
			}
		}
		if expected.RedoAvailable != nil {
			canRedo := tracker.CanRedo()
			if canRedo != *expected.RedoAvailable {
				t.Errorf("Expected CanRedo()=%v, got %v", *expected.RedoAvailable, canRedo)
			}
		}
	}
}

// assertItem checks a single item matches the assertion.
func assertItem(t *testing.T, item worker.ConversationItem, assertion ItemAssertion, index int) {
	t.Helper()

	prefix := fmt.Sprintf("Item[%d]", index)

	// Check type
	if assertion.Type != "" {
		if item.Type != assertion.Type {
			t.Errorf("%s: expected type=%q, got %q", prefix, assertion.Type, item.Type)
		}
	}

	// Check ToolUseID
	if assertion.ToolUseID != "" {
		if item.ToolUseID != assertion.ToolUseID {
			t.Errorf("%s: expected toolUseId=%q, got %q", prefix, assertion.ToolUseID, item.ToolUseID)
		}
	}

	// Check State
	if assertion.State != "" {
		if item.State != assertion.State {
			t.Errorf("%s: expected state=%q, got %q", prefix, assertion.State, item.State)
		}
	}

	// Check content
	if assertion.Content != "" {
		if item.Content != assertion.Content {
			t.Errorf("%s: expected content=%q, got %q", prefix, assertion.Content, item.Content)
		}
	}

	// Check ItemID
	if assertion.ItemID != "" {
		if item.ItemID != assertion.ItemID {
			t.Errorf("%s: expected itemId=%q, got %q", prefix, assertion.ItemID, item.ItemID)
		}
	}
}

// DumpDocument prints the document state for debugging.
// Use this when a test fails to see the actual state.
func DumpDocument(t *testing.T, doc *worker.ConversationDocument) {
	t.Helper()

	items := doc.GetItems()
	t.Logf("=== Document State ===")
	t.Logf("Items: %d", len(items))
	for i, item := range items {
		itemJSON, _ := json.MarshalIndent(item, "  ", "  ")
		t.Logf("Item[%d]: %s", i, string(itemJSON))
	}

	// Count context items (unified storage - context items are items with an itemId)
	contextItemCount := 0
	for _, item := range items {
		if item.ItemID != "" {
			t.Logf("  Context item: %s (index %d)", item.ItemID, contextItemCount)
			contextItemCount++
		}
	}
	t.Logf("Context items: %d", contextItemCount)

	t.Logf("CanUndo: (check tracker), CanRedo: (check tracker)")
}
