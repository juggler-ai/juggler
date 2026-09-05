//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// loginShellProbeTimeout bounds the login-shell probe: a shell that has not
// answered by then is SIGKILLed and PATH is left untouched. Sized for a real
// login shell sourcing a user's rc files (a slow one here is ~40ms).
//
// A var rather than a const so a test can buy patience it proves nothing
// about: a test's probe execs a script written moments earlier and pays macOS
// first-exec scanning for it, a cost belonging to the machine rather than to
// anything the test asserts.
var loginShellProbeTimeout = 4 * time.Second

// repairPathForGUILaunch merges the user's login-shell $PATH into this process's
// PATH so every child it later spawns (the bash tool, git, the claude/codex CLIs)
// resolves tools the way a terminal launch would. A Finder/Dock launch inherits a
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) with none of the Homebrew,
// version-manager (nvm/fnm/volta/asdf), or ~/.local/bin entries the shell adds,
// because LaunchServices never sources the shell's profile/rc files.
//
// A terminal launch already has the full PATH, so this is a no-op there. Any
// failure (no $SHELL, timeout, bad exit) leaves PATH untouched — no worse than
// before.
func repairPathForGUILaunch(hasTerminal bool) {
	if hasTerminal {
		return
	}
	if loginPath := loginShellPath(); loginPath != "" {
		_ = os.Setenv("PATH", mergePath(os.Getenv("PATH"), loginPath))
	}
}

// loginShellPath runs the user's login shell and captures the $PATH it builds,
// or "" if $SHELL is unset or the probe fails/times out. -l -i sources both the
// profile and the interactive rc files (.zshrc/.bashrc), where version managers
// register their bin dirs; the flags are separate (not -lic) for fish.
//
// Setsid is load-bearing: it puts the shell in a new session with no controlling
// terminal, so an interactive shell can't grab our tty's foreground group or
// leave it in raw mode — which, when the timeout SIGKILLs a slow shell before
// it restores the terminal, would background us (SIGTTIN → "suspended (tty
// input)") and corrupt the terminal. Stdin is /dev/null by default.
func loginShellPath() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), loginShellProbeTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, shell, "-l", "-i", "-c", "printf %s \"$PATH\"")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// mergePath unions two PATH-style strings, putting login's entries first and
// de-duplicating by exact string match (case-sensitive, matching how shells
// resolve PATH). Entries from login come first so the merged PATH matches what
// a terminal launch would have produced; anything present only in current is
// appended afterwards so a Juggler-added entry is never lost. Empty entries are
// dropped. Returns the joined result using the platform PATH separator.
func mergePath(current, login string) string {
	var result []string
	seen := make(map[string]bool)
	add := func(path string) {
		for _, entry := range filepath.SplitList(path) {
			entry = strings.TrimSpace(entry)
			if entry == "" || seen[entry] {
				continue
			}
			seen[entry] = true
			result = append(result, entry)
		}
	}
	add(login)
	add(current)
	return strings.Join(result, string(os.PathListSeparator))
}
