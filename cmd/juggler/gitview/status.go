//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package gitview reads the git state of a directory tree on this machine: every
// repository under it, the root one and any nested inside it, as the three views
// the app shows of a working tree — the status card's counts (Status), the
// review's complete file manifest (Review) and one file's diff (Diff).
//
// It knows nothing of projects, workspaces or HTTP. It is handed a root it may
// read, runs git there and nowhere above it, and answers in the shapes the API
// sends on unchanged. Everything it does is a read (see gitCommand for what that
// takes).
package gitview

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The card's bounds. Its walk is deliberately shallow — a git repo lives at the
// top of its tree, so scanning a few levels catches the root repo and its direct
// submodules without risking a long recursive crawl of a deep source tree. What
// that misses is what an explicit review is for; a card polled every twenty
// seconds settles for the cheap answer.
const (
	gitScanMaxDepth  = 4   // directory levels below the project root to descend
	gitScanMaxRepos  = 32  // stop discovering after this many repos
	gitStatusMaxFile = 200 // per repo, the most files listed individually
)

// The card's clocks are the shortest of the three surfaces, which is right for a
// number in the corner of a window and is why they are the first to run out
// anywhere else. Var rather than const for the same reason the diff's and the
// review's are: a test asking what the card counted is not asking how quickly
// this machine's git could count it.
var (
	gitStatusPerCmd = 3 * time.Second
	gitStatusBudget = 6 * time.Second
)

// gitFileStatus is one file in a repository's working tree. Index and Worktree
// are porcelain status letters — "M", "A", "D", "?" and so on — where "." means
// that side is unmodified.
type gitFileStatus struct {
	Path       string `json:"path"`
	OldPath    string `json:"oldPath,omitempty"`
	Index      string `json:"index"`
	Worktree   string `json:"worktree"`
	Conflicted bool   `json:"conflicted,omitempty"`
	Added      *int   `json:"added,omitempty"`
	Removed    *int   `json:"removed,omitempty"`
}

// gitDiffstat is the numeric part of one `git diff --numstat` record. Binary
// files have no numeric record and therefore never masquerade as +0/-0.
type gitDiffstat struct {
	Added   int
	Removed int
}

// RepoStatus is one repository's summary. Path is relative to the project
// root ("" for the root repo itself), always forward-slashed. Files is bounded
// by whatever ceiling its caller asked for; Truncated says the tree holds more
// than the list shows and Total says how many. Changed, Staged and Total count
// the whole tree either way.
type RepoStatus struct {
	Path       string          `json:"path"`
	Changed    int             `json:"changed"` // files with working-tree changes (incl. untracked)
	Staged     int             `json:"staged"`  // files with staged (index) changes
	Conflicted int             `json:"conflicted"`
	Total      int             `json:"total"` // files git reported, listed or not
	Added      int             `json:"added"`
	Removed    int             `json:"removed"`
	Branch     string          `json:"branch"` // "" on a detached head or an unreadable ref
	Upstream   string          `json:"upstream"`
	Head       string          `json:"head"`
	Initial    bool            `json:"initial"`
	Ahead      int             `json:"ahead"`
	Behind     int             `json:"behind"`
	Stashes    int             `json:"stashes"`
	Detached   bool            `json:"detached"`
	Files      []gitFileStatus `json:"files"`
	Truncated  bool            `json:"truncated"`
}

// Status discovers the repositories under root and reports each one's branch,
// divergence from its upstream, changed/staged counts and bounded file list —
// the status card's answer. It is best-effort: a repo whose `git status` fails
// (git missing, bare repo) is simply omitted rather than failing the whole
// answer, which is why it has no error to return.
func Status(ctx context.Context, root string) []RepoStatus {
	ctx, cancel := context.WithTimeout(ctx, gitStatusBudget)
	defer cancel()

	repos := []RepoStatus{}
	for _, dir := range discoverRepos(ctx, root) {
		status, err := repoStatus(ctx, dir, repoStatusOptions{maxFiles: gitStatusMaxFile, perCmd: gitStatusPerCmd})
		if err != nil {
			continue // best-effort: a repo git cannot report is left off the card
		}
		// Line counts are a nicety on a card and the whole point of a review, so
		// this is the one caller that can shrug at losing them.
		_ = repoDiffstats(ctx, dir, gitStatusPerCmd, &status)
		status.Path = repoRelativePath(root, dir)
		repos = append(repos, status)
	}

	// Root repo first, then nested repos alphabetically — stable ordering so the
	// card doesn't reshuffle between polls.
	sort.SliceStable(repos, func(i, j int) bool {
		return repos[i].Path < repos[j].Path
	})
	return repos
}

