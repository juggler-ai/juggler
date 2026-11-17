//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"bytes"
	"context"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"juggler/cmd/juggler/gitview/internal/clocks"
)

// Changes is one repository's working tree as the git client's Changes place
// shows it: every changed file, each with what is staged and what is not, and
// what a commit box needs to know about HEAD.
//
// Unlike the status card it lists every file — the place's list is
// virtualized — and counts each side of a file separately, because a file
// staged and then edited again is two changes the user acts on one at a time.
type Changes struct {
	Repo      string        `json:"repo"`
	Branch    string        `json:"branch"`
	Upstream  string        `json:"upstream"`
	Ahead     int           `json:"ahead"`
	Behind    int           `json:"behind"`
	Detached  bool          `json:"detached"`
	Initial   bool          `json:"initial"`
	Head      *HeadCommit   `json:"head,omitempty"`
	WrapsBody bool          `json:"wrapsBody"`
	Operation string        `json:"operation,omitempty"`
	Stopped   *Stopped      `json:"stopped,omitempty"` // the operation in progress in full; nil when Operation is ""
	Remotes   int           `json:"remotes"`           // how many remotes it has: fetching, pulling and pushing need one
	Files     []ChangedFile `json:"files"`
	Truncated bool          `json:"truncated"`
}

// HeadCommit is the commit HEAD names: what an amend starts from, and whether
// it is still the user's alone to undo.
type HeadCommit struct {
	Sha     string `json:"sha"`
	Message string `json:"message"`
	Pushed  bool   `json:"pushed"`
}

// Stat is one side of one file's change in lines.
type Stat struct {
	Added   int `json:"added"`
	Removed int `json:"removed"`
}

// ChangedFile is one changed file. Index and Worktree are porcelain letters
// ("." for an unchanged side, "?" for untracked). Staged is the index against
// HEAD and Unstaged the working tree against the index, each absent when that
// side has no change with lines in it — a binary file never has one.
type ChangedFile struct {
	Path       string `json:"path"`
	OldPath    string `json:"oldPath,omitempty"`
	Index      string `json:"index"`
	Worktree   string `json:"worktree"`
	Conflicted bool   `json:"conflicted,omitempty"`
	Submodule  bool   `json:"submodule,omitempty"`
	Binary     bool   `json:"binary,omitempty"`
	LFS        bool   `json:"lfs,omitempty"`
	Staged     *Stat  `json:"staged,omitempty"`
	Unstaged   *Stat  `json:"unstaged,omitempty"`
}

// wrapColumn is where a commit body is wrapped, and wrapEvidence how long a
// line of prose must be before it says the repository does not wrap.
const (
	wrapColumn   = 72
	wrapEvidence = 80
	wrapSample   = 20 // recent commits whose bodies are read for it
)

// ReadChanges reads one repository under root, named as the API names it.
func ReadChanges(ctx context.Context, root, repo string) (Changes, error) {
	ctx, cancel := context.WithTimeout(ctx, clocks.Review.Budget)
	defer cancel()
	dir, err := ResolveRepo(ctx, root, repo)
	if err != nil {
		return Changes{}, err
	}
	perCmd := clocks.Review.PerCmd

	status, err := repoStatus(ctx, dir, repoStatusOptions{maxFiles: math.MaxInt, perCmd: perCmd, allUntracked: true})
	if err != nil {
		return Changes{}, err
	}
	c := Changes{
		Repo: RepoPath(root, dir), Branch: status.Branch, Upstream: status.Upstream,
		Ahead: status.Ahead, Behind: status.Behind, Detached: status.Detached,
		Initial: status.Initial, Truncated: status.Truncated, Files: make([]ChangedFile, 0, len(status.Files)),
	}
	for _, f := range status.Files {
		c.Files = append(c.Files, ChangedFile{
			Path: f.Path, OldPath: f.OldPath, Index: f.Index, Worktree: f.Worktree,
			Conflicted: f.Conflicted, Submodule: f.Submodule,
		})
	}

	if err := changesStats(ctx, dir, perCmd, &c); err != nil {
		return Changes{}, err
	}
	if err := changesLFS(ctx, dir, perCmd, &c); err != nil {
		return Changes{}, err
	}
	if !c.Initial {
		if c.Head, err = headCommit(ctx, dir, perCmd); err != nil {
			return Changes{}, err
		}
	}
	if c.WrapsBody, err = wrapsBody(ctx, dir, perCmd, c.Initial); err != nil {
		return Changes{}, err
	}
	gitDir, _, err := GitDirs(ctx, dir)
	if err != nil {
		return Changes{}, err
	}
	c.Operation = OperationIn(gitDir)
	if c.Operation != "" {
		c.Stopped = readStopped(ctx, dir, gitDir, c.Operation, c.Branch, perCmd)
	}
	remotes, err := gitRead(ctx, dir, perCmd, 64*1024, "remote")
	if err != nil {
		return Changes{}, err
	}
	c.Remotes = len(strings.Fields(string(remotes.Kept)))
	return c, nil
}

