//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/gitview/internal/clocks"
)

// What a commit-context read keeps, in bytes of text. They bound what a
// commit-message prompt costs: the diff is most of it, and a model reads the
// first few thousand characters of a file's change for its gist as well as it
// reads all of them.
const (
	commitDiffFileBudget = 4000  // one file's patch
	commitDiffBudget     = 24000 // every file's patches together
	commitStatBudget     = 8000  // the --stat text
	commitRulesBudget    = 4000  // the rules from every instruction file together
	commitSubjects       = 10    // recent subjects kept as style samples

	commitDiffReadMax  = 4 << 20   // the raw patch read from git, before any budget
	commitRulesFileMax = 512 << 10 // an instruction file larger than this is not read
)

// commitRuleFiles are where a repository writes down how its commits are made,
// relative to its top level, in the order their rules are given.
var commitRuleFiles = []string{
	"AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md",
	".github/copilot-instructions.md", ".github/CONTRIBUTING.md",
}

// CommitContextQuery is what a commit-context read describes: a commit made
// now, or an amend of HEAD when Amend is set.
type CommitContextQuery struct {
	Amend bool `json:"amend,omitempty"`
}

// CommitContext is what a model is given to write a commit message for what
// is staged in one repository, already cut to size.
//
// Diff is the staged patch, each file's cut to commitDiffFileBudget and the
// whole to commitDiffBudget. Every cut is marked in the text itself, on a line
// of its own in square brackets opening with "[…", so the model knows it has
// not seen everything:
//
//	[… N more lines of this file's diff left out]
//	[… N more files left out; the stat lists them]
//
// A file whose content says nothing to a reader keeps its header and has its
// content replaced by "[<kind>: content left out, +A -R lines]", kind being
// "binary file" (with no counts), "lock file", "minified file" or "generated
// file" (marked linguist-generated in .gitattributes). Truncated is set when
// anything was cut or left out.
//
// Stat is git's --stat of the same change, whole unless it passes
// commitStatBudget. Subjects are the subjects of the last commitSubjects
// commits that will remain below the new one, newest first, merges skipped.
// Rules is what the repository's instruction files say about commits, each
// part headed "From <file>:". WrapsBody is whether the repository's commit
// bodies are hard-wrapped (see Changes.WrapsBody).
//
// Amending, the commit replaces HEAD: the change is the index against HEAD's
// parent (the empty tree when HEAD is the first commit), HeadMessage is HEAD's
// message, and the subjects start below HEAD. Amend is false when there is no
// commit to amend, whatever was asked.
type CommitContext struct {
	Repo        string              `json:"repo"`
	Amend       bool                `json:"amend"`
	HeadMessage string              `json:"headMessage,omitempty"`
	Files       []CommitContextFile `json:"files"`
	Stat        string              `json:"stat"`
	Diff        string              `json:"diff"`
	Truncated   bool                `json:"truncated"`
	Subjects    []string            `json:"subjects"`
	Rules       string              `json:"rules"`
	WrapsBody   bool                `json:"wrapsBody"`
}

// CommitContextFile is one file the commit changes: git's status letter for
// it (A, M, D, R, C, T, or U for unresolved conflicts), its path relative to
// the repository's top level, and where a rename or copy came from.
type CommitContextFile struct {
	Path    string `json:"path"`
	OldPath string `json:"oldPath,omitempty"`
	Status  string `json:"status"`
}

