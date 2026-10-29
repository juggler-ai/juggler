//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/worker"
)

// newProgramsFixture builds an API over a real session holding one
// conversation, and returns the API and that conversation's id.
func newProgramsFixture(t *testing.T) (*SessionAPI, string) {
	t.Helper()
	projectDir := t.TempDir()
	mgr, err := core.NewSessionManagerForPath(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mgr.Shutdown)
	convID, _, err := mgr.CreateConversation("programs")
	if err != nil {
		t.Fatal(err)
	}
	return &SessionAPI{managerProvider: func() *core.SessionManager { return mgr }}, convID
}

// programRequest sends one request to the snapshot handler for method, with
// the route's path variables set as the router would set them.
func programRequest(api *SessionAPI, method, convID, toolUseID string, body io.Reader) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/api/session/conversations/"+convID+"/programs/"+toolUseID, body)
	req = mux.SetURLVars(req, map[string]string{"convId": convID, "toolUseId": toolUseID})
	rr := httptest.NewRecorder()
	switch method {
	case http.MethodPut:
		api.HandlePutProgram(rr, req)
	case http.MethodGet:
		api.HandleGetProgram(rr, req)
	case http.MethodDelete:
		api.HandleDeleteProgram(rr, req)
	}
	return rr
}

func wantStatus(t *testing.T, step string, rr *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rr.Code != want {
		t.Fatalf("%s: status %d, want %d (body %q)", step, rr.Code, want, rr.Body.String())
	}
}

// TestProgramRoutes_RoundTrip pins that a snapshot PUT reads back byte for
// byte, uncached, and that once deleted it is a 404 — while a DELETE of one
// that is not there is still a 204.
func TestProgramRoutes_RoundTrip(t *testing.T) {
	api, convID := newProgramsFixture(t)
	body := `{"journal":[{"ok":true}]}`

	wantStatus(t, "GET before PUT", programRequest(api, http.MethodGet, convID, "toolu_01", nil), http.StatusNotFound)
	wantStatus(t, "PUT", programRequest(api, http.MethodPut, convID, "toolu_01", bytes.NewBufferString(body)), http.StatusNoContent)

	rr := programRequest(api, http.MethodGet, convID, "toolu_01", nil)
	wantStatus(t, "GET", rr, http.StatusOK)
	if got := rr.Body.String(); got != body {
		t.Fatalf("GET body = %q, want %q", got, body)
	}
	if cc := rr.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("GET Cache-Control = %q, want no-store", cc)
	}

	wantStatus(t, "DELETE", programRequest(api, http.MethodDelete, convID, "toolu_01", nil), http.StatusNoContent)
	wantStatus(t, "GET after DELETE", programRequest(api, http.MethodGet, convID, "toolu_01", nil), http.StatusNotFound)
	wantStatus(t, "DELETE of a missing snapshot", programRequest(api, http.MethodDelete, convID, "toolu_01", nil), http.StatusNoContent)
}

// TestProgramRoutes_RefusesBadInput pins the client errors: an id that cannot
// be a file name is a 400 on every method, and a body past the cap is a 413
// that stores nothing.
func TestProgramRoutes_RefusesBadInput(t *testing.T) {
	api, convID := newProgramsFixture(t)

	for _, method := range []string{http.MethodPut, http.MethodGet, http.MethodDelete} {
		var body io.Reader
		if method == http.MethodPut {
			body = bytes.NewBufferString("{}")
		}
		wantStatus(t, method+" with a bad id", programRequest(api, method, convID, "..", body), http.StatusBadRequest)
	}

	big := bytes.NewReader(make([]byte, worker.MaxProgramSnapshotBytes+1))
	wantStatus(t, "PUT past the cap", programRequest(api, http.MethodPut, convID, "toolu_big", big), http.StatusRequestEntityTooLarge)
	wantStatus(t, "GET after a refused PUT", programRequest(api, http.MethodGet, convID, "toolu_big", nil), http.StatusNotFound)
}

// TestProgramRoutes_UnknownConversation pins that a conversation that is gone
// — deleted, binned, never there — is a 404 for a read or a write, not a
// server error, and that deleting a snapshot from one is a 204 like deleting
// any other snapshot that is not there.
func TestProgramRoutes_UnknownConversation(t *testing.T) {
	api, _ := newProgramsFixture(t)

	wantStatus(t, "GET", programRequest(api, http.MethodGet, "conv-gone", "toolu_01", nil), http.StatusNotFound)
	wantStatus(t, "PUT", programRequest(api, http.MethodPut, "conv-gone", "toolu_01", bytes.NewBufferString("{}")), http.StatusNotFound)
	wantStatus(t, "DELETE", programRequest(api, http.MethodDelete, "conv-gone", "toolu_01", nil), http.StatusNoContent)

	noProject := &SessionAPI{managerProvider: func() *core.SessionManager { return nil }}
	wantStatus(t, "GET with no project", programRequest(noProject, http.MethodGet, "conv-any", "toolu_01", nil), http.StatusNotFound)
}