// changesStats counts each side of every file: the index against HEAD (or the
// empty tree before the first commit) and the working tree against the index.
// A file git reports as binary on either side is marked so and counted on
// neither.
func changesStats(ctx context.Context, dir string, perCmd time.Duration, c *Changes) error {
	base, err := gitDiffBase(ctx, dir, perCmd)
	if err != nil {
		return err
	}
	staged, err := gitRead(ctx, dir, perCmd, gitDiffMaxMeta,
		"diff-index", "--cached", "--no-ext-diff", "--no-textconv", "--find-renames", "--numstat", "-z", base, "--")
	if err != nil {
		return err
	}
	unstaged, err := gitRead(ctx, dir, perCmd, gitDiffMaxMeta,
		"diff-files", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--")
	if err != nil {
		return err
	}
	stagedStats, stagedBinary := parseNumstatSides(staged.Kept)
	unstagedStats, unstagedBinary := parseNumstatSides(unstaged.Kept)
	for i := range c.Files {
		f := &c.Files[i]
		f.Binary = stagedBinary[f.Path] || unstagedBinary[f.Path]
		if s, ok := stagedStats[f.Path]; ok && f.Index != "." {
			f.Staged = &s
		}
		if s, ok := unstagedStats[f.Path]; ok && f.Worktree != "." && f.Worktree != "?" {
			f.Unstaged = &s
		}
	}
	return nil
}

// parseNumstatSides reads `--numstat -z` into line counts and the set of files
// git called binary ("-" for both counts).
func parseNumstatSides(out []byte) (map[string]Stat, map[string]bool) {
	stats := map[string]Stat{}
	binary := map[string]bool{}
	records := bytes.Split(out, []byte{0})
	for i := 0; i < len(records); i++ {
		fields := strings.SplitN(string(records[i]), "\t", 3)
		if len(fields) != 3 {
			continue
		}
		path := fields[2]
		if path == "" {
			// A rename: the old name is the next record and the new the one after.
			if i+2 >= len(records) {
				continue
			}
			i += 2
			path = string(records[i])
		}
		if fields[0] == "-" && fields[1] == "-" {
			binary[path] = true
			continue
		}
		added, aerr := strconv.Atoi(fields[0])
		removed, rerr := strconv.Atoi(fields[1])
		if aerr == nil && rerr == nil {
			stats[path] = Stat{Added: added, Removed: removed}
		}
	}
	return stats, binary
}

// changesLFS marks the files git hands to the LFS filter, asked of git's
// attributes for every listed file in one command.
func changesLFS(ctx context.Context, dir string, perCmd time.Duration, c *Changes) error {
	if len(c.Files) == 0 {
		return nil
	}
	var stdin bytes.Buffer
	for _, f := range c.Files {
		stdin.WriteString(f.Path)
		stdin.WriteByte(0)
	}
	cctx, cancel := context.WithTimeout(ctx, perCmd)
	defer cancel()
	cmd := gitCommand(cctx, dir, "check-attr", "-z", "--stdin", "filter")
	cmd.Stdin = &stdin
	out, err := cmd.Output()
	if err != nil {
		if cctx.Err() != nil {
			return gitDeadlineError(ctx, cctx, perCmd)
		}
		return err
	}
	lfs := map[string]bool{}
	fields := bytes.Split(out, []byte{0})
	for i := 0; i+2 < len(fields); i += 3 {
		if string(fields[i+2]) == "lfs" {
			lfs[string(fields[i])] = true
		}
	}
	for i := range c.Files {
		c.Files[i].LFS = lfs[c.Files[i].Path]
	}
	return nil
}

// headCommit reads HEAD's id and whole message, and whether any
// remote-tracking branch already has it.
func headCommit(ctx context.Context, dir string, perCmd time.Duration) (*HeadCommit, error) {
	out, err := gitRead(ctx, dir, perCmd, 1<<20, "log", "-1", "--format=%H%x00%B", "HEAD", "--")
	if err != nil {
		return nil, err
	}
	sha, message, _ := strings.Cut(string(out.Kept), "\x00")
	head := &HeadCommit{Sha: sha, Message: strings.TrimSuffix(message, "\n")}
	remotes, err := gitRead(ctx, dir, perCmd, 64*1024, "for-each-ref", "--count=1", "--contains", sha, "--format=%(refname)", "refs/remotes")
	if err != nil {
		return nil, err
	}
	head.Pushed = strings.TrimSpace(string(remotes.Kept)) != ""
	return head, nil
}

// wrapsBody reads whether the repository's recent commits wrap their bodies:
// true unless a body holds a line of prose — words, not a URL, a trailer or
// indented code — longer than wrapEvidence, which only an unwrapped paragraph
// has. A repository with no bodies to go on is assumed to wrap, as git's own
// convention does.
func wrapsBody(ctx context.Context, dir string, perCmd time.Duration, initial bool) (bool, error) {
	if initial {
		return true, nil
	}
	out, err := gitRead(ctx, dir, perCmd, 4<<20, "log", "-"+strconv.Itoa(wrapSample), "--format=%b%x00", "HEAD", "--")
	if err != nil {
		return false, err
	}
	for _, body := range bytes.Split(out.Kept, []byte{0}) {
		for _, line := range strings.Split(string(body), "\n") {
			if isProse(line) && utf8.RuneCountInString(line) > wrapEvidence {
				return false, nil
			}
		}
	}
	return true, nil
}

// isProse reports whether a body line is running text a wrap would apply to.
func isProse(line string) bool {
	if line == "" || line[0] == ' ' || line[0] == '\t' {
		return false
	}
	if strings.Contains(line, "://") || !strings.Contains(line, " ") {
		return false
	}
	return true
}
