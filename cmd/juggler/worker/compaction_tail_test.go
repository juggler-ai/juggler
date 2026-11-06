//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// tailTestWorker builds an idle root of [rule, u1, a1, … uN, aN] where every
// user turn is short and every reply is replyChars long, so the tail the rule
// keeps is predictable in whole turns.
func tailTestWorker(t *testing.T, turns, replyChars, keepPercent int) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker("test-conv", "user:test")
	t.Cleanup(w.doc.Destroy)
	w.currentRun().storeState(StateIdle)
	w.SetKeepRecent(func() int { return keepPercent })
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: "rule", ItemID: "rule", Content: "a standing rule"})})
		for i := 1; i <= turns; i++ {
			arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: fmt.Sprintf("u%d", i), Content: fmt.Sprintf("do step %d", i)})})
			arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: fmt.Sprintf("a%d", i), Content: strings.Repeat("y", replyChars)})})
		}
	}, w.doc.authorID)
	return w
}

// rootIDs lists the root item ids, the fold thread shown as "fold".
func rootIDs(w *ConversationWorker) []string {
	var ids []string
	for _, it := range w.doc.GetItems() {
		if it.Type == ItemTypeThread && it.BoundedCompaction {
			ids = append(ids, "fold")
			continue
		}
		ids = append(ids, it.ItemID)
	}
	return ids
}

// TestCompactKeepsRecentShareOfConversation pins the /compact half of the tail
// rule: with keepRecent the fold stops where the newest p% of the conversation
// begins, at a whole unit, and the tail stays verbatim after the summary.
// Ten equal turns at 30% keep exactly the last three turns.
func TestCompactKeepsRecentShareOfConversation(t *testing.T) {
	w := tailTestWorker(t, 10, 3000, 30)

	_, folded, err := w.currentRun().foldConversationForCompaction(w.turn.thread, compactFoldOptions{keepRecent: true})
	if err != nil || !folded {
		t.Fatalf("fold = (%v, %v), want a fold", folded, err)
	}
	got := strings.Join(rootIDs(w), ",")
	if want := "rule,fold,u8,a8,u9,a9,u10,a10"; got != want {
		t.Fatalf("root = %s, want %s", got, want)
	}
}

// TestCompactWithoutKeepRecentFoldsEverything pins /compact all and /handoff:
// the whole history after the leading standing context folds.
func TestCompactWithoutKeepRecentFoldsEverything(t *testing.T) {
	w := tailTestWorker(t, 10, 3000, 30)

	_, folded, err := w.currentRun().foldConversationForCompaction(w.turn.thread, compactFoldOptions{})
	if err != nil || !folded {
		t.Fatalf("fold = (%v, %v), want a fold", folded, err)
	}
	if got := strings.Join(rootIDs(w), ","); got != "rule,fold" {
		t.Fatalf("root = %s, want rule,fold", got)
	}
}

// TestCompactKeepsLatestUserTurnAtZero pins the floor and the snap: at 0% the
// walk keeps only the newest unit (the last reply), and the cut then moves back
// to the user message that reply answers, so the model keeps the current
// request verbatim.
func TestCompactKeepsLatestUserTurnAtZero(t *testing.T) {
	w := tailTestWorker(t, 10, 3000, 0)

	_, folded, err := w.currentRun().foldConversationForCompaction(w.turn.thread, compactFoldOptions{keepRecent: true})
	if err != nil || !folded {
		t.Fatalf("fold = (%v, %v), want a fold", folded, err)
	}
	if got := strings.Join(rootIDs(w), ","); got != "rule,fold,u10,a10" {
		t.Fatalf("root = %s, want rule,fold,u10,a10", got)
	}
}

