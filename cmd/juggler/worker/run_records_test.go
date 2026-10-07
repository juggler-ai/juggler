//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

// TestResolveRunOutcome pins the whole outcome table. Every ending resolves to
// a status and a non-empty result: a caller that stamped a tool_use is owed a
// tool_result whatever happened, and an unpaired tool_use is wire-invalid.
func TestResolveRunOutcome(t *testing.T) {
	assistant := ConversationItem{Type: ItemTypeAssistant, Content: "Here is the answer."}
	user := ConversationItem{Type: ItemTypeUser, Content: "do it"}

	tests := []struct {
		name       string
		items      []ConversationItem
		cancelled  bool
		wantStatus string
		wantResult string
	}{
		{
			name:       "clean trailing reply rests",
			items:      []ConversationItem{user, assistant},
			wantStatus: runStatusRest,
			wantResult: "Here is the answer.",
		},
		{
			// The error is what the run ended on, so it is what the run returns —
			// never dropped in favour of the reply that preceded it.
			name: "trailing error wins over earlier text",
			items: []ConversationItem{
				user, assistant,
				{Type: ItemTypeError, Content: "invalid request: bad model"},
			},
			wantStatus: runStatusError,
			wantResult: "invalid request: bad model",
		},
		{
			name:       "cancelled with nothing produced",
			items:      []ConversationItem{user},
			cancelled:  true,
			wantStatus: runStatusCancelled,
			wantResult: runCancelledNote,
		},
		{
			// What it managed to say is worth keeping; the reason is appended so
			// the caller can tell a full answer from an interrupted one.
			name:       "cancelled keeps what it produced",
			items:      []ConversationItem{user, assistant},
			cancelled:  true,
			wantStatus: runStatusCancelled,
			wantResult: "Here is the answer.\n\n" + runCancelledNote,
		},
		{
			name:       "nothing clean to return is barren",
			items:      []ConversationItem{user},
			wantStatus: runStatusBarren,
			wantResult: runBarrenNote,
		},
		{
			// A run whose last act was a sync meta tool has no reply to return:
			// the trailing item is plumbing, not an answer.
			name: "trailing meta-tool result is barren",
			items: []ConversationItem{
				user,
				{Type: ItemTypeMetaToolResult, ToolName: "drop_context_items"},
			},
			wantStatus: runStatusBarren,
			wantResult: runBarrenNote,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			status, result, _ := resolveRunOutcome(tc.items, tc.cancelled, runResultFloorChars)
			if status != tc.wantStatus {
				t.Errorf("status = %q, want %q", status, tc.wantStatus)
			}
			if result != tc.wantResult {
				t.Errorf("result = %q, want %q", result, tc.wantResult)
			}
			if result == "" {
				t.Errorf("every ending must return something — a caller is owed a tool_result")
			}
		})
	}
}

// threadItemWithRun builds a thread item whose transcript is one invocation
// message in the given run state, as the wire and the deciders see it. A
// settled run reports the summary as its own result, exactly as a real settle
// writes both.
func threadItemWithRun(t *testing.T, runStatus, result string) ConversationItem {
	t.Helper()
	invocation := ConversationItem{
		Type:         ItemTypeUser,
		ItemID:       "inv-1",
		Content:      "do the task",
		RunToolUseID: "tu-1",
		RunToolName:  "create_thread",
		RunToolInput: json.RawMessage(`{"goal":"g","prompt":"p"}`),
		RunStatus:    runStatus,
	}
	if runStatus != "" {
		invocation.RunResult = result
	}
	nested := []ConversationItem{invocation}
	raw, err := json.Marshal(nested)
	if err != nil {
		t.Fatalf("marshal nested items: %v", err)
	}
	item := ConversationItem{Type: ItemTypeThread, ItemID: "thread-1", Goal: "g", Items: raw}
	if result != "" {
		item.Result, _ = json.Marshal(result)
	}
	return item
}

// TestThreadRunSettledReadsTheRunNotTheSummary pins the distinction the whole
// refactor turns on. `result` is the thread's current summary and outlives the
// run that wrote it, so a thread invoked again while carrying one is still
// running — reading the summary instead would report it finished and answer its
// caller with the previous run's reply.
func TestThreadRunSettledReadsTheRunNotTheSummary(t *testing.T) {
	if settled := threadRunSettled(threadItemWithRun(t, "", "")); settled {
		t.Errorf("a run with no recorded outcome must read as running")
	}
	if settled := threadRunSettled(threadItemWithRun(t, runStatusRest, "The summary.")); !settled {
		t.Errorf("a settled run must read as finished")
	}
	if settled := threadRunSettled(threadItemWithRun(t, "", "An older summary.")); settled {
		t.Errorf("a thread carrying a summary from an earlier run must still read as running")
	}

	// A document written before run records existed answers from `result`, which
	// is the only completion it ever recorded.
	legacy := ConversationItem{Type: ItemTypeThread, ItemID: "thread-legacy", Goal: "g"}
	legacy.Result, _ = json.Marshal("Legacy result.")
	if settled := threadRunSettled(legacy); !settled {
		t.Errorf("a thread with no run record must fall back to its result")
	}
	if settled := threadRunSettled(ConversationItem{Type: ItemTypeThread, ItemID: "empty"}); settled {
		t.Errorf("a thread with neither a run record nor a result is not finished")
	}
}

