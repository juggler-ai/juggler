//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"fmt"
	"strings"
	"testing"
)

// The fixtures are real `git status --porcelain=v2 --branch` output. The entry
// fields before the path are fixed-width and uninteresting here, so they are
// written as plausible constants; what each test varies is the part it is about.
const (
	gitOrdinary = "%s N... 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 %s"
	gitRename   = "%s N... 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 R100 %s\t%s"
	gitUnmerged = "%s N... 100644 100644 100644 100644 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 %s"
)

func ordinary(xy, path string) string { return "1 " + fmt.Sprintf(gitOrdinary, xy, path) }
func rename(xy, path, orig string) string {
	return "2 " + fmt.Sprintf(gitRename, xy, path, orig)
}
func unmerged(xy, path string) string { return "u " + fmt.Sprintf(gitUnmerged, xy, path) }

func TestGitStatusParsesBranchHeaders(t *testing.T) {
	out := strings.Join([]string{
		"# branch.oid 1111111111111111111111111111111111111111",
		"# branch.head develop",
		"# branch.upstream origin/develop",
		"# branch.ab +3 -2",
		"# stash 4",
	}, "\n")

	got := parseGitStatusV2([]byte(out))
	if got.Head != "1111111111111111111111111111111111111111" {
		t.Errorf("Head = %q, want the commit oid", got.Head)
	}
	if got.Stashes != 4 {
		t.Errorf("Stashes = %d, want 4", got.Stashes)
	}
	if got.Branch != "develop" {
		t.Errorf("Branch = %q, want %q", got.Branch, "develop")
	}
	if got.Upstream != "origin/develop" {
		t.Errorf("Upstream = %q, want %q", got.Upstream, "origin/develop")
	}
	if got.Ahead != 3 || got.Behind != 2 {
		t.Errorf("Ahead/Behind = %d/%d, want 3/2", got.Ahead, got.Behind)
	}
	if got.Detached {
		t.Error("Detached = true on a named branch")
	}
}

func TestGitStatusDetachedHeadHasNoBranchName(t *testing.T) {
	out := "# branch.oid 1111111111111111111111111111111111111111\n# branch.head (detached)\n"

	got := parseGitStatusV2([]byte(out))
	if !got.Detached {
		t.Error("Detached = false on a detached head")
	}
	// "(detached)" is a state, not a name — reporting it as one would put a
	// parenthesised non-branch wherever the UI shows a branch.
	if got.Branch != "" {
		t.Errorf("Branch = %q, want empty on a detached head", got.Branch)
	}
}

func TestGitStatusWithoutUpstreamHasNoDivergence(t *testing.T) {
	out := "# branch.oid (initial)\n# branch.head main\n"

	got := parseGitStatusV2([]byte(out))
	if !got.Initial {
		t.Error("Initial = false for a repository with no commits")
	}
	if got.Head != "" {
		t.Errorf("Head = %q, want empty before the first commit", got.Head)
	}
	if got.Branch != "main" {
		t.Errorf("Branch = %q, want %q", got.Branch, "main")
	}
	if got.Upstream != "" {
		t.Errorf("Upstream = %q, want empty", got.Upstream)
	}
	if got.Ahead != 0 || got.Behind != 0 {
		t.Errorf("Ahead/Behind = %d/%d, want 0/0 without an upstream", got.Ahead, got.Behind)
	}
}

// The counts drive the info card, which shipped against porcelain v1. v2 spells
// "unmodified" as "." where v1 spelled it as a space, and every other letter is
// the same — so the same tree must produce the same two numbers it always did.
func TestGitStatusCountsMatchPorcelainV1Semantics(t *testing.T) {
	out := strings.Join([]string{
		"# branch.head main",
		ordinary("M.", "staged-only.go"),   // v1 "M "
		ordinary(".M", "worktree-only.go"), // v1 " M"
		ordinary("MM", "both.go"),          // v1 "MM"
		ordinary("A.", "added.go"),         // v1 "A "
		ordinary(".D", "deleted.go"),       // v1 " D"
		"? untracked.go",                   // v1 "??"
		unmerged("UU", "conflict.go"),      // v1 "UU"
	}, "\n")

	got := parseGitStatusV2([]byte(out))
	// staged: M. MM A. UU. changed: .M MM .D ? UU.
	if got.Staged != 4 {
		t.Errorf("Staged = %d, want 4", got.Staged)
	}
	if got.Changed != 5 {
		t.Errorf("Changed = %d, want 5", got.Changed)
	}
	if got.Conflicted != 1 {
		t.Errorf("Conflicted = %d, want 1", got.Conflicted)
	}
}

