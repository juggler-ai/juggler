//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Diff bounds. A diff is read to be looked at, so the ceilings are the size of a
// thing a person can scroll rather than the size of a thing git can produce: a
// generated file rewritten wholesale is the common way to meet them, and it is
// better answered with the first few thousand lines and a note than with a
// megabyte nobody reads.
const (
	gitDiffContext  = 3       // lines of context git is asked for when none is asked of us
	gitDiffMaxLines = 20000   // diff lines returned before the rest is dropped
	gitDiffMaxMeta  = 8 << 20 // bytes kept from git's metadata passes
	gitDiffSniff    = 8000    // bytes of an untracked file read to judge it binary
)

// gitDiffMaxContext is the widest context a request may ask for, and what "the
// whole file" is asked for as.
//
// It does not need to be the length of the longest file anyone has: the two
// ceilings above already bound what comes back, so a whole-file request for
// something enormous returns the first several thousand lines and says it was cut
// short — the same answer, and the same notice, as an ordinary diff that big.
// What this bounds is the argument handed to git, so that a number arriving from
// a query string cannot become one.
const gitDiffMaxContext = 1 << 20

// gitDiffMaxBytes is the patch bytes kept before the rest is dropped.
//
// A var rather than a const so a test can lower it. Crossing eight megabytes
// honestly costs git a quarter of a million lines to produce and parse, which
// on a loaded runner takes longer than the diff's own per-command clock allows
// — the test then fails on the clock rather than on the truncation it is about.
// The code either side of the ceiling does not know what the ceiling is, so a
// small one exercises it exactly.
var gitDiffMaxBytes = 8 << 20

// The diff's clocks, which are not the status card's. A card is polled in the
// background and settles for the cheap answer, so it gives up quickly; a diff is
// asked for once, by somebody waiting to look at it, and the patch it is allowed
// to return runs to eight megabytes. Git reads the file for the metadata pass,
// again for the patch and again for the tally behind a truncated one, and on a
// loaded machine those reads take seconds rather than milliseconds. Refusing a
// diff that another few seconds would have produced is the worse answer.
//
// Var rather than const so a test can lend itself more of them, as the review's
// clocks are. A test that means to check what a diff says is not asking how fast
// this machine's git is, and on a loaded runner those are different questions
// with the same answer: a 502 naming the clock.
var (
	gitDiffPerCmd = 10 * time.Second // one git command's clock
	gitDiffBudget = 30 * time.Second // the whole request's, across all of them
)

// gitAbsentMode is the mode git writes for the side of a change a file does not
// exist on, and gitSymlinkMode the mode it writes for a symbolic link.
const (
	gitAbsentMode  = "000000"
	gitSymlinkMode = "120000"
)

// gitDiffLine is one line of a hunk. Old and New are the line's number on each
// side, and are 0 on the side the line does not exist — an added line has no
// number in the old file. Text carries no leading +/-/space: which side a line
// is on is Kind's job, not the text's.
type gitDiffLine struct {
	Kind string `json:"kind"` // "context", "add" or "remove"
	Old  int    `json:"oldLine,omitempty"`
	New  int    `json:"newLine,omitempty"`
	Text string `json:"text"`
}

// gitDiffHunk is one run of changed lines and the context around it, with the
// range it covers on each side. Heading is the section git names in the `@@`
// line — usually the enclosing function — and is often empty.
type gitDiffHunk struct {
	OldStart int           `json:"oldStart"`
	OldLines int           `json:"oldLines"`
	NewStart int           `json:"newStart"`
	NewLines int           `json:"newLines"`
	Heading  string        `json:"heading,omitempty"`
	Lines    []gitDiffLine `json:"lines"`
}

