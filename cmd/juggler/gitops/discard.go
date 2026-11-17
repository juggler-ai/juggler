//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/msg"
)

// DiscardRef is where a discard saves what it throws away, before it throws it
// away: a chain of commits, newest at the tip, each holding the discarded
// files' working-tree content in its tree and, in its message, what each file
// was before and after. One ref rather than one per discard, so the user's
// refs list does not fill with them; under refs/juggler/, which nothing pushes
// or fetches by default. It is the common directory's, so every worktree of
// the repository sees it.
const DiscardRef = "refs/juggler/discarded"

// discardKeep is how old the newest discard may be for the next one to chain
// onto it. A discard made after a quieter spell than this starts the chain
// afresh, and the old chain is left to git's garbage collection.
const discardKeep = 14 * 24 * time.Hour

// discardIdentity signs the recovery commits, which are not the user's and
// must not fail for want of a configured name.
var discardIdentity = []string{
	"GIT_AUTHOR_NAME=Juggler", "GIT_AUTHOR_EMAIL=juggler@localhost",
	"GIT_COMMITTER_NAME=Juggler", "GIT_COMMITTER_EMAIL=juggler@localhost",
}

// discardedFile is one file a discard touched. Mode and Blob are its content
// before (both empty when it did not exist); After is the blob id of what the
// discard left, or empty when it left nothing. Blob ids are of the bytes on
// disk exactly — no filters — so restoring one writes back what was there.
type discardedFile struct {
	Path  string `json:"path"`
	Mode  string `json:"mode,omitempty"`
	Blob  string `json:"blob,omitempty"`
	After string `json:"after,omitempty"`
}

// discardRecord is a recovery commit's message body.
type discardRecord struct {
	Worktree string          `json:"worktree"`
	Files    []discardedFile `json:"files"`
	Done     bool            `json:"done"`
}

// discardSubject heads every recovery commit's message.
const discardSubject = "Discarded by Juggler"

// discardSave is a recovery point in two halves. saveDiscard writes the files'
// content and moves the ref before anything is discarded, so that whatever
// happens next the content is recoverable. finish then records what the
// discard left, which is what an undo checks it is not about to overwrite, as
// a second commit with the same tree and parent.
type discardSave struct {
	r      *runner
	rec    discardRecord
	tree   string
	parent string
	first  string
}

// saveDiscard saves paths' working-tree content to DiscardRef.
func (r *runner) saveDiscard(paths []string) (*discardSave, error) {
	s := &discardSave{r: r, rec: discardRecord{Worktree: r.dir}}
	for _, p := range paths {
		f, err := r.snapshot(p, true)
		if err != nil {
			return nil, err
		}
		s.rec.Files = append(s.rec.Files, f)
	}
	tree, err := r.discardTree(s.rec.Files)
	if err != nil {
		return nil, err
	}
	s.tree = tree
	if s.parent, err = r.discardParent(); err != nil {
		return nil, err
	}
	if s.first, err = s.commit(""); err != nil {
		return nil, err
	}
	return s, nil
}

// finish records what the discard left and returns the recovery point's id.
func (s *discardSave) finish() (string, error) {
	for i, f := range s.rec.Files {
		after, err := s.r.snapshot(f.Path, false)
		if err != nil {
			return s.first, err
		}
		s.rec.Files[i].After = after.Blob
	}
	s.rec.Done = true
	return s.commit(s.first)
}

// commit writes the record as a commit on the saved tree and moves the ref to
// it from old ("" for wherever it is now).
func (s *discardSave) commit(old string) (string, error) {
	body, err := json.Marshal(s.rec)
	if err != nil {
		return "", err
	}
	args := []string{"commit-tree", s.tree}
	if s.parent != "" {
		args = append(args, "-p", s.parent)
	}
	out, err := s.r.run(call{args: args, stdin: []byte(discardSubject + "\n\n" + string(body) + "\n"), env: discardIdentity, quiet: true})
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(out))
	update := []string{"update-ref", "-m", discardSubject, DiscardRef, id}
	if old != "" {
		update = append(update, old)
	}
	if _, err := s.r.git(update...); err != nil {
		return "", err
	}
	return id, nil
}

// snapshot is one file's content as it is now: written to the object store
// when write is set, only hashed otherwise.
func (r *runner) snapshot(rel string, write bool) (discardedFile, error) {
	f := discardedFile{Path: rel}
	abs := filepath.Join(r.dir, filepath.FromSlash(rel))
	info, err := os.Lstat(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return f, nil
	}
	if err != nil {
		return f, err
	}
	hash := []string{"hash-object", "--no-filters"}
	if write {
		hash = append(hash, "-w")
	}
	var c call
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		target, err := os.Readlink(abs)
		if err != nil {
			return f, err
		}
		f.Mode = "120000"
		c = call{args: append(hash, "--stdin"), stdin: []byte(target), quiet: true}
	case info.Mode().IsRegular():
		f.Mode = "100644"
		if info.Mode()&0o111 != 0 {
			f.Mode = "100755"
		}
		c = call{args: append(hash, "--", rel), quiet: true}
	default:
		return f, refused(msg.NewError("{path} is not a file.", "path", rel))
	}
	out, err := r.run(c)
	if err != nil {
		return f, err
	}
	f.Blob = strings.TrimSpace(string(out))
	return f, nil
}

