//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package jlog provides unified logging for Juggler.
//
// Three log levels control what appears where:
//
//	Info  – always on console and file (startup, errors, tool actions)
//	Debug – console only when debug enabled; always in file
//	Trace – file only (provider payloads, etc.)
package jlog

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Level controls which messages are emitted.
type Level int

const (
	LevelInfo  Level = 0
	LevelDebug Level = 1
	LevelTrace Level = 2
)

// ANSI codes used by this package.
const (
	colorReset   = "\033[0m"
	colorRed     = "\033[31m"
	colorMagenta = "\033[35m"
	colorBold    = "\033[1m"
	colorDim     = "\033[2m"
)

// Options configures the logging system.
type Options struct {
	ConsoleLevel Level
	LogFilePath  string // empty = no file logging
	Colors       bool
	// MaxSizeMB caps the log file; a write that would exceed it rotates the
	// file to "<path>.1" first. <= 0 disables rotation (unbounded growth).
	MaxSizeMB int
	// MaxBackups is how many rotated "<path>.N" files to retain.
	MaxBackups int
	// Component identifies the writing process (e.g. "server", "app"). It is
	// recorded in the instance header so a collected log is self-describing.
	Component string
	// HeaderExtra are additional key=value pairs written into the instance
	// header line — e.g. project path, watchdog relaunch generation. Ordering
	// is not significant.
	HeaderExtra map[string]string
	// DiscardConsole silences console (stderr) output, leaving only the file
	// sink. Set when no one is watching stderr interactively (an app/icon-
	// spawned server whose stderr a parent already captures to a crash file) —
	// otherwise every line would be duplicated into both the file sink and that
	// captured-stderr file.
	DiscardConsole bool
}

var (
	consoleLevel Level = LevelInfo
	colors       bool  = true
	fileLogger   *log.Logger
	fileSink     *rotatingWriter
	filePath     string
)

// ansiRe strips ANSI escape codes for file output.
var ansiRe = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// Init configures the logging system. Call once at startup.
func Init(opts Options) {
	consoleLevel = opts.ConsoleLevel
	colors = opts.Colors

	// Remove timestamp from stdlib log (used for console).
	log.SetFlags(0)
	if opts.DiscardConsole {
		log.SetOutput(io.Discard)
	}

	if opts.LogFilePath != "" {
		dir := filepath.Dir(opts.LogFilePath)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Printf("[ERROR] Failed to create log directory %s: %v", dir, err)
			return
		}
		maxBytes := int64(opts.MaxSizeMB) * 1024 * 1024
		w, err := newRotatingWriter(opts.LogFilePath, maxBytes, opts.MaxBackups)
		if err != nil {
			log.Printf("[ERROR] Failed to open log file %s: %v", opts.LogFilePath, err)
			return
		}
		fileSink = w
		fileLogger = log.New(w, "", log.LstdFlags)
		filePath = opts.LogFilePath
		writeHeader(opts)
	}
}

// writeHeader records a one-line instance banner to the file sink so a collected
// log is self-describing — which process wrote it (component, pid), and, when a
// watchdog re-exec recycles the image in place, which generation produced the
// lines that follow. File-only: it would be noise on the console.
func writeHeader(opts Options) {
	if fileLogger == nil {
		return
	}
	parts := []string{
		fmt.Sprintf("component=%s", nonEmpty(opts.Component, "?")),
		fmt.Sprintf("pid=%d", os.Getpid()),
	}
	keys := make([]string, 0, len(opts.HeaderExtra))
	for k := range opts.HeaderExtra {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%s", k, opts.HeaderExtra[k]))
	}
	fileLogger.Printf("===== juggler %s =====", strings.Join(parts, " "))
}

func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// Close flushes and closes the log file (if any).
func Close() {
	if fileSink != nil {
		fileSink.Close()
		fileSink = nil
		fileLogger = nil
	}
}

// Info logs a message that is always visible on console and file.
func Info(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Print(msg)
	writeFile("INFO", msg)
}

// Debug logs a message visible on console only when debug is enabled.
// Always written to the log file.
func Debug(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if consoleLevel >= LevelDebug {
		if colors {
			log.Printf("%s[DEBUG] %s%s", colorDim, msg, colorReset)
		} else {
			log.Printf("[DEBUG] %s", msg)
		}
	}
	writeFile("DEBUG", msg)
}

