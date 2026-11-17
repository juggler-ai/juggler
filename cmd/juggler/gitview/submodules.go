//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"juggler/cmd/juggler/gitview/internal/clocks"
)

// Submodules is a repository's submodules: each one `.gitmodules` names and the
// index records a commit for, at most submodulesMax of them.
type Submodules struct {
	Repo       string      `json:"repo"`
	Submodules []Submodule `json:"submodules"`
	Truncated  bool        `json:"truncated"`
}

// Submodule is one submodule. Path is where it is checked out, relative to its
// repository and forward-slashed; Recorded is the commit the repository's
// index records for it — the commit an update checks out — and Head and
// Branch what is checked out in it now, both "" when nothing is.
type Submodule struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	URL      string `json:"url"`
	Recorded string `json:"recorded"`
	Head     string `json:"head,omitempty"`
	Branch   string `json:"branch,omitempty"`
	State    string `json:"state"`
}

// The states of a Submodule.
const (
	SubmoduleCurrent       = "current"       // checked out at the recorded commit
	SubmoduleMoved         = "moved"         // checked out at another commit
	SubmoduleUninitialized = "uninitialized" // not checked out
	SubmoduleConflicted    = "conflicted"    // a merge left its recorded commit in conflict
)

const (
	submodulesMax     = 500     // submodules listed before the list is cut
	submodulesReadMax = 4 << 20 // bytes of one listing kept
)

// ReadSubmodules reads one repository under root, named as the API names it.
//
// `.gitmodules` is read for names, paths and URLs and the index for the
// commits recorded, so a submodule never checked out is listed as surely as one
// that is; then each checked-out one is asked where its HEAD is. Nothing here
// runs `git submodule`, whose status would describe every one of them by
// running git in each.
func ReadSubmodules(ctx context.Context, root, repo string) (Submodules, error) {
	ctx, cancel := context.WithTimeout(ctx, clocks.Review.Budget)
	defer cancel()
	dir, err := ResolveRepo(ctx, root, repo)
	if err != nil {
		return Submodules{}, err
	}
	s := Submodules{Repo: RepoPath(root, dir), Submodules: []Submodule{}}
	if _, err := os.Stat(filepath.Join(dir, ".gitmodules")); err != nil {
		return s, nil
	}

	named, err := readGitmodules(ctx, dir)
	if err != nil || len(named) == 0 {
		return s, err
	}
	paths := make([]string, 0, len(named))
	for path := range named {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	recorded, conflicted, err := readGitlinks(ctx, dir, paths)
	if err != nil {
		return Submodules{}, err
	}
	for _, path := range paths {
		sha, ok := recorded[path]
		if !ok {
			continue // named in .gitmodules, but nothing is recorded for it
		}
		if len(s.Submodules) == submodulesMax {
			s.Truncated = true
			break
		}
		m := named[path]
		m.Recorded = sha
		if conflicted[path] {
			m.State = SubmoduleConflicted
		} else {
			m.Head, m.Branch = readSubmoduleHead(ctx, filepath.Join(dir, filepath.FromSlash(path)))
			switch m.Head {
			case "":
				m.State = SubmoduleUninitialized
			case sha:
				m.State = SubmoduleCurrent
			default:
				m.State = SubmoduleMoved
			}
		}
		s.Submodules = append(s.Submodules, m)
	}
	return s, nil
}

// readGitmodules is what `.gitmodules` says of each submodule, by path. A name
// may hold dots, so the key is cut at its known ends rather than split.
func readGitmodules(ctx context.Context, dir string) (map[string]Submodule, error) {
	out, err := gitRead(ctx, dir, clocks.Review.PerCmd, submodulesReadMax,
		"config", "-z", "--file", ".gitmodules", "--get-regexp", `^submodule\..*\.(path|url)$`)
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return nil, nil // git's word, said silently, for no key matching
	}
	if err != nil {
		return nil, err
	}
	byName := map[string]*Submodule{}
	var order []string
	for _, entry := range strings.Split(string(out.Kept), "\x00") {
		key, value, ok := strings.Cut(entry, "\n")
		if !ok {
			continue
		}
		rest := strings.TrimPrefix(key, "submodule.")
		var name, field string
		switch {
		case strings.HasSuffix(rest, ".path"):
			name, field = strings.TrimSuffix(rest, ".path"), "path"
		case strings.HasSuffix(rest, ".url"):
			name, field = strings.TrimSuffix(rest, ".url"), "url"
		default:
			continue
		}
		m := byName[name]
		if m == nil {
			m = &Submodule{Name: name}
			byName[name] = m
			order = append(order, name)
		}
		if field == "path" {
			m.Path = strings.Trim(filepath.ToSlash(value), "/")
		} else {
			m.URL = value
		}
	}
	named := map[string]Submodule{}
	for _, name := range order {
		if m := byName[name]; m.Path != "" {
			named[m.Path] = *m
		}
	}
	return named, nil
}

// readGitlinks is the commit the index records at each of paths that is a
// submodule (a gitlink, mode 160000), and which of them a merge left in
// conflict.
func readGitlinks(ctx context.Context, dir string, paths []string) (recorded map[string]string, conflicted map[string]bool, err error) {
	args := append([]string{"ls-files", "--stage", "-z", "--"}, paths...)
	out, err := gitRead(ctx, dir, clocks.Review.PerCmd, submodulesReadMax, args...)
	if err != nil {
		return nil, nil, err
	}
	recorded = map[string]string{}
	conflicted = map[string]bool{}
	for _, entry := range strings.Split(string(out.Kept), "\x00") {
		meta, path, ok := strings.Cut(entry, "\t")
		if !ok {
			continue
		}
		f := strings.Fields(meta)
		if len(f) != 3 || f[0] != "160000" {
			continue
		}
		if f[2] != "0" {
			conflicted[path] = true
			if f[2] == "2" || recorded[path] == "" {
				recorded[path] = f[1] // ours, while there is one
			}
			continue
		}
		recorded[path] = f[1]
	}
	return recorded, conflicted, nil
}

// readSubmoduleHead is the commit and branch checked out in the submodule at
// dir, both "" when it is not checked out. A directory with no `.git` of its
// own is not asked: git would answer for the repository around it.
func readSubmoduleHead(ctx context.Context, dir string) (head, branch string) {
	if _, err := os.Lstat(filepath.Join(dir, ".git")); err != nil {
		return "", ""
	}
	out, err := gitRead(ctx, dir, clocks.Review.PerCmd, gitDiffMaxMeta, "rev-parse", "-q", "--verify", "HEAD")
	if err != nil {
		return "", ""
	}
	head = strings.TrimSpace(string(out.Kept))
	if ref, err := gitRead(ctx, dir, clocks.Review.PerCmd, gitDiffMaxMeta, "symbolic-ref", "-q", "--short", "HEAD"); err == nil {
		branch = strings.TrimSpace(string(ref.Kept))
	}
	return head, branch
}