// discardTree builds a tree of the files that existed, through an index of its
// own so the repository's is never touched.
func (r *runner) discardTree(files []discardedFile) (string, error) {
	scratch, err := os.MkdirTemp("", "juggler-discard-")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(scratch) }()
	env := []string{"GIT_INDEX_FILE=" + filepath.Join(scratch, "index")}
	for _, f := range files {
		if f.Blob == "" {
			continue
		}
		if _, err := r.run(call{args: []string{"update-index", "--add", "--cacheinfo", f.Mode + "," + f.Blob + "," + f.Path}, env: env, quiet: true}); err != nil {
			return "", err
		}
	}
	out, err := r.run(call{args: []string{"write-tree"}, env: env, quiet: true})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// discardParent is the chain's tip, unless it is older than discardKeep.
func (r *runner) discardParent() (string, error) {
	out, ok, err := r.ask("log", "-1", "--format=%H %ct", DiscardRef, "--")
	if err != nil || !ok || out == "" {
		return "", err
	}
	id, stamp, _ := strings.Cut(out, " ")
	secs, err := strconv.ParseInt(stamp, 10, 64)
	if err != nil || time.Since(time.Unix(secs, 0)) > discardKeep {
		return "", nil //nolint:nilerr // an unreadable date starts a new chain
	}
	return id, nil
}

// discard throws away the unstaged changes of whole files: a tracked file goes
// back to what the index holds, an untracked one is removed. Everything is
// saved to DiscardRef first.
func discard(r *runner, op Op) (Result, error) {
	paths, err := r.files(op.Paths)
	if err != nil {
		return Result{}, err
	}
	var tracked, untracked []string
	for _, p := range paths {
		if _, known, err := r.ask("ls-files", "--error-unmatch", "--", p); err != nil {
			return Result{}, err
		} else if known {
			tracked = append(tracked, p)
		} else {
			untracked = append(untracked, p)
		}
	}
	saved, err := r.saveDiscard(paths)
	if err != nil {
		return Result{}, err
	}
	if len(tracked) > 0 {
		if _, err := r.git(append([]string{"restore", "--worktree", "--"}, tracked...)...); err != nil {
			return Result{}, err
		}
	}
	for _, p := range untracked {
		if err := os.Remove(filepath.Join(r.dir, filepath.FromSlash(p))); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return Result{}, err
		}
	}
	id, err := saved.finish()
	return Result{Discard: id}, err
}

// undoDiscard puts back what a discard threw away — but only into files that
// are still exactly as the discard left them. Anything done to a file since is
// work too, and the discarded version stays in DiscardRef for the user to take
// by hand.
func undoDiscard(r *runner, op Op) (Result, error) {
	rec, err := r.discardRecord(op.Discard)
	if err != nil {
		return Result{}, err
	}
	if err := r.leftAsSaved(rec); err != nil {
		return Result{}, err
	}
	for _, f := range rec.Files {
		if err := r.restore(f); err != nil {
			return Result{}, err
		}
	}
	return Result{}, nil
}

// leftAsSaved refuses a save whose files are not all still exactly as what
// saved them left them: writing one back would throw away what was done to it
// since.
func (r *runner) leftAsSaved(rec discardRecord) error {
	for _, f := range rec.Files {
		if _, err := r.files([]string{f.Path}); err != nil {
			return err
		}
		now, err := r.snapshot(f.Path, false)
		if err != nil {
			return err
		}
		if now.Blob != f.After {
			return refused(msg.NewError("{path} has changed since it was discarded, so nothing was put back. The discarded version is kept in {ref}.",
				"path", f.Path, "ref", DiscardRef))
		}
	}
	return nil
}

// discardRecord is the record of a finished save on DiscardRef, refusing an id
// that names none.
func (r *runner) discardRecord(id string) (discardRecord, error) {
	var rec discardRecord
	id = strings.TrimSpace(id)
	if id == "" || strings.HasPrefix(id, "-") {
		return rec, refused(msg.NewError("No discard was named."))
	}
	if _, ours, err := r.ask("merge-base", "--is-ancestor", id, DiscardRef); err != nil {
		return rec, err
	} else if !ours {
		return rec, refused(msg.NewError("That discard is not one Juggler saved here."))
	}
	body, ok, err := r.ask("log", "-1", "--format=%b", id, "--")
	if err != nil {
		return rec, err
	}
	if !ok || json.Unmarshal([]byte(body), &rec) != nil || !rec.Done {
		return rec, refused(msg.NewError("That discard can't be undone here. Its files are kept in {ref}.", "ref", DiscardRef))
	}
	return rec, nil
}

// restore writes one discarded file back as it was, or removes it if it did
// not exist.
func (r *runner) restore(f discardedFile) error {
	abs := filepath.Join(r.dir, filepath.FromSlash(f.Path))
	if f.Blob == "" {
		if err := os.Remove(abs); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	content, err := r.run(call{args: []string{"cat-file", "blob", f.Blob}, quiet: true})
	if err != nil {
		return err
	}
	if r.hooks.Command != nil {
		r.hooks.Command([]string{"cat-file", "blob", f.Blob, ">", f.Path})
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o750); err != nil {
		return err
	}
	if err := os.Remove(abs); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if f.Mode == "120000" {
		return os.Symlink(string(content), abs)
	}
	perm := os.FileMode(0o644)
	if f.Mode == "100755" {
		perm = 0o755
	}
	return os.WriteFile(abs, content, perm) //nolint:gosec // restoring the user's own file with its own mode
}