// ReadCommitContext reads what a commit message for repository repo under
// root is written from.
func ReadCommitContext(ctx context.Context, root, repo string, q CommitContextQuery) (CommitContext, error) {
	ctx, cancel := context.WithTimeout(ctx, clocks.Review.Budget)
	defer cancel()
	dir, err := ResolveRepo(ctx, root, repo)
	if err != nil {
		return CommitContext{}, err
	}
	perCmd := clocks.Review.PerCmd
	c := CommitContext{Repo: RepoPath(root, dir), Files: []CommitContextFile{}, Subjects: []string{}}

	hasHead, err := revExists(ctx, dir, perCmd, "HEAD")
	if err != nil {
		return CommitContext{}, err
	}
	c.Amend = q.Amend && hasHead
	base, below := "HEAD", "HEAD" // what the index is compared with, and where the subjects start
	switch {
	case !hasHead:
		below = ""
		if base, err = emptyTree(ctx, dir, perCmd); err != nil {
			return CommitContext{}, err
		}
	case c.Amend:
		head, err := headCommit(ctx, dir, perCmd)
		if err != nil {
			return CommitContext{}, err
		}
		c.HeadMessage = strings.TrimRight(head.Message, "\n")
		parent, err := revExists(ctx, dir, perCmd, "HEAD^")
		if err != nil {
			return CommitContext{}, err
		}
		base, below = "HEAD^", "HEAD^"
		if !parent {
			below = ""
			if base, err = emptyTree(ctx, dir, perCmd); err != nil {
				return CommitContext{}, err
			}
		}
	}

	if c.Files, err = commitFiles(ctx, dir, perCmd, base); err != nil {
		return CommitContext{}, err
	}
	stat, err := gitRead(ctx, dir, perCmd, commitStatBudget,
		"diff-index", "--cached", "--no-ext-diff", "--no-textconv", "--find-renames", "--stat", base, "--")
	if err != nil {
		return CommitContext{}, err
	}
	c.Stat = string(stat.Kept)
	if stat.Truncated {
		c.Stat = cutAtLine(c.Stat, commitStatBudget) + "[… the stat is cut here]\n"
		c.Truncated = true
	}
	if err := commitDiff(ctx, dir, perCmd, base, &c); err != nil {
		return CommitContext{}, err
	}
	if below != "" {
		if c.Subjects, err = recentSubjects(ctx, dir, perCmd, below); err != nil {
			return CommitContext{}, err
		}
	}
	if c.WrapsBody, err = wrapsBody(ctx, dir, perCmd, !hasHead); err != nil {
		return CommitContext{}, err
	}
	c.Rules = commitRules(dir)
	return c, nil
}

// revExists says whether rev names a commit in the repository at dir.
func revExists(ctx context.Context, dir string, budget time.Duration, rev string) (bool, error) {
	cctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	if err := gitCommand(cctx, dir, "rev-parse", "--verify", "-q", rev+"^{commit}").Run(); err != nil {
		if cctx.Err() != nil {
			return false, gitDeadlineError(ctx, cctx, budget)
		}
		return false, nil
	}
	return true, nil
}

// commitFiles lists the files the index changes against base.
func commitFiles(ctx context.Context, dir string, budget time.Duration, base string) ([]CommitContextFile, error) {
	out, err := gitRead(ctx, dir, budget, stagedReadMax,
		"diff-index", "--cached", "--name-status", "-z", "--find-renames", base, "--")
	if err != nil {
		return nil, err
	}
	if out.Truncated {
		return nil, tooManyStaged()
	}
	files := []CommitContextFile{}
	fields := strings.Split(string(out.Kept), "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		status := fields[i]
		if status == "" {
			break
		}
		f := CommitContextFile{Status: status[:1], Path: fields[i+1]}
		if (f.Status == "R" || f.Status == "C") && i+2 < len(fields) {
			f.OldPath, f.Path = fields[i+1], fields[i+2]
			i++
		}
		files = append(files, f)
	}
	return files, nil
}

