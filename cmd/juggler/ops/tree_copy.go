//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"juggler/internal/gitignore"
	"juggler/internal/jlog"
)

// Copying and comparing whole trees, for anything that needs a second copy of a
// project and needs to know what has happened to it since.
//
// Both walk with the same matcher every other surface here uses, so "the files
// that matter" means the same thing to a copy as it does to glob, grep and the
// file tree — and it means it whether or not git is installed, since the matcher
// reads `.gitignore` itself. That is the whole reason these are operations
// rather than a shell command: `cp` cannot read a `.gitignore`, the pipelines
// that can (`git ls-files | tar`) need git and a POSIX toolchain that agrees
// with the server about absolute paths, and neither is a promise this app can
// make on Windows.
//
// Both ends of both operations are contained: a path that resolves outside the
// scope is refused rather than sanitised, because unlike a write these are not
// gated by the approval flow that would otherwise have asked.

const (
	// maxTreeFiles is the most files either operation will look at. It is a
	// refusal rather than a truncation: half a copy is worse than none, and a
	// comparison missing the file that matters is a wrong answer rather than a
	// short one.
	maxTreeFiles = 50000

	// maxTreeReport is the most paths a comparison will list. Past that the
	// counts still add up and `truncated` says the lists do not.
	maxTreeReport = 5000
)

// afterCollectHook runs between a copy's two passes, where a test can take a
// file away the way another writer would. It is atomic because a copy runs on
// whichever goroutine is serving the request. Production never sets it.
var afterCollectHook atomic.Value // func()

// errSourceVanished marks a source file that the walk found and the copy could
// not open because it had gone. It is the one failure a copy steps over, so
// nothing else that cannot be opened is mistaken for it.
var errSourceVanished = errors.New("the source file has gone")

// copyEntry is what a walk remembers about one thing it found: enough to copy
// it, and enough to tell it apart from the same path in another tree without
// opening either of them.
type copyEntry struct {
	isDir   bool
	link    string // symlink target, "" for everything else
	mode    fs.FileMode
	size    int64
	modTime time.Time
}

