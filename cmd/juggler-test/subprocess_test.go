//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"net"
	"testing"
	"time"
)

// TestWaitForServerFailsFastOnWedgedServer: a server that accepts the
// connection and never replies (a wedged engine main thread) must fail the
// readiness poll at its deadline, not block it forever on a no-timeout client.
func TestWaitForServerFailsFastOnWedgedServer(t *testing.T) {
	t.Parallel()
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

	start := time.Now()
	err = waitForServer("http://"+ln.Addr().String(), 2*time.Second)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("waitForServer returned nil against a wedged server; expected a timeout error")
	}
	if elapsed > 6*time.Second {
		t.Fatalf("waitForServer blocked %s past its 2s deadline — the no-timeout client "+
			"regression is back", elapsed)
	}
}
