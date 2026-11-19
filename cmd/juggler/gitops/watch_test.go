//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/gitview"

	"github.com/fsnotify/fsnotify"
)

// Two kinds of test here. The fan-out tests build real repositories — the
// directory layout of a linked worktree is git's to decide, not ours — but hand
// the watcher synthetic events and flush by hand, so what each tree is told is
// exact and nothing waits on the clock. The end-to-end tests run real git
// against real fsnotify and wait for what they expect to arrive; they never
// assert that something did not, which only a clock could say.

// TestMain gives git a configuration of nothing but what the tests set, as
// gitview's tests do: the machine's and the user's settings could carry hooks or
// housekeeping that write into .git behind a test's back.
func TestMain(m *testing.M) {
	home, err := os.MkdirTemp("", "gitops-home-*")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for k, v := range map[string]string{"GIT_CONFIG_NOSYSTEM": "1", "HOME": home, "XDG_CONFIG_HOME": filepath.Join(home, ".config")} {
		if err := os.Setenv(k, v); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	code := m.Run()
	_ = os.RemoveAll(home)
	os.Exit(code)
}

// repo is a throwaway repository.
type repo struct {
	t   *testing.T
	dir string
}

const repoConfig = "[user]\n\temail = test@example.com\n\tname = Juggler Test\n" +
	"[commit]\n\tgpgsign = false\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n"

func newRepo(t *testing.T) *repo {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	return initRepo(t, t.TempDir())
}

func initRepo(t *testing.T, dir string) *repo {
	t.Helper()
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	r := &repo{t: t, dir: dir}
	r.git("init", "-q")
	cfg := filepath.Join(dir, ".git", "config")
	existing, err := os.ReadFile(cfg) //nolint:gosec // a repository this test made
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg, append(existing, repoConfig...), 0o600); err != nil {
		t.Fatal(err)
	}
	return r
}

func (r *repo) git(args ...string) string {
	r.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = r.dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

func (r *repo) write(rel, content string) {
	r.t.Helper()
	abs := filepath.Join(r.dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o750); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o600); err != nil {
		r.t.Fatal(err)
	}
}

func (r *repo) commit(message string) {
	r.t.Helper()
	r.git("add", "-A")
	r.git("commit", "-qm", message)
}

// withLinkedWorktree is a committed repository and a linked worktree of it on a
// branch of its own, somewhere else on disk.
func withLinkedWorktree(t *testing.T) (main *repo, linked string) {
	t.Helper()
	main = newRepo(t)
	main.write("a.txt", "one\n")
	main.commit("init")
	linked = filepath.Join(t.TempDir(), "linked")
	main.git("worktree", "add", "-q", "-b", "side", linked)
	return main, linked
}

// dirs is a tree's two git directories, as the watcher keys them.
func dirs(t *testing.T, tree string) (own, common string) {
	t.Helper()
	own, common, err := gitview.GitDirs(t.Context(), tree)
	if err != nil {
		t.Fatal(err)
	}
	return own, common
}

// manualWatcher is a watcher that flushes only when a test says so.
func manualWatcher(t *testing.T) *Watcher {
	t.Helper()
	w, err := NewWatcher("", nil)
	if err != nil {
		t.Fatal(err)
	}
	w.manual = true
	t.Cleanup(w.Close)
	return w
}

func watch(t *testing.T, w *Watcher, root string) <-chan []Change {
	t.Helper()
	ch, err := w.Watch(t.Context(), root, Attribution{})
	if err != nil {
		t.Fatalf("Watch(%s): %v", root, err)
	}
	return ch
}

// flushed flushes the tree at root and returns what it was told, by repository.
func flushed(t *testing.T, w *Watcher, root string, ch <-chan []Change) map[string]Kinds {
	t.Helper()
	var target *tree
	w.do(func() {
		for tr := range w.trees {
			if tr.root == root {
				target = tr
			}
		}
	})
	if target == nil {
		t.Fatalf("no tree is watched at %s", root)
	}
	target.flush(t.Context())
	select {
	case batch := <-ch:
		got := map[string]Kinds{}
		for _, c := range batch {
			got[c.Repo] = c.Kinds
		}
		return got
	default:
		t.Fatalf("a manual flush of %s sent nothing", root)
		return nil
	}
}

func event(path string, op fsnotify.Op) fsnotify.Event {
	return fsnotify.Event{Name: path, Op: op}
}

