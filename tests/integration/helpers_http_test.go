//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"net"
	"testing"
	"time"

	"juggler/tests/helpers"
)

// acceptButNeverReply stands up a TCP listener that accepts every connection
// and then holds it open without ever writing an HTTP response — the exact
// shape of a server whose engine main thread has stalled (the macOS
// hidden-WebView hazard). Returns its address; the listener closes with t.
func acceptButNeverReply(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			_ = c // never reply; hold the connection
		}
	}()
	return ln.Addr().String()
}

// TestPollJSONFailsFastOnWedgedServer guards the regression that made
// `make test` "get stuck": the harness HTTP helpers once used the default
// no-timeout client, so a wedged server (accepts the connection, never replies)
// blocked the polling goroutine forever. In the browser suite that goroutine
// holds a pool lane, so one wedged server hung the WHOLE suite until the outer
// 15-minute -timeout fired. PollJSON must instead fail at its deadline so the
// per-test failure frees the lane and the run continues.
func TestPollJSONFailsFastOnWedgedServer(t *testing.T) {
	t.Parallel()
	addr := acceptButNeverReply(t)

	var out struct{ Passed bool }
	start := time.Now()
	// No liveness check: this listener is not a pool subprocess.
	err := helpers.PollJSON(addr, "/api/test/result", 2*time.Second, &out, nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("PollJSON returned nil against a wedged server; expected a timeout error")
	}
	if elapsed > 6*time.Second {
		t.Fatalf("PollJSON blocked %s past its 2s deadline — the no-timeout client "+
			"regression is back; a wedged server will hang the whole suite", elapsed)
	}
}
