//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := runGit(dir, args...)
	if err != nil {
		t.Fatalf("git %v in %s: %v", args, dir, err)
	}
	return out
}

// gitInit turns dir into a git repo with a single commit containing one file.
func gitInit(t *testing.T, dir, file string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, dir, "init", "-q")
	mustGit(t, dir, "config", "user.email", "test@example.com")
	mustGit(t, dir, "config", "user.name", "Test")
	mustGit(t, dir, "config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(dir, file), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, dir, "add", ".")
	mustGit(t, dir, "commit", "-q", "-m", "init")
}

// gitInitRepo creates a standalone repo (project root IS the repo).
func gitInitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitInit(t, dir, "README.md")
	return dir
}

func newConv(t *testing.T, base, home string, enabled bool) *ConvWorktrees {
	t.Helper()
	c := NewConvWorktrees(base, home, enabled)
	t.Cleanup(c.Close)
	return c
}

func TestConvWorktrees_DisabledIsIdentity(t *testing.T) {
	repo := gitInitRepo(t)
	c := newConv(t, repo, t.TempDir(), false)
	p := filepath.Join(repo, "README.md")
	if got := c.Remap("conv-a", p); got != p {
		t.Errorf("disabled: Remap = %q, want identity %q", got, p)
	}
}

func TestConvWorktrees_EmptyConvIsIdentity(t *testing.T) {
	repo := gitInitRepo(t)
	c := newConv(t, repo, t.TempDir(), true)
	p := filepath.Join(repo, "README.md")
	if got := c.Remap("", p); got != p {
		t.Errorf("empty convID: Remap = %q, want identity %q", got, p)
	}
}

func TestConvWorktrees_NonGitPathIsIdentity(t *testing.T) {
	// A non-git parent that contains no repo at the touched path.
	base := t.TempDir()
	loose := filepath.Join(base, "loose.txt")
	if err := os.WriteFile(loose, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := newConv(t, base, t.TempDir(), true)
	if got := c.Remap("conv-a", loose); got != loose {
		t.Errorf("non-git file: Remap = %q, want identity %q", got, loose)
	}
}

func TestConvWorktrees_SingleRepoRedirects(t *testing.T) {
	repo := gitInitRepo(t)
	home := t.TempDir()
	c := newConv(t, repo, home, true)

	src := filepath.Join(repo, "README.md")
	a := c.Remap("conv-a", src)
	b := c.Remap("conv-b", src)

	if a == src || b == src {
		t.Fatalf("expected redirect off the real repo, got a=%q b=%q real=%q", a, b, src)
	}
	if a == b {
		t.Fatalf("two conversations must get distinct worktrees, both got %q", a)
	}
	for _, p := range []string{a, b} {
		if !strings.HasPrefix(p, home) {
			t.Errorf("redirected path %s not under home %s", p, home)
		}
		if filepath.Base(p) != "README.md" {
			t.Errorf("redirected path %s lost the file basename", p)
		}
		if _, err := os.Stat(p); err != nil {
			t.Errorf("worktree file %s missing: %v", p, err)
		}
	}
}

func TestConvWorktrees_MultipleReposIndependent(t *testing.T) {
	// A non-git parent containing two independent repos: one conversation
	// touching both must get a SEPARATE worktree for each.
	base := t.TempDir()
	repoA := filepath.Join(base, "service-a")
	repoB := filepath.Join(base, "service-b")
	gitInit(t, repoA, "a.txt")
	gitInit(t, repoB, "b.txt")

	c := newConv(t, base, t.TempDir(), true)
	wa := c.Remap("conv-1", filepath.Join(repoA, "a.txt"))
	wb := c.Remap("conv-1", filepath.Join(repoB, "b.txt"))

	if wa == filepath.Join(repoA, "a.txt") || wb == filepath.Join(repoB, "b.txt") {
		t.Fatalf("expected both repos redirected, got wa=%q wb=%q", wa, wb)
	}
	// Distinct worktrees (different repo groups), and each has the right file.
	if filepath.Dir(filepath.Dir(wa)) == filepath.Dir(filepath.Dir(wb)) {
		t.Errorf("two repos shared a worktree group: %q vs %q", wa, wb)
	}
	if _, err := os.Stat(wa); err != nil {
		t.Errorf("repoA worktree file missing: %v", err)
	}
	if _, err := os.Stat(wb); err != nil {
		t.Errorf("repoB worktree file missing: %v", err)
	}
	// The two repos' worktrees are distinct checkouts.
	if filepath.Base(wa) != "a.txt" || filepath.Base(wb) != "b.txt" {
		t.Errorf("wrong files: wa=%q wb=%q", wa, wb)
	}
}

func TestConvWorktrees_NestedRepoIsolatedFromParent(t *testing.T) {
	// Project root IS a repo, with a nested independent repo inside it. A path
	// in the nested repo must map to the nested repo's own worktree, not the
	// parent's.
	base := gitInitRepo(t)
	nested := filepath.Join(base, "vendored")
	gitInit(t, nested, "n.txt")

	c := newConv(t, base, t.TempDir(), true)
	parentFile := c.Remap("conv-1", filepath.Join(base, "README.md"))
	nestedFile := c.Remap("conv-1", filepath.Join(nested, "n.txt"))

	if parentFile == filepath.Join(base, "README.md") {
		t.Fatal("parent repo file was not redirected")
	}
	if nestedFile == filepath.Join(nested, "n.txt") {
		t.Fatal("nested repo file was not redirected")
	}
	// Different repo groups → the nested repo has its own worktree.
	if filepath.Dir(filepath.Dir(parentFile)) == filepath.Dir(filepath.Dir(nestedFile)) {
		t.Errorf("nested repo shared the parent's worktree group:\n parent=%q\n nested=%q", parentFile, nestedFile)
	}
	if _, err := os.Stat(nestedFile); err != nil {
		t.Errorf("nested worktree file missing: %v", err)
	}
}

func TestConvWorktrees_ProjectInsideLargerRepo(t *testing.T) {
	// Project root is a SUBDIR of a repo (toplevel above the project). The whole
	// project maps to that repo's worktree.
	repo := gitInitRepo(t)
	sub := filepath.Join(repo, "packages", "app")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "x.go"), []byte("package app\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", ".")
	mustGit(t, repo, "commit", "-q", "-m", "add sub")

	c := newConv(t, sub, t.TempDir(), true)
	got := c.Remap("conv-1", filepath.Join(sub, "x.go"))
	if got == filepath.Join(sub, "x.go") {
		t.Fatal("expected redirect into the enclosing repo's worktree")
	}
	// The worktree checks out the whole repo, so the file sits at the same
	// repo-relative location (packages/app/x.go) within it.
	if !strings.HasSuffix(filepath.ToSlash(got), "packages/app/x.go") {
		t.Errorf("redirected path %q lost the repo-relative location", got)
	}
}

