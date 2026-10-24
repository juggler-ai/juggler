//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os"
	"testing"

	"juggler/cmd/juggler/projectenv"
)

// The projectEnv ops read and write the PROJECT's files whichever workspace the
// request names, and approval is an explicit act on what the file holds now.
func TestProjectEnvOps(t *testing.T) {
	t.Setenv("JUGGLER_CONFIG_DIR", t.TempDir())
	project, workspace := t.TempDir(), t.TempDir()
	o := NewProjectEnvOperations(NewPathScope(workspace, nil).WithProjectRoot(project))
	ctx := context.Background()

	get := func() projectenv.Resolved {
		t.Helper()
		res, err := o.Execute(ctx, "get", nil)
		if err != nil {
			t.Fatal(err)
		}
		return res.(projectenv.Resolved)
	}

	// Written by hand (or by a clone), the project file waits.
	writeEnvFile(t, projectenv.Path(projectenv.ScopeProject, project), `{"REPO":"1"}`)
	if r := get(); !r.Pending || r.Env["REPO"] != "" {
		t.Fatalf("hand-written project file applied without approval: %+v", r)
	}
	if _, err := o.Execute(ctx, "approve", nil); err != nil {
		t.Fatal(err)
	}
	if r := get(); r.Pending || r.Env["REPO"] != "1" {
		t.Fatalf("approve did not apply the project file: %+v", r)
	}

	// set takes a scope and a whole map; values arrive as JSON strings.
	if _, err := o.Execute(ctx, "set", map[string]any{
		"scope": "local", "env": map[string]any{"SECRET": "s"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(projectenv.Path(projectenv.ScopeLocal, project)); err != nil {
		t.Fatalf("local file not written in the project: %v", err)
	}
	if r := get(); r.Env["SECRET"] != "s" || r.Sources["SECRET"] != projectenv.ScopeLocal {
		t.Fatalf("set local not applied: %+v", r)
	}

	for name, params := range map[string]map[string]any{
		"unknown scope":    {"scope": "global", "env": map[string]any{}},
		"no scope":         {"env": map[string]any{}},
		"non-string value": {"scope": "local", "env": map[string]any{"N": 1}},
		"invalid name":     {"scope": "user", "env": map[string]any{"A-B": "x"}},
	} {
		if _, err := o.Execute(ctx, "set", params); err == nil {
			t.Errorf("%s: set accepted %v", name, params)
		}
	}
	if _, err := o.Execute(ctx, "nope", nil); err == nil {
		t.Error("an unknown operation succeeded")
	}
}
