//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"testing"

	"juggler/internal/projectpaths"
)

// TestEphemeralConversationIsNeverPartOfTheSession pins what an ephemeral
// conversation — the one a headless agent run works in — may and may not do.
// Its worker must be able to find and save into its folder, but nothing that
// lists the session's conversations may see it: not the order, not the names,
// not a reorder that names it, not the cap, and not the next load's scan. Its
// delete removes the folder and nothing else.
func TestEphemeralConversationIsNeverPartOfTheSession(t *testing.T) {
	mgr := newManagerForTest(t)
	listed, _, err := mgr.CreateConversation("Listed")
	if err != nil {
		t.Fatal(err)
	}
	before := slices.Clone(mgr.GetSession().ConversationOrder)

	id, dir, err := mgr.CreateEphemeralConversation("Agent run", "")
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := mgr.ConvDir(id); !ok || got != dir {
		t.Fatalf("ConvDir(%s) = %q, %v; want the ephemeral folder %q", id, got, ok, dir)
	}
	if !mgr.IsEphemeral(id) || mgr.IsEphemeral(listed) {
		t.Errorf("IsEphemeral: run=%v listed=%v, want true, false", mgr.IsEphemeral(id), mgr.IsEphemeral(listed))
	}
	if saved, err := mgr.SaveConversationBinaryIfOwned(id, []byte("doc")); err != nil || !saved {
		t.Fatalf("the run's worker could not save into its folder: saved=%v err=%v", saved, err)
	}
	if _, err := os.Stat(ConvDocPath(dir)); err != nil {
		t.Fatalf("the save did not land in the ephemeral folder: %v", err)
	}

	if got := mgr.GetSession().ConversationOrder; !slices.Equal(got, before) {
		t.Errorf("order after an ephemeral create = %v, want it unchanged at %v", got, before)
	}
	if _, ok := mgr.ConvNames()[id]; ok {
		t.Error("the ephemeral conversation is listed in ConvNames, which GET /api/session exposes")
	}
	order, _, err := mgr.ReorderConversations([]string{id, listed}, id)
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(order, id) {
		t.Errorf("a reorder naming the ephemeral conversation put it in the order: %v", order)
	}

	// A fresh manager over the same folder is the next launch: it must neither
	// list the run nor keep its folder.
	store, err := NewFileSessionStore(mgr.GetProjectPath())
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(reloaded.ConversationOrder, id) {
		t.Errorf("the next load put the run's leftover folder in the order: %v", reloaded.ConversationOrder)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("the next load kept the run's leftover folder %s (stat err %v)", dir, err)
	}

	id2, dir2, err := mgr.CreateEphemeralConversation("Agent run", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := mgr.DeleteEphemeralConversation(id2); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir2); !os.IsNotExist(err) {
		t.Errorf("the ephemeral folder survived its delete (stat err %v)", err)
	}
	if _, ok := mgr.ConvDir(id2); ok {
		t.Error("a deleted ephemeral conversation still resolves to a folder")
	}
	if saved, _ := mgr.SaveConversationBinaryIfOwned(id2, []byte("late")); saved {
		t.Error("a late worker save recreated a deleted ephemeral conversation")
	}
	if err := mgr.DeleteEphemeralConversation(listed); err == nil {
		t.Error("DeleteEphemeralConversation removed a listed conversation")
	}
	if _, ok := mgr.ConvDir(listed); !ok {
		t.Error("the listed conversation is gone")
	}
}

// TestEphemeralConversationsDoNotCountTowardTheCap: a run is not a tab, so a
// full bar never refuses one and a run never takes a tab's place.
func TestEphemeralConversationsDoNotCountTowardTheCap(t *testing.T) {
	mgr, err := NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mgr.Shutdown)
	for i := range MaxConversations {
		if _, _, err := mgr.CreateConversation("Conv " + strconv.Itoa(i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, dir, err := mgr.CreateEphemeralConversation("Agent run", ""); err != nil {
		t.Errorf("a full session refused an ephemeral conversation: %v", err)
	} else if filepath.Dir(filepath.Dir(dir)) != projectpaths.StateDir(mgr.GetProjectPath()) {
		t.Errorf("ephemeral folder %s is not under the state folder's runs folder", dir)
	}
}
