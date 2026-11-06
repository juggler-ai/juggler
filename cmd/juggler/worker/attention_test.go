//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"juggler/internal/attention"
)

// A conversation's attention is its tab's status circle, worked out on the
// server: waiting on the user outranks working, which outranks a failed last
// turn.

var attentionT0 = time.Date(2026, 11, 6, 9, 30, 0, 0, time.UTC)

func pendingBash(t *testing.T, command string) ConversationItem {
	t.Helper()
	return ConversationItem{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-bash",
		ToolUseID: "tu-bash",
		ToolName:  "bash",
		ToolInput: json.RawMessage(`{"command":` + mustJSON(t, command) + `}`),
		State:     StatePending,
		Timestamp: attentionT0.Format(time.RFC3339),
	}
}

func TestAttentionWaitingOnApproval(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	w := m.GetOrCreate("conv-approval", "user:test")
	w.doc.InsertMessage(0, pendingBash(t, "rm -rf build"))
	if !w.requestLLM("") {
		t.Fatal("precondition: requestLLM should succeed on an idle worker")
	}
	defer w.releaseLLM("")

	got := w.attentionNow(attention.Entry{}, attentionT0.Add(time.Hour))
	want := attention.Entry{State: attention.Waiting, Wait: attention.Approval, Since: attentionT0, Excerpt: "bash: rm -rf build"}
	if got != want {
		t.Fatalf("attention = %+v, want %+v", got, want)
	}
}

func TestAttentionWaitingOnQuestionInASubThread(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	w := m.GetOrCreate("conv-question", "user:test")
	nested, err := json.Marshal([]ConversationItem{{
		Type:      ItemTypeToolAction,
		ItemID:    "ta-ask",
		ToolUseID: "tu-ask",
		ToolName:  "AskUserQuestion",
		ToolInput: json.RawMessage(`{"questions":[{"question":"Which database should I use?\n   Postgres or SQLite?","header":"DB","options":[],"multiSelect":false}]}`),
		State:     StatePending,
		Timestamp: attentionT0.Format(time.RFC3339),
	}})
	if err != nil {
		t.Fatal(err)
	}
	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeThread, ItemID: "t-sub", Items: nested})

	got := w.attentionNow(attention.Entry{}, attentionT0.Add(time.Hour))
	want := attention.Entry{State: attention.Waiting, Wait: attention.Question, Since: attentionT0, Excerpt: "Which database should I use? Postgres or SQLite?"}
	if got != want {
		t.Fatalf("attention = %+v, want %+v", got, want)
	}
}

// Waiting outranks working: a pending approval beside a tool that is running
// still shows as waiting, as the tab does.
func TestAttentionWaitingOutranksWorking(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	w := m.GetOrCreate("conv-both", "user:test")
	w.doc.InsertMessage(0, pendingBash(t, "make"))
	w.doc.InsertMessage(1, ConversationItem{Type: ItemTypeToolAction, ItemID: "ta-run", ToolUseID: "tu-run", ToolName: "bash", State: StateRunning})
	if !w.claimLLM("") {
		t.Fatal("precondition: claimLLM should succeed")
	}
	defer w.releaseLLM("")

	if got := w.attentionNow(attention.Entry{}, attentionT0); got.State != attention.Waiting {
		t.Fatalf("state = %q, want waiting", got.State)
	}
}

// Working keeps the time it was first seen working across recomputations.
func TestAttentionWorking(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	w := m.GetOrCreate("conv-working", "user:test")
	if got := w.attentionNow(attention.Entry{}, attentionT0); got != (attention.Entry{State: attention.Idle}) {
		t.Fatalf("an idle conversation: attention = %+v, want idle", got)
	}
	if !w.claimLLM("") {
		t.Fatal("precondition: claimLLM should succeed")
	}
	first := w.attentionNow(attention.Entry{State: attention.Idle}, attentionT0)
	if first != (attention.Entry{State: attention.Working, Since: attentionT0}) {
		t.Fatalf("a claimed turn: attention = %+v, want working since %v", first, attentionT0)
	}
	if again := w.attentionNow(first, attentionT0.Add(time.Minute)); again != first {
		t.Fatalf("still working a minute on: attention = %+v, want %+v", again, first)
	}
	w.releaseLLM("")
	if got := w.attentionNow(first, attentionT0.Add(2*time.Minute)); got.State != attention.Idle {
		t.Fatalf("after the turn: state = %q, want idle", got.State)
	}
}

// A root thread ending in an error is failed; an error in a sub-thread is not,
// as the tab judges only the root.
func TestAttentionFailed(t *testing.T) {
	m := NewManager()
	defer m.Shutdown()
	w := m.GetOrCreate("conv-failed", "user:test")
	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u1", Content: "hello"})
	w.doc.InsertMessage(1, ConversationItem{Type: ItemTypeError, ItemID: "e1", Summary: "The provider rejected the API key.", Content: "401 Unauthorized", Timestamp: attentionT0.Format(time.RFC3339)})

	got := w.attentionNow(attention.Entry{}, attentionT0.Add(time.Hour))
	want := attention.Entry{State: attention.Failed, Since: attentionT0, Excerpt: "The provider rejected the API key."}
	if got != want {
		t.Fatalf("attention = %+v, want %+v", got, want)
	}

	w.doc.InsertMessage(2, ConversationItem{Type: ItemTypeUser, ItemID: "u2", Content: "try again"})
	if got := w.attentionNow(got, attentionT0.Add(time.Hour)); got.State != attention.Idle {
		t.Fatalf("after a later message: state = %q, want idle", got.State)
	}
}

