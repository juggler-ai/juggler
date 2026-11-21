//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/msg"
)

// TestExtraRoutesSeam proves the ExtraRoutes seam: a distribution's route is
// served on the control API behind its token and shadows no built-in one, and
// the Host it is lent opens a session that its spawner's token reaches, held
// against retirement until it is released.
func TestExtraRoutesSeam(t *testing.T) {
	useHelperChildren(t)
	var host Host
	s := &Server{reg: newRegistry(), token: testToken, extraRoutes: func(api *mux.Router, h Host) {
		host = h
		api.HandleFunc("/extra/ping", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTeapot)
		}).Methods("GET")
		api.HandleFunc("/recents", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTeapot)
		}).Methods("GET")
	}}
	front := httptest.NewServer(s.routes())
	t.Cleanup(func() {
		front.Close()
		s.stopAllChildren()
	})
	if host == nil {
		t.Fatal("routes() never called the hook")
	}

	call := func(path, token string) int {
		req, _ := http.NewRequest("GET", front.URL+path, nil)
		if token != "" {
			req.Header.Set(TokenHeader, token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := call("/api/server/extra/ping", testToken); got != http.StatusTeapot {
		t.Fatalf("the hook's route: status %d; want %d", got, http.StatusTeapot)
	}
	if got := call("/api/server/extra/ping", ""); got != http.StatusUnauthorized {
		t.Fatalf("the hook's route without the control token: status %d; want %d", got, http.StatusUnauthorized)
	}
	if got := call("/api/server/recents", testToken); got != http.StatusOK {
		t.Fatalf("a built-in route the hook also registered: status %d; want the built-in's %d", got, http.StatusOK)
	}

	// The error envelope the host writes is the control API's own.
	rec := httptest.NewRecorder()
	host.WriteMessageError(rec, http.StatusConflict, msg.New("Busy with {what}.", "what", "it"))
	var envelope errorBody
	if err := json.NewDecoder(rec.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusConflict || envelope.Error != "Busy with it." || envelope.Message == nil || envelope.Message.Key != "Busy with {what}." {
		t.Fatalf("WriteMessageError wrote %d %+v", rec.Code, envelope)
	}

	ctx, cancel := context.WithTimeout(context.Background(), childStartTimeout)
	defer cancel()
	held, err := host.OpenSession(ctx, t.TempDir())
	if err != nil {
		t.Fatalf("OpenSession: %v", err)
	}
	resp, err := held.Do(ctx, "GET", "/api/anything", nil)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	var report helperReport
	err = json.NewDecoder(resp.Body).Decode(&report)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if report.EnvToken == "" || report.TokenHeader != report.EnvToken {
		t.Fatalf("Do quoted token %q; the child was minted %q", report.TokenHeader, report.EnvToken)
	}

	// Held: a viewer, so no grace runs out on it, however long it is held.
	c, ok := s.reg.runningChild(held.id)
	if !ok {
		t.Fatal("the held session is not running")
	}
	if sess, _ := s.reg.get(held.id); sess.Viewers != 1 {
		t.Fatalf("held session has %d viewers; want 1", sess.Viewers)
	}
	if s.reg.retireUnviewed(held.id, c, time.Now().Add(2*sessionViewerGrace)) {
		t.Fatal("a held session was claimed for retirement")
	}

	held.Release()
	held.Release()
	if sess, _ := s.reg.get(held.id); sess.Viewers != 0 {
		t.Fatalf("released session has %d viewers; want 0", sess.Viewers)
	}
	resp, err = held.Do(ctx, "GET", "/api/anything", nil)
	if err == nil {
		resp.Body.Close()
	}
	if !errors.Is(err, errHeldSessionGone) {
		t.Fatalf("Do after Release: %v; want errHeldSessionGone", err)
	}
}
