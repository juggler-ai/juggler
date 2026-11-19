//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"testing"

	"juggler/cmd/juggler/gitview/internal/clocks"
)

// gitCounter records the git commands one test's reads ran. TestMain points
// gitcmd.Observe at observeGit, which records a command against the counter
// its context carries, so a parallel test's commands are never counted here.
// The commands are held in a channel of one, which is the lock on them.
type gitCounter struct{ runs chan [][]string }

type gitCounterKey struct{}

func observeGit(ctx context.Context, args []string) {
	if c, ok := ctx.Value(gitCounterKey{}).(*gitCounter); ok {
		c.runs <- append(<-c.runs, slices.Clone(args))
	}
}

// countingGit is a context whose git commands are counted.
func countingGit(t *testing.T) (context.Context, *gitCounter) {
	c := &gitCounter{runs: make(chan [][]string, 1)}
	c.runs <- nil
	return context.WithValue(t.Context(), gitCounterKey{}, c), c
}

// take is the commands run since the last take.
func (c *gitCounter) take() [][]string {
	runs := <-c.runs
	c.runs <- nil
	return runs
}

// withArg is how many of runs carry arg.
func withArg(runs [][]string, arg string) int {
	n := 0
	for _, r := range runs {
		if slices.Contains(r, arg) {
			n++
		}
	}
	return n
}

// A commit's detail costs three processes the first time — resolving the
// revision, its metadata, one diff-tree for its files and their lines — and
// none after that when it is named by its id, or one rev-parse when it is
// named by a ref. The answer is the same each time.
func TestReadCommitRunsFewGitProcesses(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("keep.txt", "one\ntwo\n")
	p.write("old.txt", "a long enough file\nto be found renamed\nwhen it moves\n")
	root := commitAt(t, p, "root", 1_700_000_000)
	p.write("keep.txt", "one\n2\nthree\n")
	p.git("mv", "old.txt", "new.txt")
	sha := commitAt(t, p, "two", 1_700_000_100)

	ctx, git := countingGit(t)
	cold, err := ReadCommit(ctx, p.root, "", sha)
	if err != nil {
		t.Fatal(err)
	}
	if runs := git.take(); len(runs) > 3 {
		t.Errorf("a first read ran %d git commands, want at most 3: %q", len(runs), runs)
	}
	warm, err := ReadCommit(ctx, p.root, "", sha)
	if err != nil {
		t.Fatal(err)
	}
	if runs := git.take(); len(runs) != 0 {
		t.Errorf("a second read of %s ran %d git commands, want none: %q", sha, len(runs), runs)
	}
	if !reflect.DeepEqual(cold, warm) {
		t.Errorf("the second read differs:\n%+v\n%+v", cold, warm)
	}
	byRef, err := ReadCommit(ctx, p.root, "", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if runs := git.take(); len(runs) > 1 {
		t.Errorf("a read through HEAD of a commit already read ran %d git commands, want at most 1: %q", len(runs), runs)
	}
	if !reflect.DeepEqual(cold, byRef) {
		t.Errorf("the read through HEAD differs:\n%+v\n%+v", cold, byRef)
	}
	if len(cold.Files) != 2 || cold.Base != root {
		t.Errorf("commit = %+v", cold)
	}

	if _, err := ReadCommit(ctx, p.root, "", root); err != nil {
		t.Fatal(err)
	}
	if runs := git.take(); len(runs) > 3 {
		t.Errorf("a first read of a root commit ran %d git commands, want at most 3: %q", len(runs), runs)
	}
}

// Two files of one commit are two patches, and the pass that says what
// happened to every file of it — renames, copies, modes — is run once. A
// commit read just before leaves nothing to resolve.
func TestDiffReadsOfOneCommitShareItsMetadata(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.write("b.txt", "b\n")
	commitAt(t, p, "root", 1_700_000_000)
	p.write("a.txt", "a\nmore a\n")
	p.write("b.txt", "b\nmore b\n")
	sha := commitAt(t, p, "two", 1_700_000_100)
	scope := sha + "^!"

	ctx, git := countingGit(t)
	a, err := Diff(ctx, p.root, DiffRequest{Path: "a.txt", Scope: scope})
	if err != nil {
		t.Fatal(err)
	}
	first := git.take()
	if len(first) > 3 {
		t.Errorf("the first file ran %d git commands, want at most 3: %q", len(first), first)
	}
	b, err := Diff(ctx, p.root, DiffRequest{Path: "b.txt", Scope: scope})
	if err != nil {
		t.Fatal(err)
	}
	second := git.take()
	if n := withArg(append(first, second...), "--raw"); n != 1 {
		t.Errorf("the whole-commit metadata pass ran %d times for two files, want once: %q then %q", n, first, second)
	}
	if len(second) > 1 {
		t.Errorf("the second file ran %d git commands, want only its patch: %q", len(second), second)
	}
	if a.Added != 1 || b.Added != 1 || a.Status != "modified" || b.Status != "modified" {
		t.Errorf("a = %+v, b = %+v", a, b)
	}
	again, err := Diff(ctx, p.root, DiffRequest{Path: "a.txt", Scope: scope})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, again) {
		t.Errorf("the same file read twice differs:\n%+v\n%+v", a, again)
	}

	// A file clicked after the commit was read resolves nothing more.
	other := sha[:12]
	if _, err := ReadCommit(ctx, p.root, "", other); err != nil {
		t.Fatal(err)
	}
	git.take()
	if _, err := Diff(ctx, p.root, DiffRequest{Path: "a.txt", Scope: scope, Context: "5"}); err != nil {
		t.Fatal(err)
	}
	if runs := git.take(); len(runs) != 1 {
		t.Errorf("a file of a commit already read ran %d git commands, want only its patch: %q", len(runs), runs)
	}
}