// copyTree copies one tree onto another, respecting the ignore rules by default,
// and removes what it is told to remove first.
//
// Params: from (the tree to copy; omit it to only delete), to (required),
// respectIgnore (default true), paths (copy only these, relative to from),
// delete (remove these from `to` first, relative to `to`, and each of them
// something in `to` rather than `to` itself).
//
// A call with no `from` is a removal, which is here rather than in a `remove`
// operation of its own because it is the inverse of a copy and its caller is
// always the same one: whoever made a tree is who unmakes it. It also means a
// caller with a tree to build and unbuild needs no shell at all, and so needs no
// opinion about how three different Windows shells quote a path.
func (ops *TreeOperations) copyTree(ctx context.Context, params map[string]any) (any, error) {
	from, to, err := ops.resolveEnds(params, "from", "to")
	if err != nil {
		return nil, err
	}
	respectIgnore := treeBoolParam(params, "respectIgnore", true)
	only, err := treeStringsParam(params, "paths")
	if err != nil {
		return nil, err
	}
	remove, err := treeStringsParam(params, "delete")
	if err != nil {
		return nil, err
	}

	// What the destination itself canonicalises to, so a deletion naming the root
	// by any of its spellings — "", ".", "a/..", the absolute path — is recognised
	// as the one thing a deletion may not name.
	toRoot, err := containedIn(to, ".")
	if err != nil {
		return nil, err
	}

	// Deletions first: they are what the caller wants gone, and doing them after
	// the copy would take away files the copy had just put there.
	deleted := 0
	for _, rel := range remove {
		abs, err := containedIn(to, rel)
		if err != nil {
			return nil, err
		}
		// Containment is satisfied by the root itself, and a caller that reaches
		// the root reaches every tree it stands for: a workspace conversation's
		// scope holds the project, so one blank string here would be the project.
		// A deletion names something IN the destination.
		if abs == toRoot {
			return nil, fmt.Errorf("refusing to remove %q: it is the destination itself, not something in it", rel)
		}
		if err := removeTree(ctx, abs, rel); err != nil {
			return nil, err
		}
		deleted++
	}

	if from == "" {
		if deleted == 0 {
			return nil, fmt.Errorf("from is required unless something is being deleted")
		}
		return map[string]any{"copied": 0, "deleted": deleted, "skipped": 0, "bytes": int64(0)}, nil
	}
	if from == to {
		return nil, fmt.Errorf("cannot copy %s onto itself", from)
	}

	entries, err := collectTree(ctx, from, respectIgnore, to, only)
	if err != nil {
		return nil, err
	}
	if hook, _ := afterCollectHook.Load().(func()); hook != nil {
		hook()
	}

	// Parents before children, so a file never arrives before the directory it
	// goes in.
	paths := slices.Sorted(maps.Keys(entries))
	copied, skipped := 0, 0
	var written int64
	for _, rel := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		entry := entries[rel]
		src := filepath.Join(from, filepath.FromSlash(rel))
		dst := filepath.Join(to, filepath.FromSlash(rel))

		if err := clearSymlink(dst); err != nil {
			return nil, fmt.Errorf("could not replace the link at %s: %w", rel, err)
		}

		switch {
		case entry.isDir:
			if err := os.MkdirAll(dst, 0o755); err != nil {
				return nil, fmt.Errorf("could not create %s: %w", rel, err)
			}
		case entry.link != "":
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return nil, fmt.Errorf("could not create %s: %w", rel, err)
			}
			// Whatever is there goes: a link cannot be made over a file that
			// already exists, and the source says this path is a link.
			_ = os.Remove(dst)
			// A symlink the platform will not let us make is counted and left
			// out rather than fatal: on Windows creating one needs a privilege
			// the user may simply not have, and a tree of source files is still
			// worth copying without its links.
			if err := os.Symlink(entry.link, dst); err != nil {
				skipped++
				continue
			}
		default:
			n, err := copyFile(src, dst, entry)
			// A tree is collected and then copied, and anything else writing into
			// it — the user's editor, a build, another conversation's atomic write
			// — can take a file away in between. The walk steps over what it cannot
			// read, and so does this: the file is counted as skipped and left out,
			// which is what `copied` and `bytes` then describe.
			if errors.Is(err, errSourceVanished) {
				skipped++
				continue
			}
			if err != nil {
				return nil, err
			}
			written += n
			copied++
		}
	}

	return map[string]any{
		"copied":  copied,
		"deleted": deleted,
		"skipped": skipped,
		"bytes":   written,
	}, nil
}

// compareTrees reports how two trees differ, by path.
//
// Params: left (required), right (required), respectIgnore (default true),
// paths (compare only these, named relative to both ends), exact (read the
// bytes of every file whose size matches, rather than trusting equal
// modification times).
// `added` is what only the right has, `removed` what only the left has, and
// `changed` what both have and disagree about.
//
// `paths` restricts BOTH ends, which is what lets one of them hold only the
// files a caller is asking about: against the whole of the other tree, every
// file the partial one does not hold would read as added — a wrong answer, and
// a long enough one to be truncated. A named path missing from both ends is not
// an error, so a caller may ask about a file that has since gone.
func (ops *TreeOperations) compareTrees(ctx context.Context, params map[string]any) (any, error) {
	left, right, err := ops.resolveEnds(params, "left", "right")
	if err != nil {
		return nil, err
	}
	respectIgnore := treeBoolParam(params, "respectIgnore", true)
	exact := treeBoolParam(params, "exact", false)
	only, err := treeStringsParam(params, "paths")
	if err != nil {
		return nil, err
	}

	leftEntries, err := collectTree(ctx, left, respectIgnore, "", only)
	if err != nil {
		return nil, err
	}
	rightEntries, err := collectTree(ctx, right, respectIgnore, "", only)
	if err != nil {
		return nil, err
	}

	changed, added, removed := []string{}, []string{}, []string{}
	for _, rel := range slices.Sorted(maps.Keys(leftEntries)) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		entry := leftEntries[rel]
		if entry.isDir {
			// Directories are not compared: an empty one is not work, and a
			// directory that holds anything is already spoken for by its files.
			continue
		}
		other, present := rightEntries[rel]
		switch {
		case !present || other.isDir:
			removed = append(removed, rel)
		case !sameContent(filepath.Join(left, filepath.FromSlash(rel)),
			filepath.Join(right, filepath.FromSlash(rel)), entry, other, exact):
			changed = append(changed, rel)
		}
	}
	for _, rel := range slices.Sorted(maps.Keys(rightEntries)) {
		entry := rightEntries[rel]
		if entry.isDir {
			continue
		}
		if other, present := leftEntries[rel]; !present || other.isDir {
			added = append(added, rel)
		}
	}

	truncated := len(changed) > maxTreeReport || len(added) > maxTreeReport || len(removed) > maxTreeReport
	return map[string]any{
		"changed":   capPaths(changed),
		"added":     capPaths(added),
		"removed":   capPaths(removed),
		"truncated": truncated,
	}, nil
}