// gitDiffResponse is the JSON response shape for GET /api/git/diff: one file's
// working tree against HEAD. Status is what happened to the file rather than a
// porcelain letter, because a reader is being told a story about the file and
// not asked to decode one.
// Status is one of modified, added, deleted, renamed, copied, typechange,
// conflicted, untracked or unchanged.
//
// Revision fingerprints the change this response describes — every byte git
// produced for it, or every byte of an untracked file's content, including the
// bytes past a ceiling that were never returned. A comment is anchored to it, so
// it answers the only question an anchor has: is this still the same file I
// commented on. HEAD cannot answer that, because almost every edit under review
// happens without HEAD moving at all.
//
// Context is how many unchanged lines the patch carries around each change —
// what the request asked for, clamped, or the default when it asked for nothing.
// It is reported rather than assumed because a client can narrow a patch it
// already holds but cannot widen one, and telling the two apart needs this.
//
// OldMode and NewMode are git's six-digit modes, carried whenever they differ: a
// file can change without a line of it changing, and an empty patch with no
// modes reads as nothing having happened. An untracked symbolic link carries a
// NewMode alone, which is the only thing separating the path it holds from an
// ordinary new file whose one line happens to be a path.
type gitDiffResponse struct {
	Repo       string        `json:"repo"`
	Path       string        `json:"path"`
	OldPath    string        `json:"oldPath,omitempty"`
	Status     string        `json:"status"`
	Binary     bool          `json:"binary"`
	Conflicted bool          `json:"conflicted,omitempty"`
	Truncated  bool          `json:"truncated"`
	Added      int           `json:"added"`
	Removed    int           `json:"removed"`
	Revision   string        `json:"revision"`
	Context    int           `json:"context"`
	OldMode    string        `json:"oldMode,omitempty"`
	NewMode    string        `json:"newMode,omitempty"`
	Hunks      []gitDiffHunk `json:"hunks"`
}

// HandleGitDiff handles GET /api/git/diff?repo=<rel>&path=<rel>. It answers with
// one file's whole working-tree change relative to HEAD — index and worktree
// together, the same comparison the status card's line counts are taken from, so
// a file's diffstat there and its diff here can never disagree.
//
// `repo` locates the repository within the project ("" for the root repo) and
// `path` locates the file within that repository. Both are relative and are
// refused if they climb out of where they belong: this endpoint reads whatever
// it is pointed at, so where it may be pointed is the whole of its security.
//
// `context` is how many unchanged lines to carry around each change, -1 for the
// whole file, and the shipped default when it is absent or unusable. The answer
// reports the width it was produced at.
func (a *GitStatusAPI) HandleGitDiff(w http.ResponseWriter, r *http.Request) {
	tree, err := a.gitRoot(r)
	if err != nil {
		WriteError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	root := tree.Root
	if root == "" {
		WriteError(w, r, http.StatusBadRequest, "No project is open")
		return
	}

	repoRel, ok := cleanRepoRelative(r.URL.Query().Get("repo"))
	if !ok {
		WriteError(w, r, http.StatusBadRequest, "Not a path inside the project: repo")
		return
	}
	fileRel, ok := cleanRepoRelative(r.URL.Query().Get("path"))
	if !ok || fileRel == "" {
		WriteError(w, r, http.StatusBadRequest, "Not a path inside the repository: path")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), gitDiffBudget)
	defer cancel()

	dir, ok := resolveRepoDir(ctx, root, repoRel)
	if !ok {
		// Discovery that ran out of time finds nothing, which is not the same as
		// there being nothing to find. Reported as the latter it becomes a settled
		// fact about the project rather than the passing failure it is.
		if ctx.Err() != nil {
			WriteError(w, r, http.StatusBadGateway, "Couldn't read the diff. "+ctx.Err().Error())
			return
		}
		WriteError(w, r, http.StatusBadRequest, "Not a repository in this project: repo")
		return
	}
	abs := filepath.Join(dir, filepath.FromSlash(fileRel))
	if !fileWithinRepo(abs, dir) {
		WriteError(w, r, http.StatusBadRequest, "Not a path inside the repository: path")
		return
	}

	unified := diffContextFrom(r.URL.Query().Get("context"))
	resp := gitDiffResponse{
		Repo: repoRel, Path: fileRel, Status: "unchanged",
		Context: unified, Hunks: []gitDiffHunk{},
	}

	base, err := gitDiffBase(ctx, dir, gitDiffPerCmd)
	if err != nil {
		WriteError(w, r, http.StatusBadGateway, "Couldn't read the diff. "+err.Error())
		return
	}

	// What happened to a file is settled before the file's own patch is asked
	// for, because some of it cannot be seen from there: a rename is a statement
	// about two paths, and a pathspec naming one of them is a file that appeared
	// from nowhere. The metadata is keyed by the file's current path, which is
	// the path the review lists a renamed file under.
	meta, err := gitDiffMetadata(ctx, dir, base)
	if err != nil {
		WriteError(w, r, http.StatusBadGateway, "Couldn't read the diff. "+err.Error())
		return
	}
	file, changed := meta[fileRel]

	// Both sides of a rename go into the pathspec, so that git pairs them again
	// rather than reporting the deletion and the creation it would otherwise see.
	paths := []string{fileRel}
	if file.OldPath != "" {
		paths = append(paths, file.OldPath)
	}

	patch, err := gitFilePatch(ctx, dir, base, paths, unified)
	if err != nil {
		WriteError(w, r, http.StatusBadGateway, "Couldn't read the diff. "+err.Error())
		return
	}
	resp.Revision, resp.Truncated = patch.Revision, patch.Truncated
	if len(patch.Kept) > 0 {
		parseGitPatch(patch.Kept, &resp)
	}

	switch {
	case changed:
		applyGitFileMeta(&resp, file)
		// The working tree of a conflicted file holds both sides and the markers
		// between them. Shown as an ordinary diff, that reads as text the user
		// wrote, so the state is reported rather than left to be inferred.
		if gitFileConflicted(ctx, dir, fileRel) {
			resp.Status, resp.Conflicted = "conflicted", true
		}
		// A patch cut short took the rest of its own tally with it. git still has
		// the whole one, and a truncated diff that understated the change would be
		// truncation nobody could see.
		if resp.Truncated {
			if stat, ok := gitNumstatCounts(ctx, dir, base, paths); ok {
				resp.Added, resp.Removed = stat.Added, stat.Removed
			}
		}
	case len(patch.Kept) == 0:
		// Nothing from `git diff` is either an unchanged file or one git has never
		// been told about, and only the second has anything to show. An untracked
		// file is diffed here rather than by `--no-index` against the null device,
		// which is spelled differently on each platform for a file we have to read
		// anyway to know whether it is text.
		if untracked, uerr := gitIsUntracked(ctx, dir, fileRel); uerr == nil && untracked {
			untrackedDiff(ctx, abs, &resp)
		}
	}
	WriteJSON(w, r, 0, resp)
}

