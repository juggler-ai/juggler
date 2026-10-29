//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package machineloadtest provides the single test helper for skipping a test
// the machine starved. It lives apart from machineload, which programs link, so
// that only tests carry it.
package machineloadtest

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"juggler/internal/machineload"
)

// SkipPrefix opens the message of every test skipped by Skip, so a load skip is
// recognisable in any `go test -v` output.
const SkipPrefix = "LOAD-SKIP: "

// SkipLogEnv names a file each Skip appends one line to — the test's name and
// the machine's reading — when it is set. A run without -v prints nothing for a
// skipped test, so without it a test that skipped under load is
// indistinguishable from one that passed; the Makefile's test-all sets it and
// reports what was written.
const SkipLogEnv = "JUGGLER_LOAD_SKIP_LOG"

// Skipper is the part of *testing.T that Skip needs, so Skip's own test can
// hand it a fake that records the skip instead of ending a test.
type Skipper interface {
	Helper()
	Name() string
	Skipf(format string, args ...any)
}

// Skip skips t because the machine did not give it what its assertion needs —
// the wall-clock reading it would judge is the machine's, not the code's. The
// message carries SkipPrefix and the current MACHINE LOAD line, and the skip is
// recorded in the SkipLogEnv file when one is named.
//
// Use it only for that. A skip for any other reason (wrong OS, -short, a tool
// that is not installed) is t.Skip as usual.
func Skip(t Skipper, format string, args ...any) {
	t.Helper()
	line := machineload.Line()
	if path := os.Getenv(SkipLogEnv); path != "" {
		// O_APPEND: the packages of one run are separate processes writing the
		// same file, and an appended line this short is written whole. The test
		// binary's name (`ops.test`) says which package the name belongs to.
		pkg := strings.TrimSuffix(filepath.Base(os.Args[0]), ".test")
		pkg = strings.TrimSuffix(pkg, ".test.exe")
		if f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			_, _ = fmt.Fprintf(f, "%s.%s\t%s\n", pkg, t.Name(), line)
			_ = f.Close()
		}
	}
	t.Skipf("%s%s\n%s", SkipPrefix, fmt.Sprintf(format, args...), line)
}
