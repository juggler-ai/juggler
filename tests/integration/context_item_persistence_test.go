//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"os"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/tests/helpers"
)

// TestContextItemPersistence_SaveAndLoad tests that context items persist in .yjs file
func TestContextItemPersistence_SaveAndLoad(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create session manager
	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	// Get the session
	session := manager.GetSession()
	helpers.AssertNotNil(t, session)

	convID := "conv_ci_test_001"

	// Mock Yjs binary data that includes context items
	// This would be actual Yjs-encoded data with context items in a real scenario
	// For this test, we're verifying the file operations work correctly
	yjsDataWithItems := []byte{
		0x00, 0x01, 0x02, 0x03, // Header
		0x48, 0x65, 0x6c, 0x6c, 0x6f, // "Hello"
		// In reality, Yjs encodes context items as part of the document structure
		0x46, 0x41, 0x43, 0x54, // "FACT" marker (mock)
		0x01, 0x02, 0x03, 0x04, // Context item data
	}

	// Save Yjs data (which includes context items)
	err = manager.SaveConversationBinary(convID, yjsDataWithItems)
	helpers.AssertNoError(t, err)

	// Verify file exists
	convPath := convDocPath(t, projectDir, convID)
	_, err = os.Stat(convPath)
	helpers.AssertNoError(t, err)

	// Load Yjs data
	loadedData, err := manager.LoadConversationBinary(convID)
	helpers.AssertNoError(t, err)
	helpers.AssertNotNil(t, loadedData)

	// Verify data matches (context items are preserved in Yjs binary format)
	if len(loadedData) != len(yjsDataWithItems) {
		t.Fatalf("Expected data length %d but got %d", len(yjsDataWithItems), len(loadedData))
	}

	for i := range yjsDataWithItems {
		if loadedData[i] != yjsDataWithItems[i] {
			t.Errorf("Byte mismatch at index %d: expected %02x but got %02x", i, yjsDataWithItems[i], loadedData[i])
		}
	}
}

// TestContextItemPersistence_EmptyContextItems tests saving and loading with empty context items
func TestContextItemPersistence_EmptyContextItems(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	convID := "conv_empty_context_items"

	// Mock Yjs data with no context items (minimal document)
	yjsDataNoItems := []byte{
		0x00, 0x01, 0x02, 0x03, // Header
		// No context item data
	}

	// Save Yjs data
	err = manager.SaveConversationBinary(convID, yjsDataNoItems)
	helpers.AssertNoError(t, err)

	// Load and verify
	loadedData, err := manager.LoadConversationBinary(convID)
	helpers.AssertNoError(t, err)
	helpers.AssertEqual(t, len(loadedData), len(yjsDataNoItems))
}

// TestContextItemPersistence_MultipleContextItemTypes tests saving multiple context item types
func TestContextItemPersistence_MultipleContextItemTypes(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	convID := "conv_multiple_context_items"

	// Mock Yjs data with multiple context item types encoded
	// In a real scenario, this would be Yjs-encoded data with:
	// - file context items (read_file)
	// - tree context items (tree)
	// - search context items (grep)
	// - custom context items
	yjsDataMultipleItems := []byte{
		0x00, 0x01, 0x02, 0x03, // Header
		// Mock encoding of multiple context items
		0x46, 0x49, 0x4c, 0x45, // "FILE" context item type
		0x01, 0x02, 0x03, 0x04,
		0x54, 0x52, 0x45, 0x45, // "TREE" context item type
		0x05, 0x06, 0x07, 0x08,
		0x47, 0x52, 0x45, 0x50, // "GREP" context item type
		0x09, 0x0a, 0x0b, 0x0c,
	}

	// Save Yjs data
	err = manager.SaveConversationBinary(convID, yjsDataMultipleItems)
	helpers.AssertNoError(t, err)

	// Load and verify all context item data is preserved
	loadedData, err := manager.LoadConversationBinary(convID)
	helpers.AssertNoError(t, err)

	// Verify length matches (all context items preserved)
	helpers.AssertEqual(t, len(loadedData), len(yjsDataMultipleItems))

	// Verify specific context item markers are present
	// Check for "FILE" marker
	foundFile := false
	foundTree := false
	foundGrep := false

	for i := 0; i+3 < len(loadedData); i++ {
		if loadedData[i] == 0x46 && loadedData[i+1] == 0x49 && loadedData[i+2] == 0x4c && loadedData[i+3] == 0x45 {
			foundFile = true
		}
		if loadedData[i] == 0x54 && loadedData[i+1] == 0x52 && loadedData[i+2] == 0x45 && loadedData[i+3] == 0x45 {
			foundTree = true
		}
		if loadedData[i] == 0x47 && loadedData[i+1] == 0x52 && loadedData[i+2] == 0x45 && loadedData[i+3] == 0x50 {
			foundGrep = true
		}
	}

	if !foundFile {
		t.Error("FILE context item marker not found in loaded data")
	}
	if !foundTree {
		t.Error("TREE context item marker not found in loaded data")
	}
	if !foundGrep {
		t.Error("GREP context item marker not found in loaded data")
	}
}
