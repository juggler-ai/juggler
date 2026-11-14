//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package provider

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// An account of a CLI-login type (Claude Code, Codex) is a folder its CLI is
// pointed at through an environment variable — CLAUDE_CONFIG_DIR, CODEX_HOME.
// These are the helpers such types share: one spelling of a folder, the
// command that signs it in, and finding the folders a user already keeps.

// CanonicalDir is the one spelling of a folder: absolute, cleaned, and with
// symlinks resolved — those on the part of the path that exists, when the
// folder itself does not yet. A CLI that keys anything on the folder's path
// (the Claude CLI's Keychain entry) sees one account, not two.
func CanonicalDir(dir string) string {
	dir = filepath.Clean(dir)
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	missing := ""
	for existing := dir; ; {
		if resolved, err := filepath.EvalSymlinks(existing); err == nil {
			return filepath.Join(resolved, missing)
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return dir
		}
		missing = filepath.Join(filepath.Base(existing), missing)
		existing = parent
	}
}

// PrepareAccountDir validates a folder setting and gives it its one spelling.
// It refuses defaultDir, the folder the type's default account uses, which
// would be the same login. It creates nothing.
func PrepareAccountDir(raw, defaultDir string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("a folder is required")
	}
	dir, err := ExpandHome(raw)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(dir) {
		return "", fmt.Errorf("%s is not an absolute path", raw)
	}
	dir = CanonicalDir(dir)
	if defaultDir != "" && FolderLoginKey(dir) == FolderLoginKey(defaultDir) {
		return "", fmt.Errorf("%s is the default account's own folder", raw)
	}
	return dir, nil
}

// FolderLoginKey is the LoginKey of a type whose accounts are folders: the
// folder's one spelling, case-folded where the file system usually ignores
// case (macOS, Windows), so ~/.Claude-Work and ~/.claude-work are one login.
// "" for a value that names no folder.
func FolderLoginKey(raw string) string {
	dir, err := ExpandHome(strings.TrimSpace(raw))
	if err != nil || !filepath.IsAbs(dir) {
		return ""
	}
	dir = CanonicalDir(dir)
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		dir = strings.ToLower(dir)
	}
	return dir
}

// ExpandHome expands a leading ~ to the home directory.
func ExpandHome(path string) (string, error) {
	if path != "~" && !strings.HasPrefix(path, "~/") && !strings.HasPrefix(path, `~\`) {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, path[1:]), nil
}

// SignInCommandLine is command run with envVar set to dir, as a user types it
// in a terminal: POSIX shell syntax, or PowerShell on Windows. dir is written
// out exactly — a shorter ~ form could name a different spelling of it.
func SignInCommandLine(envVar, dir, command string) string {
	if runtime.GOOS == "windows" {
		return "$env:" + envVar + " = '" + strings.ReplaceAll(dir, "'", "''") + "'; " + command
	}
	return envVar + "=" + shellQuote(dir) + " " + command
}

// shellSafe matches a word a POSIX shell takes as it is.
var shellSafe = regexp.MustCompile(`^[A-Za-z0-9_./+:@%-]+$`)

// shellQuote quotes s for a POSIX shell when it needs it.
func shellQuote(s string) string {
	if shellSafe.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// rcFiles are the shell startup files, relative to home, that may set an
// account's folder variable.
var rcFiles = []string{".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"}

// FoldersNamedInShellFiles lists the folders the user's shell startup files
// give envVar — VAR=value in sh, in an alias or an export, or `set -x VAR
// value` in fish — with quotes taken off and ~, $HOME and ${HOME} expanded. A
// value naming any other variable is not one that can be followed. Reading a
// dotfile to find a path is all this reads.
func FoldersNamedInShellFiles(home, envVar string) []string {
	assignment := regexp.MustCompile(regexp.QuoteMeta(envVar) + `(?:=|\s+)("[^"]*"|'[^']*'|[^\s;'"&|)]+)`)
	var out []string
	for _, rc := range rcFiles {
		data, err := os.ReadFile(filepath.Join(home, rc))
		if err != nil {
			continue
		}
		for _, m := range assignment.FindAllStringSubmatch(string(data), -1) {
			if dir, ok := shellPath(m[1], home); ok {
				out = append(out, dir)
			}
		}
	}
	return out
}

// shellPath turns a shell value into a path.
func shellPath(value, home string) (string, bool) {
	value = strings.Trim(value, `"'`)
	for _, prefix := range []string{"~", "$HOME", "${HOME}"} {
		if value == prefix || strings.HasPrefix(value, prefix+"/") {
			value = home + value[len(prefix):]
			break
		}
	}
	if strings.Contains(value, "$") || !filepath.IsAbs(value) {
		return "", false
	}
	return value, true
}

// FoldersNamedLike lists home's folders whose name starts with one of
// prefixes: ".claude-" finds ~/.claude-work.
func FoldersNamedLike(home string, prefixes ...string) []string {
	entries, err := os.ReadDir(home)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		for _, prefix := range prefixes {
			if strings.HasPrefix(e.Name(), prefix) && len(e.Name()) > len(prefix) {
				out = append(out, filepath.Join(home, e.Name()))
				break
			}
		}
	}
	return out
}

// FolderSuffix names a found folder for what follows its prefix: "work" for
// ~/.claude-work given ".claude-"; else its name without a leading dot.
func FolderSuffix(dir string, prefixes ...string) string {
	base := filepath.Base(dir)
	for _, prefix := range prefixes {
		if s, ok := strings.CutPrefix(base, prefix); ok && s != "" {
			return s
		}
	}
	return strings.TrimPrefix(base, ".")
}

// HomeRelative shows a path under home with ~ in its place.
func HomeRelative(path, home string) string {
	home = CanonicalDir(home)
	if rel, err := filepath.Rel(home, path); err == nil && !strings.HasPrefix(rel, "..") {
		return filepath.Join("~", rel)
	}
	return path
}
