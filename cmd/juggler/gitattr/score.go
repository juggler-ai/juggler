//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitattr

import (
	"cmp"
	"context"
	"slices"

	"juggler/cmd/juggler/gitview"
)

// Scoring says which of the project's conversations made what is staged in one
// repository of one tree, so the commit box can ask the right one for a
// message. Each staged file is accounted for by the conversations with the best
// evidence for it, in three tiers:
//
//   - strong: a Strong record whose blob is the staged blob. This
//     conversation's own tool wrote the version being committed.
//   - prior: the tree is a workspace and the conversation is bound to it. A
//     workspace is made for its conversations, so whatever changed in it is
//     theirs, bash included, unless a version match says otherwise. This sits
//     below a version match and above anything weak.
//   - weak: a Weak record whose blob is the staged blob (a shell command seen
//     while other commands were running too), or any record of the same path
//     whose blob is not the staged one. The second kind means the conversation
//     wrote the file but it has been edited since.
//
// A file goes to every conversation in its best tier that has any evidence, and
// to no one else. So when two conversations wrote one file, the one whose
// version is staged takes it. A conversation scores by how many files it
// accounts for in each tier. The visible conversation is only a tie-break,
// never evidence.

// Request is what Read scores: one repository of one tree, as records name
// them, and the visible conversation (gitview.AttributionQuery).
type Request struct {
	Workspace string // The tree's workspace id; "" for the project's
	Repo      string // The repository, relative to the tree's root
	Amend     bool   // Score HEAD's changes as well as the index's
	Visible   string // The conversation that breaks ties
}

// Conversation is what scoring needs of one of the project's conversations.
type Conversation struct {
	Title   string
	Updated int64 // When it was last active, epoch milliseconds
}

// Directory is the project's conversations, as scoring asks about them.
type Directory interface {
	// Conversations is every conversation that exists, by id. One that is not
	// here is never answered, whatever it recorded.
	Conversations(ctx context.Context) map[string]Conversation
	// BoundTo is the conversations bound to a workspace (never the project's).
	BoundTo(ctx context.Context, workspace string) []string
}

// Attribution is the answer to an attribution read: how many files are
// staged, and the conversations that account for any of them, best first.
type Attribution struct {
	Staged        int          `json:"staged"`
	Conversations []Attributed `json:"conversations"`
}

// Attributed is one conversation's share of the staged files: how many it
// accounts for in each tier, and which, in path order.
type Attributed struct {
	Conv   string   `json:"conv"`
	Title  string   `json:"title"`
	Strong int      `json:"strong"`
	Weak   int      `json:"weak"`
	Prior  int      `json:"prior"`
	Files  []string `json:"files"`
}

// Evidence is everything Score weighs. Records are the tree's and the
// repository's; Bound is the conversations bound to the tree's workspace.
type Evidence struct {
	Staged        []gitview.StagedFile
	Records       []Record
	Conversations map[string]Conversation
	Bound         []string
	Visible       string
}

// Score attributes each staged file to the conversations with the best
// evidence for it, and orders the conversations by how many files each
// accounts for: strong first, then weak, then prior, then the visible one,
// then the most recently active.
func Score(e Evidence) Attribution {
	staged := slices.Clone(e.Staged)
	slices.SortFunc(staged, func(a, b gitview.StagedFile) int { return cmp.Compare(a.Path, b.Path) })

	byPath := map[string][]Record{}
	for _, r := range e.Records {
		if _, ok := e.Conversations[r.Conv]; ok {
			byPath[r.Path] = append(byPath[r.Path], r)
		}
	}
	var bound []string
	for _, id := range e.Bound {
		if _, ok := e.Conversations[id]; ok && !slices.Contains(bound, id) {
			bound = append(bound, id)
		}
	}

	shares := map[string]*Attributed{}
	credit := func(conv, path string, tier func(*Attributed) *int) {
		s := shares[conv]
		if s == nil {
			s = &Attributed{Conv: conv, Title: e.Conversations[conv].Title, Files: []string{}}
			shares[conv] = s
		}
		if slices.Contains(s.Files, path) {
			return
		}
		s.Files = append(s.Files, path)
		*tier(s)++
	}
	for _, f := range staged {
		recs := byPath[f.Path]
		var strong, weak []string
		for _, r := range recs {
			if f.Blob != "" && r.Blob == f.Blob && r.Strength != Weak {
				strong = append(strong, r.Conv)
			} else {
				weak = append(weak, r.Conv)
			}
		}
		switch {
		case len(strong) > 0:
			for _, c := range strong {
				credit(c, f.Path, func(s *Attributed) *int { return &s.Strong })
			}
		case len(bound) > 0:
			for _, c := range bound {
				credit(c, f.Path, func(s *Attributed) *int { return &s.Prior })
			}
		default:
			for _, c := range weak {
				credit(c, f.Path, func(s *Attributed) *int { return &s.Weak })
			}
		}
	}

	out := Attribution{Staged: len(staged), Conversations: make([]Attributed, 0, len(shares))}
	for _, s := range shares {
		out.Conversations = append(out.Conversations, *s)
	}
	slices.SortFunc(out.Conversations, func(a, b Attributed) int {
		if c := cmp.Compare(b.Strong, a.Strong); c != 0 {
			return c
		}
		if c := cmp.Compare(b.Weak, a.Weak); c != 0 {
			return c
		}
		if c := cmp.Compare(b.Prior, a.Prior); c != 0 {
			return c
		}
		if av, bv := a.Conv == e.Visible, b.Conv == e.Visible; av != bv {
			if av {
				return -1
			}
			return 1
		}
		if c := cmp.Compare(e.Conversations[b.Conv].Updated, e.Conversations[a.Conv].Updated); c != 0 {
			return c
		}
		return cmp.Compare(a.Conv, b.Conv)
	})
	return out
}

// Read scores what is staged in one repository of the tree at root against
// the index x, and the conversations dir knows of. Its git work is one
// gitview.ReadStaged, and the workspace's bound conversations are asked for
// only when something is staged.
func Read(ctx context.Context, x *Index, root string, req Request, dir Directory) (Attribution, error) {
	staged, err := gitview.ReadStaged(ctx, root, req.Repo, req.Amend)
	if err != nil {
		return Attribution{}, err
	}
	if len(staged) == 0 {
		return Attribution{Conversations: []Attributed{}}, nil
	}
	paths := make([]string, len(staged))
	for i, f := range staged {
		paths[i] = f.Path
	}
	e := Evidence{Staged: staged, Records: x.ForPaths(req.Workspace, req.Repo, paths), Visible: req.Visible}
	if dir != nil {
		e.Conversations = dir.Conversations(ctx)
		if req.Workspace != "" {
			e.Bound = dir.BoundTo(ctx, req.Workspace)
		}
	}
	if err := ctx.Err(); err != nil {
		return Attribution{}, err
	}
	return Score(e), nil
}
