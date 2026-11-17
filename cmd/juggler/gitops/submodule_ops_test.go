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