// LendClocks replaces every git clock — the card's, the review's and the
// diff's — with perCmd for one command and budget for a whole request, and
// returns the func that puts the shipped values back. It is for tests: one
// asking what git reports over a fixture of a handful of files is not asking how
// fast a loaded machine runs git, and the shipped seconds would make it measure
// the second. Not safe to call while a read is in flight.
func LendClocks(perCmd, budget time.Duration) (restore func()) {
	statusPerCmd, statusBudget := gitStatusPerCmd, gitStatusBudget
	reviewPerCmd, reviewBudget := gitReviewPerCmd, gitReviewBudget
	diffPerCmd, diffBudget := gitDiffPerCmd, gitDiffBudget
	gitStatusPerCmd, gitStatusBudget = perCmd, budget
	gitReviewPerCmd, gitReviewBudget = perCmd, budget
	gitDiffPerCmd, gitDiffBudget = perCmd, budget
	return func() {
		gitStatusPerCmd, gitStatusBudget = statusPerCmd, statusBudget
		gitReviewPerCmd, gitReviewBudget = reviewPerCmd, reviewBudget
		gitDiffPerCmd, gitDiffBudget = diffPerCmd, diffBudget
	}
}

// repoScanLimits bounds a search for repositories. The status card runs one on
// every poll and wants it cheap; an explicit review runs one when asked and
// wants it complete, settling for saying where it stopped.
type repoScanLimits struct {
	maxRepos int  // repositories named before the search gives up
	maxDirs  int  // directories visited before it gives up; 0 for no limit
	maxDepth int  // levels below the root it descends; 0 for no limit
	prune    bool // skip directories that are expensive to walk and rarely repositories
}

// repoScan is what one search found, and each way it fell short of the whole
// tree — in the words the user reads, since a reader is what an incomplete
// answer needs. Cut being empty is the only thing that makes Repos the whole
// list, so the two travel together.
type repoScan struct {
	Repos []string
	Cut   []string
}

// cut records a way the search fell short, once. A ceiling met a thousand times
// is one fact about the search and not a thousand of them.
func (s *repoScan) cut(reason string) {
	for _, existing := range s.Cut {
		if existing == reason {
			return
		}
	}
	s.Cut = append(s.Cut, reason)
}