// Trace logs a message that only goes to the log file, never to console.
func Trace(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	writeFile("TRACE", msg)
}

// Error logs an error message, always visible on console and file.
func Error(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if colors {
		log.Printf("%s%s[ERROR] %s%s", colorBold, colorRed, msg, colorReset)
	} else {
		log.Printf("[ERROR] %s", msg)
	}
	writeFile("ERROR", msg)
}

// Tool logs a concise tool action line, always visible.
func Tool(name string, summary string) {
	if colors {
		log.Printf("%s%s[TOOL] %s: %s%s", colorBold, colorMagenta, name, summary, colorReset)
	} else {
		log.Printf("[TOOL] %s: %s", name, summary)
	}
	writeFile("TOOL", fmt.Sprintf("%s: %s", name, summary))
}

// writeFile writes a message to the process-wide log file if one is configured.
func writeFile(level, msg string) {
	writeToFile(fileLogger, level, msg)
}

// writeToFile appends a level-tagged message to a specific file logger, applying
// the shared formatting (ANSI stripping, multi-line indenting). Used both by the
// process sink (writeFile) and by per-conversation Loggers, so every on-disk log
// line looks identical regardless of which sink it lands in. No-op on a nil logger.
func writeToFile(lg *log.Logger, level, msg string) {
	if lg == nil {
		return
	}
	// Strip any ANSI codes that may have leaked into the message.
	clean := ansiRe.ReplaceAllString(msg, "")
	// Collapse multi-line into indented block for file readability.
	if strings.Contains(clean, "\n") {
		lines := strings.Split(clean, "\n")
		lg.Printf("[%s] %s", level, lines[0])
		for _, line := range lines[1:] {
			lg.Printf("       %s", line)
		}
	} else {
		lg.Printf("[%s] %s", level, clean)
	}
}

// FileLoggingEnabled reports whether on-disk logging is active — a file sink was
// configured and successfully opened. Callers that want to open an additional
// per-conversation sink (jlog.NewLogger) should gate on this so they don't
// create files when the user has logging disabled or no file sink exists.
func FileLoggingEnabled() bool { return fileLogger != nil }

// FilePath returns the process-wide log file's path, or "" when on-disk logging
// is off or its file could not be opened. It is the anchor for diagnostic
// artifacts that belong beside the log rather than in it — a crash dump, a
// thread sample — so they land in the same folder a bug report already collects,
// and so "logging is disabled" suppresses them too.
func FilePath() string {
	if fileLogger == nil {
		return ""
	}
	return filePath
}

// Logger is a per-conversation log handle. Every line it emits goes to the
// process-wide sink and console exactly as the package-level functions do — so
// the process log (server.log) stays a complete, interleaved superset and
// console behavior is unchanged — and is ALSO appended to this handle's own file
// sink, giving a per-conversation view without losing the cross-conversation
// timeline.
//
// The per-conversation sink is owned by a single goroutine (the actor) reached
// over a channel: writes, Rename, and Close are all serialized there with no
// mutex (per the project's goroutines-over-mutexes rule), so Rename can close,
// move, and reopen the file with no risk of racing a concurrent write — and
// every method is safe to call from any goroutine.
//
// A nil *Logger is valid and behaves exactly like the package-level functions
// (process sink + console only, no per-conversation file). This lets a worker
// hold a nil handle before its sink is set up, or when file logging is disabled,
// and still call w.log.Info(...) unconditionally.
type Logger struct {
	cmds chan logCmd
	done chan struct{} // closed when the actor exits (after Close)
}

type logCmdKind int

const (
	cmdWrite logCmdKind = iota
	cmdRename
	cmdClose
)

type logCmd struct {
	kind     logCmdKind
	level    string        // cmdWrite
	msg      string        // cmdWrite
	newPath  string        // cmdRename
	closeAck chan struct{} // cmdClose: closed once the file is flushed + closed
}

