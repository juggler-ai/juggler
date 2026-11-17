//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"reflect"
	"testing"
)

// What a change to each file git keeps means for the trees that read it. A
// tree's own directory and the directory its repository shares are classified
// apart, because a main tree's are one directory and a linked tree's are two,
// and the same name means different things in each: HEAD in a tree's own
// directory is that tree's, a ref in the shared one is every tree's.
func TestClassifyTreeDir(t *testing.T) {
	cases := map[string]Kinds{
		"HEAD":                 KindHead,
		"logs/HEAD":            KindHead,
		"index":                KindIndex,
		"MERGE_HEAD":           KindOperation,
		"CHERRY_PICK_HEAD":     KindOperation,
		"REVERT_HEAD":          KindOperation,
		"rebase-merge":         KindOperation,
		"rebase-merge/done":    KindOperation,
		"rebase-apply/next":    KindOperation,
		"sequencer/todo":       KindOperation,
		"FETCH_HEAD":           KindRefs,
		"index.lock":           0, // the write in progress; the rename into place is the change
		"HEAD.lock":            0,
		"ORIG_HEAD":            0,
		"objects/ab/cdef":      0,
		"refs/heads/main":      0, // the shared directory's
		"config":               0, // the shared directory's
		"logs/refs/heads/main": 0,
	}
	for rel, want := range cases {
		if got := classifyTreeDir(rel); got != want {
			t.Errorf("classifyTreeDir(%q) = %v, want %v", rel, got.Names(), want.Names())
		}
	}
}

func TestClassifyCommonDir(t *testing.T) {
	cases := map[string]Kinds{
		"packed-refs":           KindRefs,
		"config":                KindRefs,
		"refs":                  KindRefs,
		"refs/heads/main":       KindRefs,
		"refs/heads/feat/x":     KindRefs,
		"refs/remotes/origin":   KindRefs,
		"refs/stash":            KindRefs,
		"logs/refs/stash":       KindRefs,
		"worktrees":             KindRefs,
		"worktrees/linked":      KindRefs,
		"packed-refs.lock":      0,
		"refs/heads/main.lock":  0,
		"config.lock":           0,
		"worktrees/linked/HEAD": 0, // that tree's own directory
		"logs/refs/heads/main":  0,
		"HEAD":                  0, // a tree's own
		"index":                 0,
		"objects/pack/x.pack":   0,
	}
	for rel, want := range cases {
		if got := classifyCommonDir(rel); got != want {
			t.Errorf("classifyCommonDir(%q) = %v, want %v", rel, got.Names(), want.Names())
		}
	}
}

// The names are the wire's, in one fixed order.
func TestKindsNames(t *testing.T) {
	if got, want := AllKinds.Names(), []string{"index", "refs", "head", "worktree", "operation"}; !reflect.DeepEqual(got, want) {
		t.Errorf("AllKinds.Names() = %v, want %v", got, want)
	}
	if got := (KindHead | KindIndex).Names(); !reflect.DeepEqual(got, []string{"index", "head"}) {
		t.Errorf("(head|index).Names() = %v", got)
	}
	if got := Kinds(0).Names(); len(got) != 0 {
		t.Errorf("no kinds named %v", got)
	}
}
