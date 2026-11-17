//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/gitcmd"
	"juggler/cmd/juggler/gitview"
)

// The network writes, against a bare repository on this disk standing in for a
// remote: git talks to it through the same transport machinery — upload-pack,
// receive-pack, progress and refusals — as it would to a server.

// cloneOf is another clone of the remote: somebody else's, who pushes to it.
func cloneOf(t *testing.T, bare string) *repo {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "other")
	r := &repo{t: t, dir: t.TempDir()}
	r.git("clone", "-q", bare, dir)
	r.dir = dir
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

// remoteSha is what the bare remote has ref at, or "".
func remoteSha(t *testing.T, bare, ref string) string {
	t.Helper()
	r := &repo{t: t, dir: bare}
	if !r.hasRef(ref) {
		return ""
	}
	return r.sha(ref)
}

// netOp runs one write and collects what it reported along the way.
func netOp(t *testing.T, root string, o Op) (Result, []string, []Progress, error) {
	t.Helper()
	q := NewQueue()
	defer q.Close()
	var commands []string
	var progress []Progress
	var out strings.Builder
	res, err := Run(t.Context(), q, root, o, Hooks{
		Command:  func(args []string) { commands = append(commands, strings.Join(args, " ")) },
		Output:   func(b []byte) { out.Write(b) },
		Progress: func(p Progress) { progress = append(progress, p) },
	})
	if err != nil {
		t.Logf("output of the failed %s:\n%s", o.Kind, out.String())
	}
	if strings.Contains(out.String(), "\r") {
		t.Errorf("%s: a progress frame reached the output: %q", o.Kind, out.String())
	}
	return res, commands, progress, err
}

func TestFetchEveryRemotePruned(t *testing.T) {
	t.Parallel()
	r := committed(t)
	main := r.mainBranch()
	bare := r.withRemote()
	other := cloneOf(t, bare)
	other.git("push", "-q", "origin", "HEAD:refs/heads/doomed")
	r.git("fetch", "-q", "origin")
	other.write("theirs.txt", "theirs\n")
	other.commit("theirs")
	other.git("push", "-q", "origin", "HEAD:"+main)
	other.git("push", "-q", "origin", "--delete", "doomed")

	_, commands, progress, err := netOp(t, r.dir, Op{Kind: OpFetch})
	if err != nil {
		t.Fatal(err)
	}
	if r.sha("origin/"+main) != other.sha("HEAD") {
		t.Fatal("fetch did not bring the remote's new commit")
	}
	if r.hasRef("refs/remotes/origin/doomed") {
		t.Fatal("fetch did not prune a branch the remote deleted")
	}
	if len(commands) != 1 || !strings.HasPrefix(commands[0], "fetch --all --prune --progress") {
		t.Fatalf("commands = %q", commands)
	}
	if len(progress) == 0 {
		t.Fatal("a fetch that received objects reported no progress")
	}
}

