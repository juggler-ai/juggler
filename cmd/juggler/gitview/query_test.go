//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"errors"
	"testing"
)

// A query names the place it reads for; "changes" is the Changes place's read,
// and a kind nobody knows is the asker's mistake, refused as one.
func TestReadAnswersAQueryByKind(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("init")
	p.write("a.txt", "b\n")

	got, err := Read(t.Context(), p.root, Query{Kind: QueryChanges, Repo: p.rel})
	if err != nil {
		t.Fatal(err)
	}
	c, ok := got.(Changes)
	if !ok || len(c.Files) != 1 || c.Files[0].Path != "a.txt" {
		t.Errorf("changes query = %#v, want the repository's one changed file", got)
	}

	_, err = Read(t.Context(), p.root, Query{Kind: "history", Repo: p.rel})
	var refused *RequestError
	if !errors.As(err, &refused) {
		t.Errorf("unknown kind = %v, want a *RequestError", err)
	}
}
