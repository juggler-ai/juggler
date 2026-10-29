//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// newTruncationWorker builds a worker wired for a bare strategy run: an
// initialised doc plus a goroutine feeding the context/tools replies the loop
// blocks on. The caller queues the mock responses.
func newTruncationWorker(t *testing.T, convID string) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker(convID, "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	initPayload, err := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: convID},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	if err != nil {
		t.Fatalf("marshal init: %v", err)
	}
	w.currentRun().handleInit(initPayload)

	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-response", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			select {
			case <-stop:
				return
			default:
			}
			if !w.engine.contextReply.inject(w.done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(w.done, toolsResp) {
				return
			}
		}
	}()
	return w
}

func thinkingBlock(s string) LLMResponseBlock {
	return LLMResponseBlock{Type: provider.ContentBlockTypeThinking, Thinking: s}
}

func textBlock(s string) LLMResponseBlock {
	return LLMResponseBlock{Type: provider.ContentBlockTypeText, Content: s}
}

// itemsByType groups a finished run's conversation items for assertions.
func itemsByType(w *ConversationWorker) map[string][]ConversationItem {
	byType := map[string][]ConversationItem{}
	for _, it := range w.doc.GetItems() {
		byType[it.Type] = append(byType[it.Type], it)
	}
	return byType
}

// assistantContains reports whether any assistant item carries the substring.
func assistantContains(items map[string][]ConversationItem, substr string) bool {
	for _, it := range items[ItemTypeAssistant] {
		if strings.Contains(it.Content, substr) {
			return true
		}
	}
	return false
}

// A reasoning model whose whole output budget goes on thinking returns thinking
// and nothing else, with stop reason max_tokens. That is a truncation, not a
// blank turn: re-issuing the identical request spends the identical budget and
// is cut off in the identical place, and each round's thinking is replayed into
// the next, so every attempt starts nearer the limit. It must cost ONE call and
// be reported as what it was.
func TestTruncatedThinkingOnlyTurnIsReportedNotRetried(t *testing.T) {
	w := newTruncationWorker(t, "conv-truncated")
	w.SetWindowResolver(func(ModelConfig) ContextWindowInfo { return ContextWindowInfo{WindowTokens: 8192, ReserveTokens: 1638} })

	// Four queued, only one may be consumed: the surplus proves the loop
	// stopped rather than merely running the queue dry.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{thinkingBlock("pondering the clipping routine")}, StopReason: "max_tokens", OutputTokens: 1638},
		{Blocks: []LLMResponseBlock{thinkingBlock("still pondering")}, StopReason: "max_tokens", OutputTokens: 1638},
		{Blocks: []LLMResponseBlock{thinkingBlock("and again")}, StopReason: "max_tokens", OutputTokens: 1638},
		{Blocks: []LLMResponseBlock{textBlock("SENTINEL")}, StopReason: "end_turn"},
	})

	w.driveStrategyLoop(t, "optimise clipToPolygon", false)

	if n := w.mock().remaining(); n != 3 {
		t.Fatalf("leftover mock responses = %d, want 3 (one call, not %d)", n, MaxBarrenTurns)
	}

	items := itemsByType(w)

	notices := items[ItemTypeNotice]
	if len(notices) != 1 {
		t.Fatalf("got %d notice items, want exactly 1", len(notices))
	}
	notice := notices[0]
	if notice.Summary == "" {
		t.Error("notice has no summary — nothing for the transcript row to title itself with")
	}
	// The point of the notice: name the budget that ended the turn, rather than
	// merely reporting that something went wrong.
	if !strings.Contains(notice.Content, "1638") {
		t.Errorf("notice drops the output budget that truncated the turn: %q", notice.Content)
	}
	// The reported symptom was thinking followed by nothing, which reads as a
	// crash unless the note says otherwise.
	if !strings.Contains(notice.Content, "thinking") {
		t.Errorf("notice doesn't explain that thinking consumed the budget: %q", notice.Content)
	}
	if _, content := assertNoticeMessages(t, notice); content.Params["used"] != float64(1638) {
		t.Errorf("message params = %v, want the tokens the turn used", content.Params)
	}

	if n := len(items[ItemTypeThinking]); n != 1 {
		t.Errorf("got %d thinking items, want 1 (one call, one thinking block)", n)
	}
	// The old ending: a placeholder blaming the model for a silence that was
	// Juggler's own output cap.
	if assistantContains(items, "no further response") {
		t.Error("truncated turn still papered over with the barren placeholder")
	}
}

