//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/gitview/internal/clocks"
)

// turnProject is a repository mid-way through some work when a turn begins:
// a tracked file edited, an untracked file, and an ignored one.
func turnProject(t *testing.T) *gitProject {
	t.Helper()
	p := newGitProject(t)
	p.write(".gitignore", "*.log\n")
	p.write("tracked.txt", "one\n")
	p.write("before.txt", "before\n")
	p.commit("Initial")
	p.write("before.txt", "before, edited before the turn\n")
	p.write("untracked-before.txt", "here already\n")
	p.write("noise.log", "ignored\n")
	return p
}

// The tree a snapshot writes holds the working tree as `git add -A` sees it.
func TestWorktreeTreeHoldsWhatAddWouldTake(t *testing.T) {
	t.Parallel()
	p := turnProject(t)
	tree, err := WorktreeTree(t.Context(), p.dir)
	if err != nil {
		t.Fatal(err)
	}
	got := p.git("ls-tree", "-r", "--name-only", tree)
	for _, want := range []string{"tracked.txt", "before.txt", "untracked-before.txt"} {
		if !strings.Contains(got, want+"\n") {
			t.Errorf("snapshot tree lacks %s:\n%s", want, got)
		}
	}
	if strings.Contains(got, "noise.log") {
		t.Errorf("snapshot tree holds the ignored noise.log:\n%s", got)
	}
	if blob := p.git("cat-file", "-p", tree+":before.txt"); blob != "before, edited before the turn\n" {
		t.Errorf("before.txt in the snapshot = %q, want the working tree's", blob)
	}
}

// A same-size edit made in the second its file was staged is "racily clean":
// its stat matches the index entry, and only the entry's mtime not predating
// the index file's own tells git to look at the content. The private copy of
// the index keeps that mtime, so the edit is in the tree however late the copy
// is made.
func TestWorktreeTreeKeepsARacilyCleanEdit(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	index := strings.TrimSpace(p.git("rev-parse", "--path-format=absolute", "--git-path", "index"))
	// The staging and the edit must share a second of mtime, which git's stat
	// check cannot tell apart; the attempt is retried until they do.
	p.write("f.txt", "nil\n")
	p.commit("Initial")
	for {
		p.write("f.txt", "one\n")
		p.git("add", "f.txt")
		p.write("f.txt", "two\n")
		if sameSecond(t, filepath.Join(p.dir, "f.txt"), index) {
			break
		}
	}
	// The copy is then made in a later second than the index it copies.
	waitForNextSecond(t, index)
	tree, err := WorktreeTree(t.Context(), p.dir)
	if err != nil {
		t.Fatal(err)
	}
	if blob := p.git("cat-file", "-p", tree+":f.txt"); blob != "two\n" {
		t.Errorf("f.txt in the tree = %q, want the edit on disk", blob)
	}
}

// sameSecond reports whether the two files' mtimes fall in one whole second.
func sameSecond(t *testing.T, a, b string) bool {
	t.Helper()
	return mtime(t, a).Unix() == mtime(t, b).Unix()
}

// waitForNextSecond returns once the clock has passed the second of path's
// mtime — the condition under test is the clock itself moving on.
func waitForNextSecond(t *testing.T, path string) {
	t.Helper()
	until := mtime(t, path).Truncate(time.Second).Add(time.Second)
	time.Sleep(time.Until(until) + 10*time.Millisecond)
}

func mtime(t *testing.T, path string) time.Time {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.ModTime()
}

// @turn shows what changed since the conversation's snapshot — edits, new
// files and deletions — and nothing that was already there when it was taken.
func TestTurnScopeShowsOnlyWhatChangedSinceTheSnapshot(t *testing.T) {
	t.Parallel()
	p := turnProject(t)
	tree, err := WorktreeTree(t.Context(), p.dir)
	if err != nil {
		t.Fatal(err)
	}
	p.git("update-ref", "refs/juggler/turns/conv-1", tree)

	p.write("tracked.txt", "one\ntwo\n")
	p.write("made-this-turn.txt", "new\n")
	p.write("more.log", "ignored\n")

	s, err := ParseScope("@turn")
	if err != nil {
		t.Fatal(err)
	}
	resp := Review(t.Context(), p.root, s.WithConversation("conv-1"))
	if len(resp.Repos) != 1 {
		t.Fatalf("review = %+v, want one repository", resp)
	}
	repo := resp.Repos[0]
	if repo.Error != "" {
		t.Fatalf("review error: %s", repo.Error)
	}
	if got, want := fileCodes(repo), "made-this-turn.txt:.A tracked.txt:.M"; got != want {
		t.Errorf("@turn files = %q, want %q", got, want)
	}

	d, err := Diff(t.Context(), p.root, DiffRequest{Path: "tracked.txt", Scope: "@turn", Conv: "conv-1"})
	if err != nil {
		t.Fatal(err)
	}
	if d.Status == "unchanged" || len(d.Hunks) == 0 {
		t.Errorf("tracked.txt diff in @turn = %+v, want its edit", d)
	}
	d, err = Diff(t.Context(), p.root, DiffRequest{Path: "before.txt", Scope: "@turn", Conv: "conv-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Hunks) != 0 {
		t.Errorf("before.txt diff in @turn = %+v, want nothing: it was edited before the turn", d)
	}
}

// Without a snapshot, or without a conversation, @turn says so rather than
// comparing against anything else.
func TestTurnScopeWithoutASnapshotIsRefused(t *testing.T) {
	t.Parallel()
	p := turnProject(t)
	s, err := ParseScope("@turn")
	if err != nil {
		t.Fatal(err)
	}
	for conv, want := range map[string]string{
		"conv-none": "This conversation has no turn snapshot yet",
		"":          "The @turn scope needs a conversation",
		"../x":      "The @turn scope needs a conversation",
	} {
		_, err := resolveScope(t.Context(), p.dir, s.WithConversation(conv), clocks.Diff.PerCmd)
		var refusal *RequestError
		if !errors.As(err, &refusal) || !strings.Contains(err.Error(), want) {
			t.Errorf("resolve @turn for %q = %v, want a refusal saying %q", conv, err, want)
		}
	}
	resp := Review(t.Context(), p.root, s.WithConversation("conv-none"))
	if len(resp.Repos) != 1 || !strings.Contains(resp.Repos[0].Error, "no turn snapshot") {
		t.Errorf("review without a snapshot = %+v, want the repository to say it has none", resp.Repos)
	}
}
