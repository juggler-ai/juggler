//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/internal/projectpaths"
)

// TestResolveAdmitsOnlyThisProjectsOutsideState: with a project's state kept
// outside it, the read scope admits that folder as it admits <project>/.juggler
// — so the spill file a command points the model at is readable without a
// prompt, from the project or from a workspace of it — and nothing beside it:
// every other project's state sits under the same base.
func TestResolveAdmitsOnlyThisProjectsOutsideState(t *testing.T) {
	base := t.TempDir()
	t.Setenv(projectpaths.StateDirEnv, base)
	project := t.TempDir()
	other := t.TempDir()
	state := projectpaths.OutsideDir(project)
	otherState := projectpaths.OutsideDir(other)
	for _, dir := range []string{state, otherState} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	spill := filepath.Join(spillDirFor(project, "conv_abc"), "out.txt")
	if filepath.Dir(filepath.Dir(filepath.Dir(spill))) != state {
		t.Fatalf("spill %s is not in the project's outside state %s", spill, state)
	}
	if err := os.MkdirAll(filepath.Dir(spill), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(spill, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	escape := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(escape, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(state, "link")
	if err := os.Symlink(escape, link); err != nil {
		t.Fatal(err)
	}

	for name, scope := range map[string]PathScope{
		"project":   NewPathScope(project, nil),
		"workspace": NewPathScope(t.TempDir(), nil).WithProjectRoot(project),
	} {
		if _, err := scope.Resolve(spill); err != nil {
			t.Errorf("%s scope refused the project's spill file: %v", name, err)
		}
		if !scope.withinScope(filepath.Join(state, "MEMORY.md")) {
			t.Errorf("%s scope does not count the project's state folder as in scope for writes", name)
		}
		for _, refused := range []string{
			filepath.Join(otherState, "session.json"),
			filepath.Join(state, "..", filepath.Base(otherState), "session.json"),
			base,
			link,
		} {
			if _, err := scope.Resolve(refused); err == nil {
				t.Errorf("%s scope admitted %s, which is not this project's state", name, refused)
			}
		}
	}
}