// TestThreadRunSettledReadsAFoldAsAFold covers the ordinary shape of a fold
// inside a long-lived session: a compaction thread whose swallowed transcript
// carries run records belonging to the runs it folded. Read as runs,
// its trailing item is the summarization prompt with no outcome, so it would
// report as a live child forever — parking the thread that holds it, and
// sending the reducer down into it to re-summarize a fold that already has its
// summary. A fold's completion is its `result`, the same question
// pendingCompactionFold asks.
func TestThreadRunSettledReadsAFoldAsAFold(t *testing.T) {
	swallowed, err := json.Marshal([]ConversationItem{
		{
			Type: ItemTypeUser, ItemID: "inv-1", Content: "do the task",
			RunToolUseID: "tu-1", RunToolName: "Explore",
			RunToolInput: json.RawMessage(`{"prompt":"p"}`),
			RunStatus:    runStatusRest, RunResult: "the answer",
		},
		{Type: ItemTypeUser, ItemID: "prompt", Content: DefaultSummarizationPrompt},
	})
	if err != nil {
		t.Fatalf("marshal swallowed items: %v", err)
	}
	fold := ConversationItem{
		Type: ItemTypeThread, ItemID: "fold-1", Goal: "Compacted conversation history",
		BoundedCompaction: true, Items: swallowed,
	}
	if threadRunSettled(fold) {
		t.Error("an unsummarized fold must read as unfinished — the summarizer still owes it a result")
	}
	fold.Result, _ = json.Marshal("the fold summary")
	if !threadRunSettled(fold) {
		t.Error("a summarized fold is finished; the run records inside it belong to what it swallowed")
	}

	// The same mistake on the wire: a fold's swallowed invocation messages are
	// the caller's calls into the thread that folded them, so emitting them here
	// would put the parent's tool_use blocks inside the child's own history. A
	// fold renders as the inert summary it is.
	if runs := threadRunRecords(fold); runs != nil {
		t.Errorf("a fold reported %d runs of its own; they belong to what it swallowed", len(runs))
	}
	msgs := appendThreadMessages(nil, fold, nil)
	if len(msgs) != 1 || msgs[0]["type"] != ItemTypeUser {
		t.Errorf("fold wire = %+v, want the single inert summary message", msgs)
	}
}

// TestSettledRunUnparksTheCaller is the direct regression guard for the switch
// from `result` to the run record: a parent parked on a child resumes the
// moment that child's run settles, whatever it settled as. A half-applied
// switch shows up here as a parent that never wakes, and nowhere else until a
// user hits it.
func TestSettledRunUnparksTheCaller(t *testing.T) {
	for _, status := range []string{runStatusRest, runStatusError, runStatusCancelled, runStatusBarren} {
		t.Run(status, func(t *testing.T) {
			items := []ConversationItem{
				{Type: ItemTypeUser, Content: "start"},
				threadItemWithRun(t, status, ""),
			}
			if action := decideNextAction(items, ActivityAwaitingLLM, true, false); action != ActionCallLLM {
				t.Errorf("action = %q, want %q — a parked caller must resume on a settled run", action, ActionCallLLM)
			}
		})
	}

	// A run still going keeps the caller parked. This is the same guard from the
	// other side: an approval the child is waiting on is not an ending, and
	// inventing a return for it would strand output nobody collects.
	items := []ConversationItem{
		{Type: ItemTypeUser, Content: "start"},
		threadItemWithRun(t, "", ""),
	}
	if action := decideNextAction(items, ActivityAwaitingLLM, true, false); action != ActionNone {
		t.Errorf("action = %q, want %q — an unsettled run must keep the caller parked", action, ActionNone)
	}
}

// TestSettleThreadRunStampsTheInvocationMessage proves the outcome is stored on
// the message that started the run, where the wire reads it to pair this run's
// tool_use with this run's tool_result — and that settling twice does not
// re-stamp a run that has already reported.
func TestSettleThreadRunStampsTheInvocationMessage(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Work", userMessage: "do it"})
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	w.currentRun().appendTargetMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "All done.",
	})

	w.settleThreadRun(threadID, false)

	ycrdtMu.Lock()
	status, result := latestRunOutcomeLocked(findThreadYMap(w.doc.getItems(), threadID))
	ycrdtMu.Unlock()
	if status != runStatusRest || result != "All done." {
		t.Fatalf("run record = (%q, %q), want (%q, %q)", status, result, runStatusRest, "All done.")
	}

	// A second settle finds no open run and leaves the record alone.
	w.currentRun().appendTargetMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "Something later.",
	})
	w.settleThreadRun(threadID, false)
	ycrdtMu.Lock()
	status, result = latestRunOutcomeLocked(findThreadYMap(w.doc.getItems(), threadID))
	ycrdtMu.Unlock()
	if status != runStatusRest || result != "All done." {
		t.Errorf("settled run was re-stamped: (%q, %q)", status, result)
	}
}

// TestRunResultIsCapped pins the bound on what a child hands its parent.
//
// A sub-thread exists so its working context never costs the caller a token,
// and that promise ends at the result: resultSpec is advice to a model, not a
// limit, and nothing measured what came back. Four children in one turn returned
// 36k, 35k, 53k and 55k characters and put ~41k fresh tokens into the parent in
// one go.
//
// The three cases are one property seen from three sides. An ordinary report is
// untouched (the cap is an outlier guard, not a redefinition of "report"); a
// transcript dump is trimmed and SAYS it was trimmed, naming what it kept and
// where the rest still is; and a cancelled run keeps its cancellation note after
// the trim rather than having it cut off — the note is the one part of that
// result the caller cannot do without.
func TestRunResultIsCapped(t *testing.T) {
	rest := func(text string) []ConversationItem {
		return []ConversationItem{{Type: ItemTypeAssistant, ItemID: "a-1", Content: text}}
	}
	// Line-shaped, as a real report is, so the trim has boundaries to land on.
	huge := strings.Repeat("a finding about the code\n", 2000) // ~50k
	ordinary := strings.Repeat("a finding about the code\n", 600)

	t.Run("an ordinary result is returned untouched", func(t *testing.T) {
		status, result, fullChars := resolveRunOutcome(rest(ordinary), false, runResultFloorChars)
		if status != runStatusRest {
			t.Fatalf("status = %q, want %q", status, runStatusRest)
		}
		if result != ordinary {
			t.Errorf("a result inside the cap must be returned byte-identical; got %d chars, want %d",
				len(result), len(ordinary))
		}
		if fullChars != 0 {
			t.Errorf("fullChars = %d for an untrimmed result, want 0 — the log would report a cut that never happened", fullChars)
		}
	})

	t.Run("a transcript dump is trimmed and says so", func(t *testing.T) {
		status, result, fullChars := resolveRunOutcome(rest(huge), false, runResultFloorChars)
		if status != runStatusRest {
			t.Fatalf("status = %q, want %q", status, runStatusRest)
		}
		if n := utf8.RuneCountInString(result); n > runResultFloorChars {
			t.Errorf("capped result = %d chars, want at most %d — the note has to fit inside the budget too",
				n, runResultFloorChars)
		}
		if fullChars != len(huge) {
			t.Errorf("fullChars = %d, want %d — the settle log names the size the result was cut from", fullChars, len(huge))
		}
		if !strings.HasPrefix(result, "a finding about the code\n") {
			t.Error("the trim must keep the START of the report: a summary is written top-down")
		}
		if !strings.Contains(result, runResultTrimmedMarker) {
			t.Errorf("a silently shortened result is worse than a long one — the model must be told. got tail %q",
				result[max(0, len(result)-200):])
		}
		if !strings.Contains(result, fmt.Sprintf("%d", len(huge))) {
			t.Errorf("the note must name the full size so the model can judge what it is missing; got tail %q",
				result[max(0, len(result)-200):])
		}
	})

	// The note speaks in characters, and so must the cap and its counts: a report
	// in accented prose is longer in bytes than in characters, and a count in
	// bytes both overstates what the caller was given and trims it early.
	t.Run("a trimmed result counts characters, not bytes", func(t *testing.T) {
		accented := strings.Repeat("é résumé of the findings\n", 2000) // 50k characters, 56k bytes
		total := utf8.RuneCountInString(accented)
		_, result, _ := resolveRunOutcome(rest(accented), false, runResultFloorChars)
		if n := utf8.RuneCountInString(result); n > runResultFloorChars {
			t.Errorf("capped result = %d characters, want at most %d", n, runResultFloorChars)
		}
		cut := strings.Index(result, "\n\n… "+runResultTrimmedMarker)
		if cut < 0 {
			t.Fatalf("no trim note in the result; tail %q", result[max(0, len(result)-200):])
		}
		want := fmt.Sprintf("%s %d of %d characters shown", runResultTrimmedMarker, utf8.RuneCountInString(result[:cut]), total)
		if !strings.Contains(result, want) {
			t.Errorf("the note must count characters: want %q in tail %q", want, result[max(0, len(result)-200):])
		}
	})

	t.Run("a cancelled run keeps its note after the trim", func(t *testing.T) {
		status, result, _ := resolveRunOutcome(rest(huge), true, runResultFloorChars)
		if status != runStatusCancelled {
			t.Fatalf("status = %q, want %q", status, runStatusCancelled)
		}
		if !strings.HasSuffix(result, runCancelledNote) {
			t.Errorf("the cancellation note must survive the trim — without it the caller reads a partial "+
				"answer as a whole one. got tail %q", result[max(0, len(result)-200):])
		}
		if !strings.Contains(result, runResultTrimmedMarker) {
			t.Error("a cancelled run's partial output is capped like any other")
		}
	})
}

