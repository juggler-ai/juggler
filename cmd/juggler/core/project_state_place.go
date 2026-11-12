//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"juggler/internal/atomicio"
	"juggler/internal/jlog"
	"juggler/internal/projectpaths"
)

// PlaceProjectState takes project's instance lock, first moving the project's
// local state to where wantOutside says it belongs: its folder outside the
// project (projectpaths.OutsideDir) or <project>/.juggler. It is the only
// thing that changes where a project's state is, and it runs before a session
// opens anything there, which is what lets every other reader find the state
// by looking (projectpaths.For).
//
// The move is made holding both locks — the one where the state is, which
// shuts out any other process still using it there, and the one where it is
// going, taken before the first entry moves, so a process that looks while it
// is under way finds the destination and waits on its lock. Only the entries
// that are local state move (isLocalStateEntry): the files meant to be
// committed stay in the project, as does anything this build does not know.
//
// A move that fails part way is undone and the state stays where it was; the
// session still starts, there, and the failure is logged. The lock returned is
// the one for the folder the state is in when it returns. A refused lock is
// reported as it is by TryAcquire, with the lock that was found held.
func PlaceProjectState(project string, wantOutside bool) (*InstanceLock, AcquireResult, error) {
	dirs := projectpaths.For(project)
	target := dirs.Shared
	if wantOutside {
		target = projectpaths.OutsideDir(project)
	}
	if dirs.State == target {
		lock := NewInstanceLock(project)
		res, err := lock.TryAcquire()
		return lock, res, err
	}
	if _, statErr := os.Stat(dirs.State); statErr != nil {
		// A project with no state anywhere yet — locking the folder it isn't
		// in would only create that folder.
		lock := newInstanceLockIn(project, target)
		res, err := lock.TryAcquire()
		return lock, res, err
	}

	// The state is somewhere else, so whoever may be using it there is shut
	// out first — even when there turns out to be nothing to move, since an
	// outside folder is cleared away below and its lock with it.
	from := newInstanceLockIn(project, dirs.State)
	res, err := from.TryAcquire()
	if err != nil || !res.Acquired {
		return from, res, err
	}
	if !hasLocalState(dirs.State) {
		// Nothing to move. An outside folder left with no state in it would,
		// by existing, keep placing the state there.
		_ = from.Release()
		if dirs.Outside() {
			_ = os.Remove(from.lockPath)
			removeIfEmptyish(dirs.State)
		}
		lock := newInstanceLockIn(project, target)
		res, err := lock.TryAcquire()
		return lock, res, err
	}

	to := newInstanceLockIn(project, target)
	toRes, err := to.TryAcquire()
	if err != nil {
		// Nothing has moved; stay where the state is. The folder TryAcquire
		// may have made must not outlive this, or it would claim the state.
		jlog.Error("[state] could not lock %s to move project state there; it stays in %s: %v", target, dirs.State, err)
		_ = os.Remove(to.lockPath)
		removeIfEmptyish(target)
		return from, res, nil
	}
	if !toRes.Acquired {
		// Something is running with the destination already: it is that
		// process's, and the refusal is reported against its lock.
		_ = from.Release()
		return to, toRes, nil
	}

	if err := moveLocalState(dirs.State, target); err != nil {
		jlog.Error("[state] moving project state from %s to %s failed; it stays where it was: %v", dirs.State, target, err)
		_ = to.Release()
		_ = os.Remove(to.lockPath)
		removeIfEmptyish(target)
		return from, res, nil
	}

	jlog.Info("[state] moved project state from %s to %s", dirs.State, target)
	_ = from.Release()
	_ = os.Remove(from.lockPath)
	removeIfEmptyish(dirs.State)
	return to, AcquireResult{Acquired: true}, nil
}

// isLocalStateEntry reports whether an entry of a state folder is local state —
// this checkout's, on this machine — and so moves with it. The lock and its
// holder's record are not: each folder has its own, taken by PlaceProjectState.
func isLocalStateEntry(name string, isDir bool) bool {
	switch name {
	case "config.json", "session.json", "held-sends.json", "attention.json",
		"MEMORY.md", "env.local.json":
		return !isDir
	case "trash", "bash-output", "sandboxes":
		return isDir
	}
	if isDir {
		if strings.HasPrefix(name, "trash.emptying") {
			return true
		}
		_, _, ok := ParseDirName(name)
		return ok
	}
	// The flat claudecode sidecar that predates per-conversation folders.
	return strings.HasPrefix(name, "conv_") && strings.HasSuffix(name, ".claudecode.json")
}

