//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"
)

// threadWithRuns builds a thread item whose nested items are the given
// invocation messages, the way a resumable child accumulates one per call.
func threadWithRuns(goal string, runs ...ConversationItem) ConversationItem {
	nested, err := json.Marshal(runs)
	if err != nil {
		panic(err)
	}
	return ConversationItem{
		Type:   ItemTypeThread,
		ItemID: "thread_1",
		Goal:   goal,
		Items:  nested,
	}
}

// invocation builds one invocation message: a user item stamped with the run
// record for the parent call that appended it.
func invocation(toolUseID, toolName, input, result string) ConversationItem {
	return ConversationItem{
		Type:         ItemTypeUser,
		ItemID:       "item_" + toolUseID,
		Content:      "do the thing",
		RunToolUseID: toolUseID,
		RunToolName:  toolName,
		RunToolInput: json.RawMessage(input),
		RunResult:    result,
	}
}

// withSelector stamps a thread item's run selector: which single run of the
// transcript this item is the parent's view of.
func withSelector(item ConversationItem, toolUseID, toolName, input string) ConversationItem {
	item.RunToolUseID = toolUseID
	item.RunToolName = toolName
	item.RunToolInput = json.RawMessage(input)
	return item
}

// aliasOf builds the parent item a resumed call inserts: a thread item owning no
// transcript, pointing at the canonical, selecting the one run it made.
func aliasOf(canonical ConversationItem, toolUseID, toolName, input string) ConversationItem {
	return withSelector(ConversationItem{
		Type:        ItemTypeThread,
		ItemID:      "alias_" + toolUseID,
		AliasOf:     canonical.ItemID,
		Goal:        canonical.Goal,
		SessionName: canonical.SessionName,
	}, toolUseID, toolName, input)
}

// humanRun builds the record of a run nobody called: a plain user message the
// user typed into a stopped child, stamped with how the run it started settled.
func humanRun(itemID, content, status, result string) ConversationItem {
	return ConversationItem{
		Type:      ItemTypeUser,
		ItemID:    itemID,
		Content:   content,
		RunStatus: status,
		RunResult: result,
	}
}

// receiptOf builds the parent item a human-started run reports to: a thread item
// owning no transcript, pointing at the canonical, selecting its run by the
// message that started it.
func receiptOf(canonical ConversationItem, runItemID string) ConversationItem {
	return ConversationItem{
		Type:        ItemTypeThread,
		ItemID:      "receipt_" + runItemID,
		AliasOf:     canonical.ItemID,
		Goal:        canonical.Goal,
		SessionName: canonical.SessionName,
		RunItemID:   runItemID,
	}
}

// TestReceiptEmitsOneUserMessage pins the shape of a run the parent never asked
// for. It is reported as a single user-role message, not as a tool_use/
// tool_result pair: no call was made, and minting one would have the wire claim
// the model chose to re-run the thread. On claudecode that claim is also fatal —
// the CLI's own transcript has no such call for the result to answer, so the
// warm append refuses and every resume cold-starts.
func TestReceiptEmitsOneUserMessage(t *testing.T) {
	canonical := withSelector(threadWithRuns("map the auth flow",
		invocation("call_1", "Explore", `{"prompt":"find it"}`, "auth lives in auth.go"),
		humanRun("human_1", "and the tests?", runStatusRest, "tests in auth_test.go")),
		"call_1", "Explore", `{"prompt":"find it"}`)
	canonical.SessionName = "hunt"
	receipt := receiptOf(canonical, "human_1")
	siblings := []ConversationItem{canonical, receipt}

	got := appendThreadMessages(nil, receipt, siblings)
	if len(got) != 1 {
		t.Fatalf("a receipt must emit exactly one message, got %d: %v", len(got), got)
	}
	if got[0]["type"] != ItemTypeUser {
		t.Errorf("a receipt must report as user-role, got %v", got[0]["type"])
	}
	if got[0]["toolUseId"] != nil {
		t.Errorf("a receipt must claim no call, got %v", got[0])
	}
	content, _ := got[0]["content"].(string)
	if !strings.HasPrefix(content, "hunt · continued in the thread") {
		t.Errorf("a receipt must name the session and say nobody called it, got %q", content)
	}
	if !strings.Contains(content, "tests in auth_test.go") {
		t.Errorf("a receipt must carry its own run's reply, got %q", content)
	}

	// The canonical still answers for its own call alone: the human's run is the
	// receipt's business, and the call above it is committed history.
	gotCanonical := appendThreadMessages(nil, canonical, siblings)
	if len(gotCanonical) != 2 || gotCanonical[1]["toolUseId"] != "call_1" {
		t.Fatalf("the canonical must still emit its own pair alone, got %v", gotCanonical)
	}
	if c, _ := gotCanonical[1]["content"].(string); !strings.Contains(c, "auth lives in auth.go") {
		t.Errorf("the canonical's answer moved: %q", c)
	}
}