// TestRunResultCapFollowsTheCallersWindow pins whose window sizes the cap: the
// caller's, because the result is spent in the caller's context. The child here
// runs on a small model and its caller on a large one, so a cap read off the
// child — or not scaled at all — trims a report the caller has ample room for.
// With no window known, the floor still holds.
func TestRunResultCapFollowsTheCallersWindow(t *testing.T) {
	huge := strings.Repeat("a finding about the code\n", 2000) // ~50k

	settle := func(t *testing.T, callerWindow int) string {
		t.Helper()
		w := NewConversationWorker("test-conv", "user:test")
		t.Cleanup(w.doc.Destroy)
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "prov", "model": "caller"})
		w.windowResolver = func(mc ModelConfig) ContextWindowInfo {
			switch mc.Model {
			case "caller":
				return ContextWindowInfo{WindowTokens: callerWindow}
			case "child":
				return ContextWindowInfo{WindowTokens: 8192}
			}
			return ContextWindowInfo{}
		}

		threadID := insertThreadWithOpts(w, threadOpts{goal: "Research", userMessage: "look into it"})
		w.doc.SetThreadField(threadID, "modelConfig", map[string]any{"provider": "prov", "model": "child"})
		w.turn.thread.itemID = threadID
		w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
		w.currentRun().appendTargetMessage(ConversationItem{
			Type: ItemTypeAssistant, ItemID: generateItemID(), Content: huge,
		})
		w.settleThreadRun(threadID, false)

		ycrdtMu.Lock()
		defer ycrdtMu.Unlock()
		_, result := latestRunOutcomeLocked(findThreadYMap(w.doc.getItems(), threadID))
		return result
	}

	t.Run("a large caller window takes the whole report", func(t *testing.T) {
		if result := settle(t, 1_000_000); result != huge {
			t.Errorf("a %d-char report against a 1M-token caller window came back as %d chars — "+
				"the cap must scale with the window of the context that pays for it", len(huge), len(result))
		}
	})

	t.Run("an unknown caller window keeps the floor", func(t *testing.T) {
		result := settle(t, 0)
		if n := utf8.RuneCountInString(result); n > 24_000 || !strings.Contains(result, runResultTrimmedMarker) {
			t.Errorf("with no window known the result must be trimmed to the 24k floor; got %d chars", n)
		}
	})

	t.Run("the budget curve", func(t *testing.T) {
		for _, tc := range []struct {
			window, want int
		}{
			{0, runResultFloorChars},            // unknown
			{32_000, runResultFloorChars},       // small window: never below the floor
			{200_000, runResultFloorChars},      // the window the floor was measured against
			{1_000_000, 120_000},                // proportional above it
			{10_000_000, runResultCeilingChars}, // an implausible figure hits the ceiling
		} {
			if got := runResultCharBudget(tc.window); got != tc.want {
				t.Errorf("runResultCharBudget(%d) = %d, want %d", tc.window, got, tc.want)
			}
		}
	})
}

// TestRunWithNothingToStampStillReports covers the child that has no message to
// stamp at all: a creation that appended no invocation message. The run's
// outcome has nowhere to live but the thread's `result`, which is then the only
// completion signal the thread has — so an ending other than rest must still
// write it, or the caller parks on hasIncompleteThreads forever, liveThreadCount
// counts the child for good, and the desktop quit guard reads it as executing.
func TestRunWithNothingToStampStillReports(t *testing.T) {
	cases := []struct {
		name      string
		cancelled bool
		trailing  ConversationItem
	}{
		{"error", false, ConversationItem{Type: ItemTypeError, ItemID: "e-1", Content: "invalid request: bad model"}},
		{"cancelled", true, ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "Got partway."}},
		{"barren", false, ConversationItem{Type: ItemTypeMetaToolResult, ItemID: "m-1", ToolName: "drop_context_items"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()

			threadID := insertThreadWithOpts(w, threadOpts{goal: "Work", llmCreated: true})
			w.turn.thread.itemID = threadID
			w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
			w.currentRun().appendTargetMessage(tc.trailing)

			w.settleThreadRun(threadID, tc.cancelled)

			if result, _ := w.doc.GetThreadYMap(threadID).Get("result").(string); result == "" {
				t.Fatalf("the run reported nothing anywhere — its caller waits on a run that can never report")
			}
			w.currentRun().resetThreadContext()
			items := append([]ConversationItem{{Type: ItemTypeUser, Content: "start"}}, w.doc.GetItems()...)
			if action := decideNextAction(items, ActivityAwaitingLLM, true, false); action != ActionCallLLM {
				t.Errorf("action = %q, want %q — a parked caller must resume", action, ActionCallLLM)
			}
		})
	}
}

