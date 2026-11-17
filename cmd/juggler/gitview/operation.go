//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// The operation in progress in a tree — a merge, rebase, cherry-pick or revert
// that stopped for the user — read from the files git keeps for it in the
// tree's own git directory, so each worktree has its own.

// SetAsideFile is the file in a tree's git directory naming the stash a write
// set the tree's changes aside in before it stopped on conflicts: the stash
// that finishing or abandoning the operation puts back.
const SetAsideFile = "JUGGLER_SET_ASIDE"

// Stopped is the operation in progress in a tree, as the git client's banner
// says it.
//
// Branch is the branch it changes ("" on a detached HEAD); for a rebase, the
// branch being rebased, which HEAD is detached from until it finishes. Other is
// the other side by name — the branch merged in, or the one rebased onto — and
// OtherSha its commit; Other is "" when no branch points there. Commit is the
// commit being applied: the rebase's current one, or the one picked or
// reverted. Step and Steps say how far a rebase has got, and are 0 for anything
// else. From is where a rebase's branch was before it began, which aborting
// puts it back to; for the others that is HEAD, and From is "". SetAside is the
// stash the tree's changes were set aside in, while it is still on the list.
//
// Between is a pick or revert of several commits stopped between them: nothing
// is being applied and there is no Commit, only the rest of the sequence, which
// continuing goes on to and quitting forgets. Left is how many commits of a
// pick or revert sequence are still to come after the one it stopped on.
type Stopped struct {
	Kind     string         `json:"kind"`
	Branch   string         `json:"branch,omitempty"`
	Other    string         `json:"other,omitempty"`
	OtherSha string         `json:"otherSha,omitempty"`
	Commit   *StoppedCommit `json:"commit,omitempty"`
	Step     int            `json:"step,omitempty"`
	Steps    int            `json:"steps,omitempty"`
	From     string         `json:"from,omitempty"`
	SetAside string         `json:"setAside,omitempty"`
	Between  bool           `json:"between,omitempty"`
	Left     int            `json:"left,omitempty"`
}

// StoppedCommit is the commit an operation is applying.
type StoppedCommit struct {
	Sha     string `json:"sha"`
	Subject string `json:"subject"`
}

// OperationIn names the operation in progress in a tree, from the files git
// keeps in the tree's own git directory while one is: "merge", "rebase",
// "cherry-pick", "revert", or "" for none.
//
// It is in progress exactly when git says so, since that is when git refuses
// to switch branch: a multi-commit pick or revert is in progress for as long as
// its sequencer's todo list names one, between commits too — after the commit
// it stopped on was committed by hand, say, which clears CHERRY_PICK_HEAD and
// leaves the rest of the sequence waiting. A sequencer directory with no todo
// list is not one.
func OperationIn(gitDir string) string {
	switch {
	case exists(gitDir, "rebase-merge"), exists(gitDir, "rebase-apply"):
		return "rebase"
	case exists(gitDir, "MERGE_HEAD"):
		return "merge"
	case exists(gitDir, "CHERRY_PICK_HEAD"):
		return "cherry-pick"
	case exists(gitDir, "REVERT_HEAD"):
		return "revert"
	}
	kind, _ := sequence(gitDir)
	return kind
}

// sequence reads the todo list of a multi-commit pick or revert: its kind, by
// its first command as git reads it, and how many commands it lists, the one it
// stopped on first. "" and 0 when there is none.
func sequence(gitDir string) (kind string, commands int) {
	todo := stateFile(gitDir, "sequencer", "todo")
	for _, line := range strings.Split(todo, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		commands++
		if commands > 1 {
			continue
		}
		switch word, _, _ := strings.Cut(line, " "); word {
		case "pick", "p":
			kind = "cherry-pick"
		case "revert", "r":
			kind = "revert"
		default:
			return "", 0
		}
	}
	return kind, commands
}

func exists(dir, name string) bool {
	_, err := os.Stat(filepath.Join(dir, name))
	return err == nil
}