func TestConvWorktrees_RemapIdempotent(t *testing.T) {
	repo := gitInitRepo(t)
	c := newConv(t, repo, t.TempDir(), true)
	p := filepath.Join(repo, "README.md")
	first := c.Remap("conv-x", p)
	second := c.Remap("conv-x", p)
	if first != second {
		t.Errorf("Remap not idempotent: %q vs %q", first, second)
	}
}

func TestConvWorktrees_ContinuityAcrossRestart(t *testing.T) {
	repo := gitInitRepo(t)
	home := t.TempDir()
	p := filepath.Join(repo, "README.md")

	c1 := NewConvWorktrees(repo, home, true)
	first := c1.Remap("conv-persist", p)
	c1.Close()

	c2 := newConv(t, repo, home, true)
	again := c2.Remap("conv-persist", p)
	if again != first {
		t.Errorf("continuity: got %q, want original %q", again, first)
	}
}

func TestConvWorktrees_MetadataIgnoredInStatus(t *testing.T) {
	repo := gitInitRepo(t)
	c := newConv(t, repo, t.TempDir(), true)
	wtFile := c.Remap("conv-meta", filepath.Join(repo, "README.md"))
	wt := filepath.Dir(wtFile)

	if err := os.WriteFile(filepath.Join(wt, ".juggler", "juggler.lock"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if status := mustGit(t, wt, "status", "--porcelain"); strings.TrimSpace(status) != "" {
		t.Errorf(".juggler metadata leaked into worktree status:\n%s", status)
	}
}

func TestConvWorktrees_ReleasePrunesAllPristine(t *testing.T) {
	base := t.TempDir()
	repoA := filepath.Join(base, "a")
	repoB := filepath.Join(base, "b")
	gitInit(t, repoA, "a.txt")
	gitInit(t, repoB, "b.txt")
	c := newConv(t, base, t.TempDir(), true)

	wa := filepath.Dir(c.Remap("conv-1", filepath.Join(repoA, "a.txt")))
	wb := filepath.Dir(c.Remap("conv-1", filepath.Join(repoB, "b.txt")))

	c.Release("conv-1", true)

	for _, wt := range []string{wa, wb} {
		if _, err := os.Stat(wt); !os.IsNotExist(err) {
			t.Errorf("pristine worktree %s still present after permanent delete: %v", wt, err)
		}
	}
}

func TestConvWorktrees_ReleaseKeepsDirty(t *testing.T) {
	repo := gitInitRepo(t)
	c := newConv(t, repo, t.TempDir(), true)
	wt := filepath.Dir(c.Remap("conv-dirty", filepath.Join(repo, "README.md")))

	if err := os.WriteFile(filepath.Join(wt, "work.txt"), []byte("wip\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c.Release("conv-dirty", true)
	if _, err := os.Stat(wt); err != nil {
		t.Errorf("worktree with uncommitted work must be kept, got: %v", err)
	}
}

func TestConvWorktrees_ReleaseSoftKeeps(t *testing.T) {
	repo := gitInitRepo(t)
	c := newConv(t, repo, t.TempDir(), true)
	wt := filepath.Dir(c.Remap("conv-soft", filepath.Join(repo, "README.md")))

	c.Release("conv-soft", false)
	if _, err := os.Stat(wt); err != nil {
		t.Errorf("soft delete must keep the worktree, got: %v", err)
	}
}

func TestConvWorktrees_Tracked(t *testing.T) {
	base := t.TempDir()
	repoA := filepath.Join(base, "a")
	repoB := filepath.Join(base, "b")
	gitInit(t, repoA, "a.txt")
	gitInit(t, repoB, "b.txt")
	c := newConv(t, base, t.TempDir(), true)

	c.Remap("conv-1", filepath.Join(repoA, "a.txt"))
	c.Remap("conv-1", filepath.Join(repoB, "b.txt"))
	tracked := c.Tracked("conv-1")
	if len(tracked) != 2 {
		t.Errorf("Tracked = %d entries, want 2: %v", len(tracked), tracked)
	}
	if _, ok := tracked[filepath.Clean(repoA)]; !ok {
		t.Errorf("Tracked missing repoA: %v", tracked)
	}
}

func TestConvWorktrees_WorktreeForRepo(t *testing.T) {
	repo := gitInitRepo(t)
	c := newConv(t, repo, t.TempDir(), true)
	wt := c.WorktreeForRepo("conv-1", repo)
	if wt == "" || wt == repo {
		t.Fatalf("WorktreeForRepo = %q, want a distinct worktree", wt)
	}
	if _, err := os.Stat(filepath.Join(wt, "README.md")); err != nil {
		t.Errorf("worktree checkout missing: %v", err)
	}
}

func TestRepoRootWithin(t *testing.T) {
	base := t.TempDir()
	repoA := filepath.Join(base, "a")
	nested := filepath.Join(repoA, "inner")
	gitInit(t, repoA, "a.txt")
	gitInit(t, nested, "n.txt")

	cases := []struct {
		name, path, want string
	}{
		{"file in repoA", filepath.Join(repoA, "a.txt"), repoA},
		{"file in nested repo", filepath.Join(nested, "n.txt"), nested},
		{"loose file under non-git base", filepath.Join(base, "loose.txt"), ""},
		{"outside project", filepath.Join(t.TempDir(), "x"), ""},
	}
	for _, tc := range cases {
		got := repoRootWithin(tc.path, base, "")
		if got != tc.want {
			t.Errorf("%s: repoRootWithin = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestProjectConfigWorktreeEnabled(t *testing.T) {
	tru, fls := true, false
	cases := []struct {
		name string
		val  *bool
		want bool
	}{
		{"nil defaults on", nil, true},
		{"explicit true", &tru, true},
		{"explicit false", &fls, false},
	}
	for _, tc := range cases {
		if got := (ProjectConfig{Worktree: tc.val}).WorktreeEnabled(); got != tc.want {
			t.Errorf("%s: WorktreeEnabled() = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestWorktreeGroupNameStableAndUnique(t *testing.T) {
	a := worktreeGroupName("/home/u/projects/myrepo")
	b := worktreeGroupName("/home/u/projects/myrepo")
	c := worktreeGroupName("/home/u/other/myrepo")
	if a != b {
		t.Errorf("group name not stable: %q vs %q", a, b)
	}
	if a == c {
		t.Errorf("distinct repo paths produced identical group name: %q", a)
	}
}