// TestReceiptWithoutItsRecordStillEmitsOneMessage guards the count, which is what
// the prompt cache is sensitive to. A run record that has been edited away leaves
// the receipt with nothing to report, and it must say so in one message rather
// than emit none and slide everything after it.
func TestReceiptWithoutItsRecordStillEmitsOneMessage(t *testing.T) {
	canonical := withSelector(threadWithRuns("map the auth flow",
		invocation("call_1", "Explore", `{"prompt":"find it"}`, "auth lives in auth.go")),
		"call_1", "Explore", `{"prompt":"find it"}`)
	orphan := receiptOf(canonical, "human_gone")

	got := appendThreadMessages(nil, orphan, []ConversationItem{canonical, orphan})
	if len(got) != 1 || got[0]["type"] != ItemTypeUser {
		t.Fatalf("a receipt whose record is gone must still emit one user message, got %v", got)
	}
	if c, _ := got[0]["content"].(string); !strings.Contains(c, "no longer in the conversation") {
		t.Errorf("it must say the reply is gone rather than invent one, got %q", c)
	}
}

// TestReceiptAppendsToParentWire is the point of the receipt: a run the parent
// never asked for lands at the END of its history, leaving the answer it has
// already read exactly where it was.
func TestReceiptAppendsToParentWire(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	run1 := invocation("call_1", "create_thread", `{"prompt":"where is auth?"}`, "auth lives in auth.go")
	canonical := withSelector(threadWithRuns("map the auth flow", run1),
		"call_1", "create_thread", `{"prompt":"where is auth?"}`)
	canonical.SessionName = "hunt"

	opening := []ConversationItem{
		{Type: ItemTypeUser, ItemID: "u_1", Content: "Investigate auth"},
		canonical,
		{Type: ItemTypeAssistant, ItemID: "a_1", Content: "It is in auth.go."},
	}
	before := w.buildMessagesFromItems(opening, false)
	wireBefore, err := json.Marshal(before)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	// The user types into the stopped child; that run settles.
	resumed := withSelector(threadWithRuns("map the auth flow", run1,
		humanRun("human_1", "who calls it?", runStatusRest, "the server does")),
		"call_1", "create_thread", `{"prompt":"where is auth?"}`)
	resumed.SessionName = "hunt"

	after := append(append([]ConversationItem{}, opening...), receiptOf(resumed, "human_1"))
	after[1] = resumed

	got := w.buildMessagesFromItems(after, false)
	if len(got) != len(before)+1 {
		t.Fatalf("a human resume must add exactly one message, got %d against %d", len(got), len(before))
	}
	wirePrefix, err := json.Marshal(got[:len(before)])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(wirePrefix) != string(wireBefore) {
		t.Fatalf("a human resume moved the committed prefix:\nbefore %s\nafter  %s", wireBefore, wirePrefix)
	}
	tail := got[len(got)-1]
	if tail["type"] != ItemTypeUser {
		t.Fatalf("the resume must close the history as a user message, got %v", tail)
	}
	if c, _ := tail["content"].(string); !strings.Contains(c, "the server does") {
		t.Errorf("the receipt must carry the resumed run's reply, got %q", c)
	}
}