// The index keeps what outlives the process — waiting and failed — in the
// project's attention.json, and a new index (a restarted session) knows it
// without loading the conversation.
func TestAttentionIndexSurvivesARestart(t *testing.T) {
	project := t.TempDir()
	waiting := attention.Entry{State: attention.Waiting, Wait: attention.Approval, Since: attentionT0, Excerpt: "bash: make"}
	x := newAttentionIndex()
	x.publish(project, "c-wait", waiting, attentionT0)
	x.publish(project, "c-work", attention.Entry{State: attention.Working, Since: attentionT0}, attentionT0)
	x.publish(project, "c-idle", attention.Entry{State: attention.Idle}, attentionT0)

	s := x.summary(project)
	if s.Rev == 0 || len(s.Conversations) != 2 || s.Conversations["c-wait"] != waiting || s.Conversations["c-work"].State != attention.Working {
		t.Fatalf("summary = %+v; want c-wait waiting and c-work working, at a revision past 0", s)
	}
	if !s.LastActive.Equal(attentionT0) {
		t.Fatalf("lastActive = %v, want %v", s.LastActive, attentionT0)
	}

	saved, err := attention.Read(project)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved) != 1 || saved["c-wait"] != waiting {
		t.Fatalf("saved = %+v; want only c-wait, waiting (working does not outlive the process)", saved)
	}

	restarted := newAttentionIndex()
	if got := restarted.summary(project).Conversations; len(got) != 1 || got["c-wait"] != waiting {
		t.Fatalf("after a restart: conversations = %+v, want c-wait waiting", got)
	}

	x.publish(project, "c-wait", attention.Entry{State: attention.Idle}, attentionT0.Add(time.Minute))
	if _, err := os.Stat(attention.Path(project)); !os.IsNotExist(err) {
		t.Fatalf("with nothing waiting the summary file should be gone; stat err = %v", err)
	}
}

// An unchanged publish moves nothing; a removed conversation leaves the
// summary and is refused until restored.
func TestAttentionIndexRevisionAndRemoval(t *testing.T) {
	project := t.TempDir()
	waiting := attention.Entry{State: attention.Waiting, Wait: attention.Question, Since: attentionT0, Excerpt: "Which one?"}
	x := newAttentionIndex()
	x.publish(project, "c1", waiting, attentionT0)
	rev := x.summary(project).Rev
	x.publish(project, "c1", waiting, attentionT0.Add(time.Minute))
	if s := x.summary(project); s.Rev != rev || !s.LastActive.Equal(attentionT0) {
		t.Fatalf("an unchanged publish moved the summary: rev %d→%d, lastActive %v", rev, s.Rev, s.LastActive)
	}

	x.drop("c1")
	if s := x.summary(project); len(s.Conversations) != 0 || s.Rev == rev {
		t.Fatalf("after drop: %+v; want no conversations at a new revision", s)
	}
	if saved, _ := attention.Read(project); len(saved) != 0 {
		t.Fatalf("after drop the file still holds %+v", saved)
	}
	x.publish(project, "c1", waiting, attentionT0)
	if s := x.summary(project); len(s.Conversations) != 0 {
		t.Fatalf("a removed conversation published again: %+v", s)
	}
	x.restore("c1")
	x.publish(project, "c1", waiting, attentionT0)
	if s := x.summary(project); s.Conversations["c1"] != waiting {
		t.Fatalf("a restored conversation did not publish: %+v", s)
	}
}

// End to end through a Manager: a conversation loaded from disk parked on an
// approval publishes itself as waiting, and a new Manager — the session after
// a restart — reports it without loading it.
func TestAttentionPublishedByALoadedConversation(t *testing.T) {
	const id = "conv-loaded-wait"
	store := newHeldStore(t, id)
	doc := NewConversationDocument(id, "user:test")
	t.Cleanup(doc.Destroy)
	doc.SetMetadata(keyDefaultModelConfig, map[string]any{"provider": "test", "model": "test"})
	doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u1", Content: "clean up"})
	doc.InsertMessage(1, pendingBash(t, "rm -rf build"))
	store.writeDoc(t, id, doc)

	m := NewManager()
	store.wire(m)
	init := &InitMessage{
		Type:         msgInit,
		Conversation: SerializedConversation{ID: id, LoadFromDisk: true},
		Config:       WorkerConfig{ProjectPath: store.project},
	}
	if w, err := m.initHeadless(id, "user:test", init); err != nil || w == nil {
		t.Fatalf("loading %s: worker %v, err %v", id, w, err)
	}
	deadline := time.Now().Add(quiesceTimeout)
	for m.Attention(store.project).Conversations[id].State != attention.Waiting {
		if time.Now().After(deadline) {
			t.Fatalf("the loaded conversation never published itself waiting: %+v", m.Attention(store.project))
		}
		time.Sleep(5 * time.Millisecond)
	}
	m.Shutdown()

	next := NewManager()
	defer next.Shutdown()
	got := next.Attention(store.project).Conversations[id]
	if got.State != attention.Waiting || got.Wait != attention.Approval || !strings.Contains(got.Excerpt, "rm -rf build") {
		t.Fatalf("after a restart: %s = %+v, want waiting on approval of rm -rf build", id, got)
	}
	if next.Get(id) != nil {
		t.Fatalf("reporting %s loaded it", id)
	}
}