// TestFoldRunSettlesNothing pins that a bounded-compaction fold is left alone by
// the settle path. Its summarisation prompt is an unstamped user item, so the
// starter search would find it and record a run outcome that describes nothing:
// a fold is a container of folded transcript, and every decider asks whether it
// has its summary by reading `result`.
func TestFoldRunSettlesNothing(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Compacted conversation history", boundedCompaction: true})

	w.settleThreadRun(threadID, false)

	for _, it := range w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID)) {
		if it.RunStatus != "" {
			t.Errorf("fold item %s was stamped runStatus=%q; a fold records no runs of its own",
				it.ItemID, it.RunStatus)
		}
	}
	if result, _ := w.doc.GetThreadYMap(threadID).Get("result").(string); result != "" {
		t.Errorf("the settle path wrote a fold's summary (%q); that belongs to the compaction path", result)
	}
}

// TestInterjectedMessageDoesNotStrandTheRun covers a human typing into a child
// whose delegated run is still in flight. The loop promotes that message
// mid-run and absorbs it into the same run, so the trailing user item at settle
// is the interjection rather than the call that started everything. Stamping
// the trailing item would leave the invocation message carrying the tool-use
// coordinates unstamped for good: the caller's tool_use would stay paired with
// the pending placeholder while the run's real reply sat somewhere the wire
// never reads. Every child column has a live composer, so this is one keystroke
// away.
func TestInterjectedMessageDoesNotStrandTheRun(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Work", llmCreated: true, delegated: true})
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)

	appendItem := func(item ConversationItem) {
		w.currentRun().appendTargetMessage(item)
	}
	appendItem(ConversationItem{
		Type: ItemTypeUser, ItemID: "inv-1", Content: "find the auth bug",
		RunToolUseID: "tu-1", RunToolName: "Explore",
		RunToolInput: json.RawMessage(`{"prompt":"find the auth bug"}`),
	})
	appendItem(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "Looking."})
	appendItem(ConversationItem{Type: ItemTypeUser, ItemID: "human-1", Content: "check the tests too"})
	appendItem(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-2", Content: "It is in the token refresh."})

	w.settleThreadRun(threadID, false)

	var invocation, interjection ConversationItem
	for _, it := range w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID)) {
		switch it.ItemID {
		case "inv-1":
			invocation = it
		case "human-1":
			interjection = it
		}
	}
	if invocation.RunStatus != runStatusRest || invocation.RunResult != "It is in the token refresh." {
		t.Fatalf("invocation message run record = (%q, %q), want (%q, %q)",
			invocation.RunStatus, invocation.RunResult, runStatusRest, "It is in the token refresh.")
	}
	// The message the run absorbed carries the same outcome, so the trailing
	// item runSettlement reads does not report an unanswered message.
	if interjection.RunStatus != runStatusRest {
		t.Errorf("the interjection carries runStatus %q, want %q — the thread would read as still working",
			interjection.RunStatus, runStatusRest)
	}

	// What the caller reads: its own tool_use paired with the run's reply, not
	// the placeholder that says the run never reported.
	var thread ConversationItem
	for _, it := range w.doc.GetItems() {
		if it.ItemID == threadID {
			thread = it
		}
	}
	if !threadRunSettled(thread) {
		t.Errorf("the thread reads as still working after its run settled — its caller would park forever")
	}
	msgs := appendThreadMessages(nil, thread, nil)
	if len(msgs) != 2 {
		t.Fatalf("expected one tool_use/tool_result pair, got %+v", msgs)
	}
	content, _ := msgs[1]["content"].(string)
	if !strings.Contains(content, "It is in the token refresh.") {
		t.Errorf("tool_result = %q, want the run's reply", content)
	}
}

// TestSettledRunPairsTheWire closes the loop on what the caller actually reads:
// the run's stored result is what comes back as its tool_result, and a run
// still going gets the pending placeholder rather than borrowing the summary
// left by an earlier one.
func TestSettledRunPairsTheWire(t *testing.T) {
	settled := threadItemWithRun(t, runStatusRest, "Thread summary.")
	msgs := appendThreadMessages(nil, settled, nil)
	if len(msgs) != 2 {
		t.Fatalf("expected a tool_use/tool_result pair, got %+v", msgs)
	}
	if content, _ := msgs[1]["content"].(string); !strings.Contains(content, "Thread summary.") {
		t.Errorf("tool_result = %q, want the run's result", content)
	}

	open := threadItemWithRun(t, "", "An older summary.")
	msgs = appendThreadMessages(nil, open, nil)
	if len(msgs) != 2 {
		t.Fatalf("expected a tool_use/tool_result pair, got %+v", msgs)
	}
	content, _ := msgs[1]["content"].(string)
	if strings.Contains(content, "An older summary.") {
		t.Errorf("a run in flight must not answer with an earlier run's reply; got %q", content)
	}
	if content != pendingToolResultPlaceholder {
		t.Errorf("tool_result = %q, want the pending placeholder", content)
	}
}

