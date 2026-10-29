//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package integration_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/internal/ingress"
)

// TestSessionChildRunsNoLoginShell: a session child has no terminal, but it
// inherits the PATH its spawner already has — the machine server repairs its
// own before spawning — so it runs no login-shell PATH probe of its own. One
// would cost every session open up to the probe's timeout, and would run the
// user's rc files with the child's secrets in their environment.
func TestSessionChildRunsNoLoginShell(t *testing.T) {
	ran := filepath.Join(t.TempDir(), "shell-ran")
	shell := filepath.Join(t.TempDir(), "fakeshell")
	script := "#!/bin/sh\nenv > '" + ran + "'\nprintf '%s%s%s%s%s' __JUGGLER_LOGIN __PATH__ \"$PATH\" __JUGGLER_LOGIN __PATH__\n"
	if err := os.WriteFile(shell, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", shell)

	secret, token := ingress.NewSecret(), ingress.NewSecret()
	startSessionChild(t, newProjectDir(t), secret, token)

	env, err := os.ReadFile(ran)
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		t.Fatalf("read %s: %v", ran, err)
	}
	t.Errorf("the session child ran $SHELL for a PATH probe")
	for _, v := range []string{secret, token} {
		if strings.Contains(string(env), v) {
			t.Errorf("the login shell ran with the child's secrets in its environment")
			break
		}
	}
}