// applyGitFileMeta overlays what the repository-wide pass established onto what
// the file's own patch said. The patch is read for its hunks; the metadata is
// what the status and the paths are taken from, since a patch for one pathspec
// cannot see past itself.
func applyGitFileMeta(resp *gitDiffResponse, file gitFileMeta) {
	if file.Status != "" {
		resp.Status = file.Status
	}
	if file.OldPath != "" {
		resp.OldPath = file.OldPath
	}
	// Modes are worth reporting when a file lived on both sides of the change and
	// its mode moved: that is a change with no lines in it, and without the modes
	// the response is an empty patch that reads as nothing having happened. On an
	// added or deleted file the absent side's mode says nothing the status has not.
	if file.OldMode != file.NewMode && file.OldMode != gitAbsentMode && file.NewMode != gitAbsentMode {
		resp.OldMode, resp.NewMode = file.OldMode, file.NewMode
	}
}

// resolveRepoDir turns the client's `repo` into the directory git runs in, and
// refuses anything that is not a repository this project actually contains.
// Without that check an ordinary subdirectory is accepted, and git — which looks
// upward for a repository when the directory it is given is not one — answers
// from whatever repository sits above the project, which may be one the user
// never opened.
func resolveRepoDir(ctx context.Context, root, repoRel string) (string, bool) {
	dir := filepath.Join(root, filepath.FromSlash(repoRel))
	if repoIsAmong(dir, discoverRepos(ctx, root)) {
		return dir, true
	}
	// The cheap search skips the directories that cost the most to walk, and the
	// review's search does not — so a checkout under vendor/ can be listed for
	// review, and a file in it has to be openable from that list. The thorough
	// search is only paid for once the cheap one has said no.
	if repoIsAmong(dir, scanRepos(ctx, root, reviewScanLimits()).Repos) {
		return dir, true
	}
	return "", false
}

// repoIsAmong reports whether dir is one of the repositories found, comparing
// resolved paths so that two names for one place are one place.
func repoIsAmong(dir string, repos []string) bool {
	resolved := resolvedPath(dir)
	for _, found := range repos {
		if resolvedPath(found) == resolved {
			return true
		}
	}
	return false
}

// fileWithinRepo reports whether abs names a file inside dir.
//
// Every directory along the way is resolved, because a symlinked directory is
// how a lexically innocent path leaves the project, and resolving is the only
// way to find that out. The last component is deliberately not resolved: a link
// is a file this endpoint describes rather than opens, and resolving it would
// refuse to say anything at all about a link purely because of what it names.
// That is safe only because it is paired with the Lstat in untrackedDiff — the
// link's own text is read with Readlink, and nothing at the end of it is opened.
func fileWithinRepo(abs, dir string) bool {
	parent, realDir := resolvedPath(filepath.Dir(abs)), resolvedPath(dir)
	if parent == realDir {
		return true
	}
	return strings.HasPrefix(parent, realDir+string(filepath.Separator))
}

