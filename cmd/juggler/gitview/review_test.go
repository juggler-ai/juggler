//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The manifest's whole claim is that it is the complete working tree, so these
// are tests over real repositories for the same reason the diff's are: only git
// can be asked whether what it reports is what the review returned. They reuse
// the gitProject harness in diff_test.go.

// unhurried lends every git clock — the review's, the diff's and the card's —
// enough time that none of them can be the thing a test measures. The fixtures
// in this package are a handful of files, so every git command over them is the
// work of milliseconds; a loaded CI runner can still lose one to the shipped
// seconds, and the test then reports a missing file, or an unreadable diff,
// rather than a slow machine. That has happened to the card's three seconds, the
// review's ten and the diff's ten, so all three are lent time from one place
// (LendClocks): newGitProject calls this, which covers every real-repository test
// here and any later one.
//
// The shipped values keep their own tests — TestGitReviewIsNotHeldToTheStatusCardsClock
// and TestGitDiffIsNotHeldToTheStatusCardsClock — which build no repository and
// so go on reading them.
func unhurried(t *testing.T) {
	t.Helper()
	t.Cleanup(LendClocks(time.Minute, 5*time.Minute))
}

// review reads the project's manifest.
func (p *gitProject) review() Manifest {
	p.t.Helper()
	return Review(p.t.Context(), p.root, Scope{})
}

// card reads the ambient status, which is the thing the review is not.
func (p *gitProject) card() []RepoStatus {
	p.t.Helper()
	return Status(p.t.Context(), p.root)
}

// repo finds one repository in a manifest by its project-relative path.
func (resp Manifest) repo(t *testing.T, rel string) gitReviewRepo {
	t.Helper()
	for _, repo := range resp.Repos {
		if repo.Path == rel {
			return repo
		}
	}
	t.Fatalf("no repository %q in the manifest; it holds %v", rel, resp.paths())
	return gitReviewRepo{}
}

// paths is every repository the manifest listed, for a failure to print.
func (resp Manifest) paths() []string {
	paths := make([]string, 0, len(resp.Repos))
	for _, repo := range resp.Repos {
		paths = append(paths, repo.Path)
	}
	return paths
}

// filePaths is every file one repository listed, in the order it listed them.
func (repo gitReviewRepo) filePaths() []string {
	paths := make([]string, 0, len(repo.Files))
	for _, file := range repo.Files {
		paths = append(paths, file.Path)
	}
	return paths
}

// A review is what the user reads before telling the agent what to fix, so a
// file missing from it is a change that never gets reviewed. Every repository
// under the project, and every file in each of them.
func TestGitReviewListsEveryRepositoryAndItsFiles(t *testing.T) {
	p := newGitProject(t)
	p.write("kept.txt", "one\ntwo\n")
	p.write("gone.txt", "delete me\n")
	p.commit("init")

	p.write("kept.txt", "one\nEDITED\n")
	p.write("staged.txt", "staged\n")
	p.git("add", "staged.txt")
	p.git("rm", "-q", "gone.txt")
	p.write("untracked.txt", "new\n")
	// Left to itself git reports a wholly new directory as one entry named after
	// the directory: a row the user cannot open, standing in for files nobody
	// then reviews.
	p.write("fresh/one.txt", "1\n")
	p.write("fresh/two.txt", "2\n")

	nested := p.nested("libs/lib")
	nested.write("lib.txt", "lib\n")
	nested.commit("init")
	nested.write("lib.txt", "lib edited\n")

	resp := p.review()
	if !resp.Complete {
		t.Errorf("Complete = false with nothing to report: %v", resp.Warnings)
	}
	if len(resp.Warnings) != 0 {
		t.Errorf("Warnings = %v, want none", resp.Warnings)
	}
	if got := resp.paths(); !reflect.DeepEqual(got, []string{"", "libs/lib"}) {
		t.Fatalf("repositories = %v, want the root repo first then the nested one", got)
	}

	root := resp.repo(t, "")
	if !root.Complete {
		t.Errorf("the root repository is incomplete: %q", root.Error)
	}
	want := []string{"fresh/one.txt", "fresh/two.txt", "gone.txt", "kept.txt", "staged.txt", "untracked.txt"}
	if got := root.filePaths(); !reflect.DeepEqual(got, want) {
		t.Errorf("files = %v, want %v", got, want)
	}
	if root.Branch == "" || root.Head == "" || root.Initial {
		t.Errorf("branch/head = %q/%q, initial = %v — a committed repo has all three settled", root.Branch, root.Head, root.Initial)
	}
	// The manifest's counts and a file's own diff are the same comparison asked
	// twice, so they are never allowed to disagree.
	if root.Added != 2 || root.Removed != 2 {
		t.Errorf("+%d/-%d, want +2/-2 — one edited line and one deleted file", root.Added, root.Removed)
	}
	for _, file := range root.Files {
		if file.Path != "kept.txt" {
			continue
		}
		if file.Added == nil || *file.Added != 1 {
			t.Errorf("kept.txt added = %v, want 1", file.Added)
		}
	}

	lib := resp.repo(t, "libs/lib")
	if got := lib.filePaths(); !reflect.DeepEqual(got, []string{"lib.txt"}) {
		t.Errorf("nested files = %v, want [lib.txt]", got)
	}
}

