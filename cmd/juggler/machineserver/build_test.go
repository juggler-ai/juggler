//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

// TestABuildFromSourceIsNamedByWhenItsBinaryWasMade: every build of one source
// tree reports the same version, so a build from source is told apart by when
// its binary was made — a rebuild is another build. A release is its version.
func TestABuildFromSourceIsNamedByWhenItsBinaryWasMade(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "juggler")
	if err := os.WriteFile(bin, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	made := time.Date(2026, 10, 29, 13, 4, 12, 0, time.Local)
	if err := os.Chtimes(bin, made, made); err != nil {
		t.Fatal(err)
	}

	orig := core.Version
	t.Cleanup(func() { core.Version = orig })
	core.Version = "v0.7.9-dev"
	first := BuildOf(bin)
	if !strings.HasPrefix(first, "v0.7.9-dev") || !strings.Contains(first, "2026-10-29 13:04:12") {
		t.Fatalf("BuildOf a build from source = %q; want its version and when it was made", first)
	}
	rebuilt := made.Add(time.Minute)
	if err := os.Chtimes(bin, rebuilt, rebuilt); err != nil {
		t.Fatal(err)
	}
	if again := BuildOf(bin); again == first {
		t.Fatalf("BuildOf a rebuilt binary = %q, the same as before; want another build", again)
	}
	if got := BuildOf(filepath.Join(t.TempDir(), "missing")); got != "v0.7.9-dev" {
		t.Fatalf("BuildOf a binary that is not there = %q; want the version alone", got)
	}

	core.Version = "v0.7.9"
	if got := BuildOf(bin); got != "v0.7.9" {
		t.Fatalf("BuildOf a release = %q; want its version alone", got)
	}
}

// TestAClientLearnsTheServersBuild: the status carries the server's build, and
// Connect hands it on. A server that reports none is from before builds were
// told apart, and is known by its version alone.
func TestAClientLearnsTheServersBuild(t *testing.T) {
	for _, c := range []struct{ build, want string }{
		{"v9.9.9-dev (built 2026-10-29 13:04:12)", "v9.9.9-dev (built 2026-10-29 13:04:12)"},
		{"", core.Version},
	} {
		userpathstest.Isolate(t)
		s := &Server{reg: newRegistry(), token: testToken, startedAt: time.Now(), build: c.build}
		front := httptest.NewServer(s.routes())
		s.addr = front.Listener.Addr().String()
		publishServerInfo(t, ServerInfo{PID: os.Getpid(), Addr: s.addr, Version: "v9.9.9-dev", Token: testToken})
		got, err := Connect(ConnectOptions{})
		front.Close()
		if err != nil {
			t.Fatalf("Connect: %v", err)
		}
		if got.Build != c.want {
			t.Errorf("server reporting build %q: client has build %q, want %q", c.build, got.Build, c.want)
		}
	}
}