// commitDiff reads the staged patch against base into c.Diff, each file's
// cut, summarised or left out as CommitContext describes.
func commitDiff(ctx context.Context, dir string, budget time.Duration, base string, c *CommitContext) error {
	out, err := gitRead(ctx, dir, budget, commitDiffReadMax,
		"diff-index", "--cached", "-p", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", base, "--")
	if err != nil {
		return err
	}
	generated, err := linguistGenerated(ctx, dir, budget, c.Files)
	if err != nil {
		return err
	}
	sections := splitPatch(string(out.Kept))
	// An unresolved conflict is listed among the files with no patch of its own,
	// so the patches are matched to the files they follow in order, skipping it.
	var patched []CommitContextFile
	for _, f := range c.Files {
		if f.Status != "U" {
			patched = append(patched, f)
		}
	}

	var b strings.Builder
	for i, s := range sections {
		path := ""
		if i < len(patched) {
			path = patched[i].Path
		}
		if i == len(sections)-1 && out.Truncated {
			s = cutAtLine(s, min(len(s), commitDiffFileBudget)) // the read itself stopped inside it
			s += "[… the rest of this file's diff left out]\n"
			c.Truncated = true
		} else {
			var cut bool
			s, cut = budgetSection(s, opaqueKind(path, generated[path], s))
			c.Truncated = c.Truncated || cut
		}
		if b.Len()+len(s) > commitDiffBudget {
			left := len(patched) - i
			noun := "files"
			if left == 1 {
				noun = "file"
			}
			fmt.Fprintf(&b, "[… %d more %s left out; the stat lists them]\n", left, noun)
			c.Truncated = true
			break
		}
		b.WriteString(s)
	}
	c.Diff = b.String()
	return nil
}

// splitPatch cuts a patch into its files, each opening with its "diff --git"
// line. A line of content cannot open that way: it carries a prefix.
func splitPatch(patch string) []string {
	var out []string
	start := -1
	for at := 0; at < len(patch); {
		end := strings.IndexByte(patch[at:], '\n')
		next := len(patch)
		if end >= 0 {
			next = at + end + 1
		}
		if strings.HasPrefix(patch[at:], "diff --git ") {
			if start >= 0 {
				out = append(out, patch[start:at])
			}
			start = at
		}
		at = next
	}
	if start >= 0 {
		out = append(out, patch[start:])
	}
	return out
}

// opaqueKind names what a file is when its content says nothing to a reader
// of the change, or "" when it should be read.
func opaqueKind(file string, generated bool, section string) string {
	name := strings.ToLower(path.Base(file))
	switch {
	case strings.Contains(section, "\nBinary files ") || strings.Contains(section, "\nGIT binary patch"):
		return "binary file"
	case lockFiles[name] || strings.HasSuffix(name, ".lock") || strings.HasSuffix(name, ".lockb"):
		return "lock file"
	case strings.Contains(name, ".min."):
		return "minified file"
	case generated:
		return "generated file"
	}
	return ""
}

// lockFiles are the lock files package managers write that do not end in .lock.
var lockFiles = map[string]bool{
	"package-lock.json": true, "npm-shrinkwrap.json": true, "pnpm-lock.yaml": true,
	"go.sum": true, "packages.lock.json": true, "gradle.lockfile": true,
}

// budgetSection is one file's section as the diff gives it: its header and a
// summary when kind names it opaque, else cut to commitDiffFileBudget with a
// line saying how much was left out. cut says whether anything was.
func budgetSection(s, kind string) (string, bool) {
	if kind != "" {
		header, added, removed := s, 0, 0
		if at := hunkStart(s); at >= 0 {
			header = s[:at]
			for line := range strings.SplitSeq(s[at:], "\n") {
				switch {
				case strings.HasPrefix(line, "+"):
					added++
				case strings.HasPrefix(line, "-"):
					removed++
				}
			}
		}
		if kind == "binary file" {
			return header + "[binary file: content left out]\n", true
		}
		return header + fmt.Sprintf("[%s: content left out, +%d -%d lines]\n", kind, added, removed), true
	}
	if len(s) <= commitDiffFileBudget {
		return s, false
	}
	kept := cutAtLine(s, commitDiffFileBudget)
	left := strings.Count(s[len(kept):], "\n")
	return kept + fmt.Sprintf("[… %d more lines of this file's diff left out]\n", left), true
}

// hunkStart is where a file's section stops being its header: the first hunk,
// or git's line saying it is binary. -1 when it has neither (a mode change,
// an empty file).
func hunkStart(s string) int {
	for _, marker := range []string{"\n@@ ", "\nBinary files ", "\nGIT binary patch"} {
		if at := strings.Index(s, marker); at >= 0 {
			return at + 1
		}
	}
	return -1
}

// cutAtLine is s cut to at most n bytes, at the end of a line.
func cutAtLine(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if at := strings.LastIndexByte(s[:n], '\n'); at >= 0 {
		return s[:at+1]
	}
	return ""
}

// linguistGenerated is the files .gitattributes marks linguist-generated,
// asked of git for every file in one command.
func linguistGenerated(ctx context.Context, dir string, budget time.Duration, files []CommitContextFile) (map[string]bool, error) {
	out := map[string]bool{}
	if len(files) == 0 {
		return out, nil
	}
	var stdin bytes.Buffer
	for _, f := range files {
		stdin.WriteString(f.Path)
		stdin.WriteByte(0)
	}
	cctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	cmd := gitCommand(cctx, dir, "check-attr", "-z", "--stdin", "linguist-generated")
	cmd.Stdin = &stdin
	raw, err := cmd.Output()
	if err != nil {
		if cctx.Err() != nil {
			return nil, gitDeadlineError(ctx, cctx, budget)
		}
		return nil, err
	}
	fields := bytes.Split(raw, []byte{0})
	for i := 0; i+2 < len(fields); i += 3 {
		if v := string(fields[i+2]); v == "set" || v == "true" {
			out[string(fields[i])] = true
		}
	}
	return out, nil
}

// recentSubjects is the subjects of the commits from rev down, newest first,
// merges skipped.
func recentSubjects(ctx context.Context, dir string, budget time.Duration, rev string) ([]string, error) {
	out, err := gitRead(ctx, dir, budget, 64<<10,
		"log", "-n", strconv.Itoa(commitSubjects), "--no-merges", "--format=%s", rev, "--")
	if err != nil {
		return nil, err
	}
	subjects := []string{}
	for line := range strings.SplitSeq(string(out.Kept), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			subjects = append(subjects, line)
		}
	}
	return subjects, nil
}