// gitEvent hands the watcher one synthetic event in git's directories, on its
// own goroutine as a real one would arrive.
func gitEvent(w *Watcher, ev fsnotify.Event) {
	w.do(func() { w.handleGitEvent(ev) })
}

// treeEvent hands the watcher one synthetic working-tree change.
func treeEvent(w *Watcher, path, kind string) {
	w.do(func() { w.workingTreeChanged(path, kind) })
}

func describe(m map[string]Kinds) string {
	parts := []string{}
	for repo, k := range m {
		parts = append(parts, fmt.Sprintf("%q:%v", repo, k.Names()))
	}
	slices.Sort(parts)
	return "{" + strings.Join(parts, " ") + "}"
}

func expect(t *testing.T, what string, got map[string]Kinds, want map[string]Kinds) {
	t.Helper()
	if describe(got) != describe(want) {
		t.Errorf("%s: told %s, want %s", what, describe(got), describe(want))
	}
}

// A linked worktree keeps HEAD and its index in a directory of its own and
// shares refs with every other tree of the repository. So a ref is news to every
// tree, and a tree's HEAD or index only to that tree.
func TestWatch_LinkedWorktreeFanOut(t *testing.T) {
	main, linked := withLinkedWorktree(t)
	w := manualWatcher(t)
	mainCh, linkedCh := watch(t, w, main.dir), watch(t, w, linked)
	mainOwn, common := dirs(t, main.dir)
	linkedOwn, _ := dirs(t, linked)

	gitEvent(w, event(filepath.Join(common, "refs", "heads", "side"), fsnotify.Write))
	expect(t, "a branch moved: the main tree", flushed(t, w, main.dir, mainCh), map[string]Kinds{"": KindRefs})
	expect(t, "a branch moved: the linked tree", flushed(t, w, linked, linkedCh), map[string]Kinds{"": KindRefs})

	gitEvent(w, event(filepath.Join(linkedOwn, "HEAD"), fsnotify.Write))
	gitEvent(w, event(filepath.Join(linkedOwn, "index"), fsnotify.Create))
	expect(t, "the linked tree's HEAD and index: the linked tree", flushed(t, w, linked, linkedCh), map[string]Kinds{"": KindHead | KindIndex})
	expect(t, "the linked tree's HEAD and index: the main tree", flushed(t, w, main.dir, mainCh), map[string]Kinds{})

	gitEvent(w, event(filepath.Join(mainOwn, "index"), fsnotify.Create))
	expect(t, "the main tree's index: the main tree", flushed(t, w, main.dir, mainCh), map[string]Kinds{"": KindIndex})
	expect(t, "the main tree's index: the linked tree", flushed(t, w, linked, linkedCh), map[string]Kinds{})

	// git keeps FETCH_HEAD with the tree that fetched, but what was fetched is
	// the repository's.
	gitEvent(w, event(filepath.Join(linkedOwn, "FETCH_HEAD"), fsnotify.Write))
	expect(t, "a fetch from the linked tree: the main tree", flushed(t, w, main.dir, mainCh), map[string]Kinds{"": KindRefs})
	expect(t, "a fetch from the linked tree: the linked tree", flushed(t, w, linked, linkedCh), map[string]Kinds{"": KindRefs})

	gitEvent(w, event(filepath.Join(linkedOwn, "MERGE_HEAD"), fsnotify.Create))
	expect(t, "a merge begun in the linked tree: the linked tree", flushed(t, w, linked, linkedCh), map[string]Kinds{"": KindOperation})
	expect(t, "a merge begun in the linked tree: the main tree", flushed(t, w, main.dir, mainCh), map[string]Kinds{})
}

// A linked worktree removed (a workspace finished) takes its git directory with
// it. That tree is told everything changed, so its next read reports what is
// left; the rest hear only that the repository's list of trees changed.
func TestWatch_RemovedWorktreeReportsEverything(t *testing.T) {
	main, linked := withLinkedWorktree(t)
	w := manualWatcher(t)
	mainCh, linkedCh := watch(t, w, main.dir), watch(t, w, linked)
	linkedOwn, _ := dirs(t, linked)

	gitEvent(w, event(linkedOwn, fsnotify.Remove))
	expect(t, "the removed tree", flushed(t, w, linked, linkedCh), map[string]Kinds{"": AllKinds})
	expect(t, "the main tree", flushed(t, w, main.dir, mainCh), map[string]Kinds{"": KindRefs})
}

