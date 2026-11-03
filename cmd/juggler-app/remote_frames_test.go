//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/core"
)

// TestARemoteWindowShowingASessionReopensWhereItWasLeft: a window onto a
// server by URL spends its life on one of that server's sessions (/s/<id>),
// which is where it is when the app quits, but it opens next launch on the
// server's own address, before its page has reopened the session. Its frame is
// the server's, so the frame it was left at is the one it opens at.
func TestARemoteWindowShowingASessionReopensWhereItWasLeft(t *testing.T) {
	a := newTestAppState(t)
	a.remoteFrames = newRemoteFramesAt(filepath.Join(t.TempDir(), "remote-frames.json"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)

	spec := windowSpec{url: srv.URL, connected: true, remoteProject: "/p"}
	e := &winEntry{id: "w1", role: roleMain, view: windowView{spec: spec, serverURL: srv.URL + "/s/abc123"}}
	registerWindow(a, e)
	left := core.WindowState{X: 300, Y: 200, Width: 1500, Height: 1000, HasPos: true}
	a.storeFrame(context.Background(), e, left)

	ws, hasState, reached := a.openingState(spec, normalizeURL(spec.url), roleMain)
	if !reached || !hasState || !ws.SameFrame(left) {
		t.Fatalf("reopened at %+v (saved %v, reached %v); want the frame it was left at, %+v", ws, hasState, reached, left)
	}
}