// scanRepos walks the project tree and returns the absolute path of every
// directory holding a `.git` entry. `.git` is a directory in a normal repo and a
// file in a submodule or linked worktree, so both are recognised. The walk
// aborts promptly if ctx is cancelled (e.g. the client disconnected).
//
// Juggler's own state and git's internals are never walked into whatever the
// limits say: neither holds a repository anybody opened this project to read.
func scanRepos(ctx context.Context, root string, limits repoScanLimits) repoScan {
	scan := repoScan{Repos: []string{}}
	sep := string(filepath.Separator)
	dirs := 0

	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entry — skip it, keep walking
		}
		if ctx.Err() != nil {
			scan.cut("The search for repositories ran out of time")
			return filepath.SkipAll
		}
		if len(scan.Repos) >= limits.maxRepos {
			scan.cut(fmt.Sprintf("Stopped after finding %d repositories", limits.maxRepos))
			return filepath.SkipAll
		}

		if !d.IsDir() {
			// A `.git` file marks a submodule or linked-worktree repo root.
			if d.Name() == ".git" {
				scan.Repos = append(scan.Repos, filepath.Dir(p))
			}
			return nil
		}

		name := d.Name()
		if name == ".git" {
			scan.Repos = append(scan.Repos, filepath.Dir(p))
			return fs.SkipDir // never descend into git internals
		}
		if p == root {
			return nil // always scan the root itself
		}
		if name == ".juggler" {
			return fs.SkipDir
		}

		dirs++
		if limits.maxDirs > 0 && dirs > limits.maxDirs {
			scan.cut(fmt.Sprintf("Stopped after searching %d directories", limits.maxDirs))
			return filepath.SkipAll
		}
		if limits.prune {
			// Large, slow, and almost never a repository the project was opened to
			// review — but "almost never" is why only the cheap search skips them.
			switch name {
			case "node_modules", "vendor", "dist", "build":
				return fs.SkipDir
			}
		}
		if limits.maxDepth > 0 {
			if rel, rerr := filepath.Rel(root, p); rerr == nil {
				if strings.Count(rel, sep)+1 >= limits.maxDepth {
					return fs.SkipDir
				}
			}
		}
		return nil
	})

	return scan
}

// discoverRepos is the cheap search: shallow, capped and pruned of the
// directories that cost the most to walk. It is what the card polls with, and
// what a diff asks first.
func discoverRepos(ctx context.Context, root string) []string {
	return scanRepos(ctx, root, repoScanLimits{
		maxRepos: gitScanMaxRepos,
		maxDepth: gitScanMaxDepth,
		prune:    true,
	}).Repos
}

// repoRelativePath names a repository the way a client asks for it: relative to
// the project root, forward-slashed, and "" for the root repository itself.
func repoRelativePath(root, dir string) string {
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == "." {
		return ""
	}
	return filepath.ToSlash(rel)
}

// repoStatusOptions is how much of a repository's state the caller is asking
// for. The card wants a summary; a review wants the files themselves.
type repoStatusOptions struct {
	maxFiles int // files listed one by one before the list is cut

	// perCmd is one git command's clock, and every caller has to name one: the
	// same read is worth waiting different lengths of time for, so there is no
	// default here that would be right for both a card polled every twenty
	// seconds, which would rather be wrong than slow, and a review the user is
	// sitting in front of, which would rather be slow than wrong. Leaving it
	// unset is a budget of nothing, and reads that fail immediately.
	perCmd time.Duration

	// allUntracked names every untracked file instead of letting git collapse a
	// whole new directory into a single entry. It costs a full walk of every
	// untracked directory, and it is the difference between "somebody added
	// src/generated/" and a list of what is in it.
	allUntracked bool
}

// repoStatus runs git in dir and summarises the working tree. The error carries
// git's own complaint, because a caller that reports a repository it could not
// read has to say why. Path is left for the caller to fill in.
func repoStatus(ctx context.Context, dir string, opts repoStatusOptions) (RepoStatus, error) {
	// Porcelain v2 with --branch reports the branch, its upstream, ahead/behind
	// and per-file detail in one invocation. --show-stash adds the stash count to
	// that same header block.
	args := []string{"status", "--porcelain=v2", "--branch", "--show-stash"}
	if opts.allUntracked {
		args = append(args, "--untracked-files=all")
	}
	out, err := gitRead(ctx, dir, opts.perCmd, gitDiffMaxMeta, args...)
	if err != nil {
		return RepoStatus{}, err
	}

	status := parseGitStatusV2(out.Kept)
	if opts.allUntracked {
		dropDirectoryEntries(&status)
	}
	// Status past the ceiling was never read, so nothing downstream can count it
	// either: the summary is short by an unknown amount and says so.
	if out.Truncated {
		status.Truncated = true
	}
	truncateGitFiles(&status, opts.maxFiles)
	return status, nil
}