// TestTrailingItemShowsTheResumedRun covers a human picking a stopped child back
// up. The run its call started has already settled as cancelled, so the resume
// starts a run no call named — recorded on a plain user message that carries no
// tool-use coordinates at all.
//
// Nothing else in the parent stands for that work, so the item that made the
// call has to report it: otherwise the tile is frozen on the cancelled note for
// good, and the parent is handed "[The run was cancelled before it finished.]"
// as the answer to a question the child has since answered properly.
func TestTrailingItemShowsTheResumedRun(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.ensureItems()
	w.currentRun().storeState(StateProcessing)

	threadID, err := w.currentRun().spawnThread(threadSpec{
		Goal:   "map auth",
		Prompt: "find the auth flow",
	}, toolSpawn{
		ToolUseID: "tu-1",
		ToolName:  "Explore",
		ToolInput: json.RawMessage(`{"prompt":"find the auth flow"}`),
		Delegated: true,
	})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	appendItem := func(item ConversationItem) {
		w.currentRun().appendTargetMessage(item)
	}

	// The call is stopped partway.
	appendItem(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "Got partway."})
	w.settleThreadRun(threadID, true)

	callWire := func() (settled bool, toolUseID, content string) {
		w.currentRun().resetThreadContext()
		items := w.doc.GetItems()
		var thread ConversationItem
		for _, it := range items {
			if it.ItemID == threadID {
				thread = it
			}
		}
		if thread.ItemID == "" {
			t.Fatalf("thread item %s is not in the parent", threadID)
		}
		msgs := appendThreadMessages(nil, thread, items)
		if len(msgs) != 2 {
			t.Fatalf("expected one tool_use/tool_result pair, got %+v", msgs)
		}
		id, _ := msgs[1]["toolUseId"].(string)
		text, _ := msgs[1]["content"].(string)
		return itemRunSettled(items, thread), id, text
	}

	settled, _, content := callWire()
	if !settled || !strings.Contains(content, runCancelledNote) {
		t.Fatalf("a stopped call must report the stop: settled=%v content=%q", settled, content)
	}

	// A human types into the child. The work is under way again, so the call
	// waits on it rather than standing on the answer it already gave.
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	appendItem(ConversationItem{Type: ItemTypeUser, ItemID: "human-1", Content: "keep going"})

	settled, _, content = callWire()
	if settled {
		t.Error("the call reads as answered while the thread is working — its parent would run on stale news")
	}
	if content != pendingToolResultPlaceholder {
		t.Errorf("tool_result = %q, want the pending placeholder while the run is in flight", content)
	}

	// And when that run rests, its reply is what the call returns.
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	appendItem(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-2", Content: "It is in the token refresh."})
	w.settleThreadRun(threadID, false)

	settled, toolUseID, content := callWire()
	if !settled {
		t.Error("the resumed run settled but the call still reads as waiting")
	}
	if toolUseID != "tu-1" {
		t.Errorf("tool_result answers %q, want tu-1 — the call the parent committed to its history", toolUseID)
	}
	if !strings.Contains(content, "It is in the token refresh.") {
		t.Errorf("tool_result = %q, want the resumed run's reply", content)
	}
	if strings.Contains(content, runCancelledNote) {
		t.Errorf("tool_result still reports the stop the thread has moved past: %q", content)
	}
}

// TestAnsweredCallGetsAReceiptNotARewrite is the other half of
// TestTrailingItemShowsTheResumedRun, and the reason receipts exist. The same
// human resume, but this time the parent has already READ the call's answer:
// rewriting it now would slide every message after it, cold-start a stateful
// provider, and leave the parent's own reasoning standing after a result that
// contradicts it. The new run gets an item of its own instead.
func TestAnsweredCallGetsAReceiptNotARewrite(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.ensureItems()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.currentRun().storeState(StateProcessing)

	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "map auth", Prompt: "find the auth flow"}, toolSpawn{
		ToolUseID: "tu-1", ToolName: "Explore", ToolInput: json.RawMessage(`{"prompt":"find the auth flow"}`), Delegated: true,
	})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	inChild := func(item ConversationItem) {
		w.turn.thread.itemID = threadID
		w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
		w.currentRun().appendTargetMessage(item)
		w.currentRun().resetThreadContext()
	}

	inChild(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "Auth lives in auth.go."})
	w.settleThreadRun(threadID, false)

	// The parent reads the answer. From here it is committed history.
	before := w.currentRun().buildMessages(nil)
	wireBefore, err := json.Marshal(before)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	// A human picks the child back up and it answers again.
	inChild(ConversationItem{Type: ItemTypeUser, ItemID: "human-1", Content: "who calls it?"})
	inChild(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-2", Content: "The router calls it."})
	w.settleThreadRun(threadID, false)

	after := w.currentRun().buildMessages(nil)
	if len(after) != len(before)+1 {
		t.Fatalf("a resume of an answered call must add exactly one message, got %d against %d:\n%v",
			len(after), len(before), after)
	}
	wirePrefix, err := json.Marshal(after[:len(before)])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(wirePrefix) != string(wireBefore) {
		t.Fatalf("the answer the parent had already read moved:\nbefore %s\nafter  %s", wireBefore, wirePrefix)
	}
	tail := after[len(after)-1]
	if tail["type"] != ItemTypeUser {
		t.Fatalf("the new run must arrive as news, not as a second answer to the same call: %v", tail)
	}
	if c, _ := tail["content"].(string); !strings.Contains(c, "The router calls it.") {
		t.Errorf("the receipt must carry the resumed run's reply, got %q", c)
	}

	// And the parent has a tile for it, pointing at the same thread, settled — it
	// stands for work the parent never asked for, so it must not park anyone.
	items := w.doc.GetItems()
	receipt := items[len(items)-1]
	if receipt.Type != ItemTypeThread || receipt.AliasOf != threadID || receipt.RunItemID != "human-1" {
		t.Fatalf("expected a receipt item selecting the human's run, got %+v", receipt)
	}
	if !itemRunSettled(items, receipt) {
		t.Error("a receipt must read as settled, or the parent parks on work nobody asked it to wait for")
	}

}