// resolvedPath is a path with its symlinks followed. Resolving matters even for
// paths nobody is trying to abuse: macOS hands out temporary directories under
// /var, which is itself a symlink to /private/var, so an unresolved path can
// fail to match a resolved one that names the same place.
//
// A path that does not exist cannot be resolved, and a deleted file still has a
// diff to show, so the deepest ancestor that does exist is resolved instead and
// the rest of the path put back on the end. Comparing the literal path in that
// case would be the bug it looks like a shortcut for: every path below a
// symlinked ancestor would stop matching the directory it is inside.
func resolvedPath(p string) string {
	p = filepath.Clean(p)
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return filepath.Clean(real)
	}
	rest := ""
	for {
		parent := filepath.Dir(p)
		rest = filepath.Join(filepath.Base(p), rest)
		if parent == p {
			return filepath.Clean(filepath.Join(p, rest))
		}
		p = parent
		if real, err := filepath.EvalSymlinks(p); err == nil {
			return filepath.Clean(filepath.Join(real, rest))
		}
	}
}

// cleanRepoRelative normalises a client-supplied relative path and rejects one
// that is absolute or climbs above where it is anchored. "" is allowed and means
// the anchor itself, which is how the root repository names itself.
//
// These paths are slash-separated whatever the client is, and they are judged
// here without the host's path rules: `filepath` answers for the machine the
// server happens to run on, which would make what escapes a property of the
// server rather than of the path. A backslash is refused outright for the same
// reason — folding it to a separator, which is what ToSlash does on Windows,
// turns `web\js\app.js` and `C:\Windows` into ordinary-looking relative paths
// that every check below then waves through.
func cleanRepoRelative(raw string) (string, bool) {
	rel := strings.TrimSpace(raw)
	if rel == "" {
		return "", true
	}
	if strings.ContainsAny(rel, "\\\x00") || strings.HasPrefix(rel, "/") || hasDriveLetter(rel) {
		return "", false
	}
	cleaned := path.Clean(rel)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") || cleaned == "." {
		return "", false
	}
	return cleaned, true
}