// TestCompactSnapsTailToUserTurn: the share alone would cut between a user
// message and its reply; the cut moves back to the user message.
func TestCompactSnapsTailToUserTurn(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	t.Cleanup(w.doc.Destroy)
	w.currentRun().storeState(StateIdle)
	w.SetKeepRecent(func() int { return 20 })
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		for i := 1; i <= 5; i++ {
			// A long request and a short reply: a share that admits the reply
			// stops before the request it answers.
			arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: fmt.Sprintf("u%d", i), Content: strings.Repeat("q", 3000)})})
			arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: fmt.Sprintf("a%d", i), Content: strings.Repeat("y", 1500)})})
		}
	}, w.doc.authorID)

	// 20% of five 4500-token turns is 4500: a5 (1500) fits, u5 (3000) would
	// reach 4500 plus framing and does not, so the walk alone keeps [a5]. The
	// snap takes u5 too — within the headroom, which is unbounded here.
	_, folded, err := w.currentRun().foldConversationForCompaction(w.turn.thread, compactFoldOptions{keepRecent: true})
	if err != nil || !folded {
		t.Fatalf("fold = (%v, %v), want a fold", folded, err)
	}
	if got := strings.Join(rootIDs(w), ","); got != "fold,u5,a5" {
		t.Fatalf("root = %s, want fold,u5,a5", got)
	}
}

// TestCompactDeclinesAFoldTooSmallToSummarize: when what would fold is smaller
// than a summary is worth, /compact folds nothing and says so (folded=false)
// rather than replacing a few lines with a summary of them.
func TestCompactDeclinesAFoldTooSmallToSummarize(t *testing.T) {
	w := tailTestWorker(t, 3, 40, 30)
	before := strings.Join(rootIDs(w), ",")

	threadID, folded, err := w.currentRun().foldConversationForCompaction(w.turn.thread, compactFoldOptions{keepRecent: true})
	if err != nil || folded || threadID != "" {
		t.Fatalf("fold = (%q, %v, %v), want no fold", threadID, folded, err)
	}
	if got := strings.Join(rootIDs(w), ","); got != before {
		t.Fatalf("root = %s, want unchanged %s", got, before)
	}

	// /compact all still folds it.
	if _, folded, err := w.currentRun().foldConversationForCompaction(w.turn.thread, compactFoldOptions{}); err != nil || !folded {
		t.Fatalf("fold all = (%v, %v), want a fold", folded, err)
	}
}

// TestContextRecoveryKeepsTheConfiguredShare pins the auto-fold half: the tail
// is the configured share of the conversation, bounded by half the usable
// budget. recoveryLimitErr leaves a usable budget of 2500 (4000 window − 200
// envelope − 300 reserve − 1000 summary floor), so the headroom bound is 1250.
func TestContextRecoveryKeepsTheConfiguredShare(t *testing.T) {
	for _, tc := range []struct {
		name    string
		percent int
		want    string
	}{
		// Each message estimates at ~326 tokens. 10% of ten is ~326: only the
		// newest message.
		{"small share", 10, "fold,m9"},
		// 60% would be ~1950, over the 1250 headroom: three messages (978) fit
		// it and a fourth (1304) does not.
		{"bounded by headroom", 60, "fold,m7,m8,m9"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()
			w.currentRun().storeState(StateProcessing)
			w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
			w.SetKeepRecent(func() int { return tc.percent })
			items := make([]ConversationItem, 0, 10)
			for i := range 10 {
				items = append(items, ConversationItem{Type: ItemTypeUser, ItemID: fmt.Sprintf("m%d", i), Content: strings.Repeat("x", 300)})
			}
			w.doc.InsertMessage(0, items...)
			pinned := &ModelConfig{Provider: "original", Model: "rejected"}
			_, stub := newRecoveryStub(t, pinned)
			w.SetLLMCaller(stub)

			if _, err := w.ownedRun(t).compactToFit(recoveryLimitErr(), pinned); err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(rootIDs(w), ","); got != tc.want {
				t.Fatalf("root = %s, want %s", got, tc.want)
			}
		})
	}
}

// TestKeepRecentFractionClamps: the setting is a whole percentage in 0..60,
// whatever the resolver says, and the default without one.
func TestKeepRecentFractionClamps(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	if got := w.keepRecentFraction(); got != 0.3 {
		t.Fatalf("default = %v, want 0.3", got)
	}
	for in, want := range map[int]float64{-5: 0, 0: 0, 45: 0.45, 60: 0.6, 95: 0.6} {
		w.SetKeepRecent(func() int { return in })
		if got := w.keepRecentFraction(); got != want {
			t.Fatalf("keepRecentFraction(%d) = %v, want %v", in, got, want)
		}
	}
}
