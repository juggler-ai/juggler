//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMachineLockAcquireConflictAndRelease(t *testing.T) {
	dir := t.TempDir()

	l1 := NewMachineLock(dir)
	acquired, existing, err := l1.TryAcquire(ServerInfo{Version: "v1", Token: "token-1"})
	if err != nil || !acquired || existing != nil {
		t.Fatalf("first acquire: acquired=%v existing=%v err=%v", acquired, existing, err)
	}
	if err := l1.UpdateAddr("127.0.0.1:9"); err != nil {
		t.Fatalf("UpdateAddr: %v", err)
	}

	// A second acquire against the same dir must fail and report the holder.
	l2 := NewMachineLock(dir)
	acquired, existing, err = l2.TryAcquire(ServerInfo{Version: "v2", Token: "token-2"})
	if err != nil {
		t.Fatalf("second acquire: %v", err)
	}
	if acquired {
		t.Fatal("second acquire should not succeed while the lock is held")
	}
	if existing == nil || existing.Addr != "127.0.0.1:9" || existing.Version != "v1" || existing.Token != "token-1" {
		t.Fatalf("holder info = %+v, want addr 127.0.0.1:9 version v1 token token-1", existing)
	}

	if err := l1.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	acquired, _, err = l2.TryAcquire(ServerInfo{Version: "v2", Token: "token-2"})
	if err != nil || !acquired {
		t.Fatalf("acquire after release: acquired=%v err=%v", acquired, err)
	}
	if err := l2.Release(); err != nil {
		t.Fatalf("second release: %v", err)
	}
}

// TestServerInfoIsPrivateToItsOwner pins what keeps the control-API token in
// server.json from being the grant it guards: only the user the machine server
// runs as can read the file — including when a server.json left by an earlier
// run is still there with wider permissions.
func TestServerInfoIsPrivateToItsOwner(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission bits; Windows guards the file by its profile directory's ACL")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "server.json"), []byte("{}"), 0o644); err != nil { //nolint:gosec // the stale, too-open file under test
		t.Fatal(err)
	}
	l := NewMachineLock(dir)
	if acquired, _, err := l.TryAcquire(ServerInfo{Version: "v1", Token: "token-1"}); err != nil || !acquired {
		t.Fatalf("acquire: acquired=%v err=%v", acquired, err)
	}
	defer func() { _ = l.Release() }()
	info, err := os.Stat(filepath.Join(dir, "server.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("server.json mode %v, want 0600", perm)
	}
}