// However many events a burst holds, it is one change per repository.
func TestWatch_BurstIsOneChange(t *testing.T) {
	r := newRepo(t)
	r.write("a.txt", "x\n")
	r.commit("init")
	w := manualWatcher(t)
	ch := watch(t, w, r.dir)
	own, common := dirs(t, r.dir)

	for _, path := range []string{
		filepath.Join(own, "index"), filepath.Join(own, "index"), filepath.Join(own, "HEAD"),
		filepath.Join(common, "refs", "heads", "main"), filepath.Join(own, "MERGE_HEAD"),
	} {
		gitEvent(w, event(path, fsnotify.Write))
	}
	expect(t, "the burst", flushed(t, w, r.dir, ch), map[string]Kinds{"": KindIndex | KindHead | KindRefs | KindOperation})
	expect(t, "after the burst", flushed(t, w, r.dir, ch), map[string]Kinds{})
}

// A working-tree change is news to the repository it is in and to every one
// enclosing it: a superproject's status reports a submodule's dirty content.
func TestWatch_WorkingTreeChangesNameTheirRepositories(t *testing.T) {
	r := newRepo(t)
	r.write("a.txt", "x\n")
	r.commit("init")
	inner := initRepo(t, filepath.Join(r.dir, "libs", "inner"))
	inner.write("b.txt", "y\n")
	w := manualWatcher(t)
	ch := watch(t, w, r.dir)

	treeEvent(w, filepath.Join(r.dir, "a.txt"), "write")
	expect(t, "a file in the root repository", flushed(t, w, r.dir, ch), map[string]Kinds{"": KindWorktree})
	treeEvent(w, filepath.Join(r.dir, "libs", "inner", "b.txt"), "write")
	expect(t, "a file in the nested repository", flushed(t, w, r.dir, ch), map[string]Kinds{"": KindWorktree, "libs/inner": KindWorktree})
}

// A repository made after the watch began is found, watched and announced.
func TestWatch_NewRepositoryIsPickedUp(t *testing.T) {
	r := newRepo(t)
	r.write("a.txt", "x\n")
	r.commit("init")
	w := manualWatcher(t)
	ch := watch(t, w, r.dir)

	sub := initRepo(t, filepath.Join(r.dir, "sub"))
	treeEvent(w, sub.dir, "create")
	expect(t, "a repository created inside the tree", flushed(t, w, r.dir, ch), map[string]Kinds{"": KindWorktree, "sub": AllKinds})

	subOwn, _ := dirs(t, sub.dir)
	if !slices.Contains(w.fsw.WatchList(), subOwn) {
		t.Errorf("the new repository's git directory %s is not watched", subOwn)
	}
}

// waitFor reads batches until the repository has been told at least want, and
// fails if the watch ends or the test's deadline passes first. It bounds nothing
// by a clock of its own: the deadline only stops a hung test.
func waitFor(t *testing.T, ch <-chan []Change, repoRel string, want Kinds) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	var seen Kinds
	for seen&want != want {
		select {
		case batch, ok := <-ch:
			if !ok {
				t.Fatalf("the watch ended having told %q only %v; want %v", repoRel, seen.Names(), want.Names())
			}
			for _, c := range batch {
				if c.Repo == repoRel {
					seen |= c.Kinds
				}
			}
		case <-ctx.Done():
			t.Fatalf("waited for %v in %q; was told only %v", want.Names(), repoRel, seen.Names())
		}
	}
}