// TestReadButUnansweredCallTakesTheRetry is the limit on the receipt rule, and
// the shape a failing child leaves. The parent's turn takes the child's error in
// — stamping runResultFed as it builds the wire — and then dies on an error of
// its own, so it commits nothing: no reply stands on that result, nothing sits
// below it on the wire, and the error item it left says nothing to the provider.
//
// Retrying the child must therefore report to the item still standing for the
// call, not appear beside it. A second tile for one call is the parent reading
// its own failure twice.
//
// The second half is the guard against over-reading that rule: once the parent
// has actually answered, the freeze is real again and the next run gets its own
// item.
func TestReadButUnansweredCallTakesTheRetry(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.ensureItems()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.currentRun().storeState(StateProcessing)

	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "map auth", Prompt: "find the auth flow"}, toolSpawn{
		ToolUseID: "tu-1", ToolName: "Explore", ToolInput: json.RawMessage(`{"prompt":"find the auth flow"}`), Delegated: true,
	})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	inChild := func(item ConversationItem) {
		w.turn.thread.itemID = threadID
		w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
		w.currentRun().appendTargetMessage(item)
		w.currentRun().resetThreadContext()
	}
	inParent := func(item ConversationItem) {
		w.currentRun().resetThreadContext()
		w.currentRun().appendTargetMessage(item)
	}
	sessionItems := func() int {
		n := 0
		for _, it := range w.doc.GetItems() {
			if it.Type == ItemTypeThread && (it.ItemID == threadID || it.AliasOf == threadID) {
				n++
			}
		}
		return n
	}

	// The child stops on an error and the parent reads it — from here the item is
	// stamped as fed — and then the parent's own turn dies on one too.
	inChild(ConversationItem{Type: ItemTypeError, ItemID: "e-1", Content: "invalid request: bad model"})
	w.settleThreadRun(threadID, false)
	before := w.currentRun().buildMessages(nil)
	inParent(ConversationItem{Type: ItemTypeError, ItemID: "pe-1", Content: "invalid request: bad model"})

	// Retrying the child answers the call that is still waiting on it.
	inChild(ConversationItem{Type: ItemTypeUser, ItemID: "human-1", Content: "try again"})
	inChild(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "Auth lives in auth.go."})
	w.settleThreadRun(threadID, false)

	if n := sessionItems(); n != 1 {
		t.Fatalf("a retry of a call nothing answered must report to the item already standing for it, got %d items", n)
	}
	items := w.doc.GetItems()
	var call ConversationItem
	for _, it := range items {
		if it.ItemID == threadID {
			call = it
		}
	}
	if call.RunItemID != "human-1" {
		t.Errorf("the call must report the run it absorbed, selects %q", call.RunItemID)
	}

	after := w.currentRun().buildMessages(nil)
	if len(after) != len(before) {
		t.Fatalf("a retry the parent never answered must cost it no extra message, got %d against %d:\n%v",
			len(after), len(before), after)
	}
	if c, _ := after[len(after)-1]["content"].(string); !strings.Contains(c, "Auth lives in auth.go.") {
		t.Errorf("the call must now answer with the retry's reply, got %q", c)
	}

	// The parent answers this time, so its next read is committed history and the
	// freeze is real: another run gets an item of its own.
	inParent(ConversationItem{Type: ItemTypeAssistant, ItemID: "pa-1", Content: "Right — auth.go it is."})
	inChild(ConversationItem{Type: ItemTypeUser, ItemID: "human-2", Content: "and the tests?"})
	inChild(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-2", Content: "Tests in auth_test.go."})
	w.settleThreadRun(threadID, false)

	if n := sessionItems(); n != 2 {
		t.Fatalf("a run arriving after the parent has answered must get its own item, got %d items", n)
	}
	final := w.doc.GetItems()
	if receipt := final[len(final)-1]; receipt.AliasOf != threadID || receipt.RunItemID != "human-2" {
		t.Errorf("expected a receipt selecting the run the parent has not read, got %+v", receipt)
	}
}

// TestUnreadReceiptCoalescesTheNextRun is the same rule read from the other end.
// A receipt the parent has not read yet is not history, so the next run follows
// it forward instead of stacking a second item — which is what keeps a user who
// sends six prompts into a child from costing the parent six items to read.
func TestUnreadReceiptCoalescesTheNextRun(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.ensureItems()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.currentRun().storeState(StateProcessing)

	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "map auth", Prompt: "find the auth flow"}, toolSpawn{
		ToolUseID: "tu-1", ToolName: "Explore", ToolInput: json.RawMessage(`{"prompt":"find the auth flow"}`), Delegated: true,
	})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	inChild := func(item ConversationItem) {
		w.turn.thread.itemID = threadID
		w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
		w.currentRun().appendTargetMessage(item)
		w.currentRun().resetThreadContext()
	}

	inChild(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "Auth lives in auth.go."})
	w.settleThreadRun(threadID, false)
	answered := w.currentRun().buildMessages(nil) // the parent reads the call's answer

	// Two more runs, with nothing read in between.
	inChild(ConversationItem{Type: ItemTypeUser, ItemID: "human-1", Content: "who calls it?"})
	inChild(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-2", Content: "The router calls it."})
	w.settleThreadRun(threadID, false)
	inChild(ConversationItem{Type: ItemTypeUser, ItemID: "human-2", Content: "and the tests?"})
	inChild(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-3", Content: "Tests in auth_test.go."})
	w.settleThreadRun(threadID, false)

	items := w.doc.GetItems()
	receipts := 0
	for _, it := range items {
		if it.Type == ItemTypeThread && it.RunItemID != "" {
			receipts++
		}
	}
	if receipts != 1 {
		t.Fatalf("two unread runs must leave one receipt, got %d", receipts)
	}
	if last := items[len(items)-1]; last.RunItemID != "human-2" {
		t.Errorf("the receipt must have followed the session to its latest run, selects %q", last.RunItemID)
	}

	got := w.currentRun().buildMessages(nil)
	if len(got) != len(answered)+1 {
		t.Fatalf("two unread runs must cost the parent one message, got %d against %d", len(got), len(answered))
	}
	if c, _ := got[len(got)-1]["content"].(string); !strings.Contains(c, "Tests in auth_test.go.") {
		t.Errorf("the receipt must report the latest run, got %q", c)
	}
}

// TestIdenticalRunGetsNoSecondReceipt is the limit on receipts. A receipt earns
// its place by being news; a run that came out exactly as the run the parent's
// trailing item already shows is not news, and appending it would stand a second
// tile next to the first saying the same words in the same order. A child that
// stalls the same way three times running must cost the parent one item, not
// three.
//
// The second half is the guard against over-reading that rule: an outcome that
// differs at all is still news, and still gets its own item.
func TestIdenticalRunGetsNoSecondReceipt(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.ensureItems()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.currentRun().storeState(StateProcessing)

	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "map auth", Prompt: "find the auth flow"}, toolSpawn{
		ToolUseID: "tu-1", ToolName: "Explore", ToolInput: json.RawMessage(`{"prompt":"find the auth flow"}`), Delegated: true,
	})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	inChild := func(item ConversationItem) {
		w.turn.thread.itemID = threadID
		w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
		w.currentRun().appendTargetMessage(item)
		w.currentRun().resetThreadContext()
	}

	// The call is stopped having produced nothing, and the parent reads that.
	// From here it is committed history.
	w.settleThreadRun(threadID, true)
	w.currentRun().buildMessages(nil)
	before := w.doc.GetItems()

	// A human picks the child back up and it stops the same way again, so this
	// run came out exactly as the one the parent is already reading.
	inChild(ConversationItem{Type: ItemTypeUser, ItemID: "human-1", Content: "keep going"})
	w.settleThreadRun(threadID, true)

	after := w.doc.GetItems()
	if len(after) != len(before) {
		t.Fatalf("a run that came out as the one the parent already reads must add no item, got %d against %d:\n%+v",
			len(after), len(before), after[len(before):])
	}

	// A run that came out differently is still news.
	inChild(ConversationItem{Type: ItemTypeUser, ItemID: "human-2", Content: "and the tests?"})
	inChild(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-2", Content: "Tests in auth_test.go."})
	w.settleThreadRun(threadID, false)

	final := w.doc.GetItems()
	if len(final) != len(before)+1 {
		t.Fatalf("a run with a different outcome must still get its own item, got %d against %d",
			len(final), len(before))
	}
	if receipt := final[len(final)-1]; receipt.AliasOf != threadID || receipt.RunItemID != "human-2" {
		t.Errorf("expected a receipt selecting the run that differed, got %+v", receipt)
	}
}

