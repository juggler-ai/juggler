//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
	"juggler/tests/helpers"

	"github.com/gorilla/mux"
)

// TestConversationHTTP_SaveAndLoadViaHTTP tests the full HTTP save/load cycle
func TestConversationHTTP_SaveAndLoadViaHTTP(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	// Create session manager
	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	convID := "conv_http_test"

	// Own the conversation first: the binary PUT seam persists only ids this
	// project owns (it will not fabricate a folder for an unknown id), so create
	// it through the authoritative entry point before saving bytes for it.
	_, _, err = manager.CreateConversation("HTTP Test", convID)
	helpers.AssertNoError(t, err)

	// Create HTTP API (nil workerManager + nil closer fine for this test - no deletions)
	sessionAPI := handlers.NewSessionAPI(func() *core.SessionManager { return manager }, nil, nil, nil, nil)

	// Create router
	router := mux.NewRouter()
	router.HandleFunc("/api/session/conversations/{convId}", sessionAPI.HandleGetConversation).Methods("GET")
	router.HandleFunc("/api/session/conversations/{convId}", sessionAPI.HandleUpdateConversation).Methods("PUT")

	// Test data
	testData := []byte{
		0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
		0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, // "Hello!"
	}

	// === SAVE via HTTP PUT ===
	t.Run("Save via PUT", func(t *testing.T) {
		req := httptest.NewRequest("PUT", "/api/session/conversations/"+convID, bytes.NewReader(testData))
		req.Header.Set("Content-Type", "application/octet-stream")
		req = mux.SetURLVars(req, map[string]string{"convId": convID})

		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)

		if rr.Code != http.StatusNoContent {
			t.Errorf("Expected status %d but got %d. Body: %s", http.StatusNoContent, rr.Code, rr.Body.String())
		}
	})

	// === LOAD via HTTP GET ===
	t.Run("Load via GET", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/session/conversations/"+convID, nil)
		req = mux.SetURLVars(req, map[string]string{"convId": convID})

		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("Expected status %d but got %d. Body: %s", http.StatusOK, rr.Code, rr.Body.String())
		}

		// Check Content-Type
		contentType := rr.Header().Get("Content-Type")
		if contentType != "application/octet-stream" {
			t.Errorf("Expected Content-Type 'application/octet-stream' but got '%s'", contentType)
		}

		// Read response body
		loadedData, err := io.ReadAll(rr.Body)
		helpers.AssertNoError(t, err)

		// Verify data matches
		if len(loadedData) != len(testData) {
			t.Fatalf("Expected data length %d but got %d", len(testData), len(loadedData))
		}

		for i := range testData {
			if loadedData[i] != testData[i] {
				t.Errorf("Byte mismatch at index %d: expected %02x but got %02x", i, testData[i], loadedData[i])
			}
		}
	})
}

// TestConversationHTTP_LoadNonexistent tests loading nonexistent conversation via HTTP
func TestConversationHTTP_LoadNonexistent(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	sessionAPI := handlers.NewSessionAPI(func() *core.SessionManager { return manager }, nil, nil, nil, nil)
	router := mux.NewRouter()
	router.HandleFunc("/api/session/conversations/{convId}", sessionAPI.HandleGetConversation).Methods("GET")

	req := httptest.NewRequest("GET", "/api/session/conversations/nonexistent", nil)
	req = mux.SetURLVars(req, map[string]string{"convId": "nonexistent"})

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Errorf("Expected status %d but got %d", http.StatusNotFound, rr.Code)
	}
}

// TestConversationHTTP_SaveOverwrite tests overwriting via HTTP
func TestConversationHTTP_SaveOverwrite(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	convID := "conv_overwrite"

	// Own the conversation first (see TestConversationHTTP_SaveAndLoadViaHTTP):
	// the binary PUT seam persists only owned ids.
	_, _, err = manager.CreateConversation("Overwrite", convID)
	helpers.AssertNoError(t, err)

	sessionAPI := handlers.NewSessionAPI(func() *core.SessionManager { return manager }, nil, nil, nil, nil)
	router := mux.NewRouter()
	router.HandleFunc("/api/session/conversations/{convId}", sessionAPI.HandleGetConversation).Methods("GET")
	router.HandleFunc("/api/session/conversations/{convId}", sessionAPI.HandleUpdateConversation).Methods("PUT")

	// Save first version
	firstData := []byte{0xAA, 0xBB, 0xCC}
	req1 := httptest.NewRequest("PUT", "/api/session/conversations/"+convID, bytes.NewReader(firstData))
	req1.Header.Set("Content-Type", "application/octet-stream")
	req1 = mux.SetURLVars(req1, map[string]string{"convId": convID})

	rr1 := httptest.NewRecorder()
	router.ServeHTTP(rr1, req1)
	helpers.AssertEqual(t, rr1.Code, http.StatusNoContent)

	// Save second version (overwrite)
	secondData := []byte{0xDD, 0xEE, 0xFF, 0x00}
	req2 := httptest.NewRequest("PUT", "/api/session/conversations/"+convID, bytes.NewReader(secondData))
	req2.Header.Set("Content-Type", "application/octet-stream")
	req2 = mux.SetURLVars(req2, map[string]string{"convId": convID})

	rr2 := httptest.NewRecorder()
	router.ServeHTTP(rr2, req2)
	helpers.AssertEqual(t, rr2.Code, http.StatusNoContent)

	// Load and verify we got the second version
	req3 := httptest.NewRequest("GET", "/api/session/conversations/"+convID, nil)
	req3 = mux.SetURLVars(req3, map[string]string{"convId": convID})

	rr3 := httptest.NewRecorder()
	router.ServeHTTP(rr3, req3)
	helpers.AssertEqual(t, rr3.Code, http.StatusOK)

	loadedData, err := io.ReadAll(rr3.Body)
	helpers.AssertNoError(t, err)
	helpers.AssertEqual(t, len(loadedData), len(secondData))

	for i := range secondData {
		if loadedData[i] != secondData[i] {
			t.Errorf("Expected byte %02x at index %d but got %02x", secondData[i], i, loadedData[i])
		}
	}
}

// TestConversationHTTP_RejectJSONFormat tests that JSON format is rejected
func TestConversationHTTP_RejectJSONFormat(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer manager.Shutdown()

	sessionAPI := handlers.NewSessionAPI(func() *core.SessionManager { return manager }, nil, nil, nil, nil)
	router := mux.NewRouter()
	router.HandleFunc("/api/session/conversations/{convId}", sessionAPI.HandleUpdateConversation).Methods("PUT")

	jsonData := []byte(`{"items":[],"contextItems":[]}`)
	req := httptest.NewRequest("PUT", "/api/session/conversations/conv_json", bytes.NewReader(jsonData))
	req.Header.Set("Content-Type", "application/json")
	req = mux.SetURLVars(req, map[string]string{"convId": "conv_json"})

	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("Expected status %d for JSON but got %d", http.StatusBadRequest, rr.Code)
	}

	body := rr.Body.String()
	if body == "" || len(body) < 10 {
		t.Errorf("Expected error message in response body but got: %s", body)
	}
}
