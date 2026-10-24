//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package projectenv

import (
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// isolate points the user config dir at a temp dir and returns a fresh project.
func isolate(t *testing.T) (configDir, project string) {
	t.Helper()
	configDir = t.TempDir()
	t.Setenv("JUGGLER_CONFIG_DIR", configDir)
	return configDir, t.TempDir()
}

// put writes raw file content, as a hand edit or a cloned repository would.
func put(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fileState(r Resolved, s Scope) FileState {
	for _, f := range r.Files {
		if f.Scope == s {
			return f
		}
	}
	return FileState{}
}

// The three files merge user < project < local, and every key says which file
// won it.
func TestProjectEnvMergeOrder(t *testing.T) {
	_, project := isolate(t)
	put(t, Path(ScopeUser, project), `{"A":"user","B":"user","C":"user"}`)
	put(t, Path(ScopeProject, project), `{"B":"project","C":"project"}`)
	put(t, Path(ScopeLocal, project), `{"C":"local"}`)
	if err := Approve(project); err != nil {
		t.Fatal(err)
	}

	r := Resolve(project)
	want := map[string]string{"A": "user", "B": "project", "C": "local"}
	if !maps.Equal(r.Env, want) {
		t.Fatalf("env %v, want %v", r.Env, want)
	}
	wantSrc := map[string]Scope{"A": ScopeUser, "B": ScopeProject, "C": ScopeLocal}
	if !maps.Equal(r.Sources, wantSrc) {
		t.Fatalf("sources %v, want %v", r.Sources, wantSrc)
	}
	if r.Pending {
		t.Fatal("an approved project file reported pending")
	}
}

// A repository can carry .juggler/env.json. Nothing in it applies until the
// user approves that exact content, and an edit asks again.
func TestProjectEnvNeedsApproval(t *testing.T) {
	_, project := isolate(t)
	put(t, Path(ScopeProject, project), `{"GIT_SSH_COMMAND":"evil"}`)

	r := Resolve(project)
	if _, ok := r.Env["GIT_SSH_COMMAND"]; ok {
		t.Fatal("an unapproved project file was applied")
	}
	if !r.Pending || fileState(r, ScopeProject).Approved {
		t.Fatalf("unapproved project file not reported pending: %+v", r)
	}
	if got := fileState(r, ScopeProject).Env["GIT_SSH_COMMAND"]; got != "evil" {
		t.Fatalf("pending entries not shown for review: %q", got)
	}

	if err := Approve(project); err != nil {
		t.Fatal(err)
	}
	if got := Resolve(project).Env["GIT_SSH_COMMAND"]; got != "evil" {
		t.Fatalf("approved value not applied: %q", got)
	}

	// Formatting alone is not a change; a value is.
	put(t, Path(ScopeProject, project), "{\n  \"GIT_SSH_COMMAND\": \"evil\"\n}\n")
	if Resolve(project).Pending {
		t.Fatal("reformatting the same content needed re-approval")
	}
	put(t, Path(ScopeProject, project), `{"GIT_SSH_COMMAND":"worse"}`)
	r = Resolve(project)
	if _, ok := r.Env["GIT_SSH_COMMAND"]; ok || !r.Pending {
		t.Fatalf("an edited project file kept its approval: %+v", r)
	}

	// Approval is per project: the same content elsewhere is asked about again.
	other := t.TempDir()
	put(t, Path(ScopeProject, other), `{"GIT_SSH_COMMAND":"evil"}`)
	if !Resolve(other).Pending {
		t.Fatal("approval in one project carried to another")
	}

	// The user's own files are never gated.
	put(t, Path(ScopeLocal, project), `{"MINE":"1"}`)
	if Resolve(project).Env["MINE"] != "1" {
		t.Fatal("the local file waited for approval")
	}
}

// A file that does not parse, or names a variable no shell can hold, is skipped
// whole and reported — never half-applied.
func TestProjectEnvBadFilesSkippedWhole(t *testing.T) {
	_, project := isolate(t)
	put(t, Path(ScopeUser, project), `{"OK":"1",`)
	put(t, Path(ScopeLocal, project), `{"GOOD":"1","BAD-NAME":"2"}`)

	r := Resolve(project)
	if len(r.Env) != 0 {
		t.Fatalf("a bad file contributed %v", r.Env)
	}
	for _, s := range []Scope{ScopeUser, ScopeLocal} {
		if fileState(r, s).Error == "" {
			t.Errorf("%s file's error not reported", s)
		}
	}
	if !strings.Contains(fileState(r, ScopeLocal).Error, "BAD-NAME") {
		t.Errorf("invalid name not named: %q", fileState(r, ScopeLocal).Error)
	}

	put(t, Path(ScopeLocal, project), `{"N":1}`)
	if fileState(Resolve(project), ScopeLocal).Error == "" {
		t.Error("a non-string value was accepted")
	}
}

func TestProjectEnvValidName(t *testing.T) {
	for name, want := range map[string]bool{
		"PATH": true, "_x": true, "A1_B": true,
		"": false, "1A": false, "A-B": false, "A=B": false, "A B": false, "É": false,
	} {
		if got := ValidName(name); got != want {
			t.Errorf("ValidName(%q) = %v, want %v", name, got, want)
		}
	}
}

// Writing through Juggler validates, keeps secrets owner-only, approves the
// project file the user just wrote, keeps the local file out of git, and an
// empty map removes the file.
func TestProjectEnvWrite(t *testing.T) {
	_, project := isolate(t)
	if err := os.MkdirAll(filepath.Join(project, ".git", "info"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := Write(project, ScopeLocal, map[string]string{"bad name": "x"}); err == nil {
		t.Fatal("an invalid name was written")
	}
	if err := Write(project, ScopeProject, map[string]string{"P": "1"}); err != nil {
		t.Fatal(err)
	}
	if r := Resolve(project); r.Pending || r.Env["P"] != "1" {
		t.Fatalf("the user's own project write was not approved: %+v", r)
	}
	for _, s := range []Scope{ScopeUser, ScopeLocal} {
		if err := Write(project, s, map[string]string{"S": "secret"}); err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS == "windows" {
			continue // no permission bits; the profile directory's ACL guards it
		}
		info, err := os.Stat(Path(s, project))
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s file mode %o, want 600", s, perm)
		}
	}

	exclude, err := os.ReadFile(filepath.Join(project, ".git", "info", "exclude"))
	if err != nil {
		t.Fatalf("local file not excluded from git: %v", err)
	}
	if strings.Count(string(exclude), localExcludePattern) != 1 {
		t.Fatalf("exclude holds %q", exclude)
	}
	// A second write does not repeat the line.
	if err := Write(project, ScopeLocal, map[string]string{"S": "2"}); err != nil {
		t.Fatal(err)
	}
	exclude, _ = os.ReadFile(filepath.Join(project, ".git", "info", "exclude"))
	if strings.Count(string(exclude), localExcludePattern) != 1 {
		t.Fatalf("exclude line repeated: %q", exclude)
	}

	if err := Write(project, ScopeLocal, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(Path(ScopeLocal, project)); !os.IsNotExist(err) {
		t.Fatalf("an empty write left the file: %v", err)
	}
}