// The card is polled every twenty seconds and can give up on a slow read; a
// review is asked for once, by somebody waiting for it, and reports whatever it
// could not reach. Holding the review to the card's clock turns a machine that
// was merely busy into a project full of unreadable repositories — the review
// reads the same repositories, so the only thing keeping the two apart is this.
func TestGitReviewIsNotHeldToTheStatusCardsClock(t *testing.T) {
	if gitReviewPerCmd <= gitStatusPerCmd {
		t.Errorf("gitReviewPerCmd = %s, want longer than the card's %s", gitReviewPerCmd, gitStatusPerCmd)
	}
	if gitReviewBudget < 2*gitReviewPerCmd {
		t.Errorf("gitReviewBudget = %s, want room for more than one %s command", gitReviewBudget, gitReviewPerCmd)
	}
}

// Both clocks are only worth naming if the read is actually run on the one its
// caller asked for. A budget these helpers accept and then ignore in favour of
// one written down inside them would make the constants above a fiction, and a
// clock no read could ever beat is what tells the two apart: given a budget that
// is already spent they have to give up, where one of their own would have them
// succeed.
//
// The budget is negative rather than merely tiny because context.WithTimeout
// only reports a deadline as passed without waiting when what is left of it is
// non-positive; any budget still in the future — a nanosecond included — is
// handed to a timer instead, and then the read gives up only if that timer beats
// git to the finish. Two consecutive clock reads land in the same tick often
// enough that a nanosecond is in the future about half the time, so a positive
// budget here tests the platform's timer resolution under load rather than these
// helpers. It is not zero either: zero is this struct's own default, so a read
// that had no budget plumbed into it at all would pass just as well.
const spentClock = -time.Second

func TestGitStatusReadsRunOnTheirCallersClock(t *testing.T) {
	p := newGitProject(t)
	p.write("file.txt", "one\n")
	p.commit("init")

	// Whether the clock runs out before git starts or during the read decides
	// which layer reports it, so either way of saying so counts.
	ranOut := func(err error) bool {
		return err != nil &&
			(errors.Is(err, context.DeadlineExceeded) ||
				strings.Contains(err.Error(), "longer than "+spentClock.String()))
	}

	_, err := repoStatus(t.Context(), p.root, repoStatusOptions{maxFiles: 10, perCmd: spentClock})
	if !ranOut(err) {
		t.Errorf("repoStatus on a spent clock = %v, want it to give up on that clock", err)
	}

	var status RepoStatus
	if err := repoDiffstats(t.Context(), p.root, spentClock, &status); !ranOut(err) {
		t.Errorf("repoDiffstats on a spent clock = %v, want it to give up on that clock", err)
	}
}

// The card prunes the directories that cost the most to walk, which is the right
// trade for a number in the corner of a window and the wrong one for a surface
// claiming to review the tree. What the review lists, the diff must also answer
// for — a file the user can see and cannot open is worse than one never listed.
func TestGitReviewFindsARepositoryTheCardSkips(t *testing.T) {
	p := newGitProject(t)
	p.write("root.txt", "root\n")
	p.commit("init")

	vendored := p.nested("vendor/thing")
	vendored.write("vendored.txt", "one\n")
	vendored.commit("init")
	vendored.write("vendored.txt", "one\nTWO\n")

	resp := p.review()
	repo := resp.repo(t, "vendor/thing")
	if got := repo.filePaths(); !reflect.DeepEqual(got, []string{"vendored.txt"}) {
		t.Errorf("files = %v, want [vendored.txt]", got)
	}
	if !resp.Complete {
		t.Errorf("Complete = false: %v", resp.Warnings)
	}

	if diff := vendored.diff("vendored.txt"); !strings.Contains(lineText(diff), "+TWO\n") {
		t.Errorf("the diff endpoint would not open a file the review listed:\n%s", lineText(diff))
	}

	// The card is allowed to go on being cheap. If that ever stops being true this
	// test is the place to find out, rather than a slow poll nobody attributes.
	for _, card := range p.card() {
		if card.Path == "vendor/thing" {
			t.Error("the status card walked into vendor/, which is what the review is for")
		}
	}
}

