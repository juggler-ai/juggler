//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package testing

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestRunAPIHoldsSessionUntilResultServed pins what a queued browser test
// holds: the session, from the moment it is queued until its harness has read
// the result — through a window still loading, a lane mid-test, and a result
// posted but not yet fetched. The list sentinel holds only while queued, since
// its answer comes back as names, never as a result.
func TestRunAPIHoldsSessionUntilResultServed(t *testing.T) {
	api := NewTestRunAPI()
	call := func(h http.HandlerFunc, method, target, body string) {
		t.Helper()
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest(method, target, strings.NewReader(body)))
		if w.Code >= 400 {
			t.Fatalf("%s %s: status %d", method, target, w.Code)
		}
	}
	expect := func(step string, want bool) {
		t.Helper()
		if got := api.HoldsSession(); got != want {
			t.Errorf("%s: HoldsSession() = %v, want %v", step, got, want)
		}
	}

	expect("nothing queued", false)
	call(api.HandleRun, http.MethodPost, "/api/test/run", `{"name":"integration:a"}`)
	expect("queued, no lane has asked", true)
	call(api.HandlePending, http.MethodGet, "/api/test/pending", "")
	expect("dispatched, running in its lane", true)
	call(api.HandlePostResult, http.MethodPost, "/api/test/result", `{"name":"integration:a","passed":true}`)
	expect("result posted, not yet read", true)
	call(api.HandleGetResult, http.MethodGet, "/api/test/result?name=integration:a", "")
	expect("result read by its harness", false)

	call(api.HandleRun, http.MethodPost, "/api/test/run", `{"name":"__list__"}`)
	expect("list sentinel queued", true)
	call(api.HandlePending, http.MethodGet, "/api/test/pending", "")
	expect("list sentinel dispatched", false)
}
