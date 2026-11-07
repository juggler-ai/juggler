//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
)

// TestHandleCreateConversation_RefusedAtCap is what a client meets at the cap:
// a conflict, not a server fault, carrying the cap's message both as the
// English a model reads and as the message a viewer translates.
func TestHandleCreateConversation_RefusedAtCap(t *testing.T) {
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mgr.Shutdown)
	for i := range core.MaxConversations {
		if _, _, err := mgr.CreateConversation("Conv " + strconv.Itoa(i)); err != nil {
			t.Fatalf("seed %d: %v", i, err)
		}
	}
	api := &SessionAPI{managerProvider: func() *core.SessionManager { return mgr }}

	req := httptest.NewRequest(http.MethodPost, "/api/conversations", strings.NewReader(`{"name":"One too many"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	api.HandleCreateConversation(rr, req)

	if rr.Code != http.StatusConflict {
		t.Fatalf("status %d, want %d (body %s)", rr.Code, http.StatusConflict, rr.Body.String())
	}
	var body errorBody
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, rr.Body.String())
	}
	if want := "at most " + strconv.Itoa(core.MaxConversations) + " conversations"; !strings.Contains(body.Error, want) {
		t.Errorf("error %q does not say %q", body.Error, want)
	}
	if body.Message == nil || body.Message.Key != core.ErrTooManyConversations.Message.Key {
		t.Errorf("message = %+v, want the cap's translatable message", body.Message)
	}
}