// A repository git cannot read is still a repository the user has, and dropping
// it turns "I could not read this" into "there is nothing here". An uninitialised
// submodule is the everyday way to meet one.
func TestGitReviewReportsARepositoryItCouldNotRead(t *testing.T) {
	p := newGitProject(t)
	p.write("root.txt", "root\n")
	p.commit("init")

	broken := filepath.Join(p.root, "libs", "broken")
	if err := os.MkdirAll(broken, 0o750); err != nil {
		t.Fatal(err)
	}
	// A `.git` file is how a submodule names the directory holding its repository.
	// Pointing it at one that does not exist is a checkout nobody ran `submodule
	// update` for.
	if err := os.WriteFile(filepath.Join(broken, ".git"), []byte("gitdir: ../nowhere\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	resp := p.review()
	if resp.Complete {
		t.Error("Complete = true with a repository that could not be read")
	}
	repo := resp.repo(t, "libs/broken")
	if repo.Complete {
		t.Error("the broken repository reports itself complete")
	}
	if repo.Error == "" {
		t.Error("the broken repository is listed with no reason given")
	}
	if !strings.Contains(strings.Join(resp.Warnings, "\n"), "libs/broken") {
		t.Errorf("warnings = %v, want one naming libs/broken", resp.Warnings)
	}
	// The rest of the project is still reviewable; one unreadable repository is
	// not a failed review.
	if root := resp.repo(t, ""); !root.Complete {
		t.Errorf("the root repository was dragged down with it: %q", root.Error)
	}
}

// Ceilings are mandatory and silence about them is not: what is on screen stays
// on screen, and the response says how much of the tree it is.
func TestGitReviewBoundsTheFileListAndSaysSo(t *testing.T) {
	p := newGitProject(t)
	p.write("committed.txt", "x\n")
	p.commit("init")

	extra := 25
	for i := 0; i < gitReviewMaxFiles+extra; i++ {
		p.write(fmt.Sprintf("f%05d.txt", i), "new\n")
	}
	starved := p.nested("libs/lib")
	starved.write("lib.txt", "x\n")

	resp := p.review()
	if resp.Complete {
		t.Error("Complete = true with more files than the response holds")
	}
	repo := resp.repo(t, "")
	if len(repo.Files) != gitReviewMaxFiles {
		t.Errorf("Files = %d entries, want %d", len(repo.Files), gitReviewMaxFiles)
	}
	if repo.Complete {
		t.Error("the repository reports itself complete with its file list cut")
	}
	// "5000 of 5025" is the useful thing to be able to say, and it needs the 5025.
	if repo.Total != gitReviewMaxFiles+extra {
		t.Errorf("Total = %d, want %d — the count covers the whole tree", repo.Total, gitReviewMaxFiles+extra)
	}
	warnings := strings.Join(resp.Warnings, "\n")
	if !strings.Contains(warnings, fmt.Sprintf("%d of %d", gitReviewMaxFiles, gitReviewMaxFiles+extra)) {
		t.Errorf("warnings = %v, want one saying how much of the tree is listed", resp.Warnings)
	}

	// The ceiling is on the response, so the repository read after it was spent
	// gets nothing — and has to say that rather than read as a clean tree, which
	// is the one thing it looks exactly like.
	lib := resp.repo(t, "libs/lib")
	if len(lib.Files) != 0 {
		t.Errorf("files = %v, want none left in the budget", lib.filePaths())
	}
	if lib.Complete || lib.Total != 1 {
		t.Errorf("a repository listing none of its %d files reported complete = %v", lib.Total, lib.Complete)
	}
	if !strings.Contains(warnings, "libs/lib: 0 of 1") {
		t.Errorf("warnings = %v, want one naming what libs/lib could not list", resp.Warnings)
	}
}

// A search that stopped early is the other way a review comes back partial, and
// it says which ceiling it met rather than leaving the shortfall to be noticed.
func TestGitReviewSearchSaysWhereItStopped(t *testing.T) {
	p := newGitProject(t)
	p.nested("a")
	p.nested("b/c")

	t.Run("every repository", func(t *testing.T) {
		scan := scanRepos(t.Context(), p.root, repoScanLimits{maxRepos: 8, maxDirs: 64})
		if len(scan.Repos) != 3 {
			t.Errorf("found %d repositories, want 3", len(scan.Repos))
		}
		if len(scan.Cut) != 0 {
			t.Errorf("Cut = %v, want nothing — the search reached the whole tree", scan.Cut)
		}
	})
	t.Run("too many repositories", func(t *testing.T) {
		scan := scanRepos(t.Context(), p.root, repoScanLimits{maxRepos: 2, maxDirs: 64})
		if len(scan.Repos) != 2 {
			t.Errorf("found %d repositories, want the 2 it was allowed", len(scan.Repos))
		}
		if !strings.Contains(strings.Join(scan.Cut, "\n"), "2 repositories") {
			t.Errorf("Cut = %v, want the repository ceiling named", scan.Cut)
		}
	})
	t.Run("too many directories", func(t *testing.T) {
		scan := scanRepos(t.Context(), p.root, repoScanLimits{maxRepos: 8, maxDirs: 2})
		if !strings.Contains(strings.Join(scan.Cut, "\n"), "2 directories") {
			t.Errorf("Cut = %v, want the directory ceiling named", scan.Cut)
		}
	})
	// Juggler's own state is never a repository the user opened the project to
	// read, whatever the limits allow.
	t.Run("juggler's own state", func(t *testing.T) {
		p.nested(filepath.Join(".juggler", "workspace"))
		scan := scanRepos(t.Context(), p.root, reviewScanLimits())
		for _, repo := range scan.Repos {
			if strings.Contains(repo, ".juggler") {
				t.Errorf("the search walked into %q", repo)
			}
		}
	})
}

// A conflict is a state a review has to arrive already knowing about: the file
// on disk holds both sides and the markers between them, which read as ordinary
// text somebody wrote.
func TestGitReviewReportsConflicts(t *testing.T) {
	p := newGitProject(t)
	p.write("shared.txt", "first\n")
	p.commit("init")

	p.git("checkout", "-q", "-b", "other")
	p.write("shared.txt", "first\nfrom other\n")
	p.commit("other")
	p.git("checkout", "-q", "-")
	p.write("shared.txt", "first\nfrom main\n")
	p.commit("main")

	merge := exec.Command("git", "merge", "other")
	merge.Dir = p.dir
	if out, err := merge.CombinedOutput(); err == nil {
		t.Fatalf("the merge succeeded; the test needs a conflict\n%s", out)
	}

	repo := p.review().repo(t, "")
	if repo.Conflicted != 1 {
		t.Errorf("Conflicted = %d, want 1", repo.Conflicted)
	}
	for _, file := range repo.Files {
		if file.Path == "shared.txt" && !file.Conflicted {
			t.Error("shared.txt is listed as an ordinary change")
		}
	}
}

// A comment is attached to a row the user found by looking, so the row has to
// still be where they left it after the next refresh.
func TestGitReviewOrdersEverythingTheSameWayTwice(t *testing.T) {
	p := newGitProject(t)
	for _, name := range []string{"zeta.txt", "alpha.txt", "middle.txt"} {
		p.write(name, "one\n")
	}
	p.commit("init")
	for _, name := range []string{"zeta.txt", "alpha.txt", "middle.txt"} {
		p.write(name, "two\n")
	}
	for _, rel := range []string{"libs/zeta", "libs/alpha"} {
		nested := p.nested(rel)
		nested.write("f.txt", "x\n")
	}

	first, second := p.review(), p.review()
	if !reflect.DeepEqual(first.paths(), second.paths()) {
		t.Errorf("repositories reshuffled between reviews: %v then %v", first.paths(), second.paths())
	}
	want := []string{"", "libs/alpha", "libs/zeta"}
	if got := first.paths(); !reflect.DeepEqual(got, want) {
		t.Errorf("repositories = %v, want %v", got, want)
	}
	wantFiles := []string{"alpha.txt", "middle.txt", "zeta.txt"}
	if got := first.repo(t, "").filePaths(); !reflect.DeepEqual(got, wantFiles) {
		t.Errorf("files = %v, want %v", got, wantFiles)
	}
	if got := second.repo(t, "").filePaths(); !reflect.DeepEqual(got, wantFiles) {
		t.Errorf("files reshuffled between reviews: %v", got)
	}
}

// Reading a review is a read. The user's index, refs and working tree are theirs,
// and a review that refreshed the index behind them would contend with the git
// client they have open in another window.
func TestGitReviewChangesNothingOnDisk(t *testing.T) {
	p := newGitProject(t)
	p.write("kept.txt", "one\ntwo\n")
	p.write("edited.txt", "one\n")
	p.commit("init")

	p.write("edited.txt", "one\nEDITED\n")
	p.write("untracked.txt", "new\n")
	// Rewriting a tracked file with the content it already has is what makes git
	// want to write the index back: the stat information it cached no longer
	// matches, and refreshing it is exactly the optional lock we refuse to take.
	p.write("kept.txt", "one\ntwo\n")
	// Backdating that file is what makes the temptation reliable rather than a
	// property of how fast the machine ran the test. A file written in the same
	// filesystem tick as the index is "racily clean": git cannot trust the stat
	// information it just read, so it declines to cache it and the index it would
	// have rewritten stays as it was. An older timestamp is unambiguous, git
	// caches the refreshed stat, and a porcelain read writes the index out.
	p.backdate("kept.txt")

	before := p.snapshot()
	if !p.review().Complete {
		t.Fatal("the review was incomplete before it could prove anything")
	}
	after := p.snapshot()

	for path, was := range before {
		switch now, present := after[path]; {
		case !present:
			t.Errorf("the review removed %s", path)
		case now != was:
			t.Errorf("the review rewrote %s", path)
		}
	}
	for path := range after {
		if _, present := before[path]; !present {
			t.Errorf("the review created %s", path)
		}
	}
}

// snapshot hashes every file under the project, git's own directory included. A
// review claims to be a read, and this is what that claim is worth.
func (p *gitProject) snapshot() map[string]string {
	p.t.Helper()
	files := map[string]string{}
	err := filepath.WalkDir(p.root, func(abs string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		data, err := os.ReadFile(abs) //nolint:gosec // a temporary directory this test built
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(p.root, abs)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		files[filepath.ToSlash(rel)] = fmt.Sprintf("%o %x", info.Mode().Perm(), sha256.Sum256(data))
		return nil
	})
	if err != nil {
		p.t.Fatal(err)
	}
	return files
}

// The states where there is nothing to say, said without claiming more than is
// known. (A project nobody opened is the API's to refuse: see
// handlers.TestGitReviewWithNoProject.)
func TestGitReviewWithNothingToReport(t *testing.T) {
	t.Run("no repository", func(t *testing.T) {
		// A project directory of its own, under one that is a repository, so that a
		// search reaching upward would be caught rather than quietly succeed.
		p := newGitProject(t)
		plain := &gitProject{t: t, root: filepath.Join(p.root, "plain")}
		if err := os.MkdirAll(plain.root, 0o750); err != nil {
			t.Fatal(err)
		}
		resp := plain.review()
		if !resp.Complete || len(resp.Repos) != 0 {
			t.Errorf("a project holding no repository reviewed as %+v", resp)
		}
	})
	t.Run("clean repository", func(t *testing.T) {
		p := newGitProject(t)
		p.write("f.txt", "one\n")
		p.commit("init")

		resp := p.review()
		if !resp.Complete {
			t.Errorf("Complete = false on a clean tree: %v", resp.Warnings)
		}
		repo := resp.repo(t, "")
		if len(repo.Files) != 0 || repo.Added != 0 || repo.Removed != 0 {
			t.Errorf("a clean tree reviewed as %+v", repo)
		}
	})
	t.Run("unborn repository", func(t *testing.T) {
		p := newGitProject(t)
		p.write("staged.txt", "one\ntwo\n")
		p.git("add", "staged.txt")

		repo := p.review().repo(t, "")
		if !repo.Initial {
			t.Error("Initial = false in a repository with no commits")
		}
		// The empty tree is the honest baseline, and against it everything staged is
		// the addition it is. Reporting nothing would be the comparison failing in
		// the one costume it must never wear.
		if repo.Added != 2 {
			t.Errorf("Added = %d, want 2", repo.Added)
		}
		if got := repo.filePaths(); !reflect.DeepEqual(got, []string{"staged.txt"}) {
			t.Errorf("files = %v, want [staged.txt]", got)
		}
	})
}
