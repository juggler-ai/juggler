//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package app

import (
	"context"
	"errors"
	"fmt"
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
// a launch with no repair — and is recorded in pathRepairReport.
func repairPathForGUILaunch(hasTerminal bool) {
	if hasTerminal {
		return
	}
	loginPath, err := loginShellPath()
	if err != nil {
		// Logging isn't up yet; initLogging reports this once it is. Without
		// it, a failed probe is invisible, and so is the reason a GUI launch
		// can't find tools a terminal launch finds.
		pathRepairReport = fmt.Sprintf("login-shell PATH probe failed, keeping the launch PATH %q: %v", os.Getenv("PATH"), err)
		return
	}
	_ = os.Setenv("PATH", mergePath(os.Getenv("PATH"), loginPath))
}

// repairPathForServe is repairPathForGUILaunch for `juggler serve`, which is
// dispatched before Run's own terminal check: a server started by the desktop
// app (or detached by bare juggler) has no terminal, and repairs.
func repairPathForServe() {
	repairPathForGUILaunch(launchedFromTerminal())
}

// loginPathMarker brackets the PATH in the probe's output. An interactive
// shell's rc files may print anything — a greeting, a fortune, a version
// manager's notice — to the same stdout before and after the command runs, and
// read as part of the PATH it would corrupt the first entry, which is usually
// the version manager's. The marker is split in the command text ('%s' pieces)
// so a shell that echoes its input can't produce a matching pair.
const loginPathMarker = "__JUGGLER_LOGIN_PATH__"

// loginShellPath runs the user's login shell and captures the $PATH it builds.
// It fails when $SHELL is unset, the shell fails or times out, or its output
// carries no marked PATH. -l -i sources both the profile and the interactive rc
// files (.zshrc/.bashrc), where version managers register their bin dirs; the
// flags are separate (not -lic) for fish, which joins a quoted "$PATH" with
// colons as the other shells do.
//
// Setsid is load-bearing: it puts the shell in a new session with no controlling
// terminal, so an interactive shell can't grab our tty's foreground group or
// leave it in raw mode — which, when the timeout SIGKILLs a slow shell before
// it restores the terminal, would background us (SIGTTIN → "suspended (tty
// input)") and corrupt the terminal. Stdin is /dev/null by default.
func loginShellPath() (string, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return "", errors.New("$SHELL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), loginShellProbeTimeout)
	defer cancel()

	half := len(loginPathMarker) / 2
	command := fmt.Sprintf(`printf '%%s%%s%%s%%s%%s' '%s' '%s' "$PATH" '%s' '%s'`,
		loginPathMarker[:half], loginPathMarker[half:], loginPathMarker[:half], loginPathMarker[half:])
	cmd := exec.CommandContext(ctx, shell, "-l", "-i", "-c", command)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	out, err := cmd.Output()
	if ctx.Err() != nil {
		return "", fmt.Errorf("%s did not answer within %s", shell, loginShellProbeTimeout)
	}
	if err != nil {
		return "", fmt.Errorf("%s: %w", shell, err)
	}
	path, ok := markedLoginPath(string(out))
	if !ok {
		return "", fmt.Errorf("%s printed no PATH", shell)
	}
	return path, nil
}

// markedLoginPath extracts the PATH from between the last pair of markers in
// the probe's output, so rc-file output on either side is ignored.
func markedLoginPath(out string) (string, bool) {
	end := strings.LastIndex(out, loginPathMarker)
	if end < 0 {
		return "", false
	}
	start := strings.LastIndex(out[:end], loginPathMarker)
	if start < 0 {
		return "", false
	}
	path := strings.TrimSpace(out[start+len(loginPathMarker) : end])
	return path, path != ""
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