// hasDriveLetter reports whether a path opens with a Windows drive specifier
// such as "C:". It is absolute on Windows and names nothing anywhere else, so
// it is refused wherever the server is running.
func hasDriveLetter(p string) bool {
	if len(p) < 2 || p[1] != ':' {
		return false
	}
	return (p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z')
}

// gitFileMeta is what one repository-wide pass establishes about a single file:
// what happened to it, where it came from if it arrived from somewhere, and its
// mode on each side of the change.
type gitFileMeta struct {
	Status  string
	OldPath string
	OldMode string
	NewMode string
}

// boundedOutput is what was read from a stream that may be larger than anything
// worth returning.
//
// Revision fingerprints every byte of the stream, including the ones past the
// ceiling that were dropped: a change is not a different change because the part
// that differs fell off the end, and an anchor that moved when nothing moved is
// worse than no anchor. Lines counts the whole stream for the same reason, so an
// untracked file can say how long it is without being held in memory.
type boundedOutput struct {
	Kept      []byte
	Lines     int
	Truncated bool
	Revision  string
}

// readBounded reads r to the end, keeping at most limit bytes of it and hashing
// all of it.
//
// What is kept ends at a line boundary whenever anything was dropped. Half a
// line parses as a real line holding half its text — a quieter wrong answer than
// a missing one — and cutting at a newline is also what keeps a multi-byte
// character whole, since no byte of one can be a newline.
func readBounded(ctx context.Context, r io.Reader, limit int) (boundedOutput, error) {
	var (
		out    boundedOutput
		kept   bytes.Buffer
		digest = sha256.New()
		buf    = make([]byte, 64*1024)
		total  int64
		last   byte
	)
	for {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		n, err := r.Read(buf)
		if chunk := buf[:n]; len(chunk) > 0 {
			digest.Write(chunk)
			out.Lines += bytes.Count(chunk, []byte{'\n'})
			last = chunk[len(chunk)-1]
			total += int64(len(chunk))
			if room := limit - kept.Len(); room > 0 {
				if room > len(chunk) {
					room = len(chunk)
				}
				kept.Write(chunk[:room])
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return out, err
		}
	}

	// A final line nobody terminated is still a line.
	if total > 0 && last != '\n' {
		out.Lines++
	}
	out.Revision = hex.EncodeToString(digest.Sum(nil))
	out.Kept = kept.Bytes()
	if total > int64(len(out.Kept)) {
		out.Truncated = true
		if i := bytes.LastIndexByte(out.Kept, '\n'); i >= 0 {
			out.Kept = out.Kept[:i+1]
		} else {
			out.Kept = nil
		}
	}
	return out, nil
}

// gitCommand builds one git invocation with the flags every read here carries.
// --no-optional-locks keeps a read from taking index.lock and contending with
// the user's own git client mid-operation, and core.quotePath=false stops git
// escaping non-ASCII paths into \303\251. diff.external is emptied for the same
// reason --no-ext-diff and --no-textconv are passed to the commands that accept
// them: reading a project is not consent to run commands its configuration
// names.
//
// --no-optional-locks is not on its own enough to keep a read from writing, and
// this is why every comparison against a tree here is asked of the plumbing
// diff-index rather than of diff. Porcelain diff refreshes the index and writes
// the refreshed stat information back whatever GIT_OPTIONAL_LOCKS says, so a
// user who only looked at a review would find their index rewritten underneath
// whatever their own git client was doing with it. diff-index answers the same
// question — the same records, byte for byte, given the rename and abbreviation
// options porcelain applies from configuration — and refreshes nothing.
func gitCommand(ctx context.Context, dir string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "git", append([]string{
		"--no-optional-locks", "-c", "core.quotePath=false", "-c", "diff.external=",
	}, args...)...)
	cmd.Dir = dir
	return cmd
}

// gitRead runs one git command and streams its output under a ceiling, so that
// nothing git can produce has to fit in memory first. Every failure is a
// failure: read as an empty diff, a command that could not run becomes the claim
// that a file did not change, which is the one thing this must never say wrongly.
// The budget is the caller's, because how long one command may take is a
// property of what is being served: a poll that wants an answer now, or a diff
// somebody is waiting to read.
func gitRead(ctx context.Context, dir string, budget time.Duration, limit int, args ...string) (boundedOutput, error) {
	cctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	cmd := gitCommand(cctx, dir, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return boundedOutput{}, err
	}
	if err := cmd.Start(); err != nil {
		return boundedOutput{}, err
	}

	out, readErr := readBounded(cctx, stdout, limit)
	// The output is read to the end even when it is past the ceiling, so git is
	// never left blocked on a pipe nobody is draining.
	_, _ = io.Copy(io.Discard, stdout)
	waitErr := cmd.Wait()

	switch {
	case cctx.Err() != nil:
		return boundedOutput{}, gitDeadlineError(ctx, cctx, budget)
	case readErr != nil:
		return boundedOutput{}, readErr
	case waitErr != nil:
		return boundedOutput{}, gitFailure(waitErr, stderr.String())
	}
	return out, nil
}

// gitDeadlineError says which clock ran out: the request's, meaning the caller
// is gone or the whole budget is spent, or this one command's.
func gitDeadlineError(ctx, cctx context.Context, budget time.Duration) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fmt.Errorf("git took longer than %s", budget)
}

// gitFailure names what git complained about, since "exit status 128" names
// nothing.
func gitFailure(err error, stderr string) error {
	if line, _, _ := strings.Cut(strings.TrimSpace(stderr), "\n"); line != "" {
		return errors.New(line)
	}
	return err
}

// gitDiffBase names what the working tree is compared against: HEAD, or — in a
// repository whose first commit has not been made — the empty tree, against
// which everything already staged reads as the addition it is. The empty tree's
// id is asked of git rather than written down here, because it is the hash of
// nothing under whichever algorithm the repository was created with.
func gitDiffBase(ctx context.Context, dir string, budget time.Duration) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	if err := gitCommand(cctx, dir, "rev-parse", "--verify", "-q", "HEAD").Run(); err == nil {
		return "HEAD", nil
	}
	if cctx.Err() != nil {
		return "", gitDeadlineError(ctx, cctx, budget)
	}

	out, err := gitRead(ctx, dir, budget, 1024, "hash-object", "-t", "tree", "--stdin")
	if err != nil {
		return "", err
	}
	empty := strings.TrimSpace(string(out.Kept))
	if empty == "" {
		return "", errors.New("this repository has no commits and no empty tree to compare against")
	}
	return empty, nil
}

// gitDiffMetadata reads one raw diff for the whole repository, keyed by each
// file's current path. Rename and copy detection compares every path that
// changed against every other, so it is asked for once, here, rather than being
// expected from a pathspec holding a single file.
//
// A metadata pass past its ceiling simply stops describing the files past the
// cut; their patches still carry their own headers, which is less than this
// knows but more than nothing.
func gitDiffMetadata(ctx context.Context, dir, base string) (map[string]gitFileMeta, error) {
	out, err := gitRead(ctx, dir, gitDiffPerCmd, gitDiffMaxMeta,
		"diff-index", "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies",
		"--raw", "--abbrev", "-z", base, "--")
	if err != nil {
		return nil, err
	}
	return parseGitRawDiff(out.Kept), nil
}

