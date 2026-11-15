//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

// The board's GET says whether the seed claim is already spent, so a window
// loading a board somebody has laid out skips the claim's round trip. It must
// agree with the claim: false only while a claim could still be granted.
func TestPinboardGetReportsSeeded(t *testing.T) {
	s, _ := newPinboardTestServer(t)

	seeded := func(path string) bool {
		t.Helper()
		rec := pinboardRequest(t, s, http.MethodGet, path, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: got %d, want 200 (%s)", path, rec.Code, rec.Body.String())
		}
		var body struct {
			Seeded *bool `json:"seeded"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode %q: %v", rec.Body.String(), err)
		}
		if body.Seeded == nil {
			t.Fatalf("GET %s carries no seeded field: %s", path, rec.Body.String())
		}
		return *body.Seeded
	}

	if seeded("/api/session/pinboard") {
		t.Fatal("a board nobody has claimed must say so, or no window ever furnishes it")
	}
	if rec := pinboardRequest(t, s, http.MethodPost, "/api/session/pinboard/seed", ""); rec.Code != http.StatusOK {
		t.Fatalf("POST seed: got %d (%s)", rec.Code, rec.Body.String())
	}
	if !seeded("/api/session/pinboard") {
		t.Fatal("once claimed, the GET must report the board seeded")
	}
	// A detached board is never furnished by a claim, so there is nothing to ask.
	if !seeded("/api/session/pinboard?board=board_one") {
		t.Fatal("a board the claim always refuses must report seeded")
	}
}
