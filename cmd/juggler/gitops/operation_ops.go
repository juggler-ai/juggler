//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"bufio"
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/gitview"
	"juggler/cmd/juggler/msg"
)

// The Operation place's writes: the merge, rebase, cherry-pick or revert in
// progress in the tree, finished, abandoned or — a pick or revert — forgotten.
//
// The client names the operation it saw, so a button pressed on a banner that
// is out of date never continues or aborts something else. Continuing is
// refused while anything is still unmerged, before git is asked: git refuses
// too, but in words that differ by command.
//
// A write that set the tree's changes aside and then stopped on conflicts
// records the stash in the tree's git directory (gitview.SetAsideFile).
// Whatever ends the operation — finishing it or abandoning it — puts them
// back, as git's own autostash does for a rebase.

// operation is the kind of the operation in progress, which must be the one
// the client saw.
func (r *runner) operation(op Op) (string, error) {
	kind := gitview.OperationIn(r.gitDir)
	if kind == "" {
		return "", refused(msg.NewError("No merge, rebase, cherry-pick or revert is in progress."))
	}
	if op.Operation != kind {
		return "", &StaleError{Err: msg.NewError("What is in progress has changed since it was shown. Look again.")}
	}
	return kind, nil
}

// unmerged reports whether the index still holds a conflict.
func (r *runner) unmerged() (bool, error) {
	out, _, err := r.ask("ls-files", "-u")
	return out != "", err
}

// operationContinue commits the resolution and goes on: a merge is committed
// with the message git prepared for it, and a rebase, pick or revert goes on
// to its next commit, stopping again on the next conflict. A pick or revert
// whose commit the resolution has emptied is refused and left for a skip.
func operationContinue(r *runner, op Op) (Result, error) {
	kind, err := r.operation(op)
	if err != nil {
		return Result{}, err
	}
	if left, err := r.unmerged(); err != nil {
		return Result{}, err
	} else if left {
		return Result{}, &ConflictsError{Err: msg.NewError("Some files still have conflicts. Resolve them, then continue.")}
	}
	args := []string{kind, "--continue"}
	if kind == "merge" {
		args = []string{"commit", "--no-edit"}
	}
	if _, err := r.rawGit(args...); err != nil {
		if left, _ := r.unmerged(); left {
			return Result{Head: r.headSha()}, conflictsError()
		}
		if kind != "merge" && said(err, emptyResult...) {
			return Result{}, refused(msg.NewError("Nothing is left of this commit once resolved. Skip it instead."))
		}
		return Result{}, r.explain(err)
	}
	return r.ended()
}

// operationSkip drops the commit a rebase, pick or revert stopped on and goes
// on, stopping again on the next conflict.
func operationSkip(r *runner, op Op) (Result, error) {
	kind, err := r.operation(op)
	if err != nil {
		return Result{}, err
	}
	if kind == "merge" {
		return Result{}, refused(msg.NewError("A merge has no commit to skip. Continue or abort it."))
	}
	if _, err := r.rawGit(kind, "--skip"); err != nil {
		if left, _ := r.unmerged(); left {
			return Result{Head: r.headSha()}, conflictsError()
		}
		return Result{}, r.explain(err)
	}
	return r.ended()
}

// operationAbort goes back to where the operation started, throwing away its
// resolutions.
func operationAbort(r *runner, op Op) (Result, error) {
	kind, err := r.operation(op)
	if err != nil {
		return Result{}, err
	}
	if _, err := r.git(kind, "--abort"); err != nil {
		return Result{}, err
	}
	return r.ended()
}

// operationQuit forgets a pick or revert — the rest of its sequence with it —
// and leaves HEAD, the index and the working tree as they are: the way out of
// a sequence stopped between commits that nobody means to finish.
func operationQuit(r *runner, op Op) (Result, error) {
	kind, err := r.operation(op)
	if err != nil {
		return Result{}, err
	}
	if kind != "cherry-pick" && kind != "revert" {
		return Result{}, refused(msg.NewError("Only a cherry-pick or revert can be quit. Continue or abort this one."))
	}
	if _, err := r.git(kind, "--quit"); err != nil {
		return Result{}, err
	}
	return r.ended()
}

