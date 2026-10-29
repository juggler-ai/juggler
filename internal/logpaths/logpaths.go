//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package logpaths is the single source of truth for where Juggler writes its
// logs on disk. Both binaries — the server (cmd/juggler) and the desktop app
// (cmd/juggler-app) — resolve paths through here, so a given project maps to
// the same file no matter which process opens it.
//
// Logs live in the platform-conventional application-log directory (see
// LogDir) — deliberately OUTSIDE ~/.juggler, so that folder stays copyable
// (config, credentials, sessions) without dragging logs along, and so each OS
// surfaces them where users and their tooling expect (e.g. macOS Console.app
// reads ~/Library/Logs).
//
// Layout — the desktop app's log is a flat file; everything for one project
// server lives in that project's own folder, so a bug report is still a single
// tree to zip but conversations no longer interleave into one file:
//
//	<log-dir>/                            (macOS: ~/Library/Logs/Juggler)
//	├── app.log                           desktop app
//	├── host/                             server launched with no project
//	│   ├── server.log                    process-level: startup, HTTP/WS, lifecycle
//	│   ├── server.stderr.log             raw stderr: panics / pre-jlog crashes
//	│   └── conversations/
//	│       └── conv_xxxxxxxxx.log        one file per conversation
//	└── <slug>/                           server for that project
//	    ├── server.log
//	    ├── server.stderr.log
//	    └── conversations/
//	        └── conv_xxxxxxxxx.log
//
// The <slug> is the project's sanitized basename plus a short hash of its
// absolute path, so two projects that share a basename never collide while the
// folder name stays human-recognisable. A conversation log is named by its
// stable conversation id (conv_<base36>), so a UI feature can map a conversation
// to its file without depending on the mutable tab title.
package logpaths

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// slugHashLen is the number of hex chars of the path hash appended to a slug.
// Eight hex chars (32 bits) is ample to separate the handful of projects a
// user juggles while keeping the folder name short.
const slugHashLen = 8

// slugNameMaxRunes caps the readable portion of a slug so the folder name stays
// well under filesystem limits even with the "-<hash>" suffix.
const slugNameMaxRunes = 40

// unsafeCharRe matches characters that are unsafe in a path segment on at least
// one supported OS, plus C0/DEL controls. Replaced with "_".
var unsafeCharRe = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f\x7f]`)

// LogDir returns the directory all Juggler logs live under, following each
// platform's convention for application logs:
//
//	macOS    ~/Library/Logs/Juggler
//	Windows  %LOCALAPPDATA%\Juggler\Logs
//	Linux    $XDG_STATE_HOME/juggler/logs   (default ~/.local/state/juggler/logs)
//
// This is deliberately OUTSIDE ~/.juggler so that folder stays copyable without
// dragging logs along. If the conventional location can't be resolved it falls
// back to the OS temp dir, so a path is always produced (logging never silently
// has nowhere to go).
func LogDir() string {
	home, _ := os.UserHomeDir()
	return resolveLogDir(runtime.GOOS, home, os.Getenv)
}

// resolveLogDir computes the platform-conventional log directory from injected
// inputs (GOOS, home, an env lookup), so every OS branch is unit-testable from
// any host. Returns the OS temp dir as a last resort.
//
// JUGGLER_LOG_DIR, if set, overrides every platform default. It is the
// sanctioned way to redirect logs away from the user's real application-log
// directory — chiefly the integration harness, which points every test
// subprocess at a throwaway temp dir so test runs never litter
// ~/Library/Logs/Juggler with browser-test-*.log files.
func resolveLogDir(goos, home string, getenv func(string) string) string {
	if override := getenv("JUGGLER_LOG_DIR"); override != "" {
		return override
	}
	switch goos {
	case "darwin":
		if home != "" {
			return filepath.Join(home, "Library", "Logs", "Juggler")
		}
	case "windows":
		if la := getenv("LOCALAPPDATA"); la != "" {
			return filepath.Join(la, "Juggler", "Logs")
		}
		if home != "" {
			return filepath.Join(home, "AppData", "Local", "Juggler", "Logs")
		}
	default: // Linux and other Unixes — XDG Base Directory spec (logs are "state").
		if xdg := getenv("XDG_STATE_HOME"); xdg != "" {
			return filepath.Join(xdg, "juggler", "logs")
		}
		if home != "" {
			return filepath.Join(home, ".local", "state", "juggler", "logs")
		}
	}
	return filepath.Join(os.TempDir(), "juggler-logs")
}

// AppLogPath returns the desktop app's log file: app.log in the platform log
// directory (see LogDir).
func AppLogPath() string {
	return filepath.Join(LogDir(), "app.log")
}

// ProjectLogDir returns the directory that holds all logs for one project
// server: its structured log, stderr crash log, and per-conversation logs. An
// empty project (a host launch) maps to the "host" folder; otherwise
// to "<slug>". Both sit directly under LogDir.
func ProjectLogDir(project string) string {
	name := "host"
	if project != "" {
		name = slug(project)
	}
	return filepath.Join(LogDir(), name)
}

// ServerLogPath returns the server's structured (jlog) log file for project:
// server.log inside the project's log folder (see ProjectLogDir).
func ServerLogPath(project string) string {
	return filepath.Join(ProjectLogDir(project), "server.log")
}

// StderrLogPath returns the raw-stderr crash file that sits alongside the
// server's structured log — the catcher for panics and any output emitted
// before jlog is initialised. It is a sibling of ServerLogPath.
func StderrLogPath(project string) string {
	return filepath.Join(ProjectLogDir(project), "server.stderr.log")
}

// ConversationLogPath returns the per-conversation log file for convID within
// project: conversations/<name>--<convID>.log inside the project's log folder
// (or conversations/<convID>.log when name is empty). The optional name is a
// human-readable prefix (the tab title) that makes the file easy to spot in a
// directory listing; the conversation id (conv_<base36>) is always the trailing,
// authoritative part, so a convID→path lookup stays stable across renames by
// matching the <convID>.log suffix. Both parts are sanitized for filename safety.
func ConversationLogPath(project, convID, name string) string {
	stem := sanitizeSegment(convID)
	if stem == "" {
		stem = "conversation"
	}
	if prefix := sanitizeSegment(name); prefix != "" {
		stem = prefix + "--" + stem
	}
	return filepath.Join(conversationLogDir(project), stem+".log")
}

// conversationLogDir is the folder of per-conversation logs inside project's
// log folder.
func conversationLogDir(project string) string {
	return filepath.Join(ProjectLogDir(project), "conversations")
}

// slug derives a stable, collision-resistant, human-recognisable filename stem
// for a project path: its sanitized basename plus a short hash of the cleaned
// absolute path. Same project (even via an un-cleaned or relative spelling) →
// same slug; different projects that share a basename → different slugs.
func slug(project string) string {
	abs := project
	if a, err := filepath.Abs(project); err == nil {
		abs = a
	}
	abs = filepath.Clean(abs)

	sum := sha256.Sum256([]byte(abs))
	hash := hex.EncodeToString(sum[:])[:slugHashLen]

	name := sanitizeSegment(filepath.Base(abs))
	if name == "" {
		name = "project"
	}
	return name + "-" + hash
}

// sanitizeSegment makes s safe to use as a single path segment.
func sanitizeSegment(s string) string {
	s = unsafeCharRe.ReplaceAllString(s, "_")
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, ". ")
	if rs := []rune(s); len(rs) > slugNameMaxRunes {
		s = strings.TrimRight(string(rs[:slugNameMaxRunes]), ". ")
	}
	return s
}