// TestCreateThreadStampsRunRecordOnInvocationMessage pins where the tool-use
// coordinates live. They must ride on the invocation message — the user item
// this creation appends — and NOT on the thread Y.Map, which is scalar and so
// could only ever describe one invocation. This is the structural precondition
// for resuming a thread: a second call appends a second stamped message rather
// than overwriting the first pairing.
func TestCreateThreadStampsRunRecordOnInvocationMessage(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.ensureItems()
	w.currentRun().storeState(StateProcessing)

	input := json.RawMessage(`{"prompt":"find the auth flow"}`)
	threadID, err := w.currentRun().spawnThread(threadSpec{
		Goal:   "map auth",
		Prompt: "find the auth flow",
	}, toolSpawn{
		ToolUseID: "tu-1",
		ToolName:  "Explore",
		ToolInput: input,
		Delegated: true,
	})
	if err != nil {
		t.Fatalf("createThread: %v", err)
	}

	// The thread Y.Map must NOT carry the coordinates.
	ym := w.doc.GetThreadYMap(threadID)
	if ym == nil {
		t.Fatal("thread Y.Map missing")
	}
	if id, _ := ym.Get("toolUseId").(string); id != "" {
		t.Errorf("thread Y.Map still carries toolUseId %q — the scalar stamp is what made a thread single-use", id)
	}
	// It carries a run SELECTOR instead: this item is the parent's view of the
	// one run the invocation message below starts, and a later call appends its
	// own alias item rather than piling a second pairing onto this one.
	if id, _ := ym.Get("runToolUseId").(string); id != "tu-1" {
		t.Errorf("thread Y.Map run selector = %q, want tu-1", id)
	}

	// The invocation message must.
	items := w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID))
	if len(items) == 0 {
		t.Fatal("child thread has no items")
	}
	last := items[len(items)-1]
	if last.Type != ItemTypeUser {
		t.Fatalf("last child item = %q, want the invocation message", last.Type)
	}
	if last.RunToolUseID != "tu-1" || last.RunToolName != "Explore" {
		t.Errorf("invocation message run record = %q/%q, want tu-1/Explore", last.RunToolUseID, last.RunToolName)
	}
	if !strings.Contains(string(last.RunToolInput), "find the auth flow") {
		t.Errorf("invocation message must replay the call's input, got %s", last.RunToolInput)
	}
	// And the ordinary tool-action keys must stay clear: a good deal of code
	// treats the mere presence of toolUseId as "this item IS a tool call".
	if last.ToolUseID != "" || last.ToolName != "" {
		t.Errorf("invocation message must not masquerade as a tool-action (toolUseId=%q toolName=%q)",
			last.ToolUseID, last.ToolName)
	}
}

// TestAppendThreadMessages_PairsPerRun pins the resumption contract on the wire:
// a thread invoked N times owes its parent N tool_use/tool_result pairs, in
// call order, each result paired to the call that produced it. One pair per
// thread — the old scalar stamping — would strand every call after the first
// with a tool_use the provider rejects as unanswered.
func TestAppendThreadMessages_PairsPerRun(t *testing.T) {
	item := threadWithRuns("map the auth flow",
		invocation("call_1", "Explore", `{"prompt":"find it"}`, "auth lives in auth.go"),
		invocation("call_2", "Explore", `{"prompt":"and the tests?"}`, "tests in auth_test.go"),
	)

	got := appendThreadMessages(nil, item, nil)

	if len(got) != 4 {
		t.Fatalf("two invocations must render two tool_use/tool_result pairs (4 messages), got %d: %v", len(got), got)
	}
	wantOrder := []struct{ typ, id string }{
		{"tool-use", "call_1"}, {"tool-result", "call_1"},
		{"tool-use", "call_2"}, {"tool-result", "call_2"},
	}
	for i, want := range wantOrder {
		if got[i]["type"] != want.typ || got[i]["toolUseId"] != want.id {
			t.Fatalf("message %d = %v/%v, want %s/%s — each run's result must pair with its own call, in call order",
				i, got[i]["type"], got[i]["toolUseId"], want.typ, want.id)
		}
	}
	// Each result carries its own run's text, not the thread's latest.
	if c, _ := got[1]["content"].(string); !strings.Contains(c, "auth lives in auth.go") {
		t.Errorf("first run's tool_result must carry its own result, got %q", c)
	}
	if c, _ := got[3]["content"].(string); !strings.Contains(c, "tests in auth_test.go") {
		t.Errorf("second run's tool_result must carry its own result, got %q", c)
	}
}

