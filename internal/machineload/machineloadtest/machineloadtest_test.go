//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineloadtest

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeSkipper records what Skip asked of it instead of ending a test.
type fakeSkipper struct {
	name    string
	skipped string
}

func (f *fakeSkipper) Helper()      {}
func (f *fakeSkipper) Name() string { return f.name }
func (f *fakeSkipper) Skipf(format string, args ...any) {
	f.skipped = fmt.Sprintf(format, args...)
}

func TestSkipIsTaggedAndRecordedInTheSkipLog(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "load-skips.log")
	t.Setenv(SkipLogEnv, logPath)

	first := &fakeSkipper{name: "TestFirst/sub"}
	Skip(first, "went %v without a beat (100%% of the window)", "3s")
	Skip(&fakeSkipper{name: "TestSecond"}, "plain")

	if !strings.HasPrefix(first.skipped, SkipPrefix+"went 3s without a beat (100% of the window)\n") {
		t.Errorf("skip message %q does not open with the prefix and the formatted reason", first.skipped)
	}
	if !strings.Contains(first.skipped, "MACHINE LOAD:") {
		t.Errorf("skip message %q carries no machine reading", first.skipped)
	}

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("no skip log written: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("skip log holds %d lines, want one per skip:\n%s", len(lines), data)
	}
	pkg := strings.TrimSuffix(filepath.Base(os.Args[0]), ".test")
	pkg = strings.TrimSuffix(pkg, ".test.exe")
	for i, want := range []string{"TestFirst/sub", "TestSecond"} {
		if !strings.HasPrefix(lines[i], pkg+"."+want+"\tMACHINE LOAD:") {
			t.Errorf("skip log line %d = %q, want %s.%s and the reading", i, lines[i], pkg, want)
		}
	}
}

func TestSkipWritesNothingWithoutASkipLog(t *testing.T) {
	t.Setenv(SkipLogEnv, "")
	f := &fakeSkipper{name: "TestQuiet"}
	Skip(f, "reason")
	if !strings.HasPrefix(f.skipped, SkipPrefix+"reason") {
		t.Errorf("skip message %q lost its prefix", f.skipped)
	}
}
