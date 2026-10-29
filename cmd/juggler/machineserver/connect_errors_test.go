//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestASlowServerIsNeitherGoneNorGoing: a call that outlasts the client's
// timeout on a server that is there is the server being slow, which a caller
// must not take for one gone or on its way out. An open is not bounded by that
// timeout at all: it waits on the server's progress (a spawn, which the server
// bounds itself). A server that is not there at all is gone.
func TestASlowServerIsNeitherGoneNorGoing(t *testing.T) {
	release := make(chan struct{})
	opening := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		open := r.Method == http.MethodPost && r.URL.Path == "/api/server/sessions"
		if open {
			opening <- struct{}{}
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		if open {
			writeJSON(w, http.StatusCreated, Session{ID: "s1", Project: "/p", State: SessionRunning})
			return
		}
		writeJSON(w, http.StatusOK, []Session{})
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	c := &Client{addr: srv.Listener.Addr().String(), token: "t", http: &http.Client{Timeout: 50 * time.Millisecond}}

	if _, err := c.ListSessions(); !errors.Is(err, ErrServerSlow) || ServerGoing(err) {
		t.Fatalf("a call that timed out on a live server: %v; want ErrServerSlow, not ServerGoing", err)
	}

	opened := make(chan error, 1)
	go func() {
		_, _, err := c.OpenSession("/p")
		opened <- err
	}()
	<-opening
	// A call begun after the open, timed out: the open has now been waiting
	// longer than the client's timeout.
	if _, err := c.ListSessions(); !errors.Is(err, ErrServerSlow) || ServerGoing(err) {
		t.Fatalf("a second call that timed out on a live server: %v; want ErrServerSlow, not ServerGoing", err)
	}
	select {
	case err := <-opened:
		t.Fatalf("the open ended before the server answered it: %v", err)
	default:
	}
	close(release)
	if err := <-opened; err != nil {
		t.Fatalf("an open the server answered once it was done: %v", err)
	}

	srv.Close()
	if _, err := c.ListSessions(); !errors.Is(err, ErrNoServer) || !ServerGoing(err) {
		t.Fatalf("a call to a server that is not there: %v; want ServerGoing", err)
	}
}
