//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bufio"
	"bytes"
	"context"
	"io/fs"
	"net/http"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// GitStatusAPI summarises the working-tree state of every git repository found
// under the current project — the root repo plus any nested subrepos/submodules
// — for the sidebar "Git status" info card. The project path is read through a
// provider func so a runtime project switch transparently retargets the scan.
type GitStatusAPI struct {
	pathProvider func() string
	// workspaceRoot resolves a conversation's bound workspace root (else ""), so
	// the diff/status card reflects the working tree the visible conversation's
	// agent is actually editing. Nil ⇒ always scan the project root.
	workspaceRoot func(convID string) string
}

// NewGitStatusAPI creates a new GitStatusAPI. pathProvider must return the
// current project path on each call ("" when no project is loaded).
// workspaceRoot resolves a conversation's bound workspace root (may be nil).
func NewGitStatusAPI(pathProvider func() string, workspaceRoot func(convID string) string) *GitStatusAPI {
	return &GitStatusAPI{pathProvider: pathProvider, workspaceRoot: workspaceRoot}
}

// Repo-discovery bounds. The walk is deliberately shallow — a git repo lives at
// the top of its tree, so scanning a few levels catches the root repo and its
// direct submodules without risking a long recursive crawl of a deep source tree.
const (
	gitScanMaxDepth = 4  // directory levels below the project root to descend
	gitScanMaxRepos = 32 // stop discovering after this many repos
	gitStatusPerCmd = 3 * time.Second
	gitStatusBudget = 6 * time.Second
)

// gitRepoStatus is one repository's summary. Path is relative to the project
// root ("" for the root repo itself), always forward-slashed.
type gitRepoStatus struct {
	Path    string `json:"path"`
	Changed int    `json:"changed"` // files with working-tree changes (incl. untracked)
	Staged  int    `json:"staged"`  // files with staged (index) changes
}

// gitStatusResponse is the JSON response shape for GET /api/git/status.
type gitStatusResponse struct {
	Root  string          `json:"root"`
	Repos []gitRepoStatus `json:"repos"`
}

// HandleGitStatus handles GET /api/git/status. It discovers repositories under
// the project root and reports each one's changed/staged file counts. Results
// are best-effort: a repo whose `git status` fails (git missing, bare repo) is
// simply omitted rather than failing the whole response.
func (a *GitStatusAPI) HandleGitStatus(w http.ResponseWriter, r *http.Request) {
	root := a.pathProvider()
	// Scope the scan to the visible conversation's bound workspace when one is
	// passed, so each tab's diff card reflects its own checkout.
	if convID := r.URL.Query().Get("conversationId"); convID != "" && a.workspaceRoot != nil {
		if ws := a.workspaceRoot(convID); ws != "" {
			root = ws
		}
	}
	resp := gitStatusResponse{Root: root, Repos: []gitRepoStatus{}}
	if root == "" {
		WriteJSON(w, r, 0, resp)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), gitStatusBudget)
	defer cancel()

	for _, dir := range discoverRepos(ctx, root) {
		changed, staged, ok := repoStatus(ctx, dir)
		if !ok {
			continue
		}
		rel, err := filepath.Rel(root, dir)
		if err != nil || rel == "." {
			rel = ""
		}
		resp.Repos = append(resp.Repos, gitRepoStatus{
			Path:    filepath.ToSlash(rel),
			Changed: changed,
			Staged:  staged,
		})
	}

	// Root repo first, then nested repos alphabetically — stable ordering so the
	// card doesn't reshuffle between polls.
	sort.SliceStable(resp.Repos, func(i, j int) bool {
		return resp.Repos[i].Path < resp.Repos[j].Path
	})

	WriteJSON(w, r, 0, resp)
}

// discoverRepos walks the project tree (bounded in depth, repo count, and pruned
// of heavy/uninteresting directories) and returns the absolute path of every
// directory that holds a `.git` entry. `.git` is a directory in a normal repo
// and a file in a submodule or linked worktree, so both are recognised. The walk
// aborts promptly if ctx is cancelled (e.g. the client disconnected).
func discoverRepos(ctx context.Context, root string) []string {
	var repos []string
	sep := string(filepath.Separator)

	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable entry — skip it, keep walking
		}
		if ctx.Err() != nil {
			return filepath.SkipAll // request cancelled / budget spent — stop walking
		}
		if len(repos) >= gitScanMaxRepos {
			return filepath.SkipAll
		}

		if !d.IsDir() {
			// A `.git` file marks a submodule or linked-worktree repo root.
			if d.Name() == ".git" {
				repos = append(repos, filepath.Dir(p))
			}
			return nil
		}

		name := d.Name()
		if name == ".git" {
			repos = append(repos, filepath.Dir(p))
			return fs.SkipDir // never descend into git internals
		}
		if p == root {
			return nil // always scan the root itself
		}
		// Prune directories that are large and never repo roots we care about.
		switch name {
		case "node_modules", "vendor", "dist", "build", ".juggler":
			return fs.SkipDir
		}
		// Depth guard: stop descending past the configured level.
		if rel, rerr := filepath.Rel(root, p); rerr == nil {
			if strings.Count(rel, sep)+1 >= gitScanMaxDepth {
				return fs.SkipDir
			}
		}
		return nil
	})

	return repos
}

// repoStatus runs `git status --porcelain` in dir and tallies changed vs staged
// files. ok is false when git could not report (missing binary, not a work tree,
// timeout), so the caller can omit the repo entirely.
func repoStatus(ctx context.Context, dir string) (changed, staged int, ok bool) {
	cctx, cancel := context.WithTimeout(ctx, gitStatusPerCmd)
	defer cancel()

	// --no-optional-locks: this is a background poll, so never take index.lock to
	// write back refreshed stat info — that would contend with the user's own git
	// client mid-operation. Status is still computed correctly, just not persisted.
	cmd := exec.CommandContext(cctx, "git", "--no-optional-locks", "status", "--porcelain")
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return 0, 0, false
	}

	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if len(line) < 2 {
			continue
		}
		// Porcelain v1: column 0 is the index (staged) state, column 1 is the
		// working-tree state. '?' in both marks an untracked file.
		if x := line[0]; x != ' ' && x != '?' {
			staged++
		}
		if line[1] != ' ' {
			changed++
		}
	}
	return changed, staged, true
}
