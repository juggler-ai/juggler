//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

func (p *gitProject) commitContext(amend bool) CommitContext {
	p.t.Helper()
	c, err := ReadCommitContext(p.t.Context(), p.root, p.rel, CommitContextQuery{Amend: amend})
	if err != nil {
		p.t.Fatal(err)
	}
	return c
}

// fileSection is the part of a commit context's diff that is about one file: from
// its "diff --git" header up to the next file's, or "" when it has none.
func fileSection(diff, path string) string {
	head := "diff --git a/" + path + " b/" + path + "\n"
	at := strings.Index(diff, head)
	if at < 0 {
		return ""
	}
	rest := diff[at+len(head):]
	if end := strings.Index(rest, "\ndiff --git "); end >= 0 {
		rest = rest[:end+1]
	}
	return head + rest
}

func stagedList(c CommitContext) []string {
	var out []string
	for _, f := range c.Files {
		out = append(out, f.Status+" "+f.Path)
	}
	return out
}

// numberedLines is n numbered lines of about width characters each.
func numberedLines(n, width int) string {
	var b strings.Builder
	for i := range n {
		line := fmt.Sprintf("line %d ", i)
		b.WriteString(line + strings.Repeat("x", max(0, width-len(line)-1)) + "\n")
	}
	return b.String()
}

// A file's diff is cut to the per-file budget and says how much it lost, and
// once the whole diff has spent its budget the files left are named only by a
// marker saying their diffs were left out. The stat still lists every file.
func TestCommitContextTruncatesEachFileAndTheWhole(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("seed.txt", "seed\n")
	p.commit("init")

	p.write("big.txt", numberedLines(400, 40))
	p.write("small.txt", "just this\n")
	p.git("add", "big.txt", "small.txt")
	c := p.commitContext(false)

	big := fileSection(c.Diff, "big.txt")
	if big == "" || len(big) > commitDiffFileBudget+200 {
		t.Fatalf("big.txt's section is %d bytes, want at most about %d:\n%.400s", len(big), commitDiffFileBudget, big)
	}
	if !strings.Contains(big, "more lines of this file's diff left out]") {
		t.Errorf("big.txt's cut section does not say so:\n%s", big[max(0, len(big)-300):])
	}
	if s := fileSection(c.Diff, "small.txt"); !strings.Contains(s, "+just this") || strings.Contains(s, "left out") {
		t.Errorf("small.txt's section should be whole:\n%s", s)
	}
	if !c.Truncated {
		t.Error("a cut diff is not marked truncated")
	}

	q := newGitProject(t)
	q.write("seed.txt", "seed\n")
	q.commit("init")
	for i := range 12 {
		q.write(fmt.Sprintf("f%02d.txt", i), numberedLines(50, 60)) // ~3k of diff each
	}
	q.git("add", "-A")
	c = q.commitContext(false)
	if len(c.Diff) > commitDiffBudget+300 {
		t.Errorf("the whole diff is %d bytes, want at most about %d", len(c.Diff), commitDiffBudget)
	}
	if fileSection(c.Diff, "f00.txt") == "" || fileSection(c.Diff, "f11.txt") != "" {
		t.Errorf("want the first file's diff kept and the last one's left out")
	}
	if !strings.Contains(c.Diff, "more files left out; the stat lists them]") {
		t.Errorf("the diff does not say files were left out:\n%s", c.Diff[max(0, len(c.Diff)-300):])
	}
	if !strings.Contains(c.Stat, "f11.txt") {
		t.Errorf("the stat should list every staged file:\n%s", c.Stat)
	}
	if len(c.Files) != 12 || !c.Truncated {
		t.Errorf("files %d truncated %v, want 12 and true", len(c.Files), c.Truncated)
	}
}

// Content nobody reads to understand a change — binaries, lock files,
// minified and generated files — is left out of the diff, its header kept and
// a line saying what it was and how much changed.
func TestCommitContextSummarisesOpaqueFiles(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write(".gitattributes", "gen/*.go linguist-generated\n")
	p.commit("init")

	p.write("package-lock.json", "{\"lockfileVersion\": 3, \"secret-lock-content\": 1}\n")
	p.write("web/app.min.js", "var minified_content=1;\n")
	p.write("gen/api.go", "package gen // generated_content\n")
	p.write("pic.dat", "\x00\x01\x02binary_content")
	p.write("main.go", "package main // readable_content\n")
	p.git("add", "-A")
	c := p.commitContext(false)

	for path, kind := range map[string]string{
		"package-lock.json": "lock file", "web/app.min.js": "minified file",
		"gen/api.go": "generated file", "pic.dat": "binary file",
	} {
		s := fileSection(c.Diff, path)
		if s == "" {
			t.Errorf("%s has no section in:\n%s", path, c.Diff)
			continue
		}
		if !strings.Contains(s, "["+kind+": content left out") {
			t.Errorf("%s's section does not say it is a %s:\n%s", path, kind, s)
		}
		if strings.Contains(s, "_content") {
			t.Errorf("%s's content is in the diff:\n%s", path, s)
		}
	}
	if s := fileSection(c.Diff, "package-lock.json"); !strings.Contains(s, "+1 -0 lines") {
		t.Errorf("the lock file's summary does not count its lines:\n%s", s)
	}
	if !strings.Contains(fileSection(c.Diff, "main.go"), "readable_content") {
		t.Errorf("an ordinary file lost its content:\n%s", c.Diff)
	}
}

