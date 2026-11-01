//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

func bashActions(items []ConversationItem) []ConversationItem {
	var out []ConversationItem
	for _, it := range items {
		if it.Type == ItemTypeToolAction && it.ToolName == "bash" {
			out = append(out, it)
		}
	}
	return out
}

// TestShellCommand_IdleInjectsApprovedBashAndStartsNoTurn: `! cmd` on an idle
// thread becomes an ordinary bash tool-action — already approved, since the
// user typed it — and asks for no model turn.
func TestShellCommand_IdleInjectsApprovedBashAndStartsNoTurn(t *testing.T) {
	w := newSkillWorker(t, "conv-shell-idle")

	sendMsg(t, w, SendMessageMessage{ShellCommand: "echo hi"})

	items := w.doc.GetItems()
	bash := bashActions(items)
	if len(bash) != 1 {
		t.Fatalf("expected exactly 1 bash tool-action, got %d (items=%+v)", len(bash), items)
	}
	var in map[string]any
	if err := json.Unmarshal(bash[0].ToolInput, &in); err != nil {
		t.Fatalf("toolInput unmarshal: %v", err)
	}
	if in["command"] != "echo hi" {
		t.Fatalf("command = %v, want %q", in["command"], "echo hi")
	}
	if d, _ := in["description"].(string); d == "" {
		t.Fatal("the call must say the user ran it, so the model does not take it for its own")
	}
	if ms, _ := in["timeout"].(float64); int(ms) != userShellTimeoutMs {
		t.Fatalf("timeout = %v, want the full cap %d", in["timeout"], userShellTimeoutMs)
	}
	if bash[0].State != StateApproved {
		t.Fatalf("state = %q, want %q (the user typed it; nothing to approve)", bash[0].State, StateApproved)
	}
	for _, it := range items {
		if it.Type == ItemTypeUser {
			t.Fatal("a shell command must not add a user message")
		}
	}
	if w.getActivity() == ActivityAwaitingLLM {
		t.Fatalf("a shell command must NOT request an LLM turn (activity=%q)", w.getActivity())
	}
}

// TestShellCommand_FinishedBatchIsNews: a finished batch of nothing but the
// user's shell commands asks for no model call, even under awaiting_llm; mixed
// with the model's own work it is answered as ever.
func TestShellCommand_FinishedBatchIsNews(t *testing.T) {
	user := ConversationItem{Type: ItemTypeUser, ItemID: "u", Content: "hi"}
	reply := ConversationItem{Type: ItemTypeAssistant, ItemID: "a", Content: "hello"}
	shell := newShellToolAction("ls")
	shell.State, shell.Result = StateCompleted, resultJSON("x")
	model := ConversationItem{Type: ItemTypeToolAction, ItemID: "m", ToolUseID: "tu-model", ToolName: "bash",
		State: StateCompleted, Result: resultJSON("y")}

	if got := decideNextAction([]ConversationItem{user, reply, shell}, ActivityAwaitingLLM, true, false); got != ActionGoIdle {
		t.Fatalf("the user's own finished command asked for %v, want ActionGoIdle", got)
	}
	if got := decideNextAction([]ConversationItem{user, reply, shell}, ActivityAwaitingLLM, true, true); got != ActionCallLLM {
		t.Fatalf("an explicit Continue after the user's command gave %v, want ActionCallLLM", got)
	}
	if got := decideNextAction([]ConversationItem{user, model, shell}, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Fatalf("the model's finished tool beside the user's command gave %v, want ActionCallLLM", got)
	}
}

// TestShellCommand_BlankIsNothing: a send whose shell command is only
// whitespace carries nothing and writes nothing.
func TestShellCommand_BlankIsNothing(t *testing.T) {
	w := newSkillWorker(t, "conv-shell-blank")

	sendMsg(t, w, SendMessageMessage{ShellCommand: "   "})

	if got := len(bashActions(w.doc.GetItems())); got != 0 {
		t.Fatalf("a blank shell command wrote %d bash tool-action(s)", got)
	}
}
