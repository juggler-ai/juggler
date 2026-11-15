//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"strings"
	"testing"
)

// TestSessionPut_AbsentHistoryKeepsTheStoredOne: the viewer leaves the prompt
// history out of a PUT /session when the server already holds it, so the save
// behind a tab switch carries the active id and the metadata alone. An absent
// field must therefore keep what is stored — read as "empty", every tab switch
// would wipe the history — while an empty one still replaces it.
func TestSessionPut_AbsentHistoryKeepsTheStoredOne(t *testing.T) {
	s, mgr := newUIPrefsTestServer(t)
	put := func(body string) {
		t.Helper()
		if rec := uiPrefRequest(t, s, http.MethodPut, "/api/session", body, localViewerAddr, false); rec.Code != http.StatusNoContent {
			t.Fatalf("PUT /api/session %s: got %d, want 204: %s", body, rec.Code, rec.Body.String())
		}
	}
	history := func() string {
		t.Helper()
		var parts []string
		for _, e := range mgr.GetSession().MessageHistory {
			parts = append(parts, string(e))
		}
		return "[" + strings.Join(parts, ",") + "]"
	}

	put(`{"activeConversationId":"conv_a","messageHistory":[{"content":"hello"}],"metadata":{"flag":1}}`)
	if got := history(); got != `[{"content":"hello"}]` {
		t.Fatalf("the history was not stored: %s", got)
	}

	put(`{"activeConversationId":"conv_b","metadata":{"flag":2}}`)
	sess := mgr.GetSession()
	if got := history(); got != `[{"content":"hello"}]` {
		t.Errorf("a PUT without a history changed the stored one to %s", got)
	}
	if sess.ActiveConversationID != "conv_b" || sess.Metadata["flag"] != float64(2) {
		t.Errorf("the rest of that PUT was not applied: active %q, metadata %v", sess.ActiveConversationID, sess.Metadata)
	}

	put(`{"activeConversationId":"conv_b","messageHistory":[],"metadata":{}}`)
	if got := history(); got != `[]` {
		t.Errorf("an empty history did not replace the stored one: %s", got)
	}
}