// TestContinueMovesOnlyTheTrailingSessionItem covers restarting a cancelled
// session with Continue, which has no user message of its own and opens a run on
// a continuation marker instead. The latest parent item follows the session back
// into work, while an earlier item remains a frozen receipt for its own call.
func TestContinueMovesOnlyTheTrailingSessionItem(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.ensureItems()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.currentRun().storeState(StateProcessing)

	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "map auth", Prompt: "find the auth flow"}, toolSpawn{
		ToolUseID: "tu-1", ToolName: "Explore", ToolInput: json.RawMessage(`{"prompt":"find the auth flow"}`), Delegated: true,
	})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	w.currentRun().appendTargetMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "Auth lives in auth.go.",
	})
	w.settleThreadRun(threadID, false)

	w.currentRun().resetThreadContext()
	if err := w.currentRun().resumeSession(threadID, threadSpec{Goal: "trace callers", Prompt: "who calls it?"}, toolSpawn{
		ToolUseID: "tu-2", ToolName: "Explore", ToolInput: json.RawMessage(`{"prompt":"who calls it?"}`), Delegated: true,
	}); err != nil {
		t.Fatalf("resumeSession: %v", err)
	}
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	w.settleThreadRun(threadID, true)

	items := w.doc.GetItems()
	canonical, alias := items[len(items)-2], items[len(items)-1]
	if !itemRunSettled(items, canonical) || !itemRunSettled(items, alias) {
		t.Fatal("both calls must be settled before Continue")
	}
	firstBefore := appendThreadMessages(nil, canonical, items)

	w.currentRun().storeState(StateIdle)
	sendMsg(t, w, SendMessageMessage{ThreadItemID: threadID, IsContinuation: true})

	items = w.doc.GetItems()
	canonical, alias = items[len(items)-2], items[len(items)-1]
	if !itemRunSettled(items, canonical) {
		t.Error("Continue reopened the earlier parent item")
	}
	if itemRunSettled(items, alias) {
		t.Error("the latest parent item stayed settled while its session restarted")
	}
	if got := appendThreadMessages(nil, alias, items); got[1]["content"] != pendingToolResultPlaceholder {
		t.Errorf("latest tool_result = %q, want the pending placeholder", got[1]["content"])
	}
	firstAfter := appendThreadMessages(nil, canonical, items)
	beforeJSON, _ := json.Marshal(firstBefore)
	afterJSON, _ := json.Marshal(firstAfter)
	if string(afterJSON) != string(beforeJSON) {
		t.Errorf("the earlier call moved:\nbefore %s\nafter  %s", beforeJSON, afterJSON)
	}

	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	w.currentRun().appendTargetMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-2", Content: "The router calls it.",
	})
	w.settleThreadRun(threadID, false)

	items = w.doc.GetItems()
	got := appendThreadMessages(nil, items[len(items)-1], items)
	content, _ := got[1]["content"].(string)
	if !strings.Contains(content, "The router calls it.") || strings.Contains(content, runCancelledNote) {
		t.Errorf("continued result = %q, want the new reply without the cancellation", content)
	}
}

// TestContinueAfterTheCallWasAnsweredLeavesItAlone is the gesture the old
// reopen-the-record shape could not survive. Continue used to clear the trailing
// run record to make it look open — and when the parent had already read that
// record's result, clearing it rewrote committed history twice over: back to the
// pending placeholder on the click, then to a different run's answer under the
// same tool_use id when the new run settled.
func TestContinueAfterTheCallWasAnsweredLeavesItAlone(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.ensureItems()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.currentRun().storeState(StateProcessing)

	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "map auth", Prompt: "find the auth flow"}, toolSpawn{
		ToolUseID: "tu-1", ToolName: "Explore", ToolInput: json.RawMessage(`{"prompt":"find the auth flow"}`), Delegated: true,
	})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	inChild := func(item ConversationItem) {
		w.turn.thread.itemID = threadID
		w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
		w.currentRun().appendTargetMessage(item)
		w.currentRun().resetThreadContext()
	}

	inChild(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "Auth lives in auth.go."})
	w.settleThreadRun(threadID, false)

	answered := w.currentRun().buildMessages(nil) // the parent reads the call's answer
	wireBefore := mustJSON(t, answered)

	// Continue, with nothing typed.
	w.currentRun().storeState(StateIdle)
	sendMsg(t, w, SendMessageMessage{ThreadItemID: threadID, IsContinuation: true})
	w.currentRun().resetThreadContext()

	if got := mustJSON(t, w.currentRun().buildMessages(nil)); got != wireBefore {
		t.Fatalf("clicking Continue moved the answer the parent had already read:\nbefore %s\nafter  %s",
			wireBefore, got)
	}

	// The child is working again, on a run of its own.
	child := w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID))
	marker := child[len(child)-1]
	if !marker.Continuation || marker.RunStatus != "" {
		t.Fatalf("Continue must open a run on a marker of its own, got %+v", marker)
	}
	items := w.doc.GetItems()
	if !itemRunSettled(items, items[len(items)-1]) {
		t.Error("a call the parent has already read must stay settled — it must not park on a run the human started")
	}

	// When it answers, that answer is news rather than a correction.
	inChild(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-2", Content: "The router calls it."})
	w.settleThreadRun(threadID, false)

	after := w.currentRun().buildMessages(nil)
	if len(after) != len(answered)+1 {
		t.Fatalf("the continued run must add exactly one message, got %d against %d", len(after), len(answered))
	}
	if got := mustJSON(t, after[:len(answered)]); got != wireBefore {
		t.Fatalf("the continued run rewrote the call's answer:\nbefore %s\nafter  %s", wireBefore, got)
	}
	if c, _ := after[len(after)-1]["content"].(string); !strings.Contains(c, "The router calls it.") {
		t.Errorf("the receipt must carry the continued run's reply, got %q", c)
	}
}

