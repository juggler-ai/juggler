//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"fmt"
	"net/http"
	"os/exec"
	"syscall"
	"time"

	"juggler/internal/apipaths"
)

// stopSubprocess sends SIGTERM and waits up to 5s before killing. Safe to call
// with a nil command or a command whose process has already exited.
func stopSubprocess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
	}
}

// waitForServer polls url+apipaths.Health every 100ms until the server returns 200
// or the timeout elapses. Each request is bounded by the readiness budget: the
// default http client never times out, so a server that accepts the connection
// but stalls before replying (a wedged engine main thread) would block this
// poll past `timeout` forever instead of failing at the deadline.
func waitForServer(url string, timeout time.Duration) error {
	client := &http.Client{Timeout: timeout}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := client.Get(url + apipaths.Health)
		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			return nil
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for server at %s", url)
}