func TestGitNumstatAddsTrackedLineCounts(t *testing.T) {
	out := []byte("12\t3\tweb/app.js\x00-\t-\tassets/logo.png\x005\t0\t\x00old name.js\x00new name.js\x00")
	got := parseGitNumstat(out)

	want := map[string]gitDiffstat{
		"web/app.js":  {Added: 12, Removed: 3},
		"new name.js": {Added: 5, Removed: 0},
	}
	if len(got) != len(want) {
		t.Fatalf("parseGitNumstat returned %d entries, want %d: %+v", len(got), len(want), got)
	}
	for path, stat := range want {
		if got[path] != stat {
			t.Errorf("parseGitNumstat[%q] = %+v, want %+v", path, got[path], stat)
		}
	}
}

func TestGitStatusAppliesDiffstats(t *testing.T) {
	status := parseGitStatusV2([]byte(strings.Join([]string{
		ordinary(".M", "web/app.js"),
		ordinary(".M", "assets/logo.png"),
		"? notes.txt",
	}, "\n")))
	applyGitDiffstats(&status, map[string]gitDiffstat{
		"web/app.js": {Added: 12, Removed: 3},
	})

	if status.Added != 12 || status.Removed != 3 {
		t.Errorf("Added/Removed = %d/%d, want 12/3", status.Added, status.Removed)
	}
	if status.Files[0].Added == nil || *status.Files[0].Added != 12 ||
		status.Files[0].Removed == nil || *status.Files[0].Removed != 3 {
		t.Errorf("tracked file diffstat = %+v, want +12 -3", status.Files[0])
	}
	if status.Files[1].Added != nil || status.Files[2].Added != nil {
		t.Errorf("binary/untracked files must not claim zero lines: %+v", status.Files)
	}
}

func TestGitStatusUntrackedIsChangedNotStaged(t *testing.T) {
	got := parseGitStatusV2([]byte("? new.go\n"))

	if got.Changed != 1 || got.Staged != 0 {
		t.Errorf("Changed/Staged = %d/%d, want 1/0 for an untracked file", got.Changed, got.Staged)
	}
	if len(got.Files) != 1 {
		t.Fatalf("Files = %d entries, want 1", len(got.Files))
	}
	want := gitFileStatus{Path: "new.go", Index: ".", Worktree: "?"}
	if got.Files[0] != want {
		t.Errorf("Files[0] = %+v, want %+v", got.Files[0], want)
	}
}

func TestGitStatusReadsFileDetail(t *testing.T) {
	out := strings.Join([]string{
		"# branch.head main",
		ordinary("M.", "web/js/app.js"),
		ordinary(".D", "docs/gone.md"),
	}, "\n")

	got := parseGitStatusV2([]byte(out))
	want := []gitFileStatus{
		{Path: "web/js/app.js", Index: "M", Worktree: "."},
		{Path: "docs/gone.md", Index: ".", Worktree: "D"},
	}
	if len(got.Files) != len(want) {
		t.Fatalf("Files = %d entries, want %d", len(got.Files), len(want))
	}
	for i := range want {
		if got.Files[i] != want[i] {
			t.Errorf("Files[%d] = %+v, want %+v", i, got.Files[i], want[i])
		}
	}
}

// A rename line ends with the new path, a tab, then the old one. Taking the
// whole tail would show the user "new.go\told.go" as a single filename.
func TestGitStatusRenameReportsBothPaths(t *testing.T) {
	got := parseGitStatusV2([]byte(rename("R.", "web/js/renamed.js", "web/js/original.js") + "\n"))

	if len(got.Files) != 1 {
		t.Fatalf("Files = %d entries, want 1", len(got.Files))
	}
	if got.Files[0].Path != "web/js/renamed.js" {
		t.Errorf("Files[0].Path = %q, want %q", got.Files[0].Path, "web/js/renamed.js")
	}
	if got.Files[0].OldPath != "web/js/original.js" {
		t.Errorf("Files[0].OldPath = %q, want %q", got.Files[0].OldPath, "web/js/original.js")
	}
	if got.Staged != 1 {
		t.Errorf("Staged = %d, want 1 for a staged rename", got.Staged)
	}
}

func TestGitStatusPathsWithSpacesSurvive(t *testing.T) {
	got := parseGitStatusV2([]byte(ordinary("M.", "docs/release notes.md") + "\n"))

	if len(got.Files) != 1 {
		t.Fatalf("Files = %d entries, want 1", len(got.Files))
	}
	if got.Files[0].Path != "docs/release notes.md" {
		t.Errorf("Files[0].Path = %q, want %q", got.Files[0].Path, "docs/release notes.md")
	}
}

