//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"errors"
	"testing"
)

// A ref strands the commits nothing else reaches: a tag on a commit its branch
// has gone from strands it and everything below it the branch never shared,
// while a tag on a commit a branch, another tag or HEAD still reaches strands
// nothing. A name that is not a full ref is refused, not handed to git.
func TestReadStranded(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("base")
	p.git("tag", "on-main")
	p.git("switch", "-c", "side")
	p.write("a.txt", "b\n")
	p.commit("one")
	p.write("a.txt", "c\n")
	p.commit("two")
	p.git("tag", "-a", "-m", "annotated", "lonely")
	p.git("tag", "twin")
	p.git("switch", "-")
	p.git("branch", "-D", "side")

	ask := func(ref string) Stranded {
		t.Helper()
		got, err := Read(t.Context(), p.root, Query{Kind: QueryStranded, Repo: p.rel, Ref: ref})
		if err != nil {
			t.Fatalf("%s: %v", ref, err)
		}
		return got.(Stranded)
	}

	if s := ask("refs/tags/on-main"); s.Count != 0 {
		t.Errorf("a tag on a commit HEAD reaches strands %d, want 0", s.Count)
	}
	if s := ask("refs/tags/lonely"); s.Count != 0 {
		t.Errorf("a tag whose commit another tag reaches strands %d, want 0", s.Count)
	}
	p.git("tag", "-d", "twin")
	if s := ask("refs/tags/lonely"); s.Count != 2 || s.More {
		t.Errorf("the only tag on a deleted branch's tip strands %+v, want its 2 commits", s)
	}

	_, err := Read(t.Context(), p.root, Query{Kind: QueryStranded, Repo: p.rel, Ref: "--all"})
	var refused *RequestError
	if !errors.As(err, &refused) {
		t.Errorf("a name that is not a ref = %v, want a *RequestError", err)
	}
}