// stateFile is one of git's files for an operation, trimmed; "" when it is
// not there.
func stateFile(gitDir string, parts ...string) string {
	b, err := os.ReadFile(filepath.Join(append([]string{gitDir}, parts...)...)) //nolint:gosec // a file of the tree's own git directory
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// readStopped reads the operation of kind in progress in the repository at
// dir, whose current branch is branch. What git does not say — a name nothing
// points at, a commit that cannot be read — is left out rather than failing
// the read: the banner says less, and the user can still finish or abort.
func readStopped(ctx context.Context, dir, gitDir, kind, branch string, perCmd time.Duration) *Stopped {
	s := &Stopped{Kind: kind, Branch: branch}
	commit := ""
	switch kind {
	case "merge":
		s.OtherSha, _, _ = strings.Cut(stateFile(gitDir, "MERGE_HEAD"), "\n")
	case "cherry-pick", "revert":
		head := "CHERRY_PICK_HEAD"
		if kind == "revert" {
			head = "REVERT_HEAD"
		}
		commit = stateFile(gitDir, head)
		if _, commands := sequence(gitDir); commands > 0 {
			s.Left = commands - 1
			s.Between = commit == ""
		}
	case "rebase":
		state, step, steps := "rebase-merge", "msgnum", "end"
		if exists(gitDir, "rebase-apply") {
			state, step, steps = "rebase-apply", "next", "last"
		}
		s.Branch = strings.TrimPrefix(stateFile(gitDir, state, "head-name"), "refs/heads/")
		if s.Branch == "detached HEAD" {
			s.Branch = ""
		}
		s.OtherSha = stateFile(gitDir, state, "onto")
		s.From = stateFile(gitDir, state, "orig-head")
		s.Step, _ = strconv.Atoi(stateFile(gitDir, state, step))
		s.Steps, _ = strconv.Atoi(stateFile(gitDir, state, steps))
		commit = stateFile(gitDir, state, "stopped-sha")
		if commit == "" {
			commit = stateFile(gitDir, state, "original-commit")
		}
	}
	if s.OtherSha != "" {
		s.Other = nameOf(ctx, dir, s.OtherSha, s.Branch, perCmd)
	}
	if commit != "" {
		if out, err := gitRead(ctx, dir, perCmd, 64*1024, "log", "-1", "--format=%H%x00%s", commit, "--"); err == nil {
			sha, subject, _ := strings.Cut(strings.TrimSpace(string(out.Kept)), "\x00")
			s.Commit = &StoppedCommit{Sha: sha, Subject: subject}
		}
	}
	s.SetAside = setAside(ctx, dir, gitDir, perCmd)
	return s
}

// nameOf is a branch that points at sha, other than skip: a local one first,
// then a remote-tracking one; "" when there is none.
func nameOf(ctx context.Context, dir, sha, skip string, perCmd time.Duration) string {
	out, err := gitRead(ctx, dir, perCmd, 64*1024, "for-each-ref", "--points-at="+sha, "--format=%(refname)", "refs/heads", "refs/remotes")
	if err != nil {
		return ""
	}
	for _, ref := range strings.Split(strings.TrimSpace(string(out.Kept)), "\n") {
		var name string
		switch {
		case strings.HasPrefix(ref, "refs/heads/"):
			name = strings.TrimPrefix(ref, "refs/heads/")
		case strings.HasPrefix(ref, "refs/remotes/") && !strings.HasSuffix(ref, "/HEAD"):
			name = strings.TrimPrefix(ref, "refs/remotes/")
		}
		if name != "" && name != skip {
			return name
		}
	}
	return ""
}

// setAside is the stash SetAsideFile names, if that stash is still on the list.
func setAside(ctx context.Context, dir, gitDir string, perCmd time.Duration) string {
	stash := stateFile(gitDir, SetAsideFile)
	if stash == "" {
		return ""
	}
	out, err := gitRead(ctx, dir, perCmd, 1<<20, "stash", "list", "--format=%H")
	if err != nil {
		return ""
	}
	for _, sha := range strings.Split(string(out.Kept), "\n") {
		if strings.TrimSpace(sha) == stash {
			return stash
		}
	}
	return ""
}
