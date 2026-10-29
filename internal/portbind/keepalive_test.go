//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package portbind

import (
	"testing"
	"time"
)

// TestKeepAliveProbesIdleConnections pins that a viewer-facing listener asks
// the kernel to probe idle connections, so a peer whose host vanished is
// reaped without anything at the application layer noticing. Asserts the
// configuration rather than observing probes: the settings are not readable
// back portably, and waiting for real probes would be a two-minute timing
// test. Binding proves the configuration is one the platform accepts.
func TestKeepAliveProbesIdleConnections(t *testing.T) {
	cfg := KeepAlive
	if !cfg.Enable {
		t.Error("keep-alive probes must be enabled")
	}
	if cfg.Idle <= 0 || cfg.Interval <= 0 || cfg.Count <= 0 {
		t.Errorf("keep-alive period must be explicit, not left to the platform default: %+v", cfg)
	}
	// A dead peer should be detected in minutes, not hours.
	if worst := cfg.Idle + cfg.Interval*time.Duration(cfg.Count); worst > 10*time.Minute {
		t.Errorf("worst-case dead-peer detection %s is too slow to be useful", worst)
	}

	ln, err := Listen("127.0.0.1:0")
	if err != nil {
		t.Fatalf("listener rejected the keep-alive configuration: %v", err)
	}
	_ = ln.Close()
}