// The reported confusion: a 262,144-token window, Max output left on auto, and a
// turn cut off at a number the user had never seen and could not trace. When
// the budget is Juggler's own derivation the notice says so, names the window
// it came from, and says what raising it costs.
func TestTruncationNoticeExplainsADerivedBudget(t *testing.T) {
	w := newTruncationWorker(t, "conv-truncated-derived")
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "llamacpp", "model": "local"})
	w.SetWindowResolver(func(ModelConfig) ContextWindowInfo {
		return ContextWindowInfo{WindowTokens: 262144, ReserveTokens: 32768, ReserveDerived: true}
	})
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{thinkingBlock("pondering")}, StopReason: "max_tokens", OutputTokens: 32768},
	})

	w.driveStrategyLoop(t, "optimise clipToPolygon", false)

	notices := itemsByType(w)[ItemTypeNotice]
	if len(notices) != 1 {
		t.Fatalf("got %d notice items, want exactly 1", len(notices))
	}
	content := notices[0].Content
	for _, want := range []string{"Max output: 32768", "Juggler's default", "262144-token context window",
		"Models and token limits", "less room"} {
		if !strings.Contains(content, want) {
			t.Errorf("derived-budget notice lacks %q: %q", want, content)
		}
	}
	if _, message := assertNoticeMessages(t, notices[0]); message.Params["window"] != float64(262144) {
		t.Errorf("message params = %v, want the window the budget was derived from", message.Params)
	}
}

// A budget the provider reported, or the user set, is not Juggler's to explain
// as a derivation.
func TestTruncationNoticeDoesNotCallAReportedBudgetDerived(t *testing.T) {
	w := newTruncationWorker(t, "conv-truncated-reported")
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "llamacpp", "model": "local"})
	w.SetWindowResolver(func(ModelConfig) ContextWindowInfo {
		return ContextWindowInfo{WindowTokens: 262144, ReserveTokens: 16384}
	})
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{thinkingBlock("pondering")}, StopReason: "max_tokens", OutputTokens: 16384},
	})

	w.driveStrategyLoop(t, "optimise clipToPolygon", false)

	notices := itemsByType(w)[ItemTypeNotice]
	if len(notices) != 1 {
		t.Fatalf("got %d notice items, want exactly 1", len(notices))
	}
	if content := notices[0].Content; strings.Contains(content, "Juggler's default") || !strings.Contains(content, "Max output: 16384") {
		t.Errorf("reported-budget notice misdescribes its budget: %q", content)
	}
}

// onlyNotice returns the run's single notice, failing unless there is exactly one.
func onlyNotice(t *testing.T, w *ConversationWorker) ConversationItem {
	t.Helper()
	notices := itemsByType(w)[ItemTypeNotice]
	if len(notices) != 1 {
		t.Fatalf("got %d notice items, want exactly 1", len(notices))
	}
	return notices[0]
}

// retryOffer decodes the one-off retry a truncation notice offers; zero when it
// offers none.
func retryOffer(t *testing.T, notice ConversationItem) truncationNoticeData {
	t.Helper()
	var data truncationNoticeData
	if len(notice.Data) > 0 {
		if err := json.Unmarshal(notice.Data, &data); err != nil {
			t.Fatalf("notice data %s: %v", notice.Data, err)
		}
	}
	return data
}