// removeRetryDelays are the pauses between attempts at a removal that failed,
// about three quarters of a second in all. Long enough for a process that was
// just stopped to be gone and for a file manager to finish with a folder it was
// showing; short enough that a removal which will never succeed says so promptly.
var removeRetryDelays = []time.Duration{
	50 * time.Millisecond, 100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond,
}

// taskStopGrace is how long a background task running in a tree being removed
// is given to stop politely before its process group is taken.
const taskStopGrace = 250 * time.Millisecond

// removeTree deletes abs and everything in it, `rel` being how the caller named
// it.
//
// A removal is only as good as the tree holding still while it runs: RemoveAll
// empties a directory and then removes it, and one file arriving in between
// fails the whole thing with "directory not empty". The writer is nearly always
// something running IN the tree — a dev server or a watch build started in a
// sandbox — so those are stopped first, which they would need to be anyway:
// left alone, they run on in a directory that no longer exists. What is left
// after that is transient, and is ridden out by trying again.
//
// A removal that still fails says what it could not remove, because RemoveAll's
// own error names one directory and not the file in it that identifies whoever
// kept writing.
func removeTree(ctx context.Context, abs, rel string) error {
	// A whole tree going is worth one line: when a file vanishes from under
	// something else, this is how its removal is found.
	jlog.Info("[tree-copy] removing %s", abs)
	stopBackgroundTasksWithin(abs, fmt.Sprintf("Stopped when %s was removed", rel), taskStopGrace)

	err := os.RemoveAll(abs)
	for _, delay := range removeRetryDelays {
		if err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
		err = os.RemoveAll(abs)
	}
	if err == nil {
		return nil
	}
	if left := leftIn(abs, 5); len(left) > 0 {
		return fmt.Errorf("could not remove %s: %w (still there: %s)", rel, err, strings.Join(left, ", "))
	}
	return fmt.Errorf("could not remove %s: %w", rel, err)
}

// leftIn lists up to limit of the files a failed removal left behind, relative
// to the directory it was removing and slash-separated.
func leftIn(dir string, limit int) []string {
	var left []string
	_ = filepath.WalkDir(dir, func(abs string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if rel, relErr := filepath.Rel(dir, abs); relErr == nil {
			left = append(left, filepath.ToSlash(rel))
		}
		if len(left) >= limit {
			return fs.SkipAll
		}
		return nil
	})
	return left
}

// resolveEnds reads the two ends of a copy or a comparison, each contained
// within the scope. Neither is defaulted: an operation that guessed one of its
// ends would be guessing about a directory it is going to write into. An absent
// `from` answers "", which only copyTree accepts, and only to delete.
func (ops *TreeOperations) resolveEnds(params map[string]any, fromKey, toKey string) (string, string, error) {
	from := ""
	if params[fromKey] != nil {
		text, ok := params[fromKey].(string)
		if !ok {
			return "", "", fmt.Errorf("%s must be a string, got %T", fromKey, params[fromKey])
		}
		from = text
	}
	to, ok := params[toKey].(string)
	if !ok || to == "" {
		return "", "", fmt.Errorf("%s is required", toKey)
	}

	fromAbs := ""
	if from != "" {
		resolved, err := ops.scope.Resolve(from)
		if err != nil {
			return "", "", err
		}
		fromAbs = resolved.AbsPath
	}
	toAbs, err := ops.scope.Resolve(to)
	if err != nil {
		return "", "", err
	}
	return fromAbs, toAbs.AbsPath, nil
}