// Nothing is remembered under a name that moves: a read through HEAD after a
// commit is of the new commit, and so is a diff of @last.
func TestCachedReadsFollowAMovingHead(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "one\n")
	commitAt(t, p, "one", 1_700_000_000)
	p.write("a.txt", "one\ntwo\n")
	commitAt(t, p, "two", 1_700_000_100)

	before, err := ReadCommit(t.Context(), p.root, "", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	last, err := Diff(t.Context(), p.root, DiffRequest{Path: "a.txt", Scope: "@last"})
	if err != nil {
		t.Fatal(err)
	}

	p.write("a.txt", "one\ntwo\nthree\nfour\n")
	sha := commitAt(t, p, "three", 1_700_000_200)

	after, err := ReadCommit(t.Context(), p.root, "", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if after.Sha != sha || after.Subject != "three" || after.Base != before.Sha {
		t.Errorf("HEAD after a commit read as %s %q against %s, want %s \"three\" against %s", after.Sha, after.Subject, after.Base, sha, before.Sha)
	}
	moved, err := Diff(t.Context(), p.root, DiffRequest{Path: "a.txt", Scope: "@last"})
	if err != nil {
		t.Fatal(err)
	}
	if last.Added != 1 || moved.Added != 2 {
		t.Errorf("@last added %d then %d lines, want 1 then 2", last.Added, moved.Added)
	}
}

// One commit, byte for byte, in two repositories is still read in each of them
// as that repository's own: the cache is per repository.
func TestCommitCacheKeepsRepositoriesApart(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "same\n")
	sha := commitAt(t, p, "same", 1_700_000_000)

	host := newGitProject(t)
	host.write("host.txt", "host\n")
	host.commit("host")
	q := host.nested("inner")
	q.write("a.txt", "same\n")
	if other := commitAt(t, q, "same", 1_700_000_000); other != sha {
		t.Fatalf("the two commits are %s and %s; the test needs them identical", sha, other)
	}

	mine, err := ReadCommit(t.Context(), p.root, "", sha)
	if err != nil {
		t.Fatal(err)
	}
	ctx, git := countingGit(t)
	theirs, err := ReadCommit(ctx, host.root, "inner", sha)
	if err != nil {
		t.Fatal(err)
	}
	if mine.Repo != "" || theirs.Repo != "inner" {
		t.Errorf("repos read as %q and %q, want \"\" and \"inner\"", mine.Repo, theirs.Repo)
	}
	if runs := git.take(); len(runs) == 0 {
		t.Error("the second repository's read was answered from the first's")
	}
}

