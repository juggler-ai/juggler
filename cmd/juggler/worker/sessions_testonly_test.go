//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside sessions_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestCreateThreadSessionResumesSameThread is the whole point of the phase: a
// second call naming a session it already ran appends one message to that
// thread and runs it again, rather than starting over. The child keeps
// everything it had; the parent gets a second, separately-paired tool_result.
func TestCreateThreadSessionResumesSameThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)

	w.setMockResponses([]MockResponse{
		// Parent: starts the session.
		{
			Blocks: []LLMResponseBlock{{Type: "tool_use", ID: "tu-1", Name: "create_thread",
				Input: json.RawMessage(`{"goal":"Find the auth code","prompt":"Where is auth?","resultSpec":"a file:line list","session":"hunt"}`)}},
			StopReason: "tool_use",
		},
		// Child run 1.
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Auth lives in auth.go."}}, StopReason: "end_turn"},
		// Parent: asks a follow-up of the SAME session.
		{
			Blocks: []LLMResponseBlock{{Type: "tool_use", ID: "tu-2", Name: "create_thread",
				Input: json.RawMessage(`{"goal":"Find the auth code","prompt":"Who calls it?","session":"hunt"}`)}},
			StopReason: "tool_use",
		},
		// Child run 2.
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "The server calls it."}}, StopReason: "end_turn"},
		// Parent: done.
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Thanks."}}, StopReason: "end_turn"},
	})

	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResponse, _ := json.Marshal(ToolsResultMessage{
			Type:  "tools-result",
			Tools: []ToolDefinition{{Name: "create_thread"}},
		})
		for i := 0; i < 5; i++ {
			w.engine.contextReply.inject(w.done, ctxResponse)
			w.engine.toolsReply.inject(w.done, toolsResponse)
		}
	}()

	w.driveStrategyLoop(t, "Investigate auth", false)

	thread := onlyThread(t, w)
	if thread.SessionName != "hunt" {
		t.Errorf("session name = %q, want hunt", thread.SessionName)
	}

	// Append-only: run 1's message and its reply are still there, in order,
	// ahead of run 2's message.
	items := threadItems(w, thread.ItemID)
	first := indexOfItem(items, ItemTypeUser, "Where is auth?")
	answer := indexOfItem(items, ItemTypeAssistant, "Auth lives in auth.go.")
	second := indexOfItem(items, ItemTypeUser, "Who calls it?")
	if first < 0 || answer < 0 || second < 0 {
		t.Fatalf("resume must append to the existing transcript; items=%+v", items)
	}
	if first >= answer || answer >= second {
		t.Errorf("transcript order = first:%d answer:%d second:%d, want ascending", first, answer, second)
	}

	// A resumed call appends its message and NOTHING else: the parent's
	// standing context is not cloned in a second time, and a contract the
	// caller did not restate is not restated for it.
	if !strings.Contains(items[first].Content, "a file:line list") {
		t.Errorf("the opening call's contract must reach the child; got %q", items[first].Content)
	}
	if strings.Contains(items[second].Content, "a file:line list") {
		t.Errorf("a resumed call stating no contract must not have the old one re-appended; got %q", items[second].Content)
	}
	if tail := items[answer+1:]; len(tail) != 2 {
		t.Errorf("resume must append one message and let the run answer it, nothing more; tail=%+v", tail)
	}

	// Each invocation message carries its own run record, settled.
	for _, want := range []struct{ toolUseID, result string }{
		{"tu-1", "Auth lives in auth.go."},
		{"tu-2", "The server calls it."},
	} {
		var found bool
		for _, it := range items {
			if it.RunToolUseID != want.toolUseID {
				continue
			}
			found = true
			if it.RunGoal != "Find the auth code" {
				t.Errorf("run %s goal = %q, want the resolved short label", want.toolUseID, it.RunGoal)
			}
			if it.RunStatus != runStatusRest {
				t.Errorf("run %s status = %q, want rest", want.toolUseID, it.RunStatus)
			}
			if !strings.Contains(it.RunResult, want.result) {
				t.Errorf("run %s result = %q, want it to carry %q", want.toolUseID, it.RunResult, want.result)
			}
		}
		if !found {
			t.Errorf("no invocation message stamped with %s", want.toolUseID)
		}
	}

	// The parent carries one item per call: the thread it created, then an alias
	// standing where the second call was made. That is what keeps the wire in
	// call order — see TestResumedCallAppendsToParentWire.
	var aliases []ConversationItem
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeThread && item.AliasOf != "" {
			aliases = append(aliases, item)
		}
	}
	if len(aliases) != 1 {
		t.Fatalf("a resumed call must add exactly one alias item to the parent, got %d", len(aliases))
	}
	if aliases[0].AliasOf != thread.ItemID {
		t.Errorf("alias points at %q, want the canonical thread %q", aliases[0].AliasOf, thread.ItemID)
	}
	if aliases[0].RunToolUseID != "tu-2" {
		t.Errorf("alias run selector = %q, want tu-2 (the call it stands for)", aliases[0].RunToolUseID)
	}
	if len(aliases[0].Items) != 0 {
		t.Errorf("an alias owns no transcript; got %s", aliases[0].Items)
	}
	if thread.RunToolUseID != "tu-1" {
		t.Errorf("canonical run selector = %q, want tu-1 (the call that created it)", thread.RunToolUseID)
	}

	// The parent sees two separately-paired calls, each answered by its own run
	// and headed by the handle it can call again.
	results := toolResultContents(w.currentRun().buildMessages(nil))
	if got := results["tu-1"]; !strings.HasPrefix(got, "hunt · new") || !strings.Contains(got, "Auth lives in auth.go.") {
		t.Errorf("first tool_result = %q, want the new-session preamble and run 1's reply", got)
	}
	if got := results["tu-2"]; !strings.HasPrefix(got, "hunt · resumed, call 2") || !strings.Contains(got, "The server calls it.") {
		t.Errorf("second tool_result = %q, want the resumed preamble and run 2's reply", got)
	}

	// And the resumed run really did see the first run's work: the child's own
	// wire history carries both, which is the warm cache the whole phase buys.
	childWire := w.buildMessagesFromItems(items, false)
	var sawFirstQuestion, sawFirstAnswer bool
	for _, m := range childWire {
		content, _ := m["content"].(string)
		if strings.Contains(content, "Where is auth?") {
			sawFirstQuestion = true
		}
		if strings.Contains(content, "Auth lives in auth.go.") {
			sawFirstAnswer = true
		}
	}
	if !sawFirstQuestion || !sawFirstAnswer {
		t.Errorf("the resumed run must be sent the first run's messages; child wire=%+v", childWire)
	}
}
