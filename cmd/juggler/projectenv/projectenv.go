//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package projectenv holds the environment variables a user sets for the
// commands the agent runs, in three flat JSON files ({"NAME": "value"}) merged
// in this order, later winning:
//
//	<ConfigDir>/env.json              the user's, for every project
//	<project>/.juggler/env.json       the project's, meant to be committed
//	<project>/.juggler/env.local.json the user's, for this project; for secrets
//
// The project file can arrive with a cloned repository, and a variable is
// enough to take over every command run (PATH, GIT_SSH_COMMAND, LD_PRELOAD).
// So it applies only once the user has approved that exact content: its
// fingerprint — project and variables — is recorded in <ConfigDir>/env-approvals.json,
// which no repository can write, and any change to a name or value waits to be
// approved again. The two files that are the user's own are never gated.
//
// The files are read on every call. They are a few hundred bytes, and reading
// them fresh means an edit applies to the next command with nothing to watch,
// invalidate or restart.
//
// Values are literal: nothing is expanded, so "$HOME" is those five characters.
package projectenv

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"juggler/internal/atomicio"
	"juggler/internal/userpaths"
)

// Scope names one of the three files.
type Scope string

const (
	ScopeUser    Scope = "user"
	ScopeProject Scope = "project"
	ScopeLocal   Scope = "local"
)

// scopes is the merge order: each file overrides the ones before it.
var scopes = []Scope{ScopeUser, ScopeProject, ScopeLocal}

// ParseScope validates a scope name from a caller.
func ParseScope(s string) (Scope, error) {
	if sc := Scope(s); slices.Contains(scopes, sc) {
		return sc, nil
	}
	return "", fmt.Errorf("unknown env scope %q (want user, project or local)", s)
}

const (
	fileName         = "env.json"
	localFileName    = "env.local.json"
	approvalFileName = "env-approvals.json"
)

// localExcludePattern is what keeps env.local.json out of git, written to the
// repository's .git/info/exclude — which, unlike .gitignore, is never
// committed. Unanchored, so it holds wherever the project sits in the repo.
const localExcludePattern = "**/.juggler/" + localFileName

// Path is where the file for scope lives.
func Path(scope Scope, projectRoot string) string {
	switch scope {
	case ScopeUser:
		return filepath.Join(userpaths.ConfigDir(), fileName)
	case ScopeLocal:
		return filepath.Join(projectRoot, ".juggler", localFileName)
	default:
		return filepath.Join(projectRoot, ".juggler", fileName)
	}
}

// FileState is one file as it stands.
type FileState struct {
	Scope  Scope             `json:"scope"`
	Path   string            `json:"path"`
	Exists bool              `json:"exists"`
	Env    map[string]string `json:"env"`
	// Error is why the file was skipped: it does not parse, or holds a name no
	// shell can carry. A skipped file contributes nothing.
	Error string `json:"error,omitempty"`
	// Approved is meaningful for the project file only; the others are always
	// approved.
	Approved bool `json:"approved"`
}

// Resolved is what a command gets, and why.
type Resolved struct {
	// Env is the merged set to add to a command's environment.
	Env map[string]string `json:"env"`
	// Sources names the file each variable in Env came from.
	Sources map[string]Scope `json:"sources"`
	// Files is every file in merge order, applied or not.
	Files []FileState `json:"files"`
	// Pending reports a project file with variables the user has not approved.
	Pending bool `json:"pending"`
}

// Resolve reads the three files for projectRoot. projectRoot "" (no project)
// resolves the user file alone.
func Resolve(projectRoot string) Resolved {
	r := Resolved{Env: map[string]string{}, Sources: map[string]Scope{}}
	var approved map[string]bool
	for _, sc := range scopes {
		if projectRoot == "" && sc != ScopeUser {
			continue
		}
		f := readFile(sc, projectRoot)
		if sc == ScopeProject {
			if approved == nil {
				approved = readApprovals()
			}
			f.Approved = len(f.Env) == 0 || approved[fingerprint(projectRoot, f.Env)]
			r.Pending = f.Error == "" && !f.Approved
		} else {
			f.Approved = true
		}
		if f.Error == "" && f.Approved {
			for k, v := range f.Env {
				r.Env[k] = v
				r.Sources[k] = sc
			}
		}
		r.Files = append(r.Files, f)
	}
	return r
}

// Overrides is the merged set alone, for a command about to start.
func Overrides(projectRoot string) map[string]string {
	return Resolve(projectRoot).Env
}

func readFile(sc Scope, projectRoot string) FileState {
	f := FileState{Scope: sc, Path: Path(sc, projectRoot), Env: map[string]string{}}
	data, err := os.ReadFile(f.Path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			f.Exists = true
			f.Error = err.Error()
		}
		return f
	}
	f.Exists = true
	env, err := parse(data)
	if err != nil {
		f.Error = err.Error()
		return f
	}
	f.Env = env
	return f
}

