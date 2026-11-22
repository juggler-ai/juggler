//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// withSubmodule is a repository with a submodule at lib, recorded at the
// library's second commit; it returns both of the library's commits. Git
// refuses to clone from a plain path for a submodule unless told the file
// transport is allowed, which only the fixture's own command is.
func withSubmodule(t *testing.T) (super *repo, first, second string) {
	t.Helper()
	lib := newRepo(t)
	lib.write("lib.txt", "one\n")
	lib.commit("one")
	first = strings.TrimSpace(lib.git("rev-parse", "HEAD"))
	lib.write("lib.txt", "two\n")
	lib.commit("two")
	second = strings.TrimSpace(lib.git("rev-parse", "HEAD"))
	super = committed(t)
	super.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.dir, "lib")
	// The clone has a config of its own, without the identity initRepo gives a
	// repository; macOS makes one up from the host name, Linux and Windows refuse.
	sub := &repo{t: t, dir: filepath.Join(super.dir, "lib")}
	sub.git("config", "user.email", "test@example.com")
	sub.git("config", "user.name", "Juggler Test")
	super.commit("add lib")
	return super, first, second
}

func TestSubmoduleUpdate(t *testing.T) {
	t.Parallel()
	super, first, second := withSubmodule(t)
	sub := &repo{t: t, dir: filepath.Join(super.dir, "lib")}
	sub.git("checkout", "-q", "-b", "topic", first)

	res := mustOp(t, super.dir, Op{Kind: OpSubmoduleUpdate, Path: "lib"})
	if head := strings.TrimSpace(sub.git("rev-parse", "HEAD")); head != second {
		t.Errorf("after the update lib is at %s, want the recorded %s", head, second)
	}
	if res.Sha != first || res.Branch != "topic" {
		t.Errorf("result = %+v, want where lib was: %s on topic", res, first)
	}
	if topic := strings.TrimSpace(sub.git("rev-parse", "topic")); topic != first {
		t.Errorf("topic moved to %s; the update must leave the branch it had out alone", topic)
	}

	// The undo is switching back, in the submodule's own repository.
	mustOp(t, super.dir, Op{Kind: OpSwitch, Repo: "lib", Branch: "topic"})
	if head := strings.TrimSpace(sub.git("rev-parse", "HEAD")); head != first {
		t.Errorf("switching back left lib at %s, want %s", head, first)
	}
}

func TestSubmoduleUpdateChecksOutOneNeverCheckedOut(t *testing.T) {
	t.Parallel()
	super, _, second := withSubmodule(t)
	super.git("submodule", "deinit", "-q", "-f", "lib")
	if super.exists("lib/lib.txt") {
		t.Fatal("deinit left the submodule checked out")
	}

	res := mustOp(t, super.dir, Op{Kind: OpSubmoduleUpdate, Path: "lib"})
	sub := &repo{t: t, dir: filepath.Join(super.dir, "lib")}
	if head := strings.TrimSpace(sub.git("rev-parse", "HEAD")); head != second {
		t.Errorf("lib is at %s, want the recorded %s", head, second)
	}
	if res.Sha != "" || res.Branch != "" {
		t.Errorf("result = %+v, want nothing to go back to", res)
	}
}

// A submodule checked out at another commit than the one recorded is not a
// change in a rebase's way — git's own check ignores submodules — so a pull
// that rebases over it goes ahead. Here it is checked out at the commit the
// upstream moved it to, the usual case after pulling the submodule first.
func TestPullRebaseOverAMovedSubmodule(t *testing.T) {
	t.Parallel()
	super, first, _ := withSubmodule(t)
	main := super.mainBranch()
	bare := super.withRemote()
	other := cloneOf(t, bare)
	other.git("update-index", "--cacheinfo", "160000,"+first+",lib")
	other.git("commit", "-qm", "lib back to one")
	other.git("push", "-q", "origin", "HEAD:"+main)

	super.write("mine.txt", "mine\n")
	super.commit("mine")
	sub := &repo{t: t, dir: filepath.Join(super.dir, "lib")}
	sub.git("checkout", "-q", first)

	if _, _, _, err := netOp(t, super.dir, Op{Kind: OpPull, Mode: PullRebase}); err != nil {
		t.Fatal(err)
	}
	if super.out("log", "-1", "--format=%s") != "mine" || super.sha("HEAD~1") != other.sha("HEAD") {
		t.Fatal("pull with rebase did not replay mine onto the upstream")
	}
	if status := super.out("status", "--porcelain"); status != "" {
		t.Fatalf("after the rebase the tree is not clean: %q", status)
	}
}

// TestResolveSubmodule takes each side of a submodule both branches moved:
// the side's commit is what gets recorded, whatever the submodule has checked
// out, and the submodule itself is left alone.
func TestResolveSubmodule(t *testing.T) {
	t.Parallel()
	// Not a commit of lib's: git cannot merge the two moves, so they conflict.
	const elsewhere = "1111111111111111111111111111111111111111"
	for side, want := range map[string]string{"ours": elsewhere, "theirs": "first"} {
		t.Run(side, func(t *testing.T) {
			t.Parallel()
			super, first, second := withSubmodule(t)
			if want == "first" {
				want = first
			}
			main := super.mainBranch()
			super.git("switch", "-q", "-c", "topic")
			super.git("update-index", "--cacheinfo", "160000,"+first+",lib")
			super.git("commit", "-qm", "lib back to one")
			super.git("switch", "-q", main)
			super.git("update-index", "--cacheinfo", "160000,"+elsewhere+",lib")
			super.git("commit", "-qm", "lib elsewhere")
			_, err := op(t, super.dir, Op{Kind: OpMerge, Rev: "topic"})
			mustFailAs[*ConflictsError](t, err, "the merge")

			mustOp(t, super.dir, Op{Kind: OpResolve, Path: "lib", Mode: side})
			if stages := super.unmergedStages("lib"); stages != "0" {
				t.Fatalf("stages %q, want resolved", stages)
			}
			if got := strings.Fields(super.out("ls-files", "-s", "--", "lib")); len(got) < 2 || got[0] != "160000" || got[1] != want {
				t.Fatalf("index records lib as %v, want 160000 %s", got, want)
			}
			sub := &repo{t: t, dir: filepath.Join(super.dir, "lib")}
			if head := strings.TrimSpace(sub.git("rev-parse", "HEAD")); head != second {
				t.Fatalf("the resolve moved lib to %s", head)
			}
		})
	}
}

func TestSubmoduleUpdateRefusesAPlainDirectory(t *testing.T) {
	t.Parallel()
	r := committed(t)
	r.write("dir/x.txt", "x\n")
	r.commit("dir")
	_, err := op(t, r.dir, Op{Kind: OpSubmoduleUpdate, Path: "dir"})
	var refusedErr *RefusedError
	if !errors.As(err, &refusedErr) {
		t.Errorf("err = %v, want a refusal", err)
	}
}
