//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
	"juggler/tests/helpers"

	"github.com/gorilla/mux"
)

// TestConversationRoundTrip exercises the complete create/save/reload cycle:
//  1. Create session.
//  2. Atomically create a conversation via SessionManager.CreateConversation
//     (the path POST /api/conversations takes in production).
//  3. Save conversation bytes via HTTP PUT.
//  4. Verify session.json has conversationOrder updated.
//  5. Load conversation via HTTP GET using the same id.
//  6. Verify data matches.
//
// Mirrors the exact flow that runs when a user reloads the page.
func TestConversationRoundTrip(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create session manager
	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	// Atomically allocate a conversation. CreateConversation is the
	// authoritative id-introduction path (POST /api/conversations in
	// production).
	convID, _, err := manager.CreateConversation("roundtrip test")
	helpers.AssertNoError(t, err)

	// Create HTTP API (nil workerManager is fine for this test - no deletions)
	sessionAPI := handlers.NewSessionAPI(func() *core.SessionManager { return manager }, nil, nil, nil, nil)

	// Create router
	router := mux.NewRouter()
	router.HandleFunc("/api/session/conversations/{convId}", sessionAPI.HandleUpdateConversation).Methods("PUT")
	router.HandleFunc("/api/session/conversations/{convId}", sessionAPI.HandleGetConversation).Methods("GET")

	// Test data
	testData := []byte{
		0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
		0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, // "Hello!"
	}

	// === STEP 1: SAVE via HTTP PUT ===
	t.Log("STEP 1: Save conversation via HTTP PUT")
	req := httptest.NewRequest("PUT", "/api/session/conversations/"+convID, bytes.NewReader(testData))
	req.Header.Set("Content-Type", "application/octet-stream")
	req = mux.SetURLVars(req, map[string]string{"convId": convID})

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNoContent {
		t.Fatalf("Save failed: Expected status %d but got %d. Body: %s", http.StatusNoContent, rr.Code, rr.Body.String())
	}

	// === STEP 2: VERIFY session.json has conversationOrder ===
	t.Log("STEP 2: Verify session.json has conversationOrder")
	sessionJSONPath := filepath.Join(projectDir, ".juggler", "session.json")
	sessionJSON, err := os.ReadFile(sessionJSONPath)
	helpers.AssertNoError(t, err)

	var sessionData struct {
		ConversationOrder []string `json:"conversationOrder"`
	}
	err = json.Unmarshal(sessionJSON, &sessionData)
	helpers.AssertNoError(t, err)

	// Verify conversation is in order
	found := slices.Contains(sessionData.ConversationOrder, convID)
	if !found {
		t.Fatalf("Conversation %s NOT found in conversationOrder: %v", convID, sessionData.ConversationOrder)
	}
	t.Logf("✓ Conversation %s found in conversationOrder", convID)

	// === STEP 3: VERIFY doc.yjs file exists in correct location ===
	t.Log("STEP 3: Verify doc.yjs exists inside the per-conv folder")
	convFilePath := convDocPath(t, projectDir, convID)
	_, err = os.Stat(convFilePath)
	if os.IsNotExist(err) {
		t.Fatalf("Conversation doc NOT found at expected path: %s", convFilePath)
	}
	helpers.AssertNoError(t, err)
	t.Logf("✓ Conversation file exists at: %s", convFilePath)

	// === STEP 4: LOAD via HTTP GET (simulating page reload) ===
	t.Log("STEP 4: Load conversation via HTTP GET (simulating page reload)")
	req2 := httptest.NewRequest("GET", "/api/session/conversations/"+convID, nil)
	req2 = mux.SetURLVars(req2, map[string]string{"convId": convID})

	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req2)

	if rr2.Code != http.StatusOK {
		t.Fatalf("Load failed: Expected status %d but got %d. Body: %s", http.StatusOK, rr2.Code, rr2.Body.String())
	}

	// Check Content-Type
	contentType := rr2.Header().Get("Content-Type")
	if contentType != "application/octet-stream" {
		t.Errorf("Expected Content-Type 'application/octet-stream' but got '%s'", contentType)
	}

	// === STEP 5: VERIFY data matches ===
	t.Log("STEP 5: Verify loaded data matches original data")
	loadedData, err := io.ReadAll(rr2.Body)
	helpers.AssertNoError(t, err)

	if len(loadedData) != len(testData) {
		t.Fatalf("Expected data length %d but got %d", len(testData), len(loadedData))
	}

	for i := range testData {
		if loadedData[i] != testData[i] {
			t.Errorf("Byte mismatch at index %d: expected %02x but got %02x", i, testData[i], loadedData[i])
		}
	}

	t.Log("✓ ROUND-TRIP TEST PASSED: Save → session.json update → Load works correctly")
}
