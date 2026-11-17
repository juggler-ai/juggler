//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"slices"
	"strings"
	"testing"
)

// A commit reads as History's detail shows it: who and when, its parents, its
// whole message, and every file it changed against its first parent, with
// lines counted — renames and deletions as what they are.
func TestReadCommit(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("keep.txt", "one\ntwo\n")
	p.write("gone.txt", "bye\n")
	p.write("old.txt", "a long enough file\nto be found renamed\nwhen it moves\n")
	commitAt(t, p, "root", 1_700_000_000)
	root := strings.TrimSpace(p.git("rev-parse", "HEAD"))

	p.write("keep.txt", "one\n2\nthree\n")
	p.git("rm", "-q", "gone.txt")
	p.git("mv", "old.txt", "new.txt")
	p.write("added.txt", "x\n")
	p.git("add", "-A")
	p.git("commit", "-q", "-m", "Change things\n\nWith a body\nof two lines.")
	sha := strings.TrimSpace(p.git("rev-parse", "HEAD"))

	c, err := ReadCommit(t.Context(), p.root, "", sha[:9])
	if err != nil {
		t.Fatal(err)
	}
	if c.Sha != sha || !slices.Equal(c.Parents, []string{root}) || c.Subject != "Change things" ||
		c.Body != "With a body\nof two lines." || c.Author.Name != "Juggler Test" || c.Author.Email != "test@example.com" ||
		c.Author.Date == 0 || c.Committer.Name != "Juggler Test" {
		t.Errorf("commit = %+v", c)
	}
	if c.Base != root || c.Target != sha || c.Scope != sha+"^!" {
		t.Errorf("compared %s against %s as %q, want %s against its parent as %s^!", c.Target, c.Base, c.Scope, sha, sha)
	}
	byPath := map[string]gitFileStatus{}
	for _, f := range c.Files {
		byPath[f.Path] = f
	}
	for path, want := range map[string]string{"keep.txt": "M", "gone.txt": "D", "new.txt": "R", "added.txt": "A"} {
		if got := byPath[path].Worktree; got != want {
			t.Errorf("%s: %q, want %q (files %+v)", path, got, want, c.Files)
		}
	}
	if byPath["new.txt"].OldPath != "old.txt" {
		t.Errorf("the rename's old path = %q", byPath["new.txt"].OldPath)
	}
	if k := byPath["keep.txt"]; k.Added == nil || *k.Added != 2 || k.Removed == nil || *k.Removed != 1 {
		t.Errorf("keep.txt counted %+v", k)
	}
	if c.Total != 4 || c.Truncated || !slices.IsSortedFunc(c.Files, func(a, b gitFileStatus) int { return strings.Compare(a.Path, b.Path) }) {
		t.Errorf("total %d truncated %v files %+v", c.Total, c.Truncated, c.Files)
	}

	first, err := ReadCommit(t.Context(), p.root, "", root)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Parents) != 0 || first.Total != 3 || first.Body != "" {
		t.Errorf("the root commit = %+v", first)
	}

	if _, err := ReadCommit(t.Context(), p.root, "", "nosuch"); !refused(err) {
		t.Errorf("an unknown commit = %v, want a refusal", err)
	}
	if _, err := ReadCommit(t.Context(), p.root, "", "--all"); !refused(err) {
		t.Errorf("an option for a commit = %v, want a refusal", err)
	}
}

// A merge is shown against its first parent: what it brought to the branch.
func TestReadCommitOfAMerge(t *testing.T) {
	t.Parallel()
	p := branchyProject(t)
	merge := strings.TrimSpace(p.git("rev-parse", "HEAD"))
	c, err := ReadCommit(t.Context(), p.root, "", merge)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Parents) != 2 || len(c.Files) != 1 || c.Files[0].Path != "t.txt" {
		t.Errorf("merge = %+v", c)
	}
}

// The query kinds route to the reads: a commit through Read, as every other.
func TestReadAnswersACommitQuery(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("one")
	got, err := Read(t.Context(), p.root, Query{Kind: QueryCommit, Commit: "HEAD"})
	if err != nil {
		t.Fatal(err)
	}
	if c, ok := got.(Commit); !ok || c.Subject != "one" {
		t.Errorf("Read(commit) = %#v", got)
	}
	if _, err := Read(t.Context(), p.root, Query{Kind: QueryLog}); !refused(err) {
		t.Errorf("a log read without a graph store = %v, want a refusal", err)
	}
}