// What a repository's directories are is read off disk the way git reads it,
// and comes to what git says: a main tree, a linked worktree, and a tree whose
// .git is a file naming a directory elsewhere.
func TestRepoIdentityMatchesGitDirs(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("one")
	linked := filepath.Join(t.TempDir(), "linked")
	p.git("worktree", "add", "-q", linked)
	separate := filepath.Join(t.TempDir(), "separate")
	p.git("init", "-q", "--separate-git-dir", filepath.Join(t.TempDir(), "elsewhere.git"), separate)

	for _, dir := range []string{p.dir, linked, separate} {
		gitDir, common, err := GitDirs(t.Context(), dir)
		if err != nil {
			t.Fatal(err)
		}
		got, ok := repoIdentity(dir)
		if !ok || got.gitDir != gitDir || got.commonDir != common {
			t.Errorf("%s: read as %+v (%v), git says %s and %s", dir, got, ok, gitDir, common)
		}
	}
	if _, ok := repoIdentity(t.TempDir()); ok {
		t.Error("a directory that is no repository has an identity")
	}
}

// A repository found once and gone since is refused, whether its .git went or
// its directory was swapped for a link to one elsewhere — however recently it
// was found.
func TestResolveRepoNoticesARepositoryGoing(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	gone := p.nested("gone")
	p.nested("swapped")
	outside := newGitProject(t)

	for _, rel := range []string{"gone", "swapped"} {
		if _, err := ResolveRepo(t.Context(), p.root, rel); err != nil {
			t.Fatalf("%s: %v", rel, err)
		}
	}
	if err := os.RemoveAll(filepath.Join(gone.dir, ".git")); err != nil {
		t.Fatal(err)
	}
	swapped := filepath.Join(p.root, "swapped")
	if err := os.RemoveAll(swapped); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside.root, swapped); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"gone", "swapped"} {
		if dir, err := ResolveRepo(t.Context(), p.root, rel); !refused(err) {
			t.Errorf("%s once gone resolved to %q, %v; want a refusal", rel, dir, err)
		}
	}
}

// The cache stays within its entries and its bytes, letting go of what was
// used longest ago, and refuses a value that would crowd out the rest.
func TestGitCacheBounds(t *testing.T) {
	t.Parallel()
	c := newGitCache(3, 800)
	key := func(n int) cacheKey { return cacheKey{kind: cacheCommit, limit: n} }
	for n := range 3 {
		c.put(key(n), n, 10)
	}
	c.get(key(0)) // 1 is now the least recently used
	c.put(key(3), 3, 10)
	if _, ok := c.get(key(1)); ok {
		t.Error("a fourth entry kept the least recently used")
	}
	for _, n := range []int{0, 2, 3} {
		if v, ok := c.get(key(n)); !ok || v != n {
			t.Errorf("entry %d = %v, %v", n, v, ok)
		}
	}
	c.put(key(4), 4, 100)
	c.put(key(5), 5, 100)
	if _, ok := c.get(key(6)); ok || c.bytes > 800 || c.recent.Len() > 3 {
		t.Errorf("holding %d bytes in %d entries", c.bytes, c.recent.Len())
	}
	c.put(key(7), 7, 101)
	if _, ok := c.get(key(7)); ok {
		t.Error("a value past an eighth of the cache was kept")
	}
	c.remove(key(5))
	if _, ok := c.get(key(5)); ok || c.recent.Len() != len(c.entries) {
		t.Errorf("removed entry still held: %d listed, %d indexed", c.recent.Len(), len(c.entries))
	}
}