// dropDirectoryEntries removes entries that name a directory rather than a file.
//
// Once git has been asked for every untracked file by name, the only thing it
// still reports as a directory is a repository it will not walk into — a nested
// checkout or a submodule. That repository is reviewed in its own right, so
// leaving the entry here lists the same tree twice, the second time under a path
// with no diff to show for it.
func dropDirectoryEntries(status *RepoStatus) {
	kept := status.Files[:0]
	for _, file := range status.Files {
		if file.Worktree == "?" && strings.HasSuffix(file.Path, "/") {
			status.Total--
			status.Changed--
			continue
		}
		kept = append(kept, file)
	}
	status.Files = kept
}

// repoDiffstats attaches line counts to a repository's files and totals them.
//
// One combined diff against the baseline answers what the checked-out files
// amount to, rather than separately reporting the index and worktree versions of
// a file — the same comparison a single file's diff is taken from, so a count
// here and a patch there can never disagree. Untracked and binary files have no
// honest line count and simply carry none.
func repoDiffstats(ctx context.Context, dir string, perCmd time.Duration, status *RepoStatus) error {
	base, err := gitDiffBase(ctx, dir, perCmd)
	if err != nil {
		return err
	}
	out, err := gitRead(ctx, dir, perCmd, gitDiffMaxMeta,
		"diff-index", "--no-ext-diff", "--no-textconv", "--find-renames",
		"--numstat", "-z", base, "--")
	if err != nil {
		return err
	}
	applyGitDiffstats(status, parseGitNumstat(out.Kept))
	return nil
}

// truncateGitFiles bounds the files a summary lists one by one. The counts are
// left alone: "200 of 4000 files" is a useful thing to be able to say, and it
// needs the 4000. A ceiling of zero lists none of them, which is what is left
// for a repository reached after a shared budget was spent.
func truncateGitFiles(status *RepoStatus, maxFiles int) {
	if len(status.Files) <= maxFiles {
		return
	}
	if maxFiles < 0 {
		maxFiles = 0
	}
	status.Files = status.Files[:maxFiles]
	status.Truncated = true
}

// parseGitStatusV2 reads `git status --porcelain=v2 --branch` output.
//
// Header lines carry the branch and its divergence. Entry lines are keyed by
// their first field: "1" ordinary changes, "2" renames/copies, "u" unmerged, "?"
// untracked. Each carries an XY status pair where X is the index state, Y the
// working-tree state, and "." means that side is unmodified — so the counts are
// the v1 counts, spelled with "." where v1 spelled a space.
//
// A line git did not write in a shape this understands is skipped rather than
// failing the repo: a summary that omits one file is worth more than no summary.
func parseGitStatusV2(out []byte) RepoStatus {
	status := RepoStatus{Files: []gitFileStatus{}}

	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "# ") {
			parseGitBranchHeader(line[2:], &status)
			continue
		}

		kind, rest, found := strings.Cut(line, " ")
		if !found {
			continue
		}

		var index, worktree, path, oldPath string
		switch kind {
		case "?":
			// Untracked. v1 wrote "??": unmodified in the index, present in the
			// working tree, which is why it counts as changed and not as staged.
			index, worktree, path = ".", "?", rest
		case "1", "2", "u":
			xy, tail, ok := strings.Cut(rest, " ")
			if !ok || len(xy) != 2 {
				continue
			}
			index, worktree = string(xy[0]), string(xy[1])
			path, oldPath = gitEntryPaths(kind, tail)
		default:
			continue
		}
		if path == "" {
			continue
		}

		status.Total++
		if kind == "u" {
			status.Conflicted++
		}
		if index != "." {
			status.Staged++
		}
		if worktree != "." {
			status.Changed++
		}
		status.Files = append(status.Files, gitFileStatus{
			Path:       unquoteGitPath(path),
			OldPath:    unquoteGitPath(oldPath),
			Index:      index,
			Worktree:   worktree,
			Conflicted: kind == "u",
		})
	}

	return status
}