// TestResumedCallAppendsToParentWire is the test the alias model exists for. A
// call into a session the parent has already called must land at the END of the
// parent's wire history — where the turn that made it stands — not back at the
// thread item the FIRST call created.
//
// Emitting run 2's pair at the thread's original position would bury the answer
// to the question the latest turn just asked in the middle of that turn's own
// past, and slide every message after it by two: a full prompt-cache miss for
// stateless providers, and a torn-down, cold-started CLI for claudecode, on
// every single resume.
func TestResumedCallAppendsToParentWire(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	run1 := invocation("call_1", "create_thread", `{"prompt":"where is auth?"}`, "auth lives in auth.go")
	canonical := withSelector(threadWithRuns("map the auth flow", run1),
		"call_1", "create_thread", `{"prompt":"where is auth?"}`)
	canonical.SessionName = "hunt"

	opening := []ConversationItem{
		{Type: ItemTypeUser, ItemID: "u_1", Content: "Investigate auth"},
		canonical,
		{Type: ItemTypeAssistant, ItemID: "a_1", Content: "It is in auth.go."},
		{Type: ItemTypeUser, ItemID: "u_2", Content: "Who calls it?"},
	}
	before := w.buildMessagesFromItems(opening, false)
	wireBefore, err := json.Marshal(before)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	// The second call: run 2 appended to the child's transcript, one alias item
	// appended to the parent where the call was made.
	resumed := withSelector(threadWithRuns("map the auth flow", run1,
		invocation("call_2", "create_thread", `{"prompt":"who calls it?"}`, "the server does")),
		"call_1", "create_thread", `{"prompt":"where is auth?"}`)
	resumed.SessionName = "hunt"

	after := append(append([]ConversationItem{}, opening...), ConversationItem{})
	after[1] = resumed
	after[len(after)-1] = aliasOf(resumed, "call_2", "create_thread", `{"prompt":"who calls it?"}`)

	got := w.buildMessagesFromItems(after, false)
	if len(got) != len(before)+2 {
		t.Fatalf("a resume must add exactly one pair, got %d messages against %d", len(got), len(before))
	}
	wirePrefix, err := json.Marshal(got[:len(before)])
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(wirePrefix) != string(wireBefore) {
		t.Fatalf("a resume moved the committed prefix:\nbefore %s\nafter  %s", wireBefore, wirePrefix)
	}

	// And the new pair is the LAST thing on the wire — the answer to the turn
	// that asked for it.
	tail := got[len(got)-2:]
	if tail[0]["type"] != "tool-use" || tail[0]["toolUseId"] != "call_2" ||
		tail[1]["type"] != "tool-result" || tail[1]["toolUseId"] != "call_2" {
		t.Fatalf("run 2's pair must close the history, got %v", tail)
	}
	if c, _ := tail[1]["content"].(string); !strings.HasPrefix(c, "hunt · resumed, call 2") ||
		!strings.Contains(c, "the server does") {
		t.Errorf("the alias must answer with its own run under the resumed preamble, got %q", c)
	}
}

// TestAliasAndCanonicalEmitOneRunEach pins the one-item-per-call rule from the
// other side: neither tile may emit the other's call, or the parent would see
// the same tool_use twice.
func TestAliasAndCanonicalEmitOneRunEach(t *testing.T) {
	canonical := withSelector(threadWithRuns("map the auth flow",
		invocation("call_1", "Explore", `{"prompt":"find it"}`, "auth lives in auth.go"),
		invocation("call_2", "Explore", `{"prompt":"and the tests?"}`, "tests in auth_test.go")),
		"call_1", "Explore", `{"prompt":"find it"}`)
	alias := aliasOf(canonical, "call_2", "Explore", `{"prompt":"and the tests?"}`)
	siblings := []ConversationItem{canonical, alias}

	gotCanonical := appendThreadMessages(nil, canonical, siblings)
	if len(gotCanonical) != 2 || gotCanonical[0]["toolUseId"] != "call_1" || gotCanonical[1]["toolUseId"] != "call_1" {
		t.Fatalf("the canonical must emit its own run alone, got %v", gotCanonical)
	}
	gotAlias := appendThreadMessages(nil, alias, siblings)
	if len(gotAlias) != 2 || gotAlias[0]["toolUseId"] != "call_2" || gotAlias[1]["toolUseId"] != "call_2" {
		t.Fatalf("the alias must emit its own run alone, got %v", gotAlias)
	}
	if c, _ := gotAlias[1]["content"].(string); !strings.Contains(c, "tests in auth_test.go") {
		t.Errorf("the alias must carry ITS run's result, got %q", c)
	}
}