// NewLogger opens path as an additional, size-rotated per-conversation sink
// (same rotation contract as the main file) and starts its owning goroutine. It
// is best-effort: if the file can't be opened the actor still runs (writes are
// dropped, a later Rename can reopen), so the caller always gets process-sink +
// console behavior. Gate creation on FileLoggingEnabled().
func NewLogger(path string, maxSizeMB, maxBackups int) *Logger {
	l := &Logger{cmds: make(chan logCmd, 256), done: make(chan struct{})}
	go l.run(path, maxSizeMB, maxBackups)
	return l
}

// run is the actor: it solely owns the per-conversation file, applying writes,
// renames, and the final close in arrival order.
func (l *Logger) run(path string, maxSizeMB, maxBackups int) {
	defer close(l.done)
	maxBytes := int64(maxSizeMB) * 1024 * 1024
	open := func(p string) (*rotatingWriter, *log.Logger) {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return nil, nil
		}
		w, err := newRotatingWriter(p, maxBytes, maxBackups)
		if err != nil {
			return nil, nil
		}
		return w, log.New(w, "", log.LstdFlags)
	}
	sink, lg := open(path)
	for cmd := range l.cmds {
		switch cmd.kind {
		case cmdWrite:
			writeToFile(lg, cmd.level, cmd.msg)
		case cmdRename:
			if cmd.newPath == "" || cmd.newPath == path {
				continue
			}
			if sink != nil {
				sink.Close()
			}
			renameLogFiles(path, cmd.newPath, maxBackups)
			path = cmd.newPath
			sink, lg = open(path)
		case cmdClose:
			if sink != nil {
				sink.Close()
			}
			close(cmd.closeAck)
			return
		}
	}
}

// renameLogFiles best-effort moves a log file and its rotation backups from old
// to new. Each rename is independent so a missing backup never aborts the rest.
func renameLogFiles(oldPath, newPath string, maxBackups int) {
	_ = os.MkdirAll(filepath.Dir(newPath), 0o755)
	_ = os.Rename(oldPath, newPath)
	for i := 1; i <= maxBackups; i++ {
		_ = os.Rename(fmt.Sprintf("%s.%d", oldPath, i), fmt.Sprintf("%s.%d", newPath, i))
	}
}

// Info/Debug/Trace/Error/Tool mirror the package-level functions, additionally
// appending to this handle's per-conversation sink.
func (l *Logger) Info(format string, args ...any) {
	Info(format, args...)
	l.enqueue("INFO", format, args...)
}
func (l *Logger) Debug(format string, args ...any) {
	Debug(format, args...)
	l.enqueue("DEBUG", format, args...)
}
func (l *Logger) Trace(format string, args ...any) {
	Trace(format, args...)
	l.enqueue("TRACE", format, args...)
}
func (l *Logger) Error(format string, args ...any) {
	Error(format, args...)
	l.enqueue("ERROR", format, args...)
}
func (l *Logger) Tool(name, summary string) {
	Tool(name, summary)
	l.enqueue("TOOL", "%s: %s", name, summary)
}

// enqueue hands a formatted line to the actor. Nil-safe and NON-blocking: if the
// buffer is full (disk backpressure) or the actor has been closed, the line is
// dropped rather than blocking the caller — logging must never wedge a worker,
// and the line is already in the process-wide server.log (written synchronously
// by the package-level call in the Info/Debug/... wrappers).
func (l *Logger) enqueue(level, format string, args ...any) {
	if l == nil {
		return
	}
	cmd := logCmd{kind: cmdWrite, level: level, msg: fmt.Sprintf(format, args...)}
	select {
	case l.cmds <- cmd:
	default:
	}
}

// Rename moves the per-conversation log file (and its rotation backups) to
// newPath and continues writing there. Serialized with writes on the actor, so
// it never races a concurrent log line. Nil-safe; no-op after Close.
func (l *Logger) Rename(newPath string) {
	if l == nil {
		return
	}
	select {
	case l.cmds <- logCmd{kind: cmdRename, newPath: newPath}:
	case <-l.done:
	}
}

// Close flushes and closes the per-conversation sink, stopping the actor.
// Blocks until the file is closed. Idempotent and nil-safe.
func (l *Logger) Close() {
	if l == nil {
		return
	}
	ack := make(chan struct{})
	select {
	case l.cmds <- logCmd{kind: cmdClose, closeAck: ack}:
		<-ack
	case <-l.done:
	}
}