// ended is the result of a write that may have ended the operation: once
// nothing is in progress, the changes set aside before it stopped are put
// back. Ones that do not go back cleanly stay in their stash, named in
// Result.Stash.
func (r *runner) ended() (Result, error) {
	res := Result{Head: r.headSha()}
	if gitview.OperationIn(r.gitDir) != "" {
		return res, nil
	}
	stash := r.setAsideStash()
	r.forgetSetAside()
	if stash == "" {
		return res, nil
	}
	if _, _, err := r.stashAt(stash); err != nil {
		var gone *StaleError
		if errors.As(err, &gone) {
			return res, nil // the user has dealt with it already
		}
		return res, err
	}
	if err := r.applyStash(stash, true); err != nil {
		res.Stash = stash
		return res, err
	}
	return res, nil
}

// stage is one side of a conflict as the index holds it.
type conflictSide struct{ mode, sha string }

// gitlinkMode is the index mode of a submodule.
const gitlinkMode = "160000"

// stages is the index stages a path is unmerged at ("1" base, "2" ours, "3"
// theirs); none when it has no conflict.
func (r *runner) stages(path string) (map[string]conflictSide, error) {
	out, _, err := r.ask("ls-files", "-u", "--", path)
	if err != nil {
		return nil, err
	}
	stages := map[string]conflictSide{}
	for _, line := range strings.Split(out, "\n") {
		if meta, _, ok := strings.Cut(line, "\t"); ok {
			if fields := strings.Fields(meta); len(fields) == 3 {
				stages[fields[2]] = conflictSide{mode: fields[0], sha: fields[1]}
			}
		}
	}
	return stages, nil
}

// isGitlink reports whether any side of a conflict is a submodule.
func isGitlink(stages map[string]conflictSide) bool {
	for _, s := range stages {
		if s.mode == gitlinkMode {
			return true
		}
	}
	return false
}

// resolve settles one conflicted file: with one side's version, which for a
// side that deleted the file is no file, or as the working tree has it. The
// working file is saved to DiscardRef first, since it may hold hand edits,
// and Result.Discard names the save for unresolve.
//
// In a rebase "ours" is the commit being rebased onto and "theirs" the commit
// being replayed, as git has it; the client names the sides for what they are.
func resolve(r *runner, op Op) (Result, error) {
	paths, err := r.files([]string{op.Path})
	if err != nil {
		return Result{}, err
	}
	path := paths[0]
	var side string
	switch op.Mode {
	case ResolveOurs:
		side = "2"
	case ResolveTheirs:
		side = "3"
	case ResolveMarked:
	default:
		return Result{}, refused(msg.NewError("Unknown way to resolve: {mode}", "mode", op.Mode))
	}
	stages, err := r.stages(path)
	if err != nil {
		return Result{}, err
	}
	if len(stages) == 0 {
		return Result{}, &StaleError{Err: msg.NewError("{path} has no conflict to resolve any more.", "path", path)}
	}
	if isGitlink(stages) {
		return Result{}, r.resolveSubmodule(path, side, stages)
	}
	if op.Mode == ResolveMarked && !op.Force {
		if marked, err := r.hasMarkers(path); err != nil {
			return Result{}, err
		} else if marked {
			return Result{}, &MarkersError{Path: path, Err: msg.NewError("{path} still has conflict markers.", "path", path)}
		}
	}
	saved, err := r.saveDiscard([]string{path})
	if err != nil {
		return Result{}, err
	}
	_, taken := stages[side]
	switch {
	case side == "":
		_, err = r.git("add", "-A", "--", path)
	case taken:
		if _, err = r.git("checkout", "--"+op.Mode, "--", path); err == nil {
			_, err = r.git("add", "--", path)
		}
	default:
		_, err = r.git("rm", "-q", "--", path)
	}
	if err != nil {
		return Result{}, err
	}
	id, err := saved.finish()
	return Result{Discard: id}, err
}