// An amend describes the commit that replaces HEAD: everything staged against
// HEAD's parent, so HEAD's own changes are in it, and HEAD's message comes
// along. Amending the first commit compares against nothing at all.
func TestCommitContextAmendsAgainstHEADsParent(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("first")
	p.write("b.txt", "b\n")
	p.git("add", "b.txt")
	p.git("commit", "-qm", "second\n\nits body")
	p.write("c.txt", "c\n")
	p.git("add", "c.txt")

	if got := stagedList(p.commitContext(false)); !slices.Equal(got, []string{"A c.txt"}) {
		t.Errorf("a new commit stages %v, want [A c.txt]", got)
	}
	c := p.commitContext(true)
	if got := stagedList(c); !slices.Equal(got, []string{"A b.txt", "A c.txt"}) {
		t.Errorf("an amend stages %v, want [A b.txt A c.txt]", got)
	}
	if !c.Amend || c.HeadMessage != "second\n\nits body" {
		t.Errorf("amend %v headMessage %q, want true and HEAD's message", c.Amend, c.HeadMessage)
	}
	if fileSection(c.Diff, "b.txt") == "" || !strings.Contains(c.Stat, "b.txt") {
		t.Errorf("an amend's diff and stat should hold HEAD's own change:\n%s\n%s", c.Diff, c.Stat)
	}
	if !slices.Equal(c.Subjects, []string{"first"}) {
		t.Errorf("an amend's subjects are %v, want those before HEAD: [first]", c.Subjects)
	}

	root := newGitProject(t)
	root.write("a.txt", "a\n")
	root.commit("only")
	root.write("x.txt", "x\n")
	root.git("add", "x.txt")
	if got := stagedList(root.commitContext(true)); !slices.Equal(got, []string{"A a.txt", "A x.txt"}) {
		t.Errorf("amending the root commit stages %v, want [A a.txt A x.txt]", got)
	}

	fresh := newGitProject(t)
	fresh.write("n.txt", "n\n")
	fresh.git("add", "n.txt")
	c = fresh.commitContext(false)
	if got := stagedList(c); !slices.Equal(got, []string{"A n.txt"}) || len(c.Subjects) != 0 || c.HeadMessage != "" {
		t.Errorf("before the first commit: staged %v subjects %v head %q, want [A n.txt] and nothing else", got, c.Subjects, c.HeadMessage)
	}
}

// The style samples are the recent subjects, newest first, without merges.
func TestCommitContextSubjectsSkipMerges(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("Added a")
	p.git("checkout", "-qb", "side")
	p.write("s.txt", "s\n")
	p.commit("Added s on the side")
	p.git("checkout", "-q", "-")
	p.write("b.txt", "b\n")
	p.commit("Added b")
	p.git("merge", "-q", "--no-ff", "-m", "Merge branch 'side'", "side")
	p.write("c.txt", "c\n")
	p.commit("Added c")

	got := p.commitContext(false).Subjects
	if want := []string{"Added c", "Added b", "Added s on the side", "Added a"}; !slices.Equal(got, want) {
		t.Errorf("subjects = %v, want %v", got, want)
	}
}

// A heading section about commits is taken whole; with none, the lines that
// mention commits; with neither, nothing. Headings inside code fences are
// code, not headings.
func TestExtractCommitRules(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ name, text, want string }{
		{
			"a heading section",
			"# Project\n\nIntro.\n\n## Git commits\n\n- One line, past tense.\n```sh\n# not a heading\n```\n### Detail\nNo trailers.\n\n## Changelog\n\nKeep it short.\n",
			"## Git commits\n\n- One line, past tense.\n```sh\n# not a heading\n```\n### Detail\nNo trailers.",
		},
		{
			"commit message headings",
			"# X\n## Commit Messages\nUse the imperative.\n# Y\nother\n",
			"## Commit Messages\nUse the imperative.",
		},
		{
			"the lines mentioning commits",
			"# Rules\n\n- Run the tests.\n- Commit messages are one line.\n- Never commit secrets.\n",
			"- Commit messages are one line.\n- Never commit secrets.",
		},
		{"nothing about commits", "# Rules\n\nRun the tests.\n", ""},
	} {
		if got := extractCommitRules(tc.text); got != tc.want {
			t.Errorf("%s:\n got %q\nwant %q", tc.name, got, tc.want)
		}
	}
}

// The rules come from the repository's instruction files, each named, and are
// capped; the body-wrap convention comes along.
func TestCommitContextRules(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("AGENTS.md", "# A\n\n## Commits\n\nPast tense.\n")
	p.write("CLAUDE.md", "Nothing here.\n")
	p.write(".github/copilot-instructions.md", "Each commit names its package.\n")
	p.commit("init")
	p.write("x.txt", "x\n")
	p.git("add", "x.txt")

	c := p.commitContext(false)
	want := "From AGENTS.md:\n## Commits\n\nPast tense.\n\nFrom .github/copilot-instructions.md:\nEach commit names its package."
	if c.Rules != want {
		t.Errorf("rules:\n got %q\nwant %q", c.Rules, want)
	}
	if !c.WrapsBody {
		t.Error("a repository with no bodies should be taken to wrap them")
	}

	q := newGitProject(t)
	q.write("AGENTS.md", "## Commits\n"+strings.Repeat("A commit rule that goes on.\n", 400))
	q.commit("init")
	if r := q.commitContext(false).Rules; len(r) > commitRulesBudget+100 || !strings.HasSuffix(r, "[… rules cut here]") {
		t.Errorf("long rules are %d bytes ending %q, want them capped with a marker", len(r), r[max(0, len(r)-40):])
	}
}
