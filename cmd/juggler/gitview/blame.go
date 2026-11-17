//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"bytes"
	"context"
	"path/filepath"
	"strconv"
	"strings"

	"juggler/cmd/juggler/gitcmd"
	"juggler/cmd/juggler/gitview/internal/clocks"
	"juggler/cmd/juggler/msg"
)

// BlameIndex is the revision of a blame of the index: the file as staged.
const BlameIndex = "@staged"

// blameLinesMax is the longest file blamed, in lines; blameReadMax the most of
// git's porcelain kept.
const (
	blameLinesMax = 50_000
	blameReadMax  = 64 << 20
)

// BlameQuery is one blame read: the file Path, as it is at Rev — a commit, ""
// for the working tree, or BlameIndex for the index.
type BlameQuery struct {
	Path string `json:"path"`
	Rev  string `json:"rev,omitempty"`
}

// BlameCommit is a commit some line of a blame came from. Sha is "" for lines
// nobody has committed yet.
type BlameCommit struct {
	Sha     string `json:"sha"`
	Author  string `json:"author"`
	Date    int64  `json:"date"` // its author time, Unix seconds
	Summary string `json:"summary"`
}

// Blame is which commit last changed each line of a file: Lines[i] is the
// index in Commits of line i+1's.
type Blame struct {
	Repo    string        `json:"repo"`
	Path    string        `json:"path"`
	Rev     string        `json:"rev"`
	Commits []BlameCommit `json:"commits"`
	Lines   []int         `json:"lines"`
}

// ReadBlame blames one file of the repository repo under root, named as the
// API names it. A path out of the repository, a revision that is not one, or a
// file too long to blame is a *RequestError.
func ReadBlame(ctx context.Context, root, repo string, q BlameQuery) (Blame, error) {
	ctx, cancel := context.WithTimeout(ctx, clocks.Review.Budget)
	defer cancel()
	dir, err := ResolveRepo(ctx, root, repo)
	if err != nil {
		return Blame{}, err
	}
	abs, err := FileInRepo(dir, q.Path)
	if err != nil {
		return Blame{}, err
	}
	rel, err := filepath.Rel(dir, abs)
	if err != nil {
		return Blame{}, err
	}
	path := filepath.ToSlash(rel)

	args := []string{"blame", "--porcelain"}
	var stdin []byte
	switch q.Rev {
	case "":
	case BlameIndex:
		staged, err := gitRead(ctx, dir, clocks.Review.PerCmd, blameReadMax, "show", ":"+path)
		if err != nil {
			return Blame{}, &RequestError{msg.NewError("{path} is not in the index.", "path", path)}
		}
		stdin = staged.Kept
		args = append(args, "--contents", "-")
	default:
		if err := checkRevision(q.Rev); err != nil {
			return Blame{}, err
		}
		sha, err := resolveCommit(ctx, dir, q.Rev, clocks.Review.PerCmd)
		if err != nil {
			return Blame{}, err
		}
		args = append(args, sha)
	}
	args = append(args, "--", path)

	cmd := gitCommand(ctx, dir, args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return Blame{}, ctx.Err()
		}
		return Blame{}, gitcmd.Failure(err, stderr.String())
	}
	if len(out) > blameReadMax {
		return Blame{}, &RequestError{msg.NewError("{path} is too large to blame.", "path", path)}
	}
	b, ok := parseBlame(out)
	if !ok {
		return Blame{}, &RequestError{msg.NewError("{path} is too large to blame.", "path", path)}
	}
	b.Repo, b.Path, b.Rev = RepoPath(root, dir), path, q.Rev
	return b, nil
}

// parseBlame reads `git blame --porcelain`: a header per line naming its
// commit and its number in the file, the commit's details after its first
// header, and the line itself after a tab. False when the file has more lines
// than blameLinesMax.
func parseBlame(out []byte) (Blame, bool) {
	b := Blame{Commits: []BlameCommit{}, Lines: []int{}}
	index := map[string]int{}
	current := -1
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" || line[0] == '\t' {
			continue
		}
		key, value, _ := strings.Cut(line, " ")
		if len(key) >= 40 && strings.Trim(key, "0123456789abcdef") == "" {
			fields := strings.Fields(value)
			if len(fields) < 2 {
				continue
			}
			at, ok := index[key]
			if !ok {
				sha := key
				if strings.Trim(sha, "0") == "" {
					sha = ""
				}
				at = len(b.Commits)
				index[key] = at
				b.Commits = append(b.Commits, BlameCommit{Sha: sha})
			}
			current = at
			n, _ := strconv.Atoi(fields[1])
			if n < 1 || n > blameLinesMax {
				return Blame{}, false
			}
			for len(b.Lines) < n {
				b.Lines = append(b.Lines, at)
			}
			b.Lines[n-1] = at
			continue
		}
		if current < 0 {
			continue
		}
		c := &b.Commits[current]
		switch key {
		case "author":
			c.Author = value
		case "author-time":
			c.Date = unixField(value)
		case "summary":
			c.Summary = value
		}
	}
	return b, true
}
