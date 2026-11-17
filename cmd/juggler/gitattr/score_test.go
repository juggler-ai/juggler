//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitattr

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/gitview"
)

// existing is a directory of conversations, each titled after its id and
// updated at the time given.
func existing(updated map[string]int64) map[string]Conversation {
	out := map[string]Conversation{}
	for id, t := range updated {
		out[id] = Conversation{Title: "Title of " + id, Updated: t}
	}
	return out
}

// described is an attribution as one line per conversation, best first:
// conv strong/weak/prior [files].
func described(a Attribution) string {
	var lines []string
	for _, c := range a.Conversations {
		lines = append(lines, fmt.Sprintf("%s %d/%d/%d %v", c.Conv, c.Strong, c.Weak, c.Prior, c.Files))
	}
	return fmt.Sprintf("staged %d: %s", a.Staged, strings.Join(lines, "; "))
}

func expectScore(t *testing.T, what string, got Attribution, want string) {
	t.Helper()
	if d := described(got); d != want {
		t.Errorf("%s:\n got %s\nwant %s", what, d, want)
	}
}

// A conversation whose version of a file is the one staged outranks one that
// only wrote a file of the same name, however many such files it wrote.
func TestAttributionScoreHashBeatsName(t *testing.T) {
	got := Score(Evidence{
		Staged: []gitview.StagedFile{{Path: "a.go", Blob: "A"}, {Path: "b.go", Blob: "B"}, {Path: "c.go", Blob: "C"}},
		Records: []Record{
			{Path: "a.go", Blob: "A", Conv: "c1", Strength: Strong, Time: 1},
			{Path: "b.go", Blob: "old-b", Conv: "c2", Strength: Strong, Time: 2},
			{Path: "c.go", Blob: "old-c", Conv: "c2", Strength: Strong, Time: 2},
		},
		Conversations: existing(map[string]int64{"c1": 1, "c2": 2}),
	})
	expectScore(t, "a hash match against two name-only matches", got, "staged 3: c1 1/0/0 [a.go]; c2 0/2/0 [b.go c.go]")
	if len(got.Conversations) == 0 || got.Conversations[0].Title != "Title of c1" {
		t.Errorf("conversations = %+v, want c1 first, with its title", got.Conversations)
	}
}

// Two conversations wrote one file: the one whose version is staged accounts
// for it and the other does not; two whose versions are the same both do.
func TestAttributionScoreTwoConversationsOnOneFile(t *testing.T) {
	convs := existing(map[string]int64{"c1": 1, "c2": 2})
	got := Score(Evidence{
		Staged: []gitview.StagedFile{{Path: "a.go", Blob: "A"}},
		Records: []Record{
			{Path: "a.go", Blob: "A", Conv: "c1", Strength: Strong, Time: 1},
			{Path: "a.go", Blob: "earlier", Conv: "c2", Strength: Strong, Time: 2},
		},
		Conversations: convs,
	})
	expectScore(t, "the blob match wins the file", got, "staged 1: c1 1/0/0 [a.go]")

	got = Score(Evidence{
		Staged: []gitview.StagedFile{{Path: "a.go", Blob: "A"}},
		Records: []Record{
			{Path: "a.go", Blob: "A", Conv: "c1", Strength: Strong, Time: 1},
			{Path: "a.go", Blob: "A", Conv: "c2", Strength: Strong, Time: 2},
		},
		Conversations: convs,
	})
	expectScore(t, "both wrote the staged version", got, "staged 1: c2 1/0/0 [a.go]; c1 1/0/0 [a.go]")
}

// A weak record — a shell command among several running — accounts for its
// file weakly even when its version is the staged one, and loses the file to a
// strong one.
func TestAttributionScoreWeakRecords(t *testing.T) {
	convs := existing(map[string]int64{"c1": 1, "c2": 2, "c3": 3})
	got := Score(Evidence{
		Staged: []gitview.StagedFile{{Path: "a.go", Blob: "A"}, {Path: "b.go", Blob: "B"}},
		Records: []Record{
			{Path: "a.go", Blob: "A", Conv: "c1", Strength: Weak, Time: 1},
			{Path: "a.go", Blob: "A", Conv: "c2", Strength: Weak, Time: 2},
			{Path: "b.go", Blob: "B", Conv: "c2", Strength: Weak, Time: 2},
			{Path: "b.go", Blob: "B", Conv: "c3", Strength: Strong, Time: 3},
		},
		Conversations: convs,
	})
	expectScore(t, "weak records", got, "staged 2: c3 1/0/0 [b.go]; c2 0/1/0 [a.go]; c1 0/1/0 [a.go]")
}

// The conversations bound to the tree's workspace account for every staged
// file nothing matches by version, ahead of a match by name alone, behind a
// match by version.
func TestAttributionScoreWorkspacePrior(t *testing.T) {
	got := Score(Evidence{
		Staged: []gitview.StagedFile{{Path: "a.go", Blob: "A"}, {Path: "b.go", Blob: "B"}, {Path: "c.go", Blob: "C"}},
		Records: []Record{
			{Workspace: "ws", Path: "a.go", Blob: "A", Conv: "c1", Strength: Strong, Time: 1},
			{Workspace: "ws", Path: "c.go", Blob: "old-c", Conv: "c2", Strength: Strong, Time: 2},
		},
		Conversations: existing(map[string]int64{"c1": 1, "c2": 2, "c3": 3}),
		Bound:         []string{"c3"},
	})
	expectScore(t, "a workspace's conversation", got, "staged 3: c1 1/0/0 [a.go]; c3 0/0/2 [b.go c.go]")

	got = Score(Evidence{
		Staged:        []gitview.StagedFile{{Path: "a.go", Blob: "A"}},
		Records:       []Record{{Workspace: "ws", Path: "a.go", Blob: "A", Conv: "c3", Strength: Strong, Time: 1}},
		Conversations: existing(map[string]int64{"c3": 3}),
		Bound:         []string{"c3"},
	})
	expectScore(t, "a bound conversation's own write counts once, strongly", got, "staged 1: c3 1/0/0 [a.go]")
}