// resolveSubmodule settles a conflict over which commit a submodule records,
// in the index alone: one side's commit (or no submodule, for a side that
// removed it), or for side "" the commit the submodule has checked out. The
// submodule's own checkout is left where it is, so there is nothing of the
// user's to save and no Result.Discard; checking it out at the recorded commit
// is a submodule update. `git checkout --ours` cannot do this: it writes no
// gitlink, and the add after it would record the submodule's HEAD instead.
func (r *runner) resolveSubmodule(path, side string, stages map[string]conflictSide) error {
	var err error
	if s, taken := stages[side]; side == "" {
		_, err = r.git("add", "--", path)
	} else if taken {
		_, err = r.git("update-index", "--cacheinfo", s.mode+","+s.sha+","+path)
	} else {
		_, err = r.git("rm", "-q", "--cached", "--", path)
	}
	return err
}

// hasMarkers reports whether the working file still has a conflict's opening
// and closing markers. A file that is not there has none.
func (r *runner) hasMarkers(path string) (bool, error) {
	b, err := os.ReadFile(filepath.Join(r.dir, filepath.FromSlash(path))) //nolint:gosec // a file of the repository, validated by files
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	opened := false
	lines := bufio.NewScanner(bytes.NewReader(b))
	lines.Buffer(nil, len(b)+1)
	for lines.Scan() {
		line := lines.Text()
		switch {
		case strings.HasPrefix(line, "<<<<<<< ") || line == "<<<<<<<":
			opened = true
		case opened && (strings.HasPrefix(line, ">>>>>>> ") || line == ">>>>>>>"):
			return true, nil
		}
	}
	return false, nil
}

// unresolve undoes a resolve while the operation is still in progress: git's
// record of the conflict puts the unmerged stages back, and the save the
// resolve named in Discard puts the working file back — only if nothing has
// changed the file since.
func unresolve(r *runner, op Op) (Result, error) {
	paths, err := r.files([]string{op.Path})
	if err != nil {
		return Result{}, err
	}
	path := paths[0]
	if gitview.OperationIn(r.gitDir) == "" {
		return Result{}, refused(msg.NewError("Nothing is in progress any more, so the resolve can't be undone."))
	}
	rec, err := r.discardRecord(op.Discard)
	if err != nil {
		return Result{}, err
	}
	var saved *discardedFile
	for i := range rec.Files {
		if rec.Files[i].Path == path {
			saved = &rec.Files[i]
		}
	}
	if saved == nil {
		return Result{}, refused(msg.NewError("That save is not of {path}.", "path", path))
	}
	changed := &StaleError{Err: msg.NewError("{path} has changed since it was resolved, so it was left as it is.", "path", path)}
	if stages, err := r.stages(path); err != nil {
		return Result{}, err
	} else if len(stages) > 0 {
		return Result{}, changed
	}
	if now, err := r.snapshot(path, false); err != nil {
		return Result{}, err
	} else if now.Blob != saved.After {
		return Result{}, changed
	}
	if _, err := r.git("update-index", "--unresolve", "--", path); err != nil {
		return Result{}, err
	}
	if stages, err := r.stages(path); err != nil {
		return Result{}, err
	} else if len(stages) == 0 {
		return Result{}, refused(msg.NewError("Git no longer has a record of {path}'s conflict, so the resolve can't be undone.", "path", path))
	}
	return Result{}, r.restore(*saved)
}

// recordSetAside notes the stash a write that stopped on conflicts set the
// tree's changes aside in.
func (r *runner) recordSetAside(stash string) {
	_ = os.WriteFile(filepath.Join(r.gitDir, gitview.SetAsideFile), []byte(stash+"\n"), 0o600)
}

// setAsideStash is the stash recordSetAside noted, or "".
func (r *runner) setAsideStash() string {
	b, err := os.ReadFile(filepath.Join(r.gitDir, gitview.SetAsideFile)) //nolint:gosec // a file of the tree's own git directory
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// forgetSetAside drops the note: the stash it named is put back, or belongs to
// an operation that ended without this client.
func (r *runner) forgetSetAside() {
	_ = os.Remove(filepath.Join(r.gitDir, gitview.SetAsideFile))
}