// parse decodes a file, rejecting it whole if anything in it is unusable.
func parse(data []byte) (map[string]string, error) {
	if len(bytes.TrimSpace(data)) == 0 {
		return map[string]string{}, nil
	}
	var env map[string]string
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("not a JSON object of string values: %w", err)
	}
	if err := validate(env); err != nil {
		return nil, err
	}
	if env == nil {
		env = map[string]string{}
	}
	return env, nil
}

var nameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ValidName reports whether name is a variable a POSIX shell can hold.
func ValidName(name string) bool { return nameRE.MatchString(name) }

func validate(env map[string]string) error {
	var bad []string
	for k, v := range env {
		if !ValidName(k) || strings.ContainsRune(v, 0) {
			bad = append(bad, k)
		}
	}
	if len(bad) > 0 {
		slices.Sort(bad)
		return fmt.Errorf("invalid variable name or value: %s", strings.Join(bad, ", "))
	}
	return nil
}

// fingerprint identifies one project's variables. JSON encoding sorts map
// keys, so the same set always hashes the same however the file is laid out.
func fingerprint(projectRoot string, env map[string]string) string {
	data, _ := json.Marshal(struct {
		Project string            `json:"project"`
		Env     map[string]string `json:"env"`
	}{filepath.Clean(projectRoot), env})
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type approvalStore struct {
	Approved []string `json:"approved"`
}

func approvalPath() string { return filepath.Join(userpaths.ConfigDir(), approvalFileName) }

// approvalSlot serialises read-modify-write of the approval store within this
// process.
var approvalSlot = make(chan struct{}, 1)

// readApprovals returns the approved fingerprints. A missing or unreadable
// store approves nothing.
func readApprovals() map[string]bool {
	out := map[string]bool{}
	data, err := os.ReadFile(approvalPath())
	if err != nil {
		return out
	}
	var store approvalStore
	if json.Unmarshal(data, &store) != nil {
		return out
	}
	for _, fp := range store.Approved {
		out[fp] = true
	}
	return out
}

func addApproval(fp string) error {
	approvalSlot <- struct{}{}
	defer func() { <-approvalSlot }()
	have := readApprovals()
	if have[fp] {
		return nil
	}
	have[fp] = true
	store := approvalStore{Approved: slices.Sorted(maps.Keys(have))}
	data, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	return writeFile(approvalPath(), append(data, '\n'), 0o600)
}

// Approve approves the project file as it stands now.
func Approve(projectRoot string) error {
	if projectRoot == "" {
		return fmt.Errorf("no project loaded")
	}
	f := readFile(ScopeProject, projectRoot)
	if f.Error != "" {
		return fmt.Errorf("%s: %s", f.Path, f.Error)
	}
	if len(f.Env) == 0 {
		return nil
	}
	return addApproval(fingerprint(projectRoot, f.Env))
}

// Write replaces one file's variables. An empty set removes the file. The
// user's files are written owner-only, since they are where secrets go; the
// project file is meant to be committed and is written like any source file.
// A project file the user writes here is one they have seen, so it is approved
// as written. Writing the local file inside a git repository keeps it out of
// git.
func Write(projectRoot string, sc Scope, env map[string]string) error {
	if sc != ScopeUser && projectRoot == "" {
		return fmt.Errorf("no project loaded")
	}
	if err := validate(env); err != nil {
		return err
	}
	path := Path(sc, projectRoot)
	if len(env) == 0 {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	data, err := json.MarshalIndent(env, "", "  ")
	if err != nil {
		return err
	}
	perm := os.FileMode(0o600)
	if sc == ScopeProject {
		perm = 0o644
	}
	if err := writeFile(path, append(data, '\n'), perm); err != nil {
		return err
	}
	switch sc {
	case ScopeProject:
		return addApproval(fingerprint(projectRoot, env))
	case ScopeLocal:
		return excludeLocal(projectRoot)
	}
	return nil
}

func writeFile(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return atomicio.WriteFile(path, data, perm)
}

// excludeLocal adds localExcludePattern to the .git/info/exclude of the
// repository holding projectRoot, once. A project outside git, or in a checkout
// whose .git is a file (a linked worktree), is left alone.
func excludeLocal(projectRoot string) error {
	gitDir := ""
	for dir := filepath.Clean(projectRoot); ; {
		if info, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			if info.IsDir() {
				gitDir = filepath.Join(dir, ".git")
			}
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if gitDir == "" {
		return nil
	}
	path := filepath.Join(gitDir, "info", "exclude")
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		if strings.TrimSpace(sc.Text()) == localExcludePattern {
			return nil
		}
	}
	if len(data) > 0 && data[len(data)-1] != '\n' {
		data = append(data, '\n')
	}
	data = append(data, localExcludePattern+"\n"...)
	return writeFile(path, data, 0o644)
}