func TestPullFastForwardsThenOffersMergeOrRebase(t *testing.T) {
	t.Parallel()
	r := committed(t)
	main := r.mainBranch()
	bare := r.withRemote()
	other := cloneOf(t, bare)
	other.write("theirs.txt", "one\n")
	other.commit("theirs one")
	other.git("push", "-q", "origin", "HEAD:"+main)

	_, commands, _, err := netOp(t, r.dir, Op{Kind: OpPull})
	if err != nil {
		t.Fatal(err)
	}
	if r.sha("HEAD") != other.sha("HEAD") {
		t.Fatal("pull did not fast-forward to the upstream")
	}
	if !slices.ContainsFunc(commands, func(c string) bool { return strings.HasPrefix(c, "merge --ff-only") }) {
		t.Fatalf("pull's default is a fast-forward only: %q", commands)
	}

	// A change of mine in the way of the fast-forward is refused, then carried
	// across it in a stash when asked.
	other.write("theirs.txt", "one and a half\n")
	other.commit("theirs again")
	other.git("push", "-q", "origin", "HEAD:"+main)
	r.write("theirs.txt", "mine in the way\n")
	_, _, _, err = netOp(t, r.dir, Op{Kind: OpPull})
	mustFailAs[*DirtyError](t, err, "pulling over a change git would overwrite")
	r.write("theirs.txt", "one\n")
	r.write("a.txt", "A\nb\nc\nd\n")
	other.write("a.txt", "a\nb\nc\nd\ne\n")
	other.commit("theirs a")
	other.git("push", "-q", "origin", "HEAD:"+main)
	_, _, _, err = netOp(t, r.dir, Op{Kind: OpPull})
	mustFailAs[*DirtyError](t, err, "pulling over a change to a file the pull changes")
	if _, _, _, err := netOp(t, r.dir, Op{Kind: OpPull, Dirty: DirtyStash}); err != nil {
		t.Fatal(err)
	}
	if r.sha("HEAD") != other.sha("HEAD") || r.read("a.txt") != "A\nb\nc\nd\ne\n" {
		t.Fatalf("pulling with the change set aside: HEAD moved %v, a.txt = %q", r.sha("HEAD") == other.sha("HEAD"), r.read("a.txt"))
	}
	if r.out("stash", "list") != "" {
		t.Fatal("the stash a pull set its changes aside in was left behind")
	}
	r.git("checkout", "-q", "--", ".")

	// Both sides move on: a fast-forward is impossible, and nothing is touched.
	r.write("mine.txt", "mine\n")
	r.commit("mine")
	other.write("theirs.txt", "two\n")
	other.commit("theirs two")
	other.git("push", "-q", "origin", "HEAD:"+main)
	mine := r.sha("HEAD")
	_, _, _, err = netOp(t, r.dir, Op{Kind: OpPull})
	diverged := wantErr[*DivergedError](t, err, "pulling a diverged branch")
	if diverged.Prefer != "merge" {
		t.Fatalf("with no pull.rebase, merge is offered first: %q", diverged.Prefer)
	}
	if r.sha("HEAD") != mine {
		t.Fatal("a refused pull moved HEAD")
	}
	r.git("config", "pull.rebase", "true")
	_, _, _, err = netOp(t, r.dir, Op{Kind: OpPull})
	if wantErr[*DivergedError](t, err, "pulling again").Prefer != "rebase" {
		t.Fatal("pull.rebase=true did not put rebase first")
	}

	if _, _, _, err := netOp(t, r.dir, Op{Kind: OpPull, Mode: PullMerge}); err != nil {
		t.Fatal(err)
	}
	if parents := strings.Fields(r.out("log", "-1", "--format=%P")); len(parents) != 2 {
		t.Fatalf("pull with merge made %d parents", len(parents))
	}

	r.git("reset", "-q", "--hard", mine)
	if _, _, _, err := netOp(t, r.dir, Op{Kind: OpPull, Mode: PullRebase}); err != nil {
		t.Fatal(err)
	}
	if r.out("log", "-1", "--format=%s") != "mine" || r.sha("HEAD~1") != other.sha("HEAD") {
		t.Fatal("pull with rebase did not replay mine onto the upstream")
	}
}

func TestPushAndPublish(t *testing.T) {
	t.Parallel()
	r := committed(t)
	main := r.mainBranch()
	bare := r.withRemote()

	r.write("mine.txt", "mine\n")
	r.commit("mine")
	_, commands, _, err := netOp(t, r.dir, Op{Kind: OpPush})
	if err != nil {
		t.Fatal(err)
	}
	if remoteSha(t, bare, "refs/heads/"+main) != r.sha("HEAD") {
		t.Fatal("push did not move the remote's branch")
	}
	if want := "push --porcelain --progress origin refs/heads/" + main + ":refs/heads/" + main; !slices.Contains(commands, want) {
		t.Fatalf("commands = %q, want %q", commands, want)
	}

	// A branch's first push publishes it: the upstream is set.
	r.git("switch", "-q", "-c", "feat")
	r.write("feat.txt", "feat\n")
	r.commit("feat")
	if _, _, _, err := netOp(t, r.dir, Op{Kind: OpPush}); err != nil {
		t.Fatal(err)
	}
	if remoteSha(t, bare, "refs/heads/feat") != r.sha("HEAD") || r.out("rev-parse", "--abbrev-ref", "feat@{upstream}") != "origin/feat" {
		t.Fatal("publishing feat did not push it and track it")
	}
}

