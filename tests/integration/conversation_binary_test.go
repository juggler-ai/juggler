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

// TestConversationBinary_SaveAndLoad tests basic binary conversation save/reload
func TestConversationBinary_SaveAndLoad(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create session manager
	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	convID := "conv_test_001"

	// Mock Yjs binary data (realistic format - starts with update header)
	originalData := []byte{
		0x00, 0x01, 0x02, 0x03, 0x04, 0x05, // Header bytes
		0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, // "Hello "
		0x57, 0x6f, 0x72, 0x6c, 0x64, 0x21, // "World!"
	}

	// Save binary conversation
	err = manager.SaveConversationBinary(convID, originalData)
	helpers.AssertNoError(t, err)

	// Verify doc.yjs exists inside the per-conv folder
	convPath := convDocPath(t, projectDir, convID)
	_, err = os.Stat(convPath)
	helpers.AssertNoError(t, err)

	// Load binary conversation
	loadedData, err := manager.LoadConversationBinary(convID)
	helpers.AssertNoError(t, err)
	helpers.AssertNotNil(t, loadedData)

	// Verify data matches exactly
	if len(loadedData) != len(originalData) {
		t.Fatalf("Expected data length %d but got %d", len(originalData), len(loadedData))
	}

	for i := range originalData {
		if loadedData[i] != originalData[i] {
			t.Errorf("Byte mismatch at index %d: expected %02x but got %02x", i, originalData[i], loadedData[i])
		}
	}
}

// TestConversationBinary_LoadNonexistent tests loading a conversation that doesn't exist
func TestConversationBinary_LoadNonexistent(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	// Try to load nonexistent conversation
	_, err = manager.LoadConversationBinary("conv_nonexistent")
	helpers.AssertError(t, err)
	helpers.AssertErrorContains(t, err, "conversation not found")
}

// TestConversationBinary_SaveEmpty tests saving empty binary data
func TestConversationBinary_SaveEmpty(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	convID := "conv_empty"

	// Save empty data
	emptyData := []byte{}
	err = manager.SaveConversationBinary(convID, emptyData)
	helpers.AssertNoError(t, err)

	// Load and verify
	loadedData, err := manager.LoadConversationBinary(convID)
	helpers.AssertNoError(t, err)
	helpers.AssertEqual(t, len(loadedData), 0)
}

// TestConversationBinary_Overwrite tests overwriting existing conversation
func TestConversationBinary_Overwrite(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	convID := "conv_overwrite"

	// Save first version
	firstData := []byte{0x01, 0x02, 0x03}
	err = manager.SaveConversationBinary(convID, firstData)
	helpers.AssertNoError(t, err)

	// Save second version (overwrite)
	secondData := []byte{0x04, 0x05, 0x06, 0x07}
	err = manager.SaveConversationBinary(convID, secondData)
	helpers.AssertNoError(t, err)

	// Load and verify we got the second version
	loadedData, err := manager.LoadConversationBinary(convID)
	helpers.AssertNoError(t, err)
	helpers.AssertEqual(t, len(loadedData), len(secondData))

	for i := range secondData {
		if loadedData[i] != secondData[i] {
			t.Errorf("Expected byte %02x at index %d but got %02x", secondData[i], i, loadedData[i])
		}
	}
}

// TestConversationBinary_MultipleConversations tests multiple conversations in same session
func TestConversationBinary_MultipleConversations(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	// Save multiple conversations
	conversations := map[string][]byte{
		"conv_001": {0x01, 0x02, 0x03},
		"conv_002": {0x04, 0x05, 0x06},
		"conv_003": {0x07, 0x08, 0x09},
	}

	for convID, data := range conversations {
		err = manager.SaveConversationBinary(convID, data)
		helpers.AssertNoError(t, err)
	}

	// Load and verify each conversation
	for convID, expectedData := range conversations {
		loadedData, err := manager.LoadConversationBinary(convID)
		helpers.AssertNoError(t, err)
		helpers.AssertEqual(t, len(loadedData), len(expectedData))

		for i := range expectedData {
			if loadedData[i] != expectedData[i] {
				t.Errorf("Conversation %s: expected byte %02x at index %d but got %02x",
					convID, expectedData[i], i, loadedData[i])
			}
		}
	}
}

// TestConversationBinary_LargeData tests saving and loading large binary data
func TestConversationBinary_LargeData(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	convID := "conv_large"

	// Create large data (1MB)
	largeData := make([]byte, 1024*1024)
	for i := range largeData {
		largeData[i] = byte(i % 256)
	}

	// Save large data
	err = manager.SaveConversationBinary(convID, largeData)
	helpers.AssertNoError(t, err)

	// Load and verify
	loadedData, err := manager.LoadConversationBinary(convID)
	helpers.AssertNoError(t, err)
	helpers.AssertEqual(t, len(loadedData), len(largeData))

	// Verify a few sample bytes rather than all (for performance)
	checkPoints := []int{0, 1000, 50000, 500000, len(largeData) - 1}
	for _, i := range checkPoints {
		if loadedData[i] != largeData[i] {
			t.Errorf("Large data mismatch at index %d: expected %02x but got %02x",
				i, largeData[i], loadedData[i])
		}
	}
}

// TestConversationBinary_ConcurrentSaves tests concurrent saves to different conversations
func TestConversationBinary_ConcurrentSaves(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	// Start concurrent saves
	done := make(chan bool, 10)
	for i := range 10 {
		go func(index int) {
			convID := "conv_concurrent_" + string(rune('0'+index))
			data := []byte{byte(index), byte(index + 1), byte(index + 2)}

			err := manager.SaveConversationBinary(convID, data)
			if err != nil {
				t.Errorf("Concurrent save %d failed: %v", index, err)
			}

			done <- true
		}(i)
	}

	// Wait for all saves to complete
	for range 10 {
		<-done
	}

	// Verify all conversations were saved
	for i := range 10 {
		convID := "conv_concurrent_" + string(rune('0'+i))
		loadedData, err := manager.LoadConversationBinary(convID)
		helpers.AssertNoError(t, err)
		helpers.AssertEqual(t, len(loadedData), 3)
		helpers.AssertEqual(t, loadedData[0], byte(i))
	}
}
