//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"
)

// threadItems returns a thread's transcript, or nil.
func threadItems(w *ConversationWorker, threadItemID string) []ConversationItem {
	arr := w.doc.GetThreadItemsArray(threadItemID)
	if arr == nil {
		return nil
	}
	return w.doc.GetItemsFromArray(arr)
}

// onlyThread returns the doc's single root-level thread CONTAINER, failing when
// there is not exactly one — which is itself the assertion for "resuming does
// not spawn a sibling". Alias items are skipped: a resume adds one per call, and
// an alias is the parent's view of a call into that same thread, not a thread of
// its own.
func onlyThread(t *testing.T, w *ConversationWorker) ConversationItem {
	t.Helper()
	var found []ConversationItem
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeThread && item.AliasOf == "" {
			found = append(found, item)
		}
	}
	if len(found) != 1 {
		t.Fatalf("expected exactly 1 thread (a resumed session must not spawn a sibling), got %d", len(found))
	}
	return found[0]
}

// indexOfItem returns the position of the first item whose content contains
// needle, or -1.
func indexOfItem(items []ConversationItem, itemType, needle string) int {
	for i, it := range items {
		if it.Type == itemType && strings.Contains(it.Content, needle) {
			return i
		}
	}
	return -1
}

// toolResultContents maps toolUseId → tool_result content for one message list.
func toolResultContents(messages []map[string]any) map[string]string {
	out := map[string]string{}
	for _, m := range messages {
		if m["type"] != "tool-result" {
			continue
		}
		id, _ := m["toolUseId"].(string)
		content, _ := m["content"].(string)
		out[id] = content
	}
	return out
}

// TestSessionNaming pins the shape of a handle. It has to be something the
// model can retype from memory, and both ends of a match pass through the same
// normaliser so a half-remembered spelling still lands.
func TestSessionNaming(t *testing.T) {
	if got := sessionBaseForTool("WebFetch"); got != "webfetch" {
		t.Errorf("sessionBaseForTool(WebFetch) = %q, want webfetch", got)
	}
	// "create_thread" names the act; the session is the thread.
	if got := sessionBaseForTool("create_thread"); got != "thread" {
		t.Errorf("sessionBaseForTool(create_thread) = %q, want thread", got)
	}
	if got := sessionSlug("Auth Hunt"); got != "auth-hunt" {
		t.Errorf("sessionSlug(Auth Hunt) = %q, want auth-hunt", got)
	}
	if got := sessionSlug("   "); got != "" {
		t.Errorf("sessionSlug of nothing = %q, want empty", got)
	}

	taken := map[string]bool{"explore-1": true, "auth-hunt": true}
	if got := allocateSessionName(taken, "explore", ""); got != "explore-2" {
		t.Errorf("auto name = %q, want explore-2", got)
	}
	if got := allocateSessionName(taken, "explore", "auth-hunt"); got != "auth-hunt-1" {
		t.Errorf("a name another tool holds must be suffixed, not swapped; got %q", got)
	}
	if got := allocateSessionName(taken, "explore", "fresh"); got != "fresh" {
		t.Errorf("a free requested name must be honoured as given; got %q", got)
	}
}

// TestSessionPreamble pins the line every session-backed result opens with. It
// is read on every delegated call, so it is information, not voice: the handle,
// whether this call started the session or continued one, and the status
// whenever the run ended as anything other than rest.
func TestSessionPreamble(t *testing.T) {
	cases := []struct {
		name   string
		call   int
		status string
		want   string
	}{
		{"explore-2", 1, runStatusRest, "explore-2 · new"},
		{"explore-2", 3, runStatusRest, "explore-2 · resumed, call 3"},
		{"explore-2", 3, runStatusError, "explore-2 · resumed, call 3 · error"},
		{"auth-hunt", 1, runStatusCancelled, "auth-hunt · new · cancelled"},
	}
	for _, c := range cases {
		if got := sessionPreamble(c.name, c.call, c.status); got != c.want {
			t.Errorf("sessionPreamble(%q, %d, %q) = %q, want %q", c.name, c.call, c.status, got, c.want)
		}
	}
}

// TestSessionBusyIsRefused pins the one-run-at-a-time rule: invoking a session
// whose run is still in flight is answered with an error, not queued behind it
// and not quietly redirected into a second thread.
func TestSessionBusyIsRefused(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.ensureItems()

	if err := w.currentRun().executeCreateThread("tu-1", "create_thread",
		json.RawMessage(`{"goal":"Dig","prompt":"Start digging","session":"hunt"}`)); err != nil {
		t.Fatalf("first create_thread: %v", err)
	}
	// The child has not run, so its session is busy.
	if err := w.currentRun().executeCreateThread("tu-2", "create_thread",
		json.RawMessage(`{"goal":"Dig","prompt":"Anything yet?","session":"hunt"}`)); err != nil {
		t.Fatalf("second create_thread: %v", err)
	}

	thread := onlyThread(t, w)
	if n := len(threadItems(w, thread.ItemID)); n != 1 {
		t.Errorf("a refused call must not append an invocation message; child has %d items", n)
	}

	var refusal ConversationItem
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeMetaToolResult && item.ToolUseID == "tu-2" {
			refusal = item
		}
	}
	if refusal.ItemID == "" {
		t.Fatalf("a busy session must answer the call; items=%+v", w.doc.GetItems())
	}
	if !refusal.IsError || !strings.Contains(string(refusal.Result), "still running") {
		t.Errorf("refusal = %+v, want an error naming the collision", refusal)
	}
}

// TestSessionIsNotHijackedByAnotherTool pins the second half of the match: a
// name alone does not identify a session, the tool that owns it does. Explore
// can never take over a Research session whatever the model types — it gets a
// new session of its own instead.
func TestSessionIsNotHijackedByAnotherTool(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.ensureItems()

	if err := w.currentRun().executeCreateThread("tu-1", "create_thread",
		json.RawMessage(`{"goal":"Dig","prompt":"Start digging","session":"hunt"}`)); err != nil {
		t.Fatalf("create_thread: %v", err)
	}

	got := w.currentRun().resolveSession("WebFetch", "hunt")
	if got.resumeThreadID != "" {
		t.Errorf("another tool's session must not resolve as resumable; got %+v", got)
	}
	if got.busy {
		t.Errorf("another tool's session must not report busy; got %+v", got)
	}
	if got.name != "hunt-1" {
		t.Errorf("colliding name = %q, want hunt-1 (the caller's word, kept and suffixed)", got.name)
	}

	// The owning tool, on the other hand, finds it — and reports it busy,
	// because that first run has not been driven.
	if own := w.currentRun().resolveSession("create_thread", "hunt"); !own.busy {
		t.Errorf("the owning tool must resolve its own session; got %+v", own)
	}
}