// commitRules is what the repository at dir's instruction files say about
// commits (extractCommitRules), each part headed by its file, cut to
// commitRulesBudget. A file that cannot be read, or that resolves outside the
// repository, says nothing; one saying what an earlier one said (CLAUDE.md
// linked to AGENTS.md) is not repeated.
func commitRules(dir string) string {
	realDir := resolvedPath(dir)
	var parts []string
	seen := map[string]bool{}
	for _, name := range commitRuleFiles {
		file := filepath.Join(dir, filepath.FromSlash(name))
		real, err := filepath.EvalSymlinks(file)
		if err != nil || !strings.HasPrefix(real, realDir+string(filepath.Separator)) {
			continue
		}
		info, err := os.Stat(real)
		if err != nil || !info.Mode().IsRegular() || info.Size() > commitRulesFileMax {
			continue
		}
		text, err := os.ReadFile(real) //nolint:gosec // a file of the repository, resolved inside it above
		if err != nil {
			continue
		}
		rules := extractCommitRules(string(text))
		if rules == "" || seen[rules] {
			continue
		}
		seen[rules] = true
		parts = append(parts, "From "+name+":\n"+rules)
	}
	all := strings.Join(parts, "\n\n")
	if len(all) > commitRulesBudget {
		all = cutAtLine(all, commitRulesBudget) + "[… rules cut here]"
	}
	return all
}

var (
	mentionsCommit = regexp.MustCompile(`(?i)\bcommit`)
	headingLine    = regexp.MustCompile(`^ {0,3}(#{1,6})(\s|$)`)
	fenceLine      = regexp.MustCompile("^ {0,3}(```|~~~)")
)

// extractCommitRules is what a Markdown instruction file says about commits:
// every heading section whose heading mentions commits, whole (to the next
// heading of its level or above); with none, every line that mentions them;
// with neither, "". A "#" line inside a code fence is not a heading.
func extractCommitRules(text string) string {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	level := make([]int, len(lines)) // each line's heading level, 0 for none
	inFence := false
	for i, line := range lines {
		if fenceLine.MatchString(line) {
			inFence = !inFence
			continue
		}
		if m := headingLine.FindStringSubmatch(line); m != nil && !inFence {
			level[i] = len(m[1])
		}
	}

	var sections []string
	for i := 0; i < len(lines); i++ {
		if level[i] == 0 || !mentionsCommit.MatchString(lines[i]) {
			continue
		}
		end := i + 1
		for end < len(lines) && (level[end] == 0 || level[end] > level[i]) {
			end++
		}
		sections = append(sections, strings.TrimRight(strings.Join(lines[i:end], "\n"), "\n \t"))
		i = end - 1
	}
	if len(sections) > 0 {
		return strings.Join(sections, "\n\n")
	}

	var mentions []string
	for _, line := range lines {
		if mentionsCommit.MatchString(line) {
			mentions = append(mentions, strings.TrimRight(line, " \t"))
		}
	}
	return strings.Join(mentions, "\n")
}