// Publishing with remotes none of which is the obvious one asks which.
func TestPublishAsksWhichRemote(t *testing.T) {
	t.Parallel()
	r := committed(t)
	for _, name := range []string{"fork", "upstream"} {
		bare := filepath.Join(t.TempDir(), name+".git")
		r.git("init", "-q", "--bare", bare)
		r.git("remote", "add", name, bare)
	}
	_, _, _, err := netOp(t, r.dir, Op{Kind: OpPush})
	needed := wantErr[*RemoteNeededError](t, err, "publishing with two remotes, neither origin")
	if !slices.Equal(needed.Remotes, []string{"fork", "upstream"}) {
		t.Fatalf("remotes offered = %q", needed.Remotes)
	}
	_, _, _, err = netOp(t, r.dir, Op{Kind: OpPush, Remote: "nosuch"})
	mustFailAs[*RefusedError](t, err, "a remote that is not one")

	if _, _, _, err := netOp(t, r.dir, Op{Kind: OpPush, Remote: "fork"}); err != nil {
		t.Fatal(err)
	}
	if got := r.out("rev-parse", "--abbrev-ref", "@{upstream}"); got != "fork/"+r.mainBranch() {
		t.Fatalf("upstream after publishing to fork = %q", got)
	}

	// remote.pushDefault names one, so nobody is asked.
	r.git("switch", "-q", "-c", "second")
	r.git("config", "remote.pushDefault", "upstream")
	if _, _, _, err := netOp(t, r.dir, Op{Kind: OpPush}); err != nil {
		t.Fatal(err)
	}
	if got := r.out("rev-parse", "--abbrev-ref", "@{upstream}"); got != "upstream/second" {
		t.Fatalf("upstream after publishing with pushDefault = %q", got)
	}
}

func TestPushRejectedThenForcedWithLease(t *testing.T) {
	t.Parallel()
	r := committed(t)
	main := r.mainBranch()
	bare := r.withRemote()
	other := cloneOf(t, bare)
	other.write("theirs.txt", "theirs\n")
	other.commit("theirs")
	other.git("push", "-q", "origin", "HEAD:"+main)
	theirs := other.sha("HEAD")
	r.write("mine.txt", "mine\n")
	r.commit("mine")

	_, _, _, err := netOp(t, r.dir, Op{Kind: OpPush})
	rejected := wantErr[*RejectedError](t, err, "pushing behind the remote")
	// "fetch first" when the remote has commits this repository has not seen,
	// "non-fast-forward" once it has.
	if !slices.Equal(rejected.Refs, []string{"refs/heads/" + main}) || (rejected.Reason != "fetch first" && rejected.Reason != "non-fast-forward") {
		t.Fatalf("rejected = %q, %q", rejected.Refs, rejected.Reason)
	}

	// A lease on what the remote held before is out of date: refused, untouched.
	stale := r.sha("origin/" + main)
	_, _, _, err = netOp(t, r.dir, Op{Kind: OpPush, Force: true, ExpectSha: stale})
	mustFailAs[*StaleError](t, err, "forcing with a lease the remote has moved past")
	if remoteSha(t, bare, "refs/heads/"+main) != theirs {
		t.Fatal("a refused lease moved the remote")
	}
	_, _, _, err = netOp(t, r.dir, Op{Kind: OpPush, Force: true})
	mustFailAs[*RefusedError](t, err, "forcing with no lease")

	_, commands, _, err := netOp(t, r.dir, Op{Kind: OpPush, Force: true, ExpectSha: theirs})
	if err != nil {
		t.Fatal(err)
	}
	if remoteSha(t, bare, "refs/heads/"+main) != r.sha("HEAD") {
		t.Fatal("forcing with the right lease did not move the remote")
	}
	if !slices.ContainsFunc(commands, func(c string) bool {
		return strings.Contains(c, "--force-with-lease=refs/heads/"+main+":"+theirs) && !strings.Contains(c, " --force ")
	}) {
		t.Fatalf("commands = %q", commands)
	}
}