// parseGitBranchHeader applies one "# branch.*" header to status. Anything else
// git puts in the header block is ignored.
func parseGitBranchHeader(header string, status *RepoStatus) {
	key, value, ok := strings.Cut(header, " ")
	if !ok {
		return
	}
	switch key {
	case "branch.oid":
		if value == "(initial)" {
			status.Initial = true
			return
		}
		status.Head = value
	case "branch.head":
		// A detached head is reported as the literal "(detached)", which is a
		// state rather than a name — so say so, and leave the name empty.
		if value == "(detached)" {
			status.Detached = true
			return
		}
		status.Branch = value
	case "branch.upstream":
		status.Upstream = value
	case "branch.ab":
		ahead, behind, cut := strings.Cut(value, " ")
		if !cut {
			return
		}
		status.Ahead = gitCount(ahead)
		status.Behind = gitCount(behind)
	case "stash":
		status.Stashes, _ = strconv.Atoi(value)
	}
}

// gitEntryPaths pulls the current and former paths out of an entry line's tail.
// A rename or copy ("2") ends with the new path, a tab, then the old one;
// everything else ends with the current path alone. The fixed-width fields
// before it hold no spaces, so the path is what follows the last one.
func gitEntryPaths(kind, tail string) (string, string) {
	fields := 6 // 1: <sub> <mH> <mI> <mW> <hH> <hI>
	switch kind {
	case "2":
		fields = 7 // plus <X><score>
	case "u":
		fields = 8 // <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3>
	}
	for i := 0; i < fields; i++ {
		_, rest, ok := strings.Cut(tail, " ")
		if !ok {
			return "", ""
		}
		tail = rest
	}
	if kind == "2" {
		path, oldPath, _ := strings.Cut(tail, "\t")
		return path, oldPath
	}
	return tail, ""
}

// parseGitNumstat reads the NUL-delimited form of `git diff --numstat -z`.
// Rename records put an empty path after the two counts, followed by old and new
// path records. A binary file writes "-" for both counts and has no line stat.
func parseGitNumstat(out []byte) map[string]gitDiffstat {
	stats := make(map[string]gitDiffstat)
	records := bytes.Split(out, []byte{0})
	for i := 0; i < len(records); i++ {
		record := string(records[i])
		if record == "" {
			continue
		}
		fields := strings.SplitN(record, "\t", 3)
		if len(fields) != 3 {
			continue
		}
		added, addErr := strconv.Atoi(fields[0])
		removed, removeErr := strconv.Atoi(fields[1])
		if addErr != nil || removeErr != nil {
			continue
		}
		path := fields[2]
		if path == "" {
			// The old name is the next record and the current name the one after.
			if i+2 >= len(records) {
				continue
			}
			i += 2
			path = string(records[i])
		}
		if path != "" {
			stats[path] = gitDiffstat{Added: added, Removed: removed}
		}
	}
	return stats
}

// applyGitDiffstats attaches known line counts to listed files and totals them
// for the repository. Files omitted by the status bound still count in the
// repository total; untracked and binary files remain unknown rather than zero.
func applyGitDiffstats(status *RepoStatus, stats map[string]gitDiffstat) {
	for _, stat := range stats {
		status.Added += stat.Added
		status.Removed += stat.Removed
	}
	for i := range status.Files {
		stat, ok := stats[status.Files[i].Path]
		if !ok {
			continue
		}
		added, removed := stat.Added, stat.Removed
		status.Files[i].Added = &added
		status.Files[i].Removed = &removed
	}
}

// gitCount reads a signed "+3"/"-0" divergence count as a plain magnitude.
func gitCount(field string) int {
	n, err := strconv.Atoi(strings.TrimPrefix(field, "+"))
	if err != nil {
		return 0
	}
	if n < 0 {
		return -n
	}
	return n
}

// unquoteGitPath undoes the C-style quoting git falls back to for a path holding
// a quote, a newline or a control character. core.quotePath=false covers the
// common case of non-ASCII names; this covers the rest, and returns the path
// untouched when it was never quoted or cannot be read.
func unquoteGitPath(path string) string {
	if !strings.HasPrefix(path, `"`) {
		return path
	}
	if unquoted, err := strconv.Unquote(path); err == nil {
		return unquoted
	}
	return path
}
