//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"slices"
	"testing"
)

// blamed is which commit each line of a blame came from: the empty string for a
// line not committed.
func blamed(b Blame) []string {
	out := make([]string, len(b.Lines))
	for i, at := range b.Lines {
		out[i] = b.Commits[at].Sha
	}
	return out
}

// Blame says which commit last changed each line: at a commit, in the working
// tree, or in the index, each with the lines nobody has committed yet as such.
func TestBlame(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	day := int64(1_700_000_000)
	p.write("f.txt", "one\ntwo\nthree\n")
	first := commitAt(t, p, "adds f", day)
	p.write("f.txt", "one\nTWO\nthree\n")
	second := commitAt(t, p, "capital two", day+10)

	at, err := ReadBlame(t.Context(), p.root, "", BlameQuery{Path: "f.txt", Rev: first})
	if err != nil {
		t.Fatal(err)
	}
	if got := blamed(at); !slices.Equal(got, []string{first, first, first}) {
		t.Errorf("at the first commit = %q", got)
	}

	p.write("f.txt", "ONE\nTWO\nthree\n")
	p.git("add", "f.txt")
	p.write("f.txt", "ONE\nTWO\nTHREE\n")

	tree, err := ReadBlame(t.Context(), p.root, "", BlameQuery{Path: "f.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if got := blamed(tree); !slices.Equal(got, []string{"", second, ""}) {
		t.Errorf("in the working tree = %q", got)
	}
	c := tree.Commits[tree.Lines[1]]
	if c.Summary != "capital two" || c.Author != "Juggler Test" || c.Date != day+10 {
		t.Errorf("the second commit = %+v", c)
	}

	index, err := ReadBlame(t.Context(), p.root, "", BlameQuery{Path: "f.txt", Rev: BlameIndex})
	if err != nil {
		t.Fatal(err)
	}
	if got := blamed(index); !slices.Equal(got, []string{"", second, first}) {
		t.Errorf("in the index = %q", got)
	}

	for _, q := range []BlameQuery{{Path: "../out.txt"}, {Path: "f.txt", Rev: "--all"}, {Path: "f.txt", Rev: "nosuch"}, {}} {
		if _, err := ReadBlame(t.Context(), p.root, "", q); err == nil {
			t.Errorf("%+v was answered", q)
		}
	}
	if _, err := ReadBlame(t.Context(), p.root, "", BlameQuery{Path: "../out.txt"}); !refused(err) {
		t.Errorf("a path out of the repository = %v, want a refusal", err)
	}
}
