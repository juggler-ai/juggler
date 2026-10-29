//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package jlog_test

import (
	"bytes"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/internal/jlog"
	facade "juggler/jlog"
)

// capture initialises the internal logger the way a hosting main does — a file
// sink, plain console at the given level — and points the console at a buffer.
// It returns the console buffer and a function that closes the sink and returns
// the file's contents.
func capture(t *testing.T, level jlog.Level) (*bytes.Buffer, func() string) {
	t.Helper()
	jlog.Close()
	prevOut, prevFlags := log.Writer(), log.Flags()
	path := filepath.Join(t.TempDir(), "server.log")
	jlog.Init(jlog.Options{ConsoleLevel: level, LogFilePath: path, Component: "test"})
	var console bytes.Buffer
	log.SetOutput(&console)
	t.Cleanup(func() {
		jlog.Close()
		jlog.Init(jlog.Options{})
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	})
	return &console, func() string {
		jlog.Close()
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read log file: %v", err)
		}
		return string(b)
	}
}

// TestFacadeLandsInTheCoreSinks covers the facade's whole promise: a line logged
// through it by code outside the module reaches the same file sink, level-tagged
// and formatted the same way, as the core's own lines, and the console shows
// exactly what the core's level rules allow.
func TestFacadeLandsInTheCoreSinks(t *testing.T) {
	console, file := capture(t, jlog.LevelInfo)

	facade.Info("info %d", 1)
	facade.Debug("debug %d", 2)
	facade.Trace("trace %d", 3)
	facade.Error("error %d", 4)
	jlog.Info("core line")

	got := file()
	for _, want := range []string{"[INFO] info 1", "[DEBUG] debug 2", "[TRACE] trace 3", "[ERROR] error 4", "[INFO] core line"} {
		if !strings.Contains(got, want) {
			t.Errorf("log file lacks %q; it holds:\n%s", want, got)
		}
	}
	// One sink, in call order: the facade's lines interleave with the core's.
	if i, j := strings.Index(got, "error 4"), strings.Index(got, "core line"); i < 0 || j < i {
		t.Errorf("facade and core lines out of order in the file:\n%s", got)
	}

	out := console.String()
	for _, want := range []string{"info 1", "[ERROR] error 4", "core line"} {
		if !strings.Contains(out, want) {
			t.Errorf("console lacks %q at info level; it shows:\n%s", want, out)
		}
	}
	for _, hidden := range []string{"debug 2", "trace 3"} {
		if strings.Contains(out, hidden) {
			t.Errorf("console shows %q at info level; it shows:\n%s", hidden, out)
		}
	}
}

// TestFacadeDebugFollowsTheConsoleLevel pins that Debug reaches the console
// only when the hosting main raised the level, and Trace never does.
func TestFacadeDebugFollowsTheConsoleLevel(t *testing.T) {
	console, file := capture(t, jlog.LevelDebug)

	facade.Debug("debug shown")
	facade.Trace("trace hidden")

	out := console.String()
	if !strings.Contains(out, "[DEBUG] debug shown") {
		t.Errorf("console lacks the debug line at debug level; it shows:\n%s", out)
	}
	if strings.Contains(out, "trace hidden") {
		t.Errorf("console shows a trace line; it shows:\n%s", out)
	}
	if got := file(); !strings.Contains(got, "[TRACE] trace hidden") {
		t.Errorf("log file lacks the trace line; it holds:\n%s", got)
	}
}

// TestFacadeIsSafeBeforeInit pins the package doc's promise: with no sink
// configured, every call goes to the console path and none of them fails.
func TestFacadeIsSafeBeforeInit(t *testing.T) {
	jlog.Close()
	prevOut, prevFlags := log.Writer(), log.Flags()
	var console bytes.Buffer
	log.SetOutput(&console)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	})

	facade.Info("before init")
	facade.Debug("debug before init")
	facade.Trace("trace before init")
	facade.Error("error before init")

	out := console.String()
	if !strings.Contains(out, "before init") || !strings.Contains(out, "error before init") {
		t.Errorf("console lacks the info/error lines before init; it shows:\n%s", out)
	}
	if strings.Contains(out, "trace before init") {
		t.Errorf("console shows a trace line before init; it shows:\n%s", out)
	}
}