// The whole path, real git through real fsnotify: a commit in a linked worktree
// is its own HEAD, index and working tree, and a ref of every tree's.
func TestWatch_RealCommitInLinkedWorktree(t *testing.T) {
	main, linked := withLinkedWorktree(t)
	w, err := NewWatcher("", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	mainCh, linkedCh := watch(t, w, main.dir), watch(t, w, linked)

	tree := &repo{t: t, dir: linked}
	tree.write("b.txt", "new\n")
	tree.commit("on the side")

	waitFor(t, linkedCh, "", KindHead|KindIndex|KindRefs|KindWorktree)
	waitFor(t, mainCh, "", KindRefs)
}

// A push moves nothing but the remote-tracking ref it pushed to, which is how
// the branch stops being ahead: that is a change of refs.
func TestWatch_RealPushIsRefs(t *testing.T) {
	r := committed(t)
	r.withRemote()
	r.write("mine.txt", "mine\n")
	r.commit("ahead")

	w, err := NewWatcher("", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	ch := watch(t, w, r.dir)

	if _, _, _, err := netOp(t, r.dir, Op{Kind: OpPush}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ch, "", KindRefs)
}

// The same push from a submodule, whose git directory lies in its
// superproject's .git/modules, is that submodule's change of refs.
func TestWatch_RealPushInSubmoduleIsRefs(t *testing.T) {
	super, _, _ := withSubmodule(t)
	sub := &repo{t: t, dir: filepath.Join(super.dir, "lib")}
	bare := filepath.Join(t.TempDir(), "up.git")
	sub.git("init", "-q", "--bare", bare)
	sub.git("remote", "set-url", "origin", bare)
	sub.git("push", "-q", "-u", "origin", "HEAD:refs/heads/"+sub.mainBranch())
	sub.git("branch", "-q", "--set-upstream-to=origin/"+sub.mainBranch())
	sub.write("mine.txt", "mine\n")
	sub.commit("ahead")

	w, err := NewWatcher("", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	ch := watch(t, w, super.dir)

	if _, _, _, err := netOp(t, super.dir, Op{Kind: OpPush, Repo: "lib"}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, ch, "lib", KindRefs)
}

func TestWatch_RealMergeConflictIsOperation(t *testing.T) {
	r := newRepo(t)
	r.write("shared.txt", "first\n")
	r.commit("init")
	r.git("checkout", "-q", "-b", "other")
	r.write("shared.txt", "first\nfrom other\n")
	r.commit("other")
	r.git("checkout", "-q", "-")
	r.write("shared.txt", "first\nfrom main\n")
	r.commit("main")

	w, err := NewWatcher("", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	ch := watch(t, w, r.dir)

	merge := exec.Command("git", "merge", "other")
	merge.Dir = r.dir
	if out, err := merge.CombinedOutput(); err == nil {
		t.Fatalf("the merge succeeded; the test needs a conflict\n%s", out)
	}
	waitFor(t, ch, "", KindOperation)
}

// The project's tree is told of its working tree by the project's own watcher,
// and starts none of its own.
func TestWatch_ProjectTreeIsFedByTheProjectWatcher(t *testing.T) {
	r := newRepo(t)
	r.write("a.txt", "x\n")
	r.commit("init")
	fw, err := core.NewFileWatcherWith(r.dir, core.FileWatcherOptions{GitFeed: true})
	if err != nil {
		t.Fatal(err)
	}
	fw.Start()
	t.Cleanup(fw.Stop)
	go func() {
		for range fw.Changes() { //nolint:revive // the viewers' stream, which nobody here reads
		}
	}()
	w, err := NewWatcher(r.dir, fw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	ch := watch(t, w, r.dir)

	w.do(func() {
		for tr := range w.trees {
			if tr.fw != nil {
				t.Error("the project's tree started a file watcher of its own")
			}
		}
	})

	r.write(".github/ci.yml", "on: push\n")
	waitFor(t, ch, "", KindWorktree)
}

// A repository's directories are watched while any tree of it is, and not a
// moment longer: the last watch to end takes every one of them with it.
func TestWatch_SharedCommonDirRefcounted(t *testing.T) {
	main, linked := withLinkedWorktree(t)
	w, err := NewWatcher("", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	_, common := dirs(t, main.dir)

	mainCtx, endMain := context.WithCancel(t.Context())
	linkedCtx, endLinked := context.WithCancel(t.Context())
	mainCh, err := w.Watch(mainCtx, main.dir, Attribution{})
	if err != nil {
		t.Fatal(err)
	}
	linkedCh, err := w.Watch(linkedCtx, linked, Attribution{})
	if err != nil {
		t.Fatal(err)
	}

	endMain()
	drainUntilClosed(t, mainCh)
	if !slices.Contains(w.fsw.WatchList(), filepath.Join(common, "refs", "heads")) {
		t.Errorf("the shared refs stopped being watched while the linked tree still is; watching %v", w.fsw.WatchList())
	}

	endLinked()
	drainUntilClosed(t, linkedCh)
	if left := w.fsw.WatchList(); len(left) != 0 {
		t.Errorf("still watching %v after every watch ended", left)
	}
}

func drainUntilClosed(t *testing.T, ch <-chan []Change) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-ctx.Done():
			t.Fatal("the watch never ended")
		}
	}
}
