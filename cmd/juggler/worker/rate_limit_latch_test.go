//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"regexp"
	"strings"
	"testing"
	"time"
)

// TestRateLimitLatch_HoldsEverySiblingThread is the incident, in miniature.
//
// A root turn and its delegated children are all parked on completed tool
// batches, so one reconcile pass holds an ActionCallLLM target for each of them.
// The account's usage cap has already been discovered by one of them and does
// not lift for four hours. Every request issued from here is spent being told
// that again, and is charged to the window the user is waiting on.
func TestRateLimitLatch_HoldsEverySiblingThread(t *testing.T) {
	w := NewConversationWorker("test-rate-limit-siblings", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "look at a and b",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll send two agents.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})

	children := []string{
		insertThreadWithOpts(w, threadOpts{goal: "read a", userMessage: "look at a", llmCreated: true, delegated: true}),
		insertThreadWithOpts(w, threadOpts{goal: "read b", userMessage: "look at b", llmCreated: true, delegated: true}),
	}
	for i, id := range children {
		appendToThread(w, id,
			ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "I'll grep for it."},
			ConversationItem{
				Type: ItemTypeToolAction, ItemID: generateItemID(),
				ToolUseID: "tu-" + string(rune('a'+i)), ToolName: "grep",
				State: StateCompleted, Result: resultJSON("ok"),
			},
		)
	}

	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})

	// One thread has already met the 429 and read its stated reset.
	if !w.latchRateLimit("test", time.Now().Add(4*time.Hour)) {
		t.Fatal("the first thread to meet a cap must be its discoverer")
	}

	// One scripted turn per child. Every one consumed is a request sent into a
	// refusal the conversation already knows about.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN (a)"}}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN (b)"}}, StopReason: "end_turn"},
	})
	feedContextAndTools(t, w)

	w.sched.markReconcile()
	w.quiesce(t)

	if left := w.mock.remaining(); left != 2 {
		t.Fatalf("a standing usage cap let %d of 2 sub-threads call the provider anyway (%d scripted turns left, want 2): "+
			"what one thread learns about the account's cap has to hold for every thread on that provider, "+
			"or each one spends its own retries discovering the same four-hour wall", 2-left, left)
	}
}

// TestRateLimitLatch_UserSendLiftsItForAParkedParent is the other half of the
// incident: not the requests the latch saved, but the way out of it.
//
// A delegated child met the cap and rested without settling, so its parent is
// parked on an open run and nothing in the conversation is running. The user
// does the one thing the report tells them to do — send again — and the send
// lands on the parent, whose activity is still awaiting_llm. That is the busy
// gate: the message queues and the handler returns. A lift that sits below the
// gate is never reached, the reducer refuses the child on every pass, and the
// conversation the report promised would start again never does.
func TestRateLimitLatch_UserSendLiftsItForAParkedParent(t *testing.T) {
	w := NewConversationWorker("test-rate-limit-parked-parent", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "look at a",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll send an agent.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})

	child := insertThreadWithOpts(w, threadOpts{goal: "read a", userMessage: "look at a", llmCreated: true, delegated: true})
	appendToThread(w, child,
		ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "I'll grep for it."},
		ConversationItem{
			Type: ItemTypeToolAction, ItemID: generateItemID(),
			ToolUseID: "tu-a", ToolName: "grep",
			State: StateCompleted, Result: resultJSON("ok"),
		},
	)

	// The child rested on the cap: its run record is open, so the parent is
	// parked on it, and the cap stands for another four hours.
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})
	w.latchRateLimit("test", time.Now().Add(4*time.Hour))

	// One turn for the child the reducer may now dispatch, and one for the parent
	// the child's settlement wakes.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "a is fine"}}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "so it is"}}, StopReason: "end_turn"},
	})
	feedContextAndTools(t, w)

	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "try again"})
	w.quiesce(t)

	if until := w.rateLimitedUntil("test"); !until.IsZero() {
		t.Fatalf("the cap still stands until %v after the user sent into the parked parent: the send is an explicit "+
			"\"try anyway\", and it is the only send this conversation has left to make", until)
	}
	if left := w.mock.remaining(); left != 0 {
		t.Fatalf("%d of 2 scripted turns went unused: lifting the cap is not enough on its own — nothing else asks "+
			"for a reducer pass, so the child is never re-offered and the queued message is never drained", left)
	}
}

// TestRateLimitLatch_LiftsItselfWhenTheResetPasses: nothing re-tickles the
// reducer when a cap expires, so the latch may only ever be a refusal that is
// still true. A hold read after its reset is not a hold.
func TestRateLimitLatch_LiftsItselfWhenTheResetPasses(t *testing.T) {
	w := NewConversationWorker("test-rate-limit-expiry", "user:test")
	defer w.doc.Destroy()

	w.latchRateLimit("test", time.Now().Add(-time.Second))
	if until := w.rateLimitedUntil("test"); !until.IsZero() {
		t.Fatalf("rateLimitedUntil = %v, want zero — a reset already in the past holds nothing", until)
	}

	w.latchRateLimit("test", time.Now().Add(time.Hour))
	if w.rateLimitedUntil("test").IsZero() {
		t.Fatal("a cap an hour out must stand")
	}
	if w.latchRateLimit("test", time.Now().Add(time.Hour)) {
		t.Fatal("a second thread meeting a cap already standing is not its discoverer — only one report reaches the user")
	}

	// The user asked us to try anyway.
	w.clearRateLimit("test")
	if until := w.rateLimitedUntil("test"); !until.IsZero() {
		t.Fatalf("rateLimitedUntil = %v, want zero after the user sent into the conversation", until)
	}
}