// raisesSent reports the raiseMaxOutputTokens each scripted request carried, 0
// for one that carried none.
func raisesSent(t *testing.T, w *ConversationWorker) []int {
	t.Helper()
	var raises []int
	for _, raw := range w.mock().sentRequests() {
		var req struct {
			Raise int `json:"raiseMaxOutputTokens"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatalf("request %s: %v", raw, err)
		}
		raises = append(raises, req.Raise)
	}
	return raises
}

// The reported case, recovered: a thinking-only turn cut off at a derived
// 32,768 offers a one-off retry at double that. Taking it removes the barren
// thinking and the notice, sends exactly one request with the raise, and the
// turn after it goes back to the model's own Max output.
func TestTruncationRetryRaisesMaxOutputForOneRequest(t *testing.T) {
	w := newTruncationWorker(t, "conv-truncated-retry")
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "llamacpp", "model": "local"})
	w.SetWindowResolver(func(ModelConfig) ContextWindowInfo {
		return ContextWindowInfo{WindowTokens: 262144, ReserveTokens: 32768, ReserveDerived: true, OutputRaiseCeiling: 131072}
	})
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{thinkingBlock("pondering")}, StopReason: "max_tokens", OutputTokens: 32768},
	})
	w.driveStrategyLoop(t, "write the whole app", false)

	notice := onlyNotice(t, w)
	offer := retryOffer(t, notice)
	if offer.RetryMaxOutput != 65536 {
		t.Fatalf("retry offered at %d, want double the 32768 that ran out", offer.RetryMaxOutput)
	}
	thinking := itemsByType(w)[ItemTypeThinking]
	if len(thinking) != 1 || len(offer.Discard) != 1 || offer.Discard[0] != thinking[0].ItemID {
		t.Fatalf("retry would discard %v, want exactly the cut-off thinking %v", offer.Discard, thinking)
	}

	// A notice that is not the one on screen asks for nothing.
	stale, _ := json.Marshal(map[string]any{"threadItemId": "", "noticeId": "no-such-notice"})
	w.currentRun().handleRetryTruncatedTurn(stale)
	if got := w.threadActivity(""); got != ActivityNone {
		t.Fatalf("a retry of an unknown notice started work: activity %q", got)
	}

	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{textBlock("here is the app")}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{textBlock("and the tests")}, StopReason: "end_turn"},
	})
	payload, _ := json.Marshal(map[string]any{"threadItemId": "", "noticeId": notice.ItemID})
	w.currentRun().handleRetryTruncatedTurn(payload)

	items := itemsByType(w)
	if n := len(items[ItemTypeThinking]) + len(items[ItemTypeNotice]); n != 0 {
		t.Fatalf("the cut-off turn is still on screen after its retry: %d thinking/notice items", n)
	}
	if got := w.threadActivity(""); got != ActivityAwaitingLLM {
		t.Fatalf("activity after retry = %q, want the thread queued for dispatch", got)
	}

	w.driveStrategyLoop(t, "", true)
	w.driveStrategyLoop(t, "now the tests", false)

	if !assistantContains(itemsByType(w), "here is the app") {
		t.Fatal("the retried turn's answer did not land")
	}
	if got := raisesSent(t, w); len(got) != 2 || got[0] != 65536 || got[1] != 0 {
		t.Fatalf("raises sent = %v, want [65536 0]: the retry alone is raised", got)
	}
}

// No retry is offered where a larger Max output cannot be had: a provider that
// cannot set a request's output length, or a model already at the limit its
// provider states.
func TestTruncationOffersNoRetryItCannotHonour(t *testing.T) {
	for name, info := range map[string]ContextWindowInfo{
		"fixed-cap provider":     {WindowTokens: 200000, ReserveTokens: 32000},
		"at the stated limit":    {WindowTokens: 200000, ReserveTokens: 64000, OutputRaiseCeiling: 64000},
		"unknown window and cap": {},
	} {
		t.Run(name, func(t *testing.T) {
			w := newTruncationWorker(t, "conv-truncated-no-retry")
			w.SetWindowResolver(func(ModelConfig) ContextWindowInfo { return info })
			w.setMockResponses([]MockResponse{
				{Blocks: []LLMResponseBlock{thinkingBlock("pondering")}, StopReason: "max_tokens", OutputTokens: 100},
			})
			w.driveStrategyLoop(t, "write the whole app", false)
			if offer := retryOffer(t, onlyNotice(t, w)); offer.RetryMaxOutput != 0 {
				t.Fatalf("offered a retry at %d it cannot honour", offer.RetryMaxOutput)
			}
		})
	}
}

// A truncated turn that DID emit text is still reported, but the text stands:
// the reply is short, not absent, and nothing may discard it.
func TestTruncatedTurnWithTextKeepsTheTextAndReportsIt(t *testing.T) {
	w := newTruncationWorker(t, "conv-truncated-text")
	w.SetWindowResolver(func(ModelConfig) ContextWindowInfo { return ContextWindowInfo{WindowTokens: 8192, ReserveTokens: 1638} })

	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{textBlock("Here is the first half of the answer")}, StopReason: "max_tokens", OutputTokens: 1638},
		{Blocks: []LLMResponseBlock{textBlock("SENTINEL")}, StopReason: "end_turn"},
	})

	w.driveStrategyLoop(t, "explain the algorithm", false)

	if n := w.mock().remaining(); n != 1 {
		t.Fatalf("leftover mock responses = %d, want 1 (exactly one call)", n)
	}
	items := itemsByType(w)
	if n := len(items[ItemTypeNotice]); n != 1 {
		t.Fatalf("got %d notice items, want exactly 1", n)
	}
	if !assistantContains(items, "first half of the answer") {
		t.Errorf("the truncated reply's text was lost; assistant items = %+v", items[ItemTypeAssistant])
	}
}

// With somebody there, a turn cut off before it acted rests and they decide
// what to do next (TestTruncatedThinkingOnlyTurnIsReportedNotRetried). With
// nobody there — a headless `juggler run` — resting ends the whole run with
// nothing done: the reported case is a GLM-5.3 run that thought for fifteen
// minutes, hit its output limit and reported "completed" having written
// nothing. So an unattended run does what the person would: it says act now,
// and goes on.
func TestUnattendedTruncatedTurnIsToldToActAndContinues(t *testing.T) {
	w := newTruncationWorker(t, "conv-truncated-unattended")
	w.doc.SetMetadata("unattended", true)
	w.SetWindowResolver(func(ModelConfig) ContextWindowInfo { return ContextWindowInfo{WindowTokens: 8192, ReserveTokens: 1638} })

	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{thinkingBlock("pondering the clipping routine")}, StopReason: "max_tokens", OutputTokens: 1638},
		{Blocks: []LLMResponseBlock{textBlock("SENTINEL")}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{textBlock("SURPLUS")}, StopReason: "end_turn"},
	})

	w.driveStrategyLoop(t, "optimise clipToPolygon", false)

	if n := w.mock().remaining(); n != 1 {
		t.Fatalf("leftover mock responses = %d, want 1 (the truncated call, then one more)", n)
	}
	items := itemsByType(w)
	if !assistantContains(items, "SENTINEL") {
		t.Fatalf("the run stopped at the truncation instead of going on; assistant items = %+v", items[ItemTypeAssistant])
	}
	if n := len(items[ItemTypeNotice]); n != 1 {
		t.Errorf("got %d truncation notice(s), want 1: the transcript still says what happened", n)
	}
	told := false
	for _, it := range items[ItemTypeSystemReminder] {
		if strings.Contains(it.Content, "output limit") {
			told = true
		}
	}
	if !told {
		t.Errorf("the model was not told why it is being asked to go on; reminders = %+v", items[ItemTypeSystemReminder])
	}
}

// Going on is bounded: a model that spirals every time is not re-asked forever.
// Two continuations per run, so three calls at most, then it rests as an
// attended run would.
func TestUnattendedTruncationContinuationsAreBounded(t *testing.T) {
	w := newTruncationWorker(t, "conv-truncated-unattended-bounded")
	w.doc.SetMetadata("unattended", true)
	w.SetWindowResolver(func(ModelConfig) ContextWindowInfo { return ContextWindowInfo{WindowTokens: 8192, ReserveTokens: 1638} })

	cut := MockResponse{Blocks: []LLMResponseBlock{thinkingBlock("pondering")}, StopReason: "max_tokens", OutputTokens: 1638}
	w.setMockResponses([]MockResponse{
		cut, cut, cut, cut, cut,
		{Blocks: []LLMResponseBlock{textBlock("SENTINEL")}, StopReason: "end_turn"},
	})

	w.driveStrategyLoop(t, "optimise clipToPolygon", false)

	if n := w.mock().remaining(); n != 3 {
		t.Fatalf("leftover mock responses = %d, want 3 (three calls: the first and two continuations)", n)
	}
	if assistantContains(itemsByType(w), "SENTINEL") {
		t.Error("the run went past its continuation bound")
	}
}

// The genuine transient-blank path must survive the truncation fix: a provider
// that intermittently emits an empty end_turn is still retried MaxBarrenTurns
// times and still ends in the placeholder. Without this, "don't retry
// truncations" could quietly become "don't retry anything".
func TestBarrenTurnWithoutTruncationStillRetries(t *testing.T) {
	w := newTruncationWorker(t, "conv-barren")

	barren := MockResponse{Blocks: []LLMResponseBlock{thinkingBlock("hmm")}, StopReason: "end_turn"}
	w.setMockResponses([]MockResponse{
		barren, barren, barren,
		{Blocks: []LLMResponseBlock{textBlock("SENTINEL")}, StopReason: "end_turn"},
	})

	w.driveStrategyLoop(t, "optimise clipToPolygon", false)

	if n := w.mock().remaining(); n != 1 {
		t.Fatalf("leftover mock responses = %d, want 1 (exactly %d calls)", n, MaxBarrenTurns)
	}

	items := itemsByType(w)
	if n := len(items[ItemTypeNotice]); n != 0 {
		t.Errorf("a barren turn earned %d truncation notice(s) it did not deserve", n)
	}
	if !assistantContains(items, "no further response") {
		t.Errorf("barren stall placeholder missing; assistant items = %+v", items[ItemTypeAssistant])
	}
}

// sentRequests returns the requests the script has answered so far.
func (m *mockLLMCaller) sentRequests() []json.RawMessage {
	if requests := m.requests.Load(); requests != nil {
		return *requests
	}
	return nil
}
