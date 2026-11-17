//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"strconv"
	"strings"

	"juggler/cmd/juggler/gitview/internal/clocks"
	"juggler/cmd/juggler/msg"
)

// strandedMax is how many stranded commits are counted before the count
// stops: past it, "more than" says all a question before a delete needs.
const strandedMax = 1000

// Stranded is what deleting one ref would leave unreachable: the commits it
// reaches that no other ref, and no tree's HEAD, does. Count stops at
// strandedMax, with More set when there are more than that.
type Stranded struct {
	Ref   string `json:"ref"`
	Count int    `json:"count"`
	More  bool   `json:"more,omitempty"`
}

// ReadStranded counts the commits only ref reaches in the repository repo
// under root. Ref is a full ref name ("refs/tags/v1"); one that is not is the
// asker's mistake. The reflogs, which keep a commit from garbage collection
// for a while, are not counted as reaching it: the question is whether
// anything the user can see in the repository still leads to it.
func ReadStranded(ctx context.Context, root, repo, ref string) (Stranded, error) {
	if !strings.HasPrefix(ref, "refs/") || strings.ContainsAny(ref, "*?[\\ ") {
		return Stranded{}, &RequestError{msg.NewError("Not a ref: {ref}", "ref", ref)}
	}
	dir, err := ResolveRepo(ctx, root, repo)
	if err != nil {
		return Stranded{}, err
	}
	// --exclude takes the ref itself out of the --all that follows it, and
	// --all brings in every other ref and each tree's HEAD.
	out, err := gitRead(ctx, dir, clocks.Review.PerCmd, 64,
		"rev-list", "--count", "--max-count="+strconv.Itoa(strandedMax+1),
		ref, "--not", "--exclude="+ref, "--all")
	if err != nil {
		return Stranded{}, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out.Kept)))
	if err != nil {
		return Stranded{}, err
	}
	s := Stranded{Ref: ref, Count: n}
	if n > strandedMax {
		s.Count, s.More = strandedMax, true
	}
	return s, nil
}