// TestEarlierItemKeepsItsOwnResult is the other half of the rule, and the one
// that keeps the wire stable: only the LAST item referring to a session tracks
// it. A session called twice has two items, and the first is a receipt for the
// first call — a resume that rewrote it would slide every message after it and
// throw away the parent's prompt cache on work the parent did not even ask for.
func TestEarlierItemKeepsItsOwnResult(t *testing.T) {
	run1 := invocation("call_1", "Explore", `{"prompt":"where is auth?"}`, "auth lives in auth.go")
	run1.RunStatus = runStatusRest
	run2 := invocation("call_2", "Explore", `{"prompt":"who calls it?"}`, "the server does")
	run2.RunStatus = runStatusRest

	canonical := withSelector(threadWithRuns("map the auth flow", run1, run2),
		"call_1", "Explore", `{"prompt":"where is auth?"}`)
	alias := aliasOf(canonical, "call_2", "Explore", `{"prompt":"who calls it?"}`)

	before, err := json.Marshal(appendThreadMessages(nil, canonical, []ConversationItem{canonical, alias}))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	// A human resumes the session: a third run, started by no call at all.
	resumed := ConversationItem{Type: ItemTypeUser, ItemID: "human-1", Content: "keep going",
		RunStatus: runStatusRest, RunResult: "and the tests are in auth_test.go"}
	canonical = withSelector(threadWithRuns("map the auth flow", run1, run2, resumed),
		"call_1", "Explore", `{"prompt":"where is auth?"}`)
	alias = aliasOf(canonical, "call_2", "Explore", `{"prompt":"who calls it?"}`)
	siblings := []ConversationItem{canonical, alias}

	after, err := json.Marshal(appendThreadMessages(nil, canonical, siblings))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(after) != string(before) {
		t.Errorf("the first call's pair moved:\nbefore %s\nafter  %s", before, after)
	}

	// The trailing item is the one that tracks the session.
	got := appendThreadMessages(nil, alias, siblings)
	if len(got) != 2 {
		t.Fatalf("expected one pair for the alias, got %+v", got)
	}
	if c, _ := got[1]["content"].(string); !strings.Contains(c, "and the tests are in auth_test.go") {
		t.Errorf("the trailing item must carry the session's current run, got %q", c)
	}
}

// TestTrailingViewKeepsItsOwnCallIdentity pins what the live view borrows and
// what it does not. The outcome comes from the run the transcript is on; the
// tool-use id, the goal and the call number stay the item's own, because it is
// still the parent's view of the call it made — an id that moved would leave the
// model an answer to a question it never asked.
func TestTrailingViewKeepsItsOwnCallIdentity(t *testing.T) {
	run1 := invocation("call_1", "create_thread", `{"prompt":"where is auth?"}`, "auth lives in auth.go")
	run1.RunStatus = runStatusRest
	run2 := invocation("call_2", "create_thread", `{"prompt":"who calls it?"}`, "the server does")
	run2.RunStatus = runStatusRest
	resumed := ConversationItem{Type: ItemTypeUser, ItemID: "human-1", Content: "keep going",
		RunStatus: runStatusRest, RunResult: "the router does, in serve.go"}

	canonical := withSelector(threadWithRuns("map the auth flow", run1, run2, resumed),
		"call_1", "create_thread", `{"prompt":"where is auth?"}`)
	canonical.SessionName = "hunt"
	alias := aliasOf(canonical, "call_2", "create_thread", `{"prompt":"who calls it?"}`)

	got := appendThreadMessages(nil, alias, []ConversationItem{canonical, alias})
	if len(got) != 2 {
		t.Fatalf("expected one pair, got %+v", got)
	}
	if got[0]["toolUseId"] != "call_2" || got[1]["toolUseId"] != "call_2" {
		t.Fatalf("the pair must close the call the item stands for, got %v", got)
	}
	content, _ := got[1]["content"].(string)
	if !strings.HasPrefix(content, sessionPreamble("hunt", 2, runStatusRest)) {
		t.Errorf("the preamble must still describe call 2, got %q", content)
	}
	if !strings.Contains(content, "the router does, in serve.go") {
		t.Errorf("tool_result = %q, want the session's current run", content)
	}
}

// TestTrailingViewWithNoRecordedRun covers a call whose run is recorded nowhere:
// a creation that appended no invocation message (settleThreadRun's orphan run).
// The call still has to be answered, and the thread's own last outcome is a
// better answer than an error about a thread that is standing right there.
func TestTrailingViewWithNoRecordedRun(t *testing.T) {
	run1 := invocation("call_1", "Explore", `{"prompt":"where is auth?"}`, "auth lives in auth.go")
	run1.RunStatus = runStatusRest
	item := withSelector(threadWithRuns("map the auth flow", run1),
		"call_2", "Explore", `{"prompt":"who calls it?"}`)
	siblings := []ConversationItem{item}

	if !itemRunSettled(siblings, item) {
		t.Error("a call standing on a settled transcript reads as waiting — its parent would park forever")
	}
	got := appendThreadMessages(nil, item, siblings)
	if len(got) != 2 || got[0]["toolUseId"] != "call_2" || got[1]["toolUseId"] != "call_2" {
		t.Fatalf("the pair must close the call the item stands for, got %v", got)
	}
	if got[1]["isError"] == true {
		t.Errorf("a thread that is still in the conversation must not be answered as gone: %v", got[1])
	}
	if c, _ := got[1]["content"].(string); !strings.Contains(c, "auth lives in auth.go") {
		t.Errorf("tool_result = %q, want the thread's own last outcome", c)
	}
}
