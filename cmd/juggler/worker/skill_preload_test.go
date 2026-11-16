//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// newSkillWorker builds an idle worker with a resolvable default model, so
// handleSendMessage proceeds past the model-selection guard.
func newSkillWorker(t *testing.T, id string) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker(id, "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "prov-A", "model": "model-A"})
	return w
}

func skillActions(items []ConversationItem) []ConversationItem {
	var out []ConversationItem
	for _, it := range items {
		if it.Type == ItemTypeToolAction && it.ToolName == "skill" {
			out = append(out, it)
		}
	}
	return out
}

// TestSkillPreload_ProseInjectsAfterUserMessage: a normal message that carries a
// user-chosen skill injects a `skill` tool-action AFTER the user message (so the
// transcript reads user → skill → reply) and still requests an LLM turn, so the
// skill loads before the assistant responds.
func TestSkillPreload_ProseInjectsAfterUserMessage(t *testing.T) {
	w := newSkillWorker(t, "conv-skill-prose")

	sendMsg(t, w, SendMessageMessage{Text: "do it", Skills: []string{"tdd"}})

	items := w.doc.GetItems()
	skills := skillActions(items)
	if len(skills) != 1 {
		t.Fatalf("expected exactly 1 skill tool-action, got %d (items=%d)", len(skills), len(items))
	}

	userIdx, skillIdx := -1, -1
	for i, it := range items {
		switch {
		case it.Type == ItemTypeUser:
			userIdx = i
		case it.Type == ItemTypeToolAction && it.ToolName == "skill":
			skillIdx = i
		}
	}
	if userIdx < 0 {
		t.Fatal("no user message was added")
	}
	if skillIdx <= userIdx {
		t.Fatalf("skill must be injected AFTER the user message: userIdx=%d skillIdx=%d", userIdx, skillIdx)
	}

	var in map[string]string
	if err := json.Unmarshal(skills[0].ToolInput, &in); err != nil {
		t.Fatalf("toolInput unmarshal: %v", err)
	}
	if in["name"] != "tdd" {
		t.Fatalf("skill toolInput name = %q, want %q", in["name"], "tdd")
	}
	// The user asked for it: the mark is what lets the `skill` tool load a
	// skill the model may not start itself (disable-model-invocation).
	if !skills[0].UserInvoked {
		t.Fatal("injected skill action must carry userInvoked")
	}
	// The injected action is left unevaluated so the engine auto-approves it.
	if skills[0].State != "" {
		t.Fatalf("injected skill state = %q, want unset (needs evaluation)", skills[0].State)
	}
	// A turn was requested: the skill loads, then the LLM runs with it in context.
	if w.getActivity() != ActivityAwaitingLLM {
		t.Fatalf("activity = %q, want %q (a turn should follow the preload)", w.getActivity(), ActivityAwaitingLLM)
	}
}

// TestSkillPreload_SkillOnlyStartsNoTurn: a skills-only send (no prose) injects
// the skill but starts NO LLM turn — a deterministic preload. The reducer will
// rest on the completed tool-action because activity never becomes awaiting_llm.
func TestSkillPreload_SkillOnlyStartsNoTurn(t *testing.T) {
	w := newSkillWorker(t, "conv-skill-only")

	sendMsg(t, w, SendMessageMessage{Text: "", Skills: []string{"research"}})

	items := w.doc.GetItems()
	if got := len(skillActions(items)); got != 1 {
		t.Fatalf("expected exactly 1 skill tool-action, got %d", got)
	}
	for _, it := range items {
		if it.Type == ItemTypeUser {
			t.Fatal("a skills-only send must not add a user message")
		}
	}
	if w.getActivity() == ActivityAwaitingLLM {
		t.Fatalf("a skills-only send must NOT request an LLM turn (activity=%q)", w.getActivity())
	}
}

// TestSkillPreload_Dedup: duplicate/blank names collapse to one action each.
func TestSkillPreload_Dedup(t *testing.T) {
	w := newSkillWorker(t, "conv-skill-dedup")

	sendMsg(t, w, SendMessageMessage{Text: "go", Skills: []string{"tdd", "tdd", "  ", "research"}})

	if got := len(skillActions(w.doc.GetItems())); got != 2 {
		t.Fatalf("expected 2 skill tool-actions after dedup, got %d", got)
	}
}