// containedIn resolves a path named relative to some root and refuses one that
// climbs out of it.
func containedIn(root, rel string) (string, error) {
	result, err := ValidateFilePathWithRoots(root, nil, rel)
	if err != nil {
		return "", err
	}
	if !result.IsValid {
		return "", fmt.Errorf("%s", result.ErrorMsg)
	}
	return result.AbsPath, nil
}

// collectTree walks a tree and remembers what is in it, keyed by POSIX-slashed
// relative path.
//
// `skip` is a directory the walk must not descend into, which is how a copy into
// a directory *inside* its own source stays finite — the ordinary case here,
// since a sandbox lives under the project it is a copy of. `only` restricts the
// walk to the named paths (each a file or a directory below the root).
func collectTree(ctx context.Context, root string, respectIgnore bool, skip string, only []string) (map[string]copyEntry, error) {
	entries := make(map[string]copyEntry)
	var ign *gitignore.Matcher
	if respectIgnore {
		ign = gitignore.NewMatcher(root)
	}

	// One visitor for both the whole-tree walk and the restricted one, so a
	// `paths` copy cannot pick up a file the full copy would have left behind.
	add := func(rel string, d fs.DirEntry) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if rel == "." || rel == "" {
			return nil
		}
		if ign.Ignored(rel, d.IsDir()) {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() && skip != "" && filepath.Join(root, filepath.FromSlash(rel)) == skip {
			return fs.SkipDir
		}
		info, err := d.Info()
		if err != nil {
			return nil // vanished or unreadable: not this operation's business
		}
		entry := copyEntry{isDir: d.IsDir(), mode: info.Mode(), size: info.Size(), modTime: info.ModTime()}
		if info.Mode()&fs.ModeSymlink != 0 {
			target, err := os.Readlink(filepath.Join(root, filepath.FromSlash(rel)))
			if err != nil {
				return nil
			}
			entry.link = target
		}
		entries[rel] = entry
		if len(entries) > maxTreeFiles {
			return fmt.Errorf("refusing to walk more than %d files under %s", maxTreeFiles, root)
		}
		return nil
	}

	fsys := os.DirFS(root)
	walk := func(start string) error {
		return fs.WalkDir(fsys, start, func(rel string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // skip what cannot be read, keep walking
			}
			return add(rel, d)
		})
	}

	if len(only) == 0 {
		if err := walk("."); err != nil {
			return nil, err
		}
		return entries, nil
	}

	for _, named := range only {
		rel := strings.Trim(filepath.ToSlash(named), "/")
		if rel == "" || rel == "." {
			continue
		}
		if _, err := containedIn(root, rel); err != nil {
			return nil, err
		}
		info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			// A named path that is not there is not an error: `paths` describes
			// what to carry across, and a caller comparing two trees a moment
			// ago may be asking for something that has gone since.
			continue
		}
		// Every ancestor directory, so the file lands somewhere that exists.
		for _, parent := range ancestors(rel) {
			if _, seen := entries[parent]; seen {
				continue
			}
			if parentInfo, err := os.Lstat(filepath.Join(root, filepath.FromSlash(parent))); err == nil {
				entries[parent] = copyEntry{isDir: true, mode: parentInfo.Mode(), modTime: parentInfo.ModTime()}
			}
		}
		if info.IsDir() {
			if err := walk(rel); err != nil {
				return nil, err
			}
			continue
		}
		if err := add(rel, fs.FileInfoToDirEntry(info)); err != nil {
			return nil, err
		}
	}
	return entries, nil
}

// clearSymlink removes a destination entry that is a symlink, so that what is
// written next is written inside the tree rather than wherever the link points.
//
// The source walk never follows a link, but `MkdirAll` and `O_CREATE` both do,
// and the destination is not this operation's to trust: a scratch copy applies
// into a tree the user has been working in for hours. A real file is left where
// it is — it is truncated rather than replaced, so anything holding it open goes
// on holding the file it opened.
func clearSymlink(dst string) error {
	info, err := os.Lstat(dst)
	if err != nil || info.Mode()&fs.ModeSymlink == 0 {
		return nil
	}
	return os.Remove(dst)
}