// errorItems returns every error item in the conversation's top-level flow.
func errorItems(w *ConversationWorker) []ConversationItem {
	var found []ConversationItem
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeError {
			found = append(found, item)
		}
	}
	return found
}

// rateLimitedWorker is a one-thread conversation whose next turn meets a
// ChatGPT-subscription usage cap: a 429 whose body dates its own reset four
// hours out.
func rateLimitedWorker(t *testing.T, name string) (*ConversationWorker, string) {
	t.Helper()
	w := NewConversationWorker(name, "user:test")
	t.Cleanup(w.doc.Destroy)
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "openaicodex", "model": "gpt-5-codex"})
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "go",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})

	providerText := `POST "https://chatgpt.com/backend-api/codex/responses": 429 Too Many Requests ` + codexUsageLimitBody
	w.setMockResponses([]MockResponse{{Error: providerText}})
	feedContextAndTools(t, w)
	return w, providerText
}

// TestRateLimitReport_LeadsTheProviderTextAndNamesTheReset: the provider's own
// sentence is the only diagnosable part and survives verbatim; what the lead
// adds is the part the provider never says — which account, how long, and until
// when, in the reader's own clock.
func TestRateLimitReport_LeadsTheProviderTextAndNamesTheReset(t *testing.T) {
	w, providerText := rateLimitedWorker(t, "test-rate-limit-report")

	w.driveStrategyLoop(t, "", true)

	items := errorItems(w)
	if len(items) != 1 {
		t.Fatalf("error items = %d, want 1: %+v", len(items), items)
	}
	content := items[0].Content
	if !strings.Contains(content, providerText) {
		t.Fatalf("the provider's own error text was dropped, leaving only our lead:\n%s", content)
	}
	lead, _, _ := strings.Cut(content, "\n")
	if strings.Contains(lead, providerText) {
		t.Fatalf("the lead must stand above the provider's text, not inside it:\n%s", content)
	}
	if !strings.Contains(lead, "openaicodex") || !strings.Contains(lead, "usage limit") {
		t.Fatalf("lead names neither the provider nor what happened: %q", lead)
	}
	if !regexp.MustCompile(`\b\d{2}:\d{2}\b`).MatchString(lead) {
		t.Fatalf("lead states no reset time, so the only way to learn when to come back is to keep trying: %q", lead)
	}
	if until := w.rateLimitedUntil("openaicodex"); until.IsZero() {
		t.Fatal("reporting a dated cap must also latch it — otherwise the next thread goes and finds it again")
	}
}

// TestRateLimitReport_SecondThreadAddsNoSecondItem: six threads met this cap at
// once in the incident and wrote six identical items. A thread already past the
// dispatch check when the cap lands still meets it — and still has nothing to
// say that the first report did not already say.
func TestRateLimitReport_SecondThreadAddsNoSecondItem(t *testing.T) {
	w, _ := rateLimitedWorker(t, "test-rate-limit-second-thread")

	// Another thread got there first and reported it.
	w.latchRateLimit("openaicodex", time.Now().Add(4*time.Hour))

	w.driveStrategyLoop(t, "", true)

	if items := errorItems(w); len(items) != 0 {
		t.Fatalf("error items = %d, want 0 — the cap was already reported, so this thread repeats it: %+v", len(items), items)
	}
}

func TestRateLimitReport_Wording(t *testing.T) {
	now := time.Date(2026, 9, 10, 19, 58, 0, 0, time.UTC)
	tests := []struct {
		name  string
		until time.Time
		want  string
	}{
		{name: "hours away", until: now.Add(4*time.Hour + 76*time.Second), want: "in about 4 hours, at 23:59"},
		{name: "minutes away", until: now.Add(25 * time.Minute), want: "in about 25 minutes, at 20:23"},
		{name: "seconds away", until: now.Add(30 * time.Second), want: "in under a minute, at 19:58"},
		{name: "tomorrow", until: now.Add(8 * time.Hour), want: "in about 8 hours, tomorrow at 03:58"},
		{name: "next week", until: now.Add(8 * 24 * time.Hour), want: "in about 8 days, on 18 Sep at 19:58"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := rateLimitReport("openaicodex", tt.until, now, "429 Too Many Requests")
			if !strings.Contains(got, tt.want) {
				t.Fatalf("report = %q, want it to contain %q", got, tt.want)
			}
		})
	}
}
