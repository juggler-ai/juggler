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
	cmd.Env = shellEnv(cmd, envWithOverrides(os.Environ(), overrides, runtime.GOOS == "windows"), overrides)
}

// envWithOverrides returns base with overrides set, each replacing any entry of
// the same name — case-insensitively where names are, as on Windows. Anything a
// particular shell needs on top is shellEnv's, in the platform's shell_ops file.
func envWithOverrides(base []string, overrides map[string]string, foldNames bool) []string {
	same := func(a, b string) bool { return a == b }
	if foldNames {
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

	out := make([]string, 0, len(base)+len(overrides))
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
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
		out = append(out, k+"="+overrides[k])
	}
	return out
}