// parseGitRawDiff reads `git diff --raw -z`: a record of colon-prefixed fields,
// ":<oldMode> <newMode> <oldBlob> <newBlob> <status>", then the path it
// describes — or the old path and then the new one when a file was renamed or
// copied, which are the only statuses that name two.
func parseGitRawDiff(out []byte) map[string]gitFileMeta {
	meta := make(map[string]gitFileMeta)
	records := bytes.Split(out, []byte{0})

	for i := 0; i < len(records); i++ {
		record := string(records[i])
		if !strings.HasPrefix(record, ":") {
			continue
		}
		fields := strings.Fields(record[1:])
		if len(fields) < 5 {
			continue
		}
		letter := fields[4]
		file := gitFileMeta{
			OldMode: fields[0],
			NewMode: fields[1],
			Status:  gitRawStatus(letter),
		}

		paths := 1
		if letter[0] == 'R' || letter[0] == 'C' {
			paths = 2
		}
		if i+paths >= len(records) {
			break // a truncated pass can stop between a record and the path it is about
		}
		if paths == 2 {
			file.OldPath = string(records[i+1])
		}
		i += paths
		if path := string(records[i]); path != "" {
			meta[path] = file
		}
	}
	return meta
}

// gitRawStatus turns a raw diff's status letter into what happened to the file.
// An unmerged or unknown letter is left unnamed: the conflict check and the
// patch itself both say more about those than a letter does.
func gitRawStatus(letter string) string {
	switch letter[0] {
	case 'A':
		return "added"
	case 'D':
		return "deleted"
	case 'M':
		return "modified"
	case 'R':
		return "renamed"
	case 'C':
		return "copied"
	case 'T':
		return "typechange"
	default:
		return ""
	}
}

// gitFileConflicted reports whether the index holds unmerged stages for a path,
// which is where a conflict lives: the diff of a conflicted file against HEAD is
// an ordinary-looking patch whose added lines include the markers.
func gitFileConflicted(ctx context.Context, dir, fileRel string) bool {
	out, err := gitRead(ctx, dir, gitDiffPerCmd, 64*1024, "ls-files", "-u", "-z", "--", fileRel)
	return err == nil && len(out.Kept) > 0
}

// gitNumstatCounts asks git for one file's line tally, for when the patch was
// cut short and can no longer be counted from.
func gitNumstatCounts(ctx context.Context, dir, base string, paths []string) (gitDiffstat, bool) {
	args := append([]string{
		"diff-index", "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies",
		"--numstat", "-z", base, "--",
	}, paths...)
	out, err := gitRead(ctx, dir, gitDiffPerCmd, gitDiffMaxMeta, args...)
	if err != nil {
		return gitDiffstat{}, false
	}
	// A rename's record is keyed by the path the file now has, which is the path
	// the patch was asked for under.
	stat, ok := parseGitNumstat(out.Kept)[paths[0]]
	return stat, ok
}

// diffContextFrom reads the context width a request asked for.
//
// Anything it cannot use — absent, blank, not a whole number, negative for any
// reason other than meaning "all of it" — yields the shipped default rather than
// an error. The width decides how much of the file around a change is shown and
// nothing else, so refusing the request over it would cost the reader the patch
// they asked for on account of a query string they never typed. -1 means the
// whole file; anything larger than the ceiling is the whole file too, since at
// that point it is asking for more lines than the response may carry.
func diffContextFrom(raw string) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	switch {
	case err != nil:
		return gitDiffContext
	case n == -1 || n > gitDiffMaxContext:
		return gitDiffMaxContext
	case n < 0:
		return gitDiffContext
	default:
		return n
	}
}

// gitFilePatch runs the diff for one file and returns its patch text, empty when
// the file is unchanged or untracked. Both sides of a rename are passed as the
// pathspec so that git pairs them; --no-color keeps the output parseable.
func gitFilePatch(ctx context.Context, dir, base string, paths []string, unified int) (boundedOutput, error) {
	args := append([]string{
		"diff-index", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames",
		"--patch", "--unified=" + strconv.Itoa(unified), base, "--",
	}, paths...)
	return gitRead(ctx, dir, gitDiffPerCmd, gitDiffMaxBytes, args...)
}

