//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"juggler/cmd/juggler/gitview/internal/clocks"
)

// Refs is what a repository has named: its branches, its remotes' branches, its
// tags and its stashes — the git client's Refs place, all but the worktrees.
//
// All of it lives in the repository's common directory, so every working tree
// of the repository reads the same Refs; only Branch.Head says which branch
// the tree asked has out.
type Refs struct {
	Repo     string   `json:"repo"`
	Branches []Branch `json:"branches"`
	Remotes  []Remote `json:"remotes"`
	Tags     []Tag    `json:"tags"` // newest first
	Stashes  []Stash  `json:"stashes"`

	// FetchedAt is when the repository last fetched, in Unix milliseconds: the
	// time FETCH_HEAD was written, or 0 when it never has been.
	FetchedAt int64 `json:"fetchedAt"`

	// Truncated is set when a section held more than refsSectionMax entries and
	// lists only the first of them.
	Truncated bool `json:"truncated"`
}

// Branch is one local branch.
type Branch struct {
	Name     string `json:"name"`
	Sha      string `json:"sha"`
	Subject  string `json:"subject"`
	Date     int64  `json:"date"` // its tip's commit time, Unix seconds
	Upstream string `json:"upstream,omitempty"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
	Gone     bool   `json:"gone,omitempty"` // it has an upstream that no longer exists

	// Worktree is the tree that has it checked out, anywhere on disk, and ""
	// when none does. Head is whether that is the tree the read was asked of.
	Worktree string `json:"worktree,omitempty"`
	Head     bool   `json:"head,omitempty"`
}

// Remote is one remote, where it fetches from, and the branches the repository
// last fetched from it. URL is "" for a remote with none set.
type Remote struct {
	Name     string         `json:"name"`
	URL      string         `json:"url"`
	Branches []RemoteBranch `json:"branches"`
}

// RemoteBranch is one remote-tracking branch, named without its remote.
type RemoteBranch struct {
	Name    string `json:"name"`
	Sha     string `json:"sha"`
	Subject string `json:"subject"`
	Date    int64  `json:"date"`
}

// Tag is one tag. Sha is what the tag's ref names — the tag object, for an
// annotated tag — and Target the commit it comes to. Restoring a deleted tag
// means restoring Sha, or an annotated tag comes back lightweight.
type Tag struct {
	Name      string `json:"name"`
	Sha       string `json:"sha"`
	Target    string `json:"target"`
	Annotated bool   `json:"annotated"`
	Subject   string `json:"subject"`
	Date      int64  `json:"date"`
}

// Stash is one stash entry, newest first. It is named by Sha because its
// position (stash@{n}) moves whenever another stash is made or dropped.
type Stash struct {
	Sha     string `json:"sha"`
	Message string `json:"message"`
	Date    int64  `json:"date"`
}

const (
	refsSectionMax = 5000    // entries listed in one section before it is cut
	refsReadMax    = 8 << 20 // bytes of one listing kept
)

// The for-each-ref format every section is read with: one ref per line, its
// fields separated by NUL, which no ref name, path or one-line subject holds.
const refsFormat = "%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00" +
	"%(upstream:short)%00%(upstream:track,nobracket)%00%(worktreepath)%00%(HEAD)%00" +
	"%(symref)%00%(creatordate:unix)%00%(contents:subject)"

// refLine is one line of refsFormat.
type refLine struct {
	name, sha, kind, peeled, upstream, track, worktree, head, symref, subject string
	date                                                                      int64
}

// ReadRefs reads one repository under root, named as the API names it.
func ReadRefs(ctx context.Context, root, repo string) (Refs, error) {
	ctx, cancel := context.WithTimeout(ctx, clocks.Review.Budget)
	defer cancel()
	dir, err := ResolveRepo(ctx, root, repo)
	if err != nil {
		return Refs{}, err
	}
	_, common, err := gitDirsOf(ctx, dir)
	if err != nil {
		return Refs{}, err
	}
	r := Refs{Repo: RepoPath(root, dir), Branches: []Branch{}, Remotes: []Remote{}, Tags: []Tag{}, Stashes: []Stash{}}

	heads, err := readRefLines(ctx, dir, &r, "--sort=refname", "refs/heads")
	if err != nil {
		return Refs{}, err
	}
	for _, l := range heads {
		b := Branch{
			Name: strings.TrimPrefix(l.name, "refs/heads/"), Sha: l.sha, Subject: l.subject, Date: l.date,
			Upstream: l.upstream, Head: l.head == "*",
		}
		b.Ahead, b.Behind, b.Gone = parseTrack(l.track)
		if l.worktree != "" {
			b.Worktree = mainTreePath(ctx, common, resolvedPath(l.worktree))
		}
		r.Branches = append(r.Branches, b)
	}

	if err := readRemotes(ctx, dir, &r); err != nil {
		return Refs{}, err
	}

	tags, err := readRefLines(ctx, dir, &r, "--sort=-creatordate", "refs/tags")
	if err != nil {
		return Refs{}, err
	}
	for _, l := range tags {
		t := Tag{Name: strings.TrimPrefix(l.name, "refs/tags/"), Sha: l.sha, Target: l.sha, Subject: l.subject, Date: l.date}
		if l.kind == "tag" {
			t.Annotated = true
			if l.peeled != "" {
				t.Target = l.peeled
			}
		}
		r.Tags = append(r.Tags, t)
	}

	if r.Stashes, err = readStashes(ctx, dir, &r); err != nil {
		return Refs{}, err
	}
	if info, err := os.Stat(filepath.Join(common, "FETCH_HEAD")); err == nil {
		r.FetchedAt = info.ModTime().UnixMilli()
	}
	return r, nil
}

// readRefLines lists the refs under one prefix, at most refsSectionMax of
// them, marking r truncated when there were more.
func readRefLines(ctx context.Context, dir string, r *Refs, sort, prefix string) ([]refLine, error) {
	out, err := gitRead(ctx, dir, clocks.Review.PerCmd, refsReadMax,
		"for-each-ref", "--format="+refsFormat, sort, "--count="+strconv.Itoa(refsSectionMax+1), prefix)
	if err != nil {
		return nil, err
	}
	if out.Truncated {
		r.Truncated = true
	}
	var lines []refLine
	for _, raw := range strings.Split(string(out.Kept), "\n") {
		f := strings.Split(raw, "\x00")
		if len(f) != 11 {
			continue
		}
		if len(lines) == refsSectionMax {
			r.Truncated = true
			break
		}
		date, _ := strconv.ParseInt(f[9], 10, 64)
		lines = append(lines, refLine{
			name: f[0], sha: f[1], kind: f[2], peeled: f[3], upstream: f[4], track: f[5],
			worktree: f[6], head: f[7], symref: f[8], date: date, subject: f[10],
		})
	}
	return lines, nil
}

// readRemotes lists every remote, and under each the branches fetched from it.
// A remote's name may itself hold a slash, so a remote-tracking ref belongs to
// the longest remote name it starts with. A remote's symbolic HEAD is not a
// branch and is left out.
func readRemotes(ctx context.Context, dir string, r *Refs) error {
	out, err := gitRead(ctx, dir, clocks.Review.PerCmd, refsReadMax, "remote")
	if err != nil {
		return err
	}
	index := map[string]int{}
	for _, name := range strings.Fields(string(out.Kept)) {
		index[name] = len(r.Remotes)
		r.Remotes = append(r.Remotes, Remote{Name: name, Branches: []RemoteBranch{}})
	}
	// "<name>\t<url> (fetch)", and a (push) line after it, for each remote with a URL.
	urls, err := gitRead(ctx, dir, clocks.Review.PerCmd, refsReadMax, "remote", "-v")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(urls.Kept), "\n") {
		name, rest, ok := strings.Cut(line, "\t")
		url, fetch := strings.CutSuffix(rest, " (fetch)")
		if i, known := index[name]; ok && fetch && known {
			r.Remotes[i].URL = url
		}
	}
	lines, err := readRefLines(ctx, dir, r, "--sort=refname", "refs/remotes")
	if err != nil {
		return err
	}
	for _, l := range lines {
		if l.symref != "" {
			continue
		}
		rest := strings.TrimPrefix(l.name, "refs/remotes/")
		owner := ""
		for name := range index {
			if strings.HasPrefix(rest, name+"/") && len(name) > len(owner) {
				owner = name
			}
		}
		if owner == "" {
			continue
		}
		rm := &r.Remotes[index[owner]]
		rm.Branches = append(rm.Branches, RemoteBranch{
			Name: strings.TrimPrefix(rest, owner+"/"), Sha: l.sha, Subject: l.subject, Date: l.date,
		})
	}
	return nil
}

// readStashes lists the stash entries, newest first.
func readStashes(ctx context.Context, dir string, r *Refs) ([]Stash, error) {
	out, err := gitRead(ctx, dir, clocks.Review.PerCmd, refsReadMax, "stash", "list", "--format=%H%x00%ct%x00%gs")
	if err != nil {
		return nil, err
	}
	stashes := []Stash{}
	for _, raw := range strings.Split(string(out.Kept), "\n") {
		f := strings.SplitN(raw, "\x00", 3)
		if len(f) != 3 {
			continue
		}
		if len(stashes) == refsSectionMax {
			r.Truncated = true
			break
		}
		date, _ := strconv.ParseInt(f[1], 10, 64)
		stashes = append(stashes, Stash{Sha: f[0], Date: date, Message: f[2]})
	}
	return stashes, nil
}

// parseTrack reads %(upstream:track,nobracket): "ahead 1, behind 2", either
// half alone, "gone", or nothing when the branch is level or has no upstream.
func parseTrack(track string) (ahead, behind int, gone bool) {
	if track == "gone" {
		return 0, 0, true
	}
	for _, part := range strings.Split(track, ", ") {
		word, n, ok := strings.Cut(part, " ")
		if !ok {
			continue
		}
		count, _ := strconv.Atoi(n)
		switch word {
		case "ahead":
			ahead = count
		case "behind":
			behind = count
		}
	}
	return ahead, behind, false
}