// Conversations that account for as much as each other are ordered by the
// visible one, then by the most recent.
func TestAttributionScoreTieBreak(t *testing.T) {
	e := Evidence{
		Staged: []gitview.StagedFile{{Path: "a.go", Blob: "A"}, {Path: "b.go", Blob: "B"}},
		Records: []Record{
			{Path: "a.go", Blob: "A", Conv: "c1", Strength: Strong, Time: 10},
			{Path: "b.go", Blob: "B", Conv: "c2", Strength: Strong, Time: 5},
		},
		Conversations: existing(map[string]int64{"c1": 1, "c2": 20}),
	}
	expectScore(t, "most recent first", Score(e), "staged 2: c2 1/0/0 [b.go]; c1 1/0/0 [a.go]")
	e.Visible = "c1"
	expectScore(t, "the visible conversation first", Score(e), "staged 2: c1 1/0/0 [a.go]; c2 1/0/0 [b.go]")
}

// A conversation that no longer exists is left out, whatever it wrote and
// whatever it is bound to.
func TestAttributionScoreDeletedConversationsOmitted(t *testing.T) {
	got := Score(Evidence{
		Staged: []gitview.StagedFile{{Path: "a.go", Blob: "A"}, {Path: "b.go", Blob: "B"}},
		Records: []Record{
			{Workspace: "ws", Path: "a.go", Blob: "A", Conv: "gone", Strength: Strong, Time: 1},
			{Workspace: "ws", Path: "b.go", Blob: "B", Conv: "c1", Strength: Strong, Time: 1},
		},
		Conversations: existing(map[string]int64{"c1": 1}),
		Bound:         []string{"gone-too"},
	})
	expectScore(t, "deleted conversations", got, "staged 2: c1 1/0/0 [b.go]")
}

// scoreDirectory answers Read from fixed lists.
type scoreDirectory struct {
	convs map[string]Conversation
	bound map[string][]string
}

func (d scoreDirectory) Conversations(context.Context) map[string]Conversation { return d.convs }
func (d scoreDirectory) BoundTo(_ context.Context, ws string) []string         { return d.bound[ws] }

// Read scores what is staged against HEAD; amending, against HEAD's parent, so
// the files the commit being amended changed count too — all of its files when
// it is the first commit.
func TestAttributionScoreAmendIncludesHead(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	write := func(root, rel, content string) string {
		if err := os.WriteFile(filepath.Join(root, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return gitIn(t, root, "hash-object", rel)
	}
	commit := func(root string) {
		gitIn(t, root, "add", "-A")
		gitIn(t, root, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "c")
	}
	dir := scoreDirectory{convs: existing(map[string]int64{"c0": 1, "c1": 1, "c2": 2})}

	// base.txt, then a.txt (c1's) committed; b.txt (c2's) staged.
	root := t.TempDir()
	gitIn(t, root, "init", "-q")
	x := Open(filepath.Join(t.TempDir(), FileName))
	x.Add(Record{Path: "base.txt", Blob: write(root, "base.txt", "base\n"), Conv: "c0"})
	commit(root)
	x.Add(Record{Path: "a.txt", Blob: write(root, "a.txt", "a\n"), Conv: "c1"})
	commit(root)
	x.Add(Record{Path: "b.txt", Blob: write(root, "b.txt", "b\n"), Conv: "c2"})
	gitIn(t, root, "add", "b.txt")

	got, err := Read(t.Context(), x, root, Request{}, dir)
	if err != nil {
		t.Fatal(err)
	}
	expectScore(t, "committing", got, "staged 1: c2 1/0/0 [b.txt]")
	got, err = Read(t.Context(), x, root, Request{Amend: true}, dir)
	if err != nil {
		t.Fatal(err)
	}
	expectScore(t, "amending", got, "staged 2: c2 1/0/0 [b.txt]; c1 1/0/0 [a.txt]")

	// Amending the first commit: everything in it is new.
	first := t.TempDir()
	gitIn(t, first, "init", "-q")
	y := Open(filepath.Join(t.TempDir(), FileName))
	y.Add(Record{Path: "a.txt", Blob: write(first, "a.txt", "a\n"), Conv: "c1"})
	commit(first)
	y.Add(Record{Path: "b.txt", Blob: write(first, "b.txt", "b\n"), Conv: "c2"})
	gitIn(t, first, "add", "b.txt")
	got, err = Read(t.Context(), y, first, Request{Amend: true}, dir)
	if err != nil {
		t.Fatal(err)
	}
	expectScore(t, "amending the first commit", got, "staged 2: c2 1/0/0 [b.txt]; c1 1/0/0 [a.txt]")

	// A deletion is staged too, and only a name can account for it.
	gitIn(t, first, "rm", "-q", "a.txt")
	got, err = Read(t.Context(), y, first, Request{}, dir)
	if err != nil {
		t.Fatal(err)
	}
	expectScore(t, "a staged deletion", got, "staged 2: c2 1/0/0 [b.txt]; c1 0/1/0 [a.txt]")
}