// gitIsUntracked reports whether git has never been told about this path. A
// missing file is not untracked — it is nothing — so a path git does not know
// and disk does not hold is reported as tracked-and-unchanged, which is what an
// empty diff already said.
func gitIsUntracked(ctx context.Context, dir, fileRel string) (bool, error) {
	if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(fileRel))); err != nil {
		return false, nil
	}
	cmd := exec.CommandContext(ctx, "git", "--no-optional-locks",
		"ls-files", "--error-unmatch", "--", fileRel)
	cmd.Dir = dir
	if err := cmd.Run(); err != nil {
		return true, nil
	}
	return false, nil
}

// untrackedDiff fills resp with a file that is entirely new: one hunk holding
// every line, added. A binary file says so and shows nothing, exactly as git
// would have. The content is read the same way a patch is — under a ceiling,
// fingerprinted whole — because this is the one file git is not reading for us.
func untrackedDiff(ctx context.Context, abs string, resp *gitDiffResponse) {
	// Lstat rather than Stat: a symlink is a pointer, and the bytes on the other
	// end of it may be anywhere on disk. The link is never opened — what is shown
	// is the link's own content, which is the path it holds, and that is what git
	// would have stored for it.
	info, err := os.Lstat(abs)
	if err != nil {
		return
	}
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		untrackedSymlinkDiff(abs, resp)
		return
	case !info.Mode().IsRegular():
		// A socket, a device or a fifo has no content to show and no mode git has
		// a name for. It is reported as present and left at that.
		resp.Status = "untracked"
		return
	}

	f, err := os.Open(abs) //nolint:gosec // path is validated and symlinks are refused above
	if err != nil {
		return
	}
	defer f.Close() //nolint:errcheck // read-only

	out, err := readBounded(ctx, f, gitDiffMaxBytes)
	if err != nil {
		return
	}
	resp.Status = "untracked"
	resp.Revision = out.Revision

	sniff := out.Kept
	if len(sniff) > gitDiffSniff {
		sniff = sniff[:gitDiffSniff]
	}
	if bytes.IndexByte(sniff, 0) >= 0 {
		resp.Binary = true
		return
	}
	if out.Truncated {
		resp.Truncated = true
	}
	// The count is every line the file adds, not every line shown: a truncated
	// response still tells the truth about the size of the change.
	resp.Added = out.Lines

	text := strings.TrimSuffix(string(out.Kept), "\n")
	if text == "" && len(out.Kept) == 0 {
		return
	}
	lines := strings.Split(text, "\n")
	hunk := gitDiffHunk{NewStart: 1, NewLines: len(lines), Lines: make([]gitDiffLine, 0, min(len(lines), gitDiffMaxLines))}
	for i, line := range lines {
		if len(hunk.Lines) >= gitDiffMaxLines {
			resp.Truncated = true
			break
		}
		hunk.Lines = append(hunk.Lines, gitDiffLine{Kind: "add", New: i + 1, Text: strings.TrimSuffix(line, "\r")})
	}
	resp.Hunks = append(resp.Hunks, hunk)
}

// untrackedSymlinkDiff fills resp with a link that git has not been told about:
// one added line holding the path the link names, and the mode that says the
// line is a link and not the first line of a file.
//
// A link's content is its text, so it is read with Readlink and never opened.
// The path it names may be anywhere, including outside the project — that is a
// fact about the link, which is worth showing, and not permission to read what
// is at the end of it.
func untrackedSymlinkDiff(abs string, resp *gitDiffResponse) {
	target, err := os.Readlink(abs)
	if err != nil {
		return
	}
	digest := sha256.Sum256([]byte(target))

	resp.Status = "untracked"
	resp.NewMode = gitSymlinkMode
	resp.Revision = hex.EncodeToString(digest[:])
	resp.Added = 1
	resp.Hunks = append(resp.Hunks, gitDiffHunk{
		NewStart: 1,
		NewLines: 1,
		Lines:    []gitDiffLine{{Kind: "add", New: 1, Text: target}},
	})
}

