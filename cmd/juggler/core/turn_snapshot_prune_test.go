//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os/exec"
	"strings"
	"testing"

	"juggler/cmd/juggler/gitview"
)

// A conversation that is gone for good takes its turn snapshot ref with it;
// one that is only binned keeps it, since it can be restored.
func TestTurnSnapshotDroppedWithConversation(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	m := newManagerForTest(t)
	project := m.GetProjectPath()
	git := func(args ...string) (string, error) {
		cmd := exec.Command("git", args...)
		cmd.Dir = project
		out, err := cmd.Output()
		return strings.TrimSpace(string(out)), err
	}
	if _, err := git("init", "-q"); err != nil {
		t.Fatal(err)
	}
	tree, err := git("hash-object", "-t", "tree", "--stdin")
	if err != nil {
		t.Fatal(err)
	}
	snapshot := func(name string) (conv, ref string) {
		t.Helper()
		conv, _, err := m.CreateConversation(name)
		if err != nil {
			t.Fatal(err)
		}
		ref, ok := gitview.TurnRef(conv)
		if !ok {
			t.Fatalf("conversation id %q names no turn ref", conv)
		}
		if _, err := git("update-ref", ref, tree); err != nil {
			t.Fatal(err)
		}
		return conv, ref
	}
	has := func(ref string) bool {
		_, err := git("rev-parse", "--verify", "-q", ref)
		return err == nil
	}

	deleted, deletedRef := snapshot("Deleted")
	binned, binnedRef := snapshot("Binned")
	staying, stayingRef := snapshot("Staying")
	if err := m.DeleteConversation(deleted, true); err != nil {
		t.Fatal(err)
	}
	if has(deletedRef) {
		t.Error("a deleted conversation's turn snapshot ref survived it")
	}
	if err := m.BinConversation(binned); err != nil {
		t.Fatal(err)
	}
	if !has(binnedRef) {
		t.Error("binning a conversation dropped its turn snapshot ref")
	}
	if err := m.DeleteBinnedConversation(binned); err != nil {
		t.Fatal(err)
	}
	if has(binnedRef) {
		t.Error("a conversation deleted from the bin kept its turn snapshot ref")
	}
	if !has(stayingRef) {
		t.Errorf("another conversation's ref (%s) went with them", staying)
	}
}