// TestPromotedReceiptReadsItsOwnTranscript covers the shape deleting a thread
// leaves behind when the only other item viewing it is a receipt: the receipt
// takes the transcript on and stops pointing anywhere (promoteThreadView). It
// still reports as a receipt — no call was ever made for it — but the run it
// names is now in its OWN items, so resolving it by following aliasOf would find
// nothing and tell the model the reply was gone while it sits right there.
func TestPromotedReceiptReadsItsOwnTranscript(t *testing.T) {
	promoted := threadWithRuns("map the auth flow",
		invocation("call_1", "Explore", `{"prompt":"find it"}`, "auth lives in auth.go"),
		humanRun("human_1", "and the tests?", runStatusRest, "tests in auth_test.go"))
	promoted.ItemID = "receipt_human_1"
	promoted.SessionName = "hunt"
	promoted.RunItemID = "human_1"

	got := appendThreadMessages(nil, promoted, []ConversationItem{promoted})
	if len(got) != 1 {
		t.Fatalf("a promoted receipt must still emit exactly one message, got %d: %v", len(got), got)
	}
	if got[0]["type"] != ItemTypeUser {
		t.Errorf("a promoted receipt must report as user-role, got %v", got[0]["type"])
	}
	c, _ := got[0]["content"].(string)
	if !strings.Contains(c, "tests in auth_test.go") {
		t.Errorf("a promoted receipt must report the run it names from its own transcript, got %q", c)
	}
}

// TestUnresolvableAliasIsAnswered guards the wire's one hard rule. An alias whose
// thread has been deleted still stands for a call the model made, and a
// tool_use no result closes is invalid — so the call is answered honestly rather
// than left dangling or answered with a placeholder waited on forever.
func TestUnresolvableAliasIsAnswered(t *testing.T) {
	canonical := withSelector(threadWithRuns("map the auth flow",
		invocation("call_1", "Explore", `{"prompt":"find it"}`, "auth lives in auth.go")),
		"call_1", "Explore", `{"prompt":"find it"}`)
	orphan := aliasOf(canonical, "call_2", "Explore", `{"prompt":"and the tests?"}`)

	got := appendThreadMessages(nil, orphan, []ConversationItem{orphan})
	if len(got) != 2 || got[0]["type"] != "tool-use" || got[1]["type"] != "tool-result" {
		t.Fatalf("an orphaned alias must still render a closed pair, got %v", got)
	}
	if got[0]["toolUseId"] != "call_2" || got[1]["toolUseId"] != "call_2" {
		t.Fatalf("the pair must close the call the alias stands for, got %v", got)
	}
	if got[1]["isError"] != true {
		t.Errorf("a call whose thread is gone must be answered as an error, got %v", got[1])
	}
	if !itemRunSettled([]ConversationItem{orphan}, orphan) {
		t.Error("an orphaned alias must read as settled, or the parent parks on it forever")
	}
}

// TestThreadWithoutSelectorEmitsEveryRun pins the shape every document written
// before aliases uses: one parent item for all its calls, so that item is the
// only place the parent can see them.
func TestThreadWithoutSelectorEmitsEveryRun(t *testing.T) {
	item := threadWithRuns("map the auth flow",
		invocation("call_1", "Explore", `{"prompt":"one"}`, "first"),
		invocation("call_2", "Explore", `{"prompt":"two"}`, "second"),
		invocation("call_3", "Explore", `{"prompt":"three"}`, "third"),
	)
	got := appendThreadMessages(nil, item, []ConversationItem{item})
	if len(got) != 6 {
		t.Fatalf("three runs on a selectorless thread must render three pairs, got %d: %v", len(got), got)
	}
	for i, id := range []string{"call_1", "call_1", "call_2", "call_2", "call_3", "call_3"} {
		if got[i]["toolUseId"] != id {
			t.Fatalf("message %d = %v, want %s", i, got[i]["toolUseId"], id)
		}
	}
}

