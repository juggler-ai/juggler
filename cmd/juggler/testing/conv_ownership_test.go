//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package testing

import "testing"

// TestConvOwnership pins the test-mode conversation-ownership guard: in the
// multi-lane pool every lane shares one server session, and the ONLY safe
// deleter of a conversation is the lane that created it. A cross-lane delete
// permanently tears down the victim lane's worker mid-test (its doc freezes
// with a tool stuck at state=running), so the guard must reject it at the API
// boundary — ownership discipline must not depend on every JS call site
// remembering to behave.
func TestConvOwnership(t *testing.T) {
	o := NewConvOwnership()
	defer o.Stop()

	o.Record("conv_a", "lane1", "integration:test-a")
	o.Record("conv_b", "lane2", "integration:test-b")

	// Owner deleting its own conversation: allowed.
	if err := o.CheckDelete("conv_a", "lane1"); err != nil {
		t.Fatalf("owner delete should be allowed, got %v", err)
	}

	// A different lane deleting an owned conversation: rejected.
	if err := o.CheckDelete("conv_a", "lane2"); err == nil {
		t.Fatal("cross-lane delete of an owned conversation must be rejected")
	}

	// An untagged delete (no lane) of an owned conversation: rejected — every
	// pool lane's apiService is patched to tag deletes, so an untagged delete
	// of someone's live conversation is exactly the bug class being fenced.
	if err := o.CheckDelete("conv_a", ""); err == nil {
		t.Fatal("untagged delete of an owned conversation must be rejected")
	}

	// Unowned conversations (bootstrap convs, worker-side duplicates) are
	// deletable by anyone — the guard only protects recorded owners.
	if err := o.CheckDelete("conv_unknown", "lane1"); err != nil {
		t.Fatalf("delete of an unowned conversation should be allowed, got %v", err)
	}
	if err := o.CheckDelete("conv_unknown", ""); err != nil {
		t.Fatalf("untagged delete of an unowned conversation should be allowed, got %v", err)
	}

	// Release on successful delete: the conversation becomes unowned, and the
	// suite-end leak dump no longer reports it.
	o.Release("conv_a")
	if err := o.CheckDelete("conv_a", "lane2"); err != nil {
		t.Fatalf("released conversation should be deletable by anyone, got %v", err)
	}

	owners := o.Dump()
	if len(owners) != 1 || owners["conv_b"].Lane != "lane2" {
		t.Fatalf("dump should report exactly the still-owned conversations, got %v", owners)
	}
	// The create reason rides along so the leak dump can name the culprit test.
	if owners["conv_b"].Reason != "integration:test-b" {
		t.Fatalf("dump should carry the create reason for attribution, got %q", owners["conv_b"].Reason)
	}

	// Recording with an empty lane is a no-op (production-path creates carry
	// no lane and must not poison the ledger).
	o.Record("conv_c", "", "integration:test-c")
	if err := o.CheckDelete("conv_c", "laneX"); err != nil {
		t.Fatalf("empty-lane record must not create ownership, got %v", err)
	}
}