func TestPushTagAndDeleteRemoteBranch(t *testing.T) {
	t.Parallel()
	r := committed(t)
	bare := r.withRemote()
	r.git("tag", "v1")
	if _, _, _, err := netOp(t, r.dir, Op{Kind: OpPushTag, Name: "v1"}); err != nil {
		t.Fatal(err)
	}
	if remoteSha(t, bare, "refs/tags/v1") != r.sha("v1") {
		t.Fatal("push-tag did not push v1")
	}

	r.git("push", "-q", "origin", "HEAD:refs/heads/gone")
	r.git("fetch", "-q", "origin")
	_, _, _, err := netOp(t, r.dir, Op{Kind: OpRemoteBranchDelete, Ref: "origin/gone", ExpectSha: "0123456789012345678901234567890123456789"})
	mustFailAs[*StaleError](t, err, "deleting a remote branch that is not where it was seen")
	res, _, _, err := netOp(t, r.dir, Op{Kind: OpRemoteBranchDelete, Ref: "origin/gone", ExpectSha: r.sha("origin/gone")})
	if err != nil {
		t.Fatal(err)
	}
	if remoteSha(t, bare, "refs/heads/gone") != "" || r.hasRef("refs/remotes/origin/gone") {
		t.Fatal("remote-branch-delete left the branch or its tracking ref")
	}
	if res.Sha == "" {
		t.Fatal("the deleted branch's tip was not reported")
	}
}

// A network write waits on its own lane, so a slow fetch never holds up a
// local write — and cancelling it stops git, frees the lane and leaves no lock.
func TestCancelledFetchFreesItsLaneAndLeavesNoLock(t *testing.T) {
	t.Parallel()
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in upload-pack is an sh script")
	}
	r := committed(t)
	r.withRemote()
	started := filepath.Join(t.TempDir(), "started")
	script := filepath.Join(t.TempDir(), "upload-pack")
	if err := os.WriteFile(script, []byte("#!/bin/sh\ntouch '"+started+"'\nexec sleep 600\n"), 0o700); err != nil { //nolint:gosec // the stand-in must be executable
		t.Fatal(err)
	}
	r.git("config", "remote.origin.uploadpack", script)

	q := NewQueue()
	defer q.Close()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ended := make(chan error, 1)
	go func() {
		_, err := Run(ctx, q, r.dir, Op{Kind: OpFetch}, Hooks{})
		ended <- err
	}()

	// Wait until the remote end is running — or the fetch has ended without
	// ever reaching it, which fails the test.
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		select {
		case err := <-ended:
			t.Fatalf("the fetch ended before reaching the remote: %v", err)
		case <-tick.C:
		}
	}

	// While it talks to the remote, a local write gets its turn.
	_, common, err := gitview.GitDirs(t.Context(), r.dir)
	if err != nil {
		t.Fatal(err)
	}
	mustOpOn(t, q, r.dir, Op{Kind: OpBranchCreate, Name: "while-fetching"})

	cancel()
	err = <-ended
	var failed *gitcmd.Error
	if !errors.As(err, &failed) || !failed.Cancelled {
		t.Fatalf("a cancelled fetch ended with %v, want a cancelled git error", err)
	}
	for _, key := range []string{common, common + netLane} {
		turn, err := q.Wait(t.Context(), key)
		if err != nil {
			t.Fatal(err)
		}
		turn.Done()
	}
	_ = filepath.WalkDir(common, func(path string, d fs.DirEntry, err error) error {
		if err == nil && strings.HasSuffix(path, ".lock") {
			t.Errorf("a cancelled fetch left %s", path)
		}
		return nil
	})
}

// mustOpOn runs one write on a queue the test shares.
func mustOpOn(t *testing.T, q *Queue, root string, o Op) {
	t.Helper()
	if _, err := Run(t.Context(), q, root, o, Hooks{}); err != nil {
		t.Fatalf("%s: %v", o.Kind, err)
	}
}
