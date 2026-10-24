//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"os"
	"os/exec"
	"runtime"
	"slices"
	"strings"

	"juggler/cmd/juggler/projectenv"
)

// applyProjectEnv gives cmd the variables the user set for this project (see
// package projectenv), on top of the server's own environment. Every command a
// shell op starts goes through here, after cmd.Dir is set.
//
// They are read from the PROJECT, not the tree the command runs in: a
// workspace is a checkout of the project, and its own .juggler/ — if a branch
// carries one — is not the user's.
//
// With nothing set, cmd.Env stays nil and the command inherits the server's
// environment exactly as it always would.
func (ops *ShellOperations) applyProjectEnv(cmd *exec.Cmd) {
	overrides := projectenv.Overrides(ops.scope.ProjectRoot())
	if len(overrides) == 0 {
		return
	}
	cmd.Env = envWithOverrides(os.Environ(), overrides, runtime.GOOS == "windows")
}

// envWithOverrides returns base with overrides set, each replacing any entry of
// the same name. On Windows names are case-insensitive, and a variable set on
// wsl.exe reaches the Linux side only when WSLENV lists it, so every name but
// PATH is added there with /u (Windows to WSL). PATH is left to WSL, which
// builds a Linux PATH of its own that this Windows-form list would replace.
func envWithOverrides(base []string, overrides map[string]string, windows bool) []string {
	same := func(a, b string) bool { return a == b }
	if windows {
		same = strings.EqualFold
	}
	overridden := func(name string) bool {
		for k := range overrides {
			if same(k, name) {
				return true
			}
		}
		return false
	}

	out := make([]string, 0, len(base)+len(overrides)+1)
	wslenv, hadWSLENV := "", false
	for _, kv := range base {
		name, value, _ := strings.Cut(kv, "=")
		if windows && same(name, "WSLENV") {
			wslenv, hadWSLENV = value, true
			continue
		}
		if !overridden(name) {
			out = append(out, kv)
		}
	}

	names := make([]string, 0, len(overrides))
	for k := range overrides {
		names = append(names, k)
	}
	slices.Sort(names)
	for _, k := range names {
		if windows && same(k, "WSLENV") {
			// The user's own WSLENV is the list the names are added to.
			wslenv, hadWSLENV = overrides[k], true
			continue
		}
		out = append(out, k+"="+overrides[k])
	}

	if windows {
		var list []string
		if wslenv != "" {
			list = strings.Split(wslenv, ":")
		}
		for _, k := range names {
			if same(k, "PATH") || same(k, "WSLENV") {
				continue
			}
			if !slices.ContainsFunc(list, func(e string) bool { n, _, _ := strings.Cut(e, "/"); return same(n, k) }) {
				list = append(list, k+"/u")
			}
		}
		if len(list) > 0 || hadWSLENV {
			out = append(out, "WSLENV="+strings.Join(list, ":"))
		}
	}
	return out
}
