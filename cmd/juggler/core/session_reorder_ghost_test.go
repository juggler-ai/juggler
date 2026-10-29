//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"slices"
	"testing"
)

// TestReorderConversations_DoesNotResurrectBinnedConv is the regression guard
// for the phantom-tab bug. A viewer posts its ENTIRE tab list on every reorder,
// and it deliberately keeps a tab whose load failed, so a viewer that binned a
// conversation elsewhere — or simply has not applied the broadcast yet — will
// post an order still naming it. Merging that in put the id back into the
// manifest while its folder sat in .juggler/trash/, producing a tab with no
// conversation behind it: it displayed as "Untitled" (the name IS the folder
// name), could not be renamed (auto-naming died with ErrConversationNotFound,
// reported to the user as the model being unavailable), and duplicating it
// yielded an empty conversation called "(copy)".
//
// Ids enter the order by being created or restored. A reorder only ever
// permutes what is already there.
func TestReorderConversations_DoesNotResurrectBinnedConv(t *testing.T) {
	projectDir := t.TempDir()

	mgr, err := NewSessionManagerForPath(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Shutdown()

	keep, _, err := mgr.CreateConversation("Keep Me")
	if err != nil {
		t.Fatal(err)
	}
	binned, _, err := mgr.CreateConversation("Bin Me")
	if err != nil {
		t.Fatal(err)
	}
	if err := mgr.BinConversation(binned); err != nil {
		t.Fatal(err)
	}

	// A viewer that still shows the binned tab posts its whole list.
	merged, _, err := mgr.ReorderConversations([]string{binned, keep}, "")
	if err != nil {
		t.Fatalf("reorder: %v", err)
	}
	if slices.Contains(merged, binned) {
		t.Fatalf("ghost: reorder returned the binned conv %s to be broadcast (merged=%v)", binned, merged)
	}

	order := mgr.GetSession().ConversationOrder
	if slices.Contains(order, binned) {
		t.Fatalf("ghost: binned conv %s was put back into ConversationOrder by a reorder (order=%v)", binned, order)
	}
	if !slices.Contains(order, keep) {
		t.Fatalf("reorder dropped live conv %s (order=%v)", keep, order)
	}
}

// TestReorderConversations_StillReordersLiveConvs guards the mitigation against
// over-reach: filtering unknown ids must not disturb ordinary drag-reordering.
func TestReorderConversations_StillReordersLiveConvs(t *testing.T) {
	projectDir := t.TempDir()

	mgr, err := NewSessionManagerForPath(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr.Shutdown()

	a, _, err := mgr.CreateConversation("A")
	if err != nil {
		t.Fatal(err)
	}
	b, _, err := mgr.CreateConversation("B")
	if err != nil {
		t.Fatal(err)
	}
	c, _, err := mgr.CreateConversation("C")
	if err != nil {
		t.Fatal(err)
	}

	want := []string{b, c, a}
	merged, _, err := mgr.ReorderConversations(want, a)
	if err != nil {
		t.Fatalf("reorder: %v", err)
	}
	if got := mgr.GetSession().ConversationOrder; !slices.Equal(got, want) {
		t.Fatalf("reorder of live conversations = %v, want %v", got, want)
	}
	// The returned order is what every viewer is told, so it has to be the
	// manifest's, not an echo of what the caller happened to post.
	if !slices.Equal(merged, want) {
		t.Fatalf("reorder returned %v to be broadcast, want %v", merged, want)
	}
}