// localStateEntries lists dir's local-state entries.
func localStateEntries(dir string) ([]os.DirEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var out []os.DirEntry
	for _, e := range entries {
		if isLocalStateEntry(e.Name(), e.IsDir()) {
			out = append(out, e)
		}
	}
	return out, nil
}

// hasLocalState reports whether dir holds any local state to move.
func hasLocalState(dir string) bool {
	entries, err := localStateEntries(dir)
	return err == nil && len(entries) > 0
}

// moveLocalState moves every local-state entry of from into to, which must
// hold none of its own. On failure every entry already moved is moved back.
func moveLocalState(from, to string) error {
	if hasLocalState(to) {
		return fmt.Errorf("%s already holds project state", to)
	}
	entries, err := localStateEntries(from)
	if err != nil {
		return err
	}
	var moved []string
	for _, e := range entries {
		if err := moveEntry(filepath.Join(from, e.Name()), filepath.Join(to, e.Name())); err != nil {
			for _, name := range moved {
				if backErr := moveEntry(filepath.Join(to, name), filepath.Join(from, name)); backErr != nil {
					jlog.Error("[state] could not move %s back to %s: %v", name, from, backErr)
				}
			}
			return fmt.Errorf("move %s: %w", e.Name(), err)
		}
		moved = append(moved, e.Name())
	}
	if err := rewriteSandboxRoots(filepath.Join(to, "session.json"), from, to); err != nil {
		// The state moved whole; only the sandbox rows still name the old
		// folder, which leaves those sandboxes unavailable rather than lost.
		jlog.Error("[state] could not rewrite sandbox paths in %s: %v", to, err)
	}
	return nil
}

// moveEntry renames src to dst, copying and then deleting it when they are on
// different volumes.
func moveEntry(src, dst string) error {
	if err := atomicio.RobustRename(src, dst); err == nil {
		return nil
	}
	if err := copyEntry(src, dst); err != nil {
		_ = os.RemoveAll(dst)
		return err
	}
	return atomicio.RobustRemoveAll(src)
}

// copyEntry copies a file, directory tree or symlink, keeping modes.
func copyEntry(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	switch {
	case info.Mode()&fs.ModeSymlink != 0:
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(target, dst)
	case info.IsDir():
		if err := os.MkdirAll(dst, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyEntry(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return err
			}
		}
		return nil
	default:
		in, err := os.Open(src)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	}
}

// rewriteSandboxRoots repoints the workspace rows in session.json whose trees
// were under from/sandboxes at the same place under to/sandboxes: a
// scratch-copy sandbox is a folder of the state, and moved with it. Only
// strings that name a path in there change — the row's root and its
// provider's meta (dir, work, pristine) — and the rest of the document is
// written back as it was read.
func rewriteSandboxRoots(sessionPath, from, to string) error {
	data, err := os.ReadFile(sessionPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		return err
	}
	raw, ok := doc["workspaces"]
	if !ok {
		return nil
	}
	var rows []map[string]any
	if err := json.Unmarshal(raw, &rows); err != nil {
		return err
	}
	oldPrefix := filepath.Join(from, "sandboxes") + string(filepath.Separator)
	newPrefix := filepath.Join(to, "sandboxes") + string(filepath.Separator)
	repoint := func(v any) (any, bool) {
		s, ok := v.(string)
		if !ok || !strings.HasPrefix(s, oldPrefix) {
			return v, false
		}
		return newPrefix + strings.TrimPrefix(s, oldPrefix), true
	}
	changed := false
	for _, row := range rows {
		if v, ok := repoint(row["root"]); ok {
			row["root"], changed = v, true
		}
		if meta, ok := row["meta"].(map[string]any); ok {
			for k, mv := range meta {
				if v, ok := repoint(mv); ok {
					meta[k], changed = v, true
				}
			}
		}
	}
	if !changed {
		return nil
	}
	if doc["workspaces"], err = json.Marshal(rows); err != nil {
		return err
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return atomicio.WriteFile(sessionPath, out, 0o644)
}

// removeIfEmptyish removes dir if all that is left in it is the lock or
// Finder's litter, so the folder state moved out of does not linger: an empty
// <project>/.juggler is the clutter the setting exists to avoid, and an empty
// outside folder would by its existence keep placing the state there.
func removeIfEmptyish(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		switch e.Name() {
		case lockFileName, instanceInfoFileName, ".DS_Store":
		default:
			return
		}
	}
	for _, e := range entries {
		_ = os.Remove(filepath.Join(dir, e.Name()))
	}
	_ = os.Remove(dir)
}
