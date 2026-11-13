//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"juggler/internal/jlog"
	"juggler/internal/projectpaths"
)

// gitWorktreeProviderID is the workspace provider whose rows are git worktrees
// of the project's repository (juggler-core's git-worktree provider).
const gitWorktreeProviderID = "git-worktree"

// errVolume refuses a move from one volume to another, which a rename cannot
// make.
var errVolume = errors.New("the destination is on another volume; a project can only be moved within one")

// CheckProjectRelocation reports why project cannot be moved to dest, or nil
// when nothing stands in the way that can be seen without trying: dest must be
// an absolute path whose parent is a folder, with nothing there yet, outside
// the project, and on the same volume — the move is a rename, never a copy. A
// volume is told apart by its name (a Windows drive or share) and by its device
// where the platform reports one.
// Both paths are taken cleaned.
func CheckProjectRelocation(project, dest string) error {
	if !filepath.IsAbs(project) || !filepath.IsAbs(dest) {
		return errors.New("both paths must be absolute")
	}
	project, dest = filepath.Clean(project), filepath.Clean(dest)
	if project == dest {
		return errors.New("the project is already there")
	}
	if strings.HasPrefix(dest, project+string(filepath.Separator)) {
		return errors.New("a project cannot be moved inside itself")
	}
	if !strings.EqualFold(filepath.VolumeName(project), filepath.VolumeName(dest)) {
		return errVolume
	}
	info, err := os.Stat(project)
	if err != nil {
		return fmt.Errorf("the project folder: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("%s is not a folder", project)
	}
	if _, err := os.Lstat(dest); err == nil {
		return fmt.Errorf("%s already exists", dest)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	parent, err := os.Stat(filepath.Dir(dest))
	if err != nil {
		return fmt.Errorf("the destination's parent folder: %w", err)
	}
	if !parent.IsDir() {
		return fmt.Errorf("%s is not a folder", filepath.Dir(dest))
	}
	if !sameVolume(info, parent) {
		return errVolume
	}
	if projectpaths.For(project).Outside() {
		if _, err := os.Lstat(projectpaths.OutsideDir(dest)); err == nil {
			return fmt.Errorf("%s already holds another project's state", projectpaths.OutsideDir(dest))
		}
	}
	return nil
}

// RelocateProject moves the project folder from project to dest and brings
// what Juggler keeps about it along, so a session opened on dest finds
// everything a session on project had:
//
//   - the folder itself, renamed (CheckProjectRelocation says what it needs);
//   - its state folder, when that lives outside the project, renamed to the
//     one dest's state is looked for in (projectpaths.OutsideDir);
//   - the workspace rows in session.json, whose paths into either folder are
//     repointed (repointWorkspacePaths);
//   - the git worktrees of the project's repository, whose links to it are
//     repaired with `git worktree repair`.
//
// It must run while no session holds the project, which it checks by taking
// the project's instance lock. A failure before the workspace rows are written
// undoes every rename and leaves the project where it was; a failed repair of
// the worktrees is only logged, since it leaves those workspaces unavailable
// rather than the project unopenable.
//
// What else is keyed by the project's path is left to find itself again: an
// env.json approval and an MCP server's trust are asked for once more, a
// claudecode conversation starts its CLI session afresh, and the project's
// log folder starts over under its new name.
func RelocateProject(project, dest string) error {
	if err := CheckProjectRelocation(project, dest); err != nil {
		return err
	}
	project, dest = filepath.Clean(project), filepath.Clean(dest)

	// The lock is only a check that no session is in the project: it is let
	// go before anything moves, since a folder holding an open file cannot be
	// renamed on Windows.
	lock := NewInstanceLock(project)
	res, err := lock.TryAcquire()
	if err != nil {
		return fmt.Errorf("lock the project: %w", err)
	}
	if !res.Acquired {
		return errors.New("a session is still running in the project")
	}
	_ = lock.Release()

	dirs := projectpaths.For(project)
	moves := []folderMove{{project, dest}}
	if err := os.Rename(project, dest); err != nil {
		return fmt.Errorf("move the project folder: %w", err)
	}
	undo := func() {
		if err := os.Rename(dest, project); err != nil {
			jlog.Error("[relocate] could not move %s back to %s: %v", dest, project, err)
		}
	}
	stateDir := projectpaths.SharedDir(dest)
	if dirs.Outside() {
		stateDir = projectpaths.OutsideDir(dest)
		if err := os.Rename(dirs.State, stateDir); err != nil {
			undo()
			return fmt.Errorf("move the project's state folder: %w", err)
		}
		moves = append(moves, folderMove{dirs.State, stateDir})
		inner := undo
		undo = func() {
			if err := os.Rename(stateDir, dirs.State); err != nil {
				jlog.Error("[relocate] could not move %s back to %s: %v", stateDir, dirs.State, err)
			}
			inner()
		}
	}
	sessionPath := filepath.Join(stateDir, "session.json")
	if err := repointWorkspacePaths(sessionPath, moves...); err != nil {
		undo()
		return fmt.Errorf("repoint the project's workspaces: %w", err)
	}

	repairWorktrees(dest, sessionPath)
	jlog.Info("[relocate] moved project %s to %s", project, dest)
	return nil
}

// repairWorktrees runs `git worktree repair` in project, when it is the root
// of a repository, naming every git-worktree workspace tree that is there to
// find: a tree's link to the repository named the project where it was, and
// a tree that moved with the project is one git can no longer find by itself.
// Relative links are asked for, as the git-worktree provider writes them; a
// git that predates the setting ignores it.
func repairWorktrees(project, sessionPath string) {
	if _, err := os.Stat(filepath.Join(project, ".git")); err != nil {
		return
	}
	args := []string{"-c", "worktree.useRelativePaths=true", "-C", project, "worktree", "repair"}
	for _, root := range worktreeRoots(sessionPath) {
		if _, err := os.Stat(root); err == nil {
			args = append(args, root)
		}
	}
	cmd := exec.Command("git", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		jlog.Error("[relocate] git worktree repair in %s failed: %v: %s", project, err, strings.TrimSpace(string(out)))
	}
}

// worktreeRoots lists the roots of the git-worktree rows in session.json that
// are not closed.
func worktreeRoots(sessionPath string) []string {
	data, err := os.ReadFile(sessionPath)
	if err != nil {
		return nil
	}
	var doc struct {
		Workspaces []Workspace `json:"workspaces"`
	}
	if json.Unmarshal(data, &doc) != nil {
		return nil
	}
	var roots []string
	for _, w := range doc.Workspaces {
		if w.ProviderID == gitWorktreeProviderID && w.State != WorkspaceStateClosed && w.Root != "" {
			roots = append(roots, w.Root)
		}
	}
	return roots
}