// TestCanonicalCompactionRecordsAcrossAlias pins the canonicalizer's index
// alignment: exactly one record per item, alias included, since recovery slices
// those records by item index.
func TestCanonicalCompactionRecordsAcrossAlias(t *testing.T) {
	canonical := withSelector(threadWithRuns("map the auth flow",
		invocation("call_1", "Explore", `{"prompt":"find it"}`, "auth lives in auth.go"),
		invocation("call_2", "Explore", `{"prompt":"and the tests?"}`, "tests in auth_test.go")),
		"call_1", "Explore", `{"prompt":"find it"}`)
	items := []ConversationItem{
		{Type: ItemTypeUser, ItemID: "u_1", Content: "Investigate auth"},
		canonical,
		{Type: ItemTypeAssistant, ItemID: "a_1", Content: "It is in auth.go."},
		aliasOf(canonical, "call_2", "Explore", `{"prompt":"and the tests?"}`),
	}

	records, err := canonicalCompactionRecords(items, "")
	if err != nil {
		t.Fatalf("canonicalCompactionRecords: %v", err)
	}
	if len(records) != len(items) {
		t.Fatalf("one record per item, got %d for %d items", len(records), len(items))
	}
	if !strings.Contains(records[3], "call_2") {
		t.Errorf("the alias's record must carry its own run, got %s", records[3])
	}
	if strings.Contains(records[1], "call_2") {
		t.Errorf("the canonical's record must not carry the alias's run, got %s", records[1])
	}
}

// TestAppendThreadMessages_RunInFlightKeepsPairCount guards the same prompt-cache
// property as the legacy test below, now per run: a run that has not recorded a
// result yet still renders a placeholder tool_result, so the message count never
// changes when the result lands.
func TestAppendThreadMessages_RunInFlightKeepsPairCount(t *testing.T) {
	inFlight := threadWithRuns("map the auth flow",
		invocation("call_1", "Explore", `{"prompt":"find it"}`, ""),
	)
	settled := threadWithRuns("map the auth flow",
		invocation("call_1", "Explore", `{"prompt":"find it"}`, "auth lives in auth.go"),
	)

	gotInFlight := appendThreadMessages(nil, inFlight, nil)
	gotSettled := appendThreadMessages(nil, settled, nil)

	if len(gotInFlight) != 2 || len(gotSettled) != 2 {
		t.Fatalf("a run must render exactly one pair either way, got in-flight=%d settled=%d",
			len(gotInFlight), len(gotSettled))
	}
	if gotInFlight[1]["isError"] != true {
		t.Errorf("an unsettled run must render the pending placeholder result, got %v", gotInFlight[1])
	}
}

// TestResultFedStampMarksTheAnswerNotTheTurn pins the discriminator the whole
// receipt model rests on: an item is stamped when its REAL result reaches the
// provider, never when the pending placeholder does.
//
// The distinction is invisible from the transcript. A parent builds requests
// while its child is still running — a turn that called create_thread alongside
// another tool, auto-continue racing ahead, an interjection — so "a later item
// exists" proves a turn happened, not that an answer was delivered. Stamping on
// the placeholder would freeze an item nobody has been told the answer to, and
// the run's real result would then be reported twice: once by the frozen item,
// once by the receipt appended for it.
func TestResultFedStampMarksTheAnswerNotTheTurn(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.ensureItems()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.currentRun().storeState(StateProcessing)

	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "map auth", Prompt: "find the auth flow"}, toolSpawn{
		ToolUseID: "tu-1", ToolName: "Explore", ToolInput: json.RawMessage(`{"prompt":"find the auth flow"}`), Delegated: true,
	})
	if err != nil {
		t.Fatalf("createThread: %v", err)
	}
	fed := func() bool {
		for _, it := range w.doc.GetItems() {
			if it.ItemID == threadID {
				return it.RunResultFed
			}
		}
		t.Fatal("thread item gone")
		return false
	}

	// A build while the run is in flight emits the placeholder — the caller is
	// parked, and nothing has been answered.
	w.currentRun().resetThreadContext()
	if msgs := w.currentRun().buildMessages(nil); msgs[len(msgs)-1]["content"] != pendingToolResultPlaceholder {
		t.Fatalf("expected the pending placeholder while the run is in flight, got %v", msgs[len(msgs)-1])
	}
	if fed() {
		t.Error("the placeholder stamped the item as answered — a later resume would then append a duplicate of the same run")
	}

	// The run settles and the next build carries its result.
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	w.currentRun().appendTargetMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "Auth lives in auth.go.",
	})
	w.settleThreadRun(threadID, false)
	w.currentRun().resetThreadContext()

	// A snapshot build renders the same messages and writes nothing: only the
	// live turn may record what the provider has seen.
	if msgs := w.buildMessagesFromItems(w.doc.GetItems(), false); len(msgs) == 0 {
		t.Fatal("snapshot build emitted nothing")
	}
	if fed() {
		t.Error("a snapshot build stamped the item — compaction and tests must not record deliveries")
	}

	if msgs := w.currentRun().buildMessages(nil); !strings.Contains(msgs[len(msgs)-1]["content"].(string), "Auth lives in auth.go.") {
		t.Fatalf("expected the run's result on the wire, got %v", msgs[len(msgs)-1])
	}
	if !fed() {
		t.Error("the item's real result went to the provider unstamped — a later resume would rewrite it in place")
	}
}