// The merged diff-tree is the two passes it replaces: what each file is, and
// how many lines it changed, read from one stream.
func TestParseGitRawNumstat(t *testing.T) {
	t.Parallel()
	out := ":100644 100644 aaa bbb M\x00bin.dat\x00" +
		":100644 100644 ccc ccc R100\x00old name.txt\x00new name.txt\x00" +
		":100644 100644 ddd ddd C100\x00src.txt\x00nl\ncopy.txt\x00" +
		":000000 100644 000 eee A\x00caf\xe9.txt\x00" +
		":100644 100644 fff 111 M\x00:colon.txt\x00" +
		":100644 100644 222 222 R100\x001\t2\tx\x00binary moved\x00" +
		"-\t-\tbin.dat\x00" +
		"0\t0\t\x00old name.txt\x00new name.txt\x00" +
		"0\t0\t\x00src.txt\x00nl\ncopy.txt\x00" +
		"1\t0\tcaf\xe9.txt\x00" +
		"2\t1\t:colon.txt\x00" +
		"-\t-\t\x001\t2\tx\x00binary moved\x00"

	meta, stats := parseGitRawNumstat([]byte(out))
	wantMeta := map[string]gitFileMeta{
		"bin.dat":      {Status: "modified", Letter: "M", OldMode: "100644", NewMode: "100644", NewID: "bbb"},
		"new name.txt": {Status: "renamed", Letter: "R", OldPath: "old name.txt", OldMode: "100644", NewMode: "100644", NewID: "ccc"},
		"nl\ncopy.txt": {Status: "copied", Letter: "C", OldPath: "src.txt", OldMode: "100644", NewMode: "100644", NewID: "ddd"},
		"caf\xe9.txt":  {Status: "added", Letter: "A", OldMode: "000000", NewMode: "100644", NewID: "eee"},
		":colon.txt":   {Status: "modified", Letter: "M", OldMode: "100644", NewMode: "100644", NewID: "111"},
		"binary moved": {Status: "renamed", Letter: "R", OldPath: "1\t2\tx", OldMode: "100644", NewMode: "100644", NewID: "222"},
	}
	if !reflect.DeepEqual(meta, wantMeta) {
		t.Errorf("meta = %#v\nwant %#v", meta, wantMeta)
	}
	wantStats := map[string]gitDiffstat{
		"new name.txt": {}, "nl\ncopy.txt": {}, "caf\xe9.txt": {Added: 1}, ":colon.txt": {Added: 2, Removed: 1},
	}
	if !reflect.DeepEqual(stats, wantStats) {
		t.Errorf("stats = %#v\nwant %#v", stats, wantStats)
	}

	// A pass cut short between its two halves describes what it reached.
	if meta, stats := parseGitRawNumstat([]byte(":100644 100644 aaa bbb M\x00a.txt\x00")); len(meta) != 1 || len(stats) != 0 {
		t.Errorf("raw alone = %v, %v", meta, stats)
	}
}

// Against a real repository, the merged pass parses to exactly what the raw
// pass and the numstat pass did apart.
func TestMergedDiffTreeMatchesSeparatePasses(t *testing.T) {
	t.Parallel()
	// A name git would quote without -z; a newline is the one that breaks a
	// line-based parse, but Windows holds no control character in a name.
	renamed := "new\nname.txt"
	if runtime.GOOS == "windows" {
		renamed = "new caf\u00e9.txt"
	}
	p := newGitProject(t)
	p.write("keep.txt", "one\ntwo\n")
	p.write("old name.txt", "a long enough file\nto be found renamed\nwhen it moves\n")
	p.write("bin.dat", "\x00\x01\x02")
	p.write("gone.txt", "bye\n")
	base := commitAt(t, p, "root", 1_700_000_000)
	p.write("keep.txt", "one\n2\nthree\n")
	p.git("mv", "old name.txt", renamed)
	p.write("bin.dat", "\x00\x01\x02\x03")
	p.git("rm", "-q", "gone.txt")
	p.write("with space.txt", "x\ny\n")
	target := commitAt(t, p, "two", 1_700_000_100)

	run := func(opts ...string) []byte {
		args := append([]string{"diff-tree", "-r", "--no-ext-diff", "--no-textconv", "--find-renames"}, opts...)
		out, err := gitRead(t.Context(), p.dir, clocks.Review.PerCmd, gitDiffMaxMeta, append(args, "-z", base, target, "--")...)
		if err != nil {
			t.Fatal(err)
		}
		return out.Kept
	}
	wantMeta := parseGitRawDiff(run("--raw", "--abbrev"))
	wantStats := parseGitNumstat(run("--numstat"))
	meta, stats := parseGitRawNumstat(run("--raw", "--abbrev", "--numstat"))
	if !reflect.DeepEqual(meta, wantMeta) || !reflect.DeepEqual(stats, wantStats) {
		t.Errorf("merged = %v %v\napart  = %v %v", meta, stats, wantMeta, wantStats)
	}
	if _, found := meta[renamed]; len(meta) != 5 || !found {
		t.Errorf("the fixture read as %v", meta)
	}
}
