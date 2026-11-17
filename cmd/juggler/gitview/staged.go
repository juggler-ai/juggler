//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"bytes"
	"context"
	"strings"

	"juggler/cmd/juggler/gitview/internal/clocks"
	"juggler/cmd/juggler/msg"
)

// stagedReadMax bounds what a read of the staged files keeps: a raw diff line
// is about a hundred bytes, so this is several hundred thousand files.
const stagedReadMax = 32 << 20

// StagedFile is one file a commit made now would change, and the blob id the
// index holds for it: what is being committed. Path is relative to the
// repository's top level, slash-separated. Blob is "" for a file the commit
// deletes, and for one with unresolved conflicts.
type StagedFile struct {
	Path string
	Blob string
}

// ReadStaged lists the files of repository repo under root that a commit made
// now would change: those whose index entry differs from HEAD's tree. Amending,
// the commit replaces HEAD, so the comparison is with HEAD's parent and the
// files HEAD itself changed are included.
//
// It is one diff-index (plumbing, which refreshes nothing; see gitcmd.Command),
// whose raw records carry the index's blob id beside each path. With nothing to
// compare against — no commit yet, or amending the first — every index entry is
// staged, and they are read from ls-files instead.
func ReadStaged(ctx context.Context, root, repo string, amend bool) ([]StagedFile, error) {
	ctx, cancel := context.WithTimeout(ctx, clocks.Review.Budget)
	defer cancel()
	dir, err := ResolveRepo(ctx, root, repo)
	if err != nil {
		return nil, err
	}
	base := "HEAD"
	if amend {
		base = "HEAD^"
	}
	out, err := gitRead(ctx, dir, clocks.Review.PerCmd, stagedReadMax,
		"diff-index", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", base, "--")
	if err == nil {
		if out.Truncated {
			return nil, tooManyStaged()
		}
		return parseRawStaged(out.Kept), nil
	}
	if ctx.Err() != nil {
		return nil, err
	}
	// The base does not exist (or diff-index could not run, and ls-files says
	// why when it cannot either).
	out, err = gitRead(ctx, dir, clocks.Review.PerCmd, stagedReadMax, "ls-files", "-s", "-z", "--full-name")
	if err != nil {
		return nil, err
	}
	if out.Truncated {
		return nil, tooManyStaged()
	}
	return parseIndexEntries(out.Kept), nil
}

func tooManyStaged() error {
	return msg.NewError("Too many files are staged to read them all.")
}

// parseRawStaged reads diff-index's -z raw records:
// ":<old mode> <new mode> <old blob> <new blob> <status>" NUL "<path>" NUL.
func parseRawStaged(raw []byte) []StagedFile {
	fields := bytes.Split(raw, []byte{0})
	out := []StagedFile{}
	for i := 0; i+1 < len(fields); i += 2 {
		meta := strings.Fields(strings.TrimPrefix(string(fields[i]), ":"))
		if len(meta) < 5 {
			break
		}
		f := StagedFile{Path: string(fields[i+1]), Blob: meta[3]}
		if status := meta[4]; status == "D" || status == "U" || strings.Trim(f.Blob, "0") == "" {
			f.Blob = ""
		}
		out = append(out, f)
	}
	return out
}

// parseIndexEntries reads ls-files -s -z: "<mode> <blob> <stage>\t<path>" NUL.
// A path with unresolved conflicts is listed once, at each of its stages, and
// is kept once, with no blob.
func parseIndexEntries(raw []byte) []StagedFile {
	out := []StagedFile{}
	at := map[string]int{}
	for entry := range bytes.SplitSeq(raw, []byte{0}) {
		meta, path, ok := strings.Cut(string(entry), "\t")
		fields := strings.Fields(meta)
		if !ok || len(fields) < 3 {
			continue
		}
		f := StagedFile{Path: path, Blob: fields[1]}
		if fields[2] != "0" {
			f.Blob = ""
		}
		if i, seen := at[path]; seen {
			out[i].Blob = ""
			continue
		}
		at[path] = len(out)
		out = append(out, f)
	}
	return out
}