// TestAppendThreadMessages_StableWireShapeAcrossCompletion is the guard for the
// claudecode cache-miss regression: a delegated-tool thread (e.g. query_code)
// must render the SAME wire shape — a tool_use + tool_result pair — whether its
// sub-thread result has landed yet or not.
//
// It doubles as the legacy-document fixture: this thread carries its
// coordinates on the thread item itself, the way every document written before
// run records existed does, and must still reconstruct its single pair.
//
// The old projection emitted ONLY the tool_use while pending and appended the
// tool_result later, so the message COUNT jumped 1→2 the moment the result
// arrived. That extra block slid every subsequent message down one slot, and a
// stateful provider (claudecode --resume) sees the committed prefix change and
// cold-starts the whole conversation — a full prompt-cache miss on every turn a
// thread completes. Stable count → the prefix stays byte-identical, cache warm.
func TestAppendThreadMessages_StableWireShapeAcrossCompletion(t *testing.T) {
	base := ConversationItem{
		Type:      ItemTypeThread,
		ItemID:    "thread_1",
		ToolUseID: "call_1",
		ToolName:  "query_code",
		ToolInput: json.RawMessage(`{"goal":"map the auth flow"}`),
		Goal:      "map the auth flow",
	}
	pending := base // Result unset → sub-thread still running
	completed := base
	completed.Result = json.RawMessage(`"the auth flow lives in auth.go"`)

	gotPending := appendThreadMessages(nil, pending, nil)
	gotComplete := appendThreadMessages(nil, completed, nil)

	if len(gotPending) != len(gotComplete) {
		t.Fatalf("thread wire shape must be stable across completion, but pending=%d and complete=%d messages — the count change shifts the prefix and busts the prompt cache",
			len(gotPending), len(gotComplete))
	}
	if len(gotPending) != 2 {
		t.Fatalf("a tool-bearing thread must render tool_use+tool_result (2 messages), got %d", len(gotPending))
	}
	if gotPending[0]["type"] != "tool-use" || gotPending[1]["type"] != "tool-result" {
		t.Fatalf("pending thread must render tool_use then tool_result, got %v + %v",
			gotPending[0]["type"], gotPending[1]["type"])
	}
	// No dangling tool_use: the pending tool_result must close the same call.
	if gotPending[1]["toolUseId"] != "call_1" {
		t.Fatalf("pending tool_result must reference toolUseId call_1, got %v", gotPending[1]["toolUseId"])
	}
	if gotComplete[0]["toolUseId"] != "call_1" || gotComplete[1]["toolUseId"] != "call_1" {
		t.Fatalf("completed pair must both reference call_1, got %v / %v",
			gotComplete[0]["toolUseId"], gotComplete[1]["toolUseId"])
	}

	// The tool_use block itself must be byte-identical across the transition (only
	// the tool_result content may flip pending→real), so the tool_use never
	// contributes a divergence of its own.
	if gotPending[0]["toolName"] != gotComplete[0]["toolName"] {
		t.Fatalf("tool_use block must be stable across completion")
	}
}