// parseGitPatch reads a unified patch for a single file into resp.
//
// The header block before the first `@@` says what happened to the file; the
// hunks say what happened inside it. A line git wrote in a shape this does not
// understand is skipped rather than failing the diff, on the same grounds as the
// status parser: a diff missing one line is worth more than no diff.
func parseGitPatch(patch []byte, resp *gitDiffResponse) {
	resp.Status = "modified"

	var hunk *gitDiffHunk
	oldLine, newLine := 0, 0
	emitted := 0

	// add records one parsed line, keeping it only while the response is still
	// under its ceiling — which is a ceiling on the whole diff and not on each
	// hunk, or a file of ten thousand small hunks would never meet it. Counting
	// carries on past the ceiling, so Added and Removed describe the whole change
	// even once the lines shown stop doing so.
	add := func(l gitDiffLine) {
		if emitted >= gitDiffMaxLines {
			resp.Truncated = true
			return
		}
		hunk.Lines = append(hunk.Lines, l)
		emitted++
	}

	sc := bufio.NewScanner(bytes.NewReader(patch))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()

		if strings.HasPrefix(line, "@@") {
			if hunk != nil {
				resp.Hunks = append(resp.Hunks, *hunk)
			}
			next, ok := parseHunkHeader(line)
			if !ok {
				hunk = nil
				continue
			}
			hunk = &next
			oldLine, newLine = next.OldStart, next.NewStart
			continue
		}

		if hunk == nil {
			parseGitPatchHeader(line, resp)
			continue
		}

		// "\ No newline at end of file" annotates the line above rather than
		// being one, and the trailing "--" of a mail-formatted patch is not a
		// removal. Neither belongs in the hunk.
		if strings.HasPrefix(line, `\`) {
			continue
		}
		switch {
		case strings.HasPrefix(line, "+"):
			add(gitDiffLine{Kind: "add", New: newLine, Text: line[1:]})
			newLine++
			resp.Added++
		case strings.HasPrefix(line, "-"):
			add(gitDiffLine{Kind: "remove", Old: oldLine, Text: line[1:]})
			oldLine++
			resp.Removed++
		case strings.HasPrefix(line, " ") || line == "":
			// An all-whitespace context line reaches us stripped of its single
			// leading space by whatever wrote the patch; an empty one is an empty
			// context line, not a hunk boundary.
			text := ""
			if line != "" {
				text = line[1:]
			}
			add(gitDiffLine{Kind: "context", Old: oldLine, New: newLine, Text: text})
			oldLine++
			newLine++
		default:
			// A header for the next file in a multi-file patch — which this is
			// not asked for — ends the hunk rather than joining it.
			resp.Hunks = append(resp.Hunks, *hunk)
			hunk = nil
			parseGitPatchHeader(line, resp)
		}
	}
	// A scan that stopped early — a line longer than the buffer is the way it
	// happens — leaves the rest of the patch unread. Unsaid, that reaches the
	// reader as a whole diff of a file with fewer hunks than it really has.
	if sc.Err() != nil {
		resp.Truncated = true
	}
	if hunk != nil {
		resp.Hunks = append(resp.Hunks, *hunk)
	}
}

// parseGitPatchHeader applies one line of a patch's header block to resp.
func parseGitPatchHeader(line string, resp *gitDiffResponse) {
	switch {
	case strings.HasPrefix(line, "new file mode"):
		resp.Status = "added"
	case strings.HasPrefix(line, "deleted file mode"):
		resp.Status = "deleted"
	case strings.HasPrefix(line, "rename from "):
		resp.Status = "renamed"
		resp.OldPath = strings.TrimPrefix(line, "rename from ")
	case strings.HasPrefix(line, "Binary files ") || strings.HasPrefix(line, "GIT binary patch"):
		resp.Binary = true
	}
}

// parseHunkHeader reads `@@ -oldStart,oldLines +newStart,newLines @@ heading`.
// A one-line range omits its count, which is what the missing comma means.
func parseHunkHeader(line string) (gitDiffHunk, bool) {
	body := strings.TrimPrefix(line, "@@")
	ranges, heading, found := strings.Cut(body, "@@")
	if !found {
		return gitDiffHunk{}, false
	}

	var hunk gitDiffHunk
	seen := 0
	for _, field := range strings.Fields(ranges) {
		start, count, ok := parseHunkRange(field)
		if !ok {
			continue
		}
		if strings.HasPrefix(field, "-") {
			hunk.OldStart, hunk.OldLines = start, count
		} else {
			hunk.NewStart, hunk.NewLines = start, count
		}
		seen++
	}
	if seen != 2 {
		return gitDiffHunk{}, false
	}

	hunk.Heading = strings.TrimSpace(heading)
	hunk.Lines = []gitDiffLine{}
	return hunk, true
}

// parseHunkRange reads one "-58,6" or "+60" side of a hunk header.
func parseHunkRange(field string) (int, int, bool) {
	if len(field) < 2 || (field[0] != '-' && field[0] != '+') {
		return 0, 0, false
	}
	startText, countText, hasCount := strings.Cut(field[1:], ",")
	start, err := strconv.Atoi(startText)
	if err != nil {
		return 0, 0, false
	}
	count := 1
	if hasCount {
		count, err = strconv.Atoi(countText)
		if err != nil {
			return 0, 0, false
		}
	}
	return start, count, true
}
