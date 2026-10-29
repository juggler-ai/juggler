//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"testing"
)

// TestAttachWaitsForASlowServersFirstAnswer: a server that is there but slow
// to count an attachment — a busy machine — is waited for, for as long as it
// lives, not given up on after a clock. Here the stand-in answers its status
// line only once a probe begun after the attach came in has timed out
// (statusProbeTimeout), so the attach has waited longer than that.
func TestAttachWaitsForASlowServersFirstAnswer(t *testing.T) {
	release := make(chan struct{})
	letGo := sync.OnceFunc(func() { close(release) })
	t.Cleanup(letGo)
	attaching := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		switch r.URL.Path {
		case "/api/server/attach":
			attaching <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(attachStatus{Attachment: "att"})
			_ = http.NewResponseController(w).Flush()
			<-r.Context().Done()
		case "/api/server/sessions":
			select {
			case <-release:
			case <-r.Context().Done():
			}
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)
	c := &Client{addr: srv.Listener.Addr().String(), token: "t", PID: os.Getpid(), http: &http.Client{Timeout: statusProbeTimeout}}

	attached := make(chan error, 1)
	var a *Attachment
	go func() {
		var err error
		a, err = c.Attach()
		attached <- err
	}()
	<-attaching
	if _, err := c.ListSessions(); !errors.Is(err, ErrServerSlow) {
		t.Fatalf("the probe: %v; want ErrServerSlow", err)
	}
	select {
	case err := <-attached:
		t.Fatalf("the attach ended before the server answered it, while the server lived: %v", err)
	default:
	}
	letGo()
	if err := <-attached; err != nil {
		t.Fatalf("an attach the server answered once it got to it: %v", err)
	}
	a.Close()
}

// TestAttachGivesUpOnAServerWhoseProcessExits: the wait for a first answer
// lasts while the server's process does. A connection left open by a process
// that has gone (here the stand-in's handler holds it; the process named is
// one the test ends) is no server.
func TestAttachGivesUpOnAServerWhoseProcessExits(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sleep(1) as the server's process")
	}
	proc := exec.Command("sleep", "600")
	if err := proc.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() {
		_ = proc.Wait()
		close(exited)
	}()
	t.Cleanup(func() {
		_ = proc.Process.Kill()
		<-exited
	})
	attaching := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		attaching <- struct{}{}
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	c := &Client{addr: srv.Listener.Addr().String(), token: "t", PID: proc.Process.Pid}

	attached := make(chan error, 1)
	go func() {
		_, err := c.Attach()
		attached <- err
	}()
	<-attaching
	select {
	case err := <-attached:
		t.Fatalf("the attach ended while the server's process lived: %v", err)
	default:
	}
	_ = proc.Process.Kill()
	<-exited
	if err := <-attached; !errors.Is(err, ErrNoServer) || !ServerGoing(err) {
		t.Fatalf("an attach to a server whose process exited: %v; want ErrNoServer", err)
	}
}