// core.quotePath=false covers non-ASCII names, but git still quotes a path
// holding a quote or a control character.
func TestGitStatusUnquotesAQuotedPath(t *testing.T) {
	got := parseGitStatusV2([]byte(ordinary("M.", `"docs/say \"hello\".md"`) + "\n"))

	if len(got.Files) != 1 {
		t.Fatalf("Files = %d entries, want 1", len(got.Files))
	}
	if got.Files[0].Path != `docs/say "hello".md` {
		t.Errorf("Files[0].Path = %q, want %q", got.Files[0].Path, `docs/say "hello".md`)
	}
}

// The list is bounded because it is serialised to every viewer on every poll.
// The counts are not: "200 of 4000 files" is a useful thing to be able to say,
// and it needs the 4000.
func TestGitStatusBoundsTheFileListButNotTheCounts(t *testing.T) {
	lines := []string{"# branch.head main"}
	total := gitStatusMaxFile + 25
	for i := 0; i < total; i++ {
		lines = append(lines, ordinary(".M", fmt.Sprintf("src/file%d.go", i)))
	}

	got := parseGitStatusV2([]byte(strings.Join(lines, "\n")))
	truncateGitFiles(&got, gitStatusMaxFile)
	if len(got.Files) != gitStatusMaxFile {
		t.Errorf("Files = %d entries, want %d", len(got.Files), gitStatusMaxFile)
	}
	if !got.Truncated {
		t.Error("Truncated = false with more files than the bound")
	}
	if got.Changed != total {
		t.Errorf("Changed = %d, want %d — the count covers the whole tree", got.Changed, total)
	}
	// Total is what lets the UI say "first 200 of 225" rather than "and more".
	if got.Total != total {
		t.Errorf("Total = %d, want %d", got.Total, total)
	}
}

// A file both staged and edited again counts once in Total and once on each
// side, so Total is not Changed + Staged.
func TestGitStatusTotalCountsFilesNotSides(t *testing.T) {
	out := strings.Join([]string{
		ordinary("MM", "both.go"),
		ordinary("M.", "staged.go"),
	}, "\n")

	got := parseGitStatusV2([]byte(out))
	if got.Total != 2 {
		t.Errorf("Total = %d, want 2", got.Total)
	}
	if got.Changed != 1 || got.Staged != 2 {
		t.Errorf("Changed/Staged = %d/%d, want 1/2", got.Changed, got.Staged)
	}
}

func TestGitStatusUntruncatedListSaysSo(t *testing.T) {
	got := parseGitStatusV2([]byte(ordinary(".M", "one.go") + "\n"))

	if got.Truncated {
		t.Error("Truncated = true for a single-file list")
	}
}

func TestGitStatusCleanTreeIsEmptyNotNil(t *testing.T) {
	got := parseGitStatusV2([]byte("# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n"))

	if got.Changed != 0 || got.Staged != 0 {
		t.Errorf("Changed/Staged = %d/%d, want 0/0 on a clean tree", got.Changed, got.Staged)
	}
	// The wire shape should be [], not null: the client renders a list.
	if got.Files == nil {
		t.Error("Files = nil, want an empty slice")
	}
}

// git writes lines this parser has no reading for — "!" ignored entries with
// --ignored, and headers beyond the branch block. Skipping one file beats
// failing the repo and showing the user nothing.
func TestGitStatusSkipsLinesItCannotRead(t *testing.T) {
	out := strings.Join([]string{
		"# branch.head main",
		"# future.value 3",
		"! target/ignored.o",
		"1 bogus",
		"",
		ordinary("M.", "real.go"),
	}, "\n")

	got := parseGitStatusV2([]byte(out))
	if len(got.Files) != 1 || got.Files[0].Path != "real.go" {
		t.Errorf("Files = %+v, want the one readable entry", got.Files)
	}
	if got.Staged != 1 || got.Changed != 0 {
		t.Errorf("Staged/Changed = %d/%d, want 1/0", got.Staged, got.Changed)
	}
	if got.Branch != "main" {
		t.Errorf("Branch = %q, want %q — an unknown header must not discard a known one", got.Branch, "main")
	}
}

func TestGitStatusEmptyOutputIsAnEmptySummary(t *testing.T) {
	got := parseGitStatusV2(nil)

	if got.Branch != "" || got.Changed != 0 || got.Staged != 0 || len(got.Files) != 0 {
		t.Errorf("parseGitStatusV2(nil) = %+v, want an empty summary", got)
	}
}
