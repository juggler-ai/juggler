//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
	"juggler/tests/helpers"

	"github.com/gorilla/mux"
)

// TestSessionResponse_IncludesConversationOrder verifies that GET /api/session
// includes conversationOrder in the response (NOT just conversations array)
func TestSessionResponse_IncludesConversationOrder(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create session manager
	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	// CreateConversation / reorder / delete / bin are the writers of
	// ConversationOrder; allocate the two conversations through it.
	id1, _, err := manager.CreateConversation("one")
	helpers.AssertNoError(t, err)
	id2, _, err := manager.CreateConversation("two")
	helpers.AssertNoError(t, err)

	err = manager.SaveConversationBinary(id1, []byte{0x01, 0x02, 0x03})
	helpers.AssertNoError(t, err)
	err = manager.SaveConversationBinary(id2, []byte{0x04, 0x05, 0x06})
	helpers.AssertNoError(t, err)

	// Create HTTP API and router (nil workerManager is fine for this test - no deletions)
	sessionAPI := handlers.NewSessionAPI(func() *core.SessionManager { return manager }, nil, nil, nil, nil)
	router := mux.NewRouter()
	router.HandleFunc("/api/session", sessionAPI.HandleGetSession).Methods("GET")

	// GET /api/session
	req := httptest.NewRequest("GET", "/api/session", nil)

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("Expected status %d but got %d. Body: %s", http.StatusOK, rr.Code, rr.Body.String())
	}

	// Parse response
	var response map[string]any
	err = json.NewDecoder(rr.Body).Decode(&response)
	helpers.AssertNoError(t, err)

	// CRITICAL: Response MUST include conversationOrder
	conversationOrderRaw, hasOrder := response["conversationOrder"]
	if !hasOrder {
		t.Fatalf("Response MISSING conversationOrder field! Response: %+v", response)
	}

	conversationOrder, ok := conversationOrderRaw.([]any)
	if !ok {
		t.Fatalf("conversationOrder is not an array: %T", conversationOrderRaw)
	}

	// Verify both conversations are in the order
	if len(conversationOrder) != 2 {
		t.Fatalf("Expected 2 conversations in order but got %d: %v", len(conversationOrder), conversationOrder)
	}

	// Verify conversation IDs match what we created
	expectedIDs := map[string]bool{id1: true, id2: true}
	for _, idRaw := range conversationOrder {
		id, ok := idRaw.(string)
		if !ok {
			t.Errorf("Conversation ID is not a string: %T", idRaw)
			continue
		}
		if !expectedIDs[id] {
			t.Errorf("Unexpected conversation ID in order: %s", id)
		}
		delete(expectedIDs, id)
	}

	if len(expectedIDs) > 0 {
		t.Errorf("Missing conversation IDs from order: %v", expectedIDs)
	}

	t.Log("✓ Response includes conversationOrder with both conversation IDs")
}