// ancestors lists the directories a relative path sits under, outermost first.
func ancestors(rel string) []string {
	parts := strings.Split(rel, "/")
	out := make([]string, 0, len(parts)-1)
	for i := 1; i < len(parts); i++ {
		out = append(out, strings.Join(parts[:i], "/"))
	}
	return out
}

// copyFile copies one file, keeping its permissions and its modification time.
//
// The time is kept because it is what makes a later comparison cheap: two trees
// copied from one another agree on size and time, and only the files that have
// actually been touched since are opened and read.
func copyFile(src, dst string, entry copyEntry) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return 0, fmt.Errorf("could not create %s: %w", filepath.Dir(dst), err)
	}
	in, err := os.Open(src)
	if err != nil {
		// Told apart from every other reason a source will not open, because it
		// is the only one the caller goes on past.
		if errors.Is(err, fs.ErrNotExist) {
			return 0, fmt.Errorf("%w: %s", errSourceVanished, src)
		}
		return 0, fmt.Errorf("could not read %s: %w", src, err)
	}
	defer func() { _ = in.Close() }()

	// Truncated rather than removed and remade: an apply overwrites files in the
	// tree the user is looking at, and replacing the inode would break anything
	// holding the old one open.
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, entry.mode.Perm())
	if err != nil {
		return 0, fmt.Errorf("could not write %s: %w", dst, err)
	}
	written, err := io.Copy(out, in)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return 0, fmt.Errorf("could not write %s: %w", dst, err)
	}
	_ = os.Chmod(dst, entry.mode.Perm())
	_ = os.Chtimes(dst, entry.modTime, entry.modTime)
	return written, nil
}

// sameContent answers whether two files are the same, as cheaply as it can.
//
// Same size and same modification time is taken as unchanged — the fast path
// that makes comparing a whole tree affordable, and the one an editor that
// deliberately restores timestamps can fool. Everything else is read.
//
// `exact` gives that fast path up and reads every file whose size matches. It
// costs a pass over the tree, and it is what a caller asks for when being wrong
// loses the work: a comparison that decides what an apply will carry, and is
// then followed by the deletion of the only other copy. Being one file out is
// cosmetic in a status line and unrecoverable there.
func sameContent(leftPath, rightPath string, left, right copyEntry, exact bool) bool {
	if left.link != "" || right.link != "" {
		return left.link == right.link
	}
	if left.size != right.size {
		return false
	}
	if !exact && left.modTime.Equal(right.modTime) {
		return true
	}
	return equalFiles(leftPath, rightPath)
}

// equalFiles compares two files byte by byte, in blocks, stopping at the first
// difference.
func equalFiles(leftPath, rightPath string) bool {
	left, err := os.Open(leftPath)
	if err != nil {
		return false
	}
	defer func() { _ = left.Close() }()
	right, err := os.Open(rightPath)
	if err != nil {
		return false
	}
	defer func() { _ = right.Close() }()

	leftBuf := make([]byte, 64*1024)
	rightBuf := make([]byte, 64*1024)
	for {
		leftRead, leftErr := io.ReadFull(left, leftBuf)
		rightRead, rightErr := io.ReadFull(right, rightBuf)
		if leftRead != rightRead || !bytes.Equal(leftBuf[:leftRead], rightBuf[:rightRead]) {
			return false
		}
		if leftErr != nil || rightErr != nil {
			return leftErr == rightErr
		}
	}
}

// capPaths keeps a report readable when a tree has gone badly wrong.
func capPaths(paths []string) []string {
	if len(paths) > maxTreeReport {
		return paths[:maxTreeReport]
	}
	return paths
}

// treeBoolParam reads an optional boolean, defaulting when it is absent.
func treeBoolParam(params map[string]any, name string, fallback bool) bool {
	if value, ok := params[name].(bool); ok {
		return value
	}
	return fallback
}

// treeStringsParam reads an optional list of paths.
func treeStringsParam(params map[string]any, name string) ([]string, error) {
	raw, present := params[name]
	if !present || raw == nil {
		return nil, nil
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array of strings, got %T", name, raw)
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		text, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("%s must be an array of strings, got a %T in it", name, item)
		}
		out = append(out, text)
	}
	return out, nil
}
