//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package projectpaths is the single source of truth for where a project's own
// files live on disk. A project has two folders:
//
//   - Shared (<project>/.juggler) holds what is meant to travel with the
//     repository: env.json, commands/, skills/, mcp.json, acp.json,
//     worktree-setup. It always lives in the project, and exists only once one
//     of those files has been written.
//   - State holds what belongs to this checkout on this machine: the lock,
//     config.json, session.json, conversation folders, trash, bash output,
//     memory, env.local.json, scratch-copy sandboxes. By default it is the
//     same folder as Shared. With the "keep project state outside the project"
//     setting on, it is <StateBase>/<Slug(project)> instead, so a project's
//     tree carries no conversation files for other tools to trip over.
//
// Where State is is decided by the disk, not by the setting: it is the outside
// folder exactly when that folder exists. The setting is read only at session
// start, where the state is moved to match it (core.PlaceProjectState). So
// every process that asks — a session, the machine server reading attention
// for a project with no session, a one-shot run — finds the same folder
// without reading settings, and a project's state is never split between two.
package projectpaths

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// DirName is the name of the project-level folder, Shared.
const DirName = ".juggler"

// StateDirEnv overrides StateBase and, when set, also turns the outside
// placement on (see OutsideByEnv): it is the way to drive the feature where
// settings.json is not read — the integration harness under --test — and a way
// for a user to choose the base folder.
const StateDirEnv = "JUGGLER_STATE_DIR"

// Dirs is where one project's files live.
type Dirs struct {
	// Shared is <project>/.juggler, for files meant to be committed.
	Shared string
	// State is the folder for this checkout's local state. Equal to Shared
	// unless the project's state lives outside it.
	State string
}

// Outside reports whether the project's state lives outside the project.
func (d Dirs) Outside() bool { return d.State != d.Shared }

// For returns where project's files live (see the package doc).
func For(project string) Dirs {
	shared := SharedDir(project)
	outside := OutsideDir(project)
	if info, err := os.Stat(outside); err == nil && info.IsDir() {
		return Dirs{Shared: shared, State: outside}
	}
	return Dirs{Shared: shared, State: shared}
}

// StateDir is For(project).State.
func StateDir(project string) string { return For(project).State }

// SharedDir returns <project>/.juggler.
func SharedDir(project string) string { return filepath.Join(project, DirName) }

// OutsideDir returns the folder project's state uses when it lives outside the
// project, whether or not it exists: <StateBase>/<Slug(project)>.
func OutsideDir(project string) string {
	return filepath.Join(StateBase(), Slug(project))
}

// OutsideByEnv reports whether StateDirEnv asks for outside placement.
func OutsideByEnv() bool { return os.Getenv(StateDirEnv) != "" }

// StateBase returns the folder that holds every project's outside state.
func StateBase() string {
	home, _ := os.UserHomeDir()
	return resolveStateBase(runtime.GOOS, home, os.Getenv)
}

// resolveStateBase computes StateBase from injected inputs, so every OS branch
// is unit-testable from any host. It follows each platform's convention for
// application data — deliberately not ~/.juggler, which stays small and
// copyable:
//
//	macOS    ~/Library/Application Support/Juggler/projects
//	Windows  %LOCALAPPDATA%\Juggler\projects
//	Linux    $XDG_STATE_HOME/juggler/projects   (default ~/.local/state/juggler/projects)
func resolveStateBase(goos, home string, getenv func(string) string) string {
	if override := getenv(StateDirEnv); override != "" {
		return override
	}
	switch goos {
	case "darwin":
		if home != "" {
			return filepath.Join(home, "Library", "Application Support", "Juggler", "projects")
		}
	case "windows":
		if la := getenv("LOCALAPPDATA"); la != "" {
			return filepath.Join(la, "Juggler", "projects")
		}
		if home != "" {
			return filepath.Join(home, "AppData", "Local", "Juggler", "projects")
		}
	default: // Linux and other Unixes — XDG Base Directory spec (this is "state").
		if xdg := getenv("XDG_STATE_HOME"); xdg != "" {
			return filepath.Join(xdg, "juggler", "projects")
		}
		if home != "" {
			return filepath.Join(home, ".local", "state", "juggler", "projects")
		}
	}
	return filepath.Join(os.TempDir(), "juggler-projects")
}

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

// Slug derives a stable, collision-resistant, human-recognisable folder name
// for a project path: its sanitized basename plus a short hash of the cleaned
// absolute path. Same project (even via an un-cleaned or relative spelling) →
// same slug; different projects that share a basename → different slugs. The
// project's log folder and its outside state folder share it.
func Slug(project string) string {
	abs := project
	if a, err := filepath.Abs(project); err == nil {
		abs = a
	}
	abs = filepath.Clean(abs)

	sum := sha256.Sum256([]byte(abs))
	hash := hex.EncodeToString(sum[:])[:slugHashLen]

	name := SanitizeSegment(filepath.Base(abs))
	if name == "" {
		name = "project"
	}
	return name + "-" + hash
}

// SanitizeSegment makes s safe to use as a single path segment.
func SanitizeSegment(s string) string {
	s = unsafeCharRe.ReplaceAllString(s, "_")
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, ". ")
	if rs := []rune(s); len(rs) > slugNameMaxRunes {
		s = strings.TrimRight(string(rs[:slugNameMaxRunes]), ". ")
	}
	return s
}
