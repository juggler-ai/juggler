//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/logpaths"
)

// A server that cannot start says why on its stderr, which goes to a log file
// rather than to the app. The window that could not open shows the error the
// spawn returns, so that error has to carry the server's own reason: "exited
// before reporting its address" tells nobody what to do.
//
// The log is appended to by every server this project has run, so an earlier
// failure already in it must not be mistaken for this one's.
func TestAServerThatFailsToStartSaysWhy(t *testing.T) {
	useFakeServer(t)
	project := t.TempDir()
	stale := logpaths.StderrLogPath(project)
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("\n"+core.StartupFailurePrefix+"an older failure\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	const reason = "could not find available port after 100 attempts"
	t.Setenv(fakeServerFailEnv, reason)
	_, proc, err := spawnServer(project)
	if err == nil {
		proc.stop()
		t.Fatal("a server that failed to start was reported as started")
	}
	if !strings.Contains(err.Error(), reason) {
		t.Fatalf("spawn error %q does not carry the server's reason %q", err, reason)
	}
	if strings.Contains(err.Error(), "an older failure") {
		t.Fatalf("spawn error %q reports a failure from an earlier run", err)
	}
}
