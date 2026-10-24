//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"juggler/cmd/juggler/providers/provider"

	ycrdt "github.com/skyterra/y-crdt"
)

// A thread is a sequence of RUNS over one accumulating transcript. A run is one
// message appended to the thread, the tool loop that message drives, and the
// rest at the end of it: many LLM calls, one outcome. The message that starts a
// run carries that run's record — runStatus/runResult once it settles, plus the
// parent's tool-use coordinates when the run was started by a delegating call.
//
// The record is what tells every decider "is this child finished?". The thread's
// `result` field cannot answer that: it is the thread's current SUMMARY, which
// survives across runs, so a thread that has run five times and is about to run
// a sixth carries a result and is not finished. Per-run state has to live per
// run.
//
// The question is asked per CALL, not per thread: a caller parks on the run it
// started (itemRunSettled), because a session resumed by somebody else's later
// call is finished as far as the earlier call is concerned. The parent names the
// run it means with a selector on its own item — the same coordinates, read from
// the other end (ConversationItem.AliasOf).
//
// The LAST of the parent's items referring to a session is the exception, and
// tracks the session rather than one run of it (isTrailingViewOf). Nothing else
// stands for a run a human started by typing into a stopped child: that run has
// no invocation message and no call behind it, so the item still waiting on the
// thread is the only place it can report. Everything above it stays frozen,
// which is what keeps the committed wire from moving.
//
// The outcome is stored rather than re-derived because a run's trailing items
// are user-editable and deletable: the wire must still reconstruct a stable
// tool_use/tool_result pair for a run whose transcript has since been edited.
const (
	// runStatusRest — the run came to rest on clean trailing assistant text.
	runStatusRest = "rest"
	// runStatusError — the run stopped on an error item.
	runStatusError = "error"
	// runStatusCancelled — the run was cancelled or interrupted. Also written
	// browser-side (conversation.js) when a stop settles a thread the worker is
	// not currently driving; keep the two spellings in step.
	runStatusCancelled = "cancelled"
	// runStatusBarren — the run settled with nothing clean to return.
	runStatusBarren = "barren"
)

const (
	// runCancelledNote is the run result for a cancelled run, appended to
	// whatever the run had produced by then.
	runCancelledNote = "[The run was cancelled before it finished.]"
	// runBarrenNote is the run result for a run that settled without a reply.
	runBarrenNote = "The run ended without producing a reply."
	// runTransientErrorNote is appended to a run that stopped on a provider
	// failure a fresh attempt usually clears (FailureKind.Transient) — one that says
	// nothing about the task itself, which the caller would otherwise have no
	// way to tell from the bare transport error.
	runTransientErrorNote = "[The model provider failed during this run; this is not an answer to the task. The worker's own retries were used up. Calling the tool again may well succeed.]"
)

// The cap on what one run hands back to whoever called it is a share of the
// CALLER's context window (runResultCharBudget).
//
// A sub-thread's whole economy is that its working context costs the caller
// nothing and only its answer is charged — and the answer was the one part
// nobody bounded. resultSpec asks a model for a shape; it does not enforce one,
// and a child that decides to return its notes returns all of them.
//
// The floor is measured against what runs actually return rather than picked
// round: across the settled runs on this machine the median is ~15k characters
// and the 80th percentile ~22k, so it sits just above the ordinary range. It is
// an outlier guard, deliberately not a redefinition of what a report may be —
// trimming the median report would push callers into asking again for what was
// cut, which costs more than it saves.
//
// The fraction is what the floor is to a 200k-token window, so a caller of that
// size is bounded exactly by the floor and a larger one gets proportionally
// more: an outlier is judged against the room the caller actually has. The
// ceiling and the chars-per-token figure mirror the browser's per-tool-result
// budget (Conversation#truncationBudget), and for the same reason — an
// implausible window figure cannot turn one result into the whole request.
const (
	runResultFloorChars     = 24_000
	runResultCeilingChars   = 200_000
	runResultWindowFraction = 0.03
	runResultCharsPerToken  = 4
)

// runResultCharBudget is the cap for a run whose caller's model has a context
// window of windowTokens. A non-positive window is unknown and gets the floor.
func runResultCharBudget(windowTokens int) int {
	if windowTokens <= 0 {
		return runResultFloorChars
	}
	scaled := int(float64(windowTokens) * runResultCharsPerToken * runResultWindowFraction)
	return min(runResultCeilingChars, max(runResultFloorChars, scaled))
}

// runResultBudgetFor is the cap for a run of threadItemID, sized by the window
// of the model that reads the result: the parent thread's, or the
// conversation's for a top-level thread. The child's own model is irrelevant —
// the result is spent in the caller's context, not its own. Takes ycrdtMu, so
// callers must hold nothing.
func (w *ConversationWorker) runResultBudgetFor(threadItemID string) int {
	resolve := w.deps().windowResolver
	if resolve == nil {
		return runResultFloorChars
	}
	mc := w.doc.ResolveEffectiveModelConfig(w.doc.ParentThreadID(threadItemID))
	if mc == nil {
		return runResultFloorChars
	}
	return runResultCharBudget(resolve(*mc).WindowTokens)
}

// runResultTrimmedMarker opens the note left in place of what was cut. Kept as
// its own constant because a trimmed result has to be RECOGNISABLE as trimmed:
// the parent model reads it, and the tests match on it.
const runResultTrimmedMarker = "[result truncated:"

// runResultTrimNote is what stands where the rest of the result was. It names
// how much was kept of how much there was, so the model can judge whether it is
// missing anything it needs, and says where the whole thing still is — nothing
// is destroyed by the trim, the child's transcript keeps every word and the
// session can be called again for more.
func runResultTrimNote(kept, total int) string {
	return fmt.Sprintf("\n\n… %s %d of %d characters shown. "+
		"The full text stands in this thread's own transcript; call the session again "+
		"if you need more of it.]", runResultTrimmedMarker, kept, total)
}

// capRunResult trims one run result to limit characters, note included, and
// reports the untrimmed length in characters — 0 when nothing was cut.
//
// Everything here counts characters (runes), never bytes: the note tells the
// model "N of M characters", and a cap in bytes would both overstate those
// figures and cut accented or non-Latin prose short of the budget it names.
//
// The note is sized before the cut and written after it, so the returned string
// honours the cap rather than overshooting it by however long the note turned
// out to be: the note's length depends only on the two counts it names, and the
// count it is finally written with is never larger than the one it was sized
// with.
//
// The START is what survives. A report is written top-down — answer first, then
// the working — so a head is the useful half; it is also the half a truncated
// tail would have thrown away in favour of text the reader had already seen.
func capRunResult(text string, limit int) (capped string, fullChars int) {
	total := utf8.RuneCountInString(text)
	if total <= limit {
		return text, 0
	}
	kept := trimToBoundary(text, limit-utf8.RuneCountInString(runResultTrimNote(limit, total)))
	return kept + runResultTrimNote(utf8.RuneCountInString(kept), total), total
}

// trimToBoundary cuts text to at most n characters, landing on a line break
// when one stands near the cut. Cutting at a character never splits a rune, so
// the provider is never handed invalid UTF-8; a cut mid-line hands the model
// half a sentence it may try to complete.
func trimToBoundary(text string, n int) string {
	if n <= 0 {
		return ""
	}
	cut, chars := len(text), 0
	for off := range text {
		if chars == n {
			cut = off
			break
		}
		chars++
	}
	if cut == len(text) {
		return text
	}
	// Only a nearby line break is worth taking: a distant one would discard
	// content to tidy the edge.
	if nl := strings.LastIndexByte(text[:cut], '\n'); nl > cut-2000 {
		cut = nl
	}
	return text[:cut]
}

// isInvocationMessage reports whether an item is the message that started a
// delegated run: a user message stamped with the calling tool's coordinates.
//
// The type is part of the test. A thread item carries the same three
// coordinates to mean its run SELECTOR (which run of that thread this item is
// the parent's view of — see ConversationItem.AliasOf), and a child thread
// standing in a transcript is not a call made into the transcript holding it.
func isInvocationMessage(it ConversationItem) bool {
	return it.Type == ItemTypeUser && it.RunToolUseID != ""
}

// lastInvocationIndex returns the position of a thread's most recent invocation
// message, or -1 when it has none.
//
// That message is the one item a compaction fold may not take (both fold paths
// pin it). Everything about the thread's current state is read off it: the
// settling run's outcome is stamped there (openRunStarterLocked), and both
// runSettlement and its live-CRDT twin decide "is this child finished?" by
// walking back to it. Fold it away and a run in flight would never settle, and
// a session whose runs have only ever errored would read as busy forever —
// refusing the resume the whole feature exists for.
//
// Earlier invocation messages carry no such live state. Their records are
// copied onto the fold that swallows them (foldedRunsIn), so folding one costs
// the transcript nothing, and the run bodies between them — which is what a
// long-lived session actually needs compacted — fold as one contiguous stretch
// rather than one stranded slice per call.
func lastInvocationIndex(items []ConversationItem) int {
	for i := len(items) - 1; i >= 0; i-- {
		if isInvocationMessage(items[i]) {
			return i
		}
	}
	return -1
}

// foldedRunsIn collects the run records a fold about to replace items must
// carry forward, in the order they stand in the transcript: each invocation
// message's own record, and every record an earlier fold in the range is
// already carrying.
//
// Reading the earlier fold's records is what makes repeated folds converge. A
// fold nests a prior summarized fold in its condensed form (condenseForRefold),
// which keeps foldedRuns and drops everything else, so each pass leaves ONE
// fold carrying every call the thread has ever taken rather than a chain of
// them.
func foldedRunsIn(items []ConversationItem) []FoldedRun {
	var runs []FoldedRun
	for _, it := range items {
		if it.Type == ItemTypeThread && it.BoundedCompaction {
			runs = append(runs, it.FoldedRuns...)
			continue
		}
		if !isInvocationMessage(it) {
			continue
		}
		runs = append(runs, FoldedRun{
			ToolUseID: it.RunToolUseID,
			ToolName:  it.RunToolName,
			ToolInput: it.RunToolInput,
			Goal:      it.RunGoal,
			Status:    it.RunStatus,
			Result:    it.RunResult,
		})
	}
	return runs
}

// threadNestedItems deserialises a thread item's nested items, or nil for a
// non-thread/empty/unreadable one.
func threadNestedItems(item ConversationItem) []ConversationItem {
	if item.Type != ItemTypeThread || len(item.Items) == 0 {
		return nil
	}
	var nested []ConversationItem
	if err := json.Unmarshal(item.Items, &nested); err != nil {
		return nil
	}
	return nested
}

// threadRunSettled reports whether a thread's most recent run has settled — the
// single "is this child finished?" question every decider asks.
//
// A thread whose transcript carries no run record at all answers from `result`
// instead: a user-created thread summarised from the footer, and every document
// written before run records existed, record completion only there. The run
// record is consulted FIRST so that a thread which is invoked again after
// carrying a summary still reads as running.
//
// A compaction fold is the exception: it is not a run but a container of folded
// transcript, and "has the summariser committed yet" is asked of `result`
// directly (pendingCompactionFold asks it the same way). A fold routinely holds
// swallowed invocation messages, and reading its contents as runs would take
// one of those for the fold's own — leaving it a child that never finishes.
func threadRunSettled(item ConversationItem) bool {
	if !item.BoundedCompaction {
		if settled, hasRuns := runSettlement(threadNestedItems(item)); hasRuns {
			return settled
		}
	}
	return hasThreadResult(item)
}

// resolveAliasTarget returns the canonical thread item an alias names, from the
// array it stands in. An alias and its canonical are always siblings: a session
// is scoped to the thread that called it (sessionsInCallingThread), so a resume
// can only ever be issued from the array the thread already sits in.
//
// A compaction fold cannot separate them either. It relocates a contiguous run
// reaching the end of the transcript, so a canonical and every alias after it
// move together; and once a thread has been folded away, sessionsInCallingThread
// no longer finds its name, so no later call can add an alias to a thread that
// is no longer a sibling. Deletion does not break the pairing either: deleting
// the canonical hands the transcript to the oldest surviving view and re-points
// the rest at it (promoteThreadView, browser side), so the set stays whole and
// stays in one array.
func resolveAliasTarget(siblings []ConversationItem, item ConversationItem) (ConversationItem, bool) {
	if item.AliasOf == "" {
		return ConversationItem{}, false
	}
	for _, sibling := range siblings {
		if sibling.Type == ItemTypeThread && sibling.AliasOf == "" && sibling.ItemID == item.AliasOf {
			return sibling, true
		}
	}
	return ConversationItem{}, false
}

// isTrailingViewOf reports whether item is the LAST of the parent's items
// referring to a session — the canonical thread and its aliases are the whole
// set, and they always stand in one array (resolveAliasTarget).
//
// That item is the session's live view: it shows the run the transcript is on
// now, whoever started it. Every earlier item is a receipt for the one call it
// was made by, frozen when that run settled. The split is what lets a human
// resume a stopped child and have the answer reach the call that is waiting for
// it, without a later result ever rewriting a tile further up the transcript.
func isTrailingViewOf(siblings []ConversationItem, item ConversationItem, canonicalID string) bool {
	for i := len(siblings) - 1; i >= 0; i-- {
		s := siblings[i]
		if s.Type != ItemTypeThread {
			continue
		}
		if s.ItemID != canonicalID && s.AliasOf != canonicalID {
			continue
		}
		return s.ItemID == item.ItemID
	}
	return false
}

// trailingRunOutcome returns the outcome of the run a transcript is currently
// on, and whether it records one at all. Empty status means that run is still
// going.
//
// It reads the LAST user item rather than the run's invocation message because
// settleThreadRun stamps the same outcome onto every message the run gathered
// (openRunMessagesLocked), so the trailing one always carries it — and it is
// the item runSettlement asks about, which keeps the two answers in step.
//
// It requires no run selector, which is the point: a run a human started by
// typing into the thread is recorded on a plain user message, so threadRunRecords
// does not see it. Reading the message rather than the record is what lets the
// live view show work no call asked for.
func trailingRunOutcome(items []ConversationItem) (status, result string, ok bool) {
	for i := len(items) - 1; i >= 0; i-- {
		if items[i].Type == ItemTypeUser {
			return items[i].RunStatus, items[i].RunResult, true
		}
	}
	return "", "", false
}

// isReceiptItem reports whether a thread item is a receipt: the parent's view of
// a run nobody called (receiptItem). It names its run by the message that
// started it and carries no tool-use coordinates, because there is no call to
// name it by.
func isReceiptItem(item ConversationItem) bool {
	return item.Type == ItemTypeThread && item.RunItemID != "" && item.RunToolUseID == ""
}

// runRecordByItemID returns the outcome of the run started by a named message
// in a thread's transcript, and whether that message is still there.
//
// This is the selector for a run no call made (ConversationItem.RunItemID). It
// walks the nested items rather than going through threadRunRecords, because
// that function's guard — a record needs tool-use coordinates to count — is
// load-bearing for the wire path that emits one tool_use per record, and a
// human-started run has no coordinates at all.
func runRecordByItemID(canonical ConversationItem, itemID string) (status, result string, ok bool) {
	if itemID == "" {
		return "", "", false
	}
	for _, it := range threadNestedItems(canonical) {
		if it.Type == ItemTypeUser && it.ItemID == itemID {
			return it.RunStatus, it.RunResult, true
		}
	}
	return "", "", false
}

// shownRunOutcomeLocked returns the outcome a parent thread item currently
// displays, and whether the run it names is still in the transcript: the run its
// RunItemID names, or — when it names none — the run its own call started. These
// are the two selectors itemThreadRun reads for an item that has been frozen, so
// the answer here is what that item's tile and its wire pair are saying now.
//
// Caller MUST hold ycrdtMu.
func shownRunOutcomeLocked(nested *ycrdt.YArray, runItemID, toolUseID string) (status, result string, ok bool) {
	if nested == nil || (runItemID == "" && toolUseID == "") {
		return "", "", false
	}
	for i := 0; i < int(nested.GetLength()); i++ {
		m, isMap := nested.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !isMap {
			continue
		}
		if itemType := yMapString(m, keyType); itemType != ItemTypeUser {
			continue
		}
		id := yMapString(m, keyItemID)
		call := yMapString(m, keyRunToolUseID)
		if runItemID != "" && id != runItemID {
			continue
		}
		if runItemID == "" && call != toolUseID {
			continue
		}
		status = yMapString(m, keyRunStatus)
		result = yMapString(m, keyRunResult)
		return status, result, true
	}
	return "", "", false
}

// itemRunCall builds the tool-use coordinates a thread item's run selector
// names, in the fields buildToolUseMap reads.
func itemRunCall(item ConversationItem) ConversationItem {
	return ConversationItem{
		ToolUseID: item.RunToolUseID,
		ToolName:  item.RunToolName,
		ToolInput: item.RunToolInput,
		Goal:      item.RunGoal,
	}
}

// itemThreadRun resolves the run a thread item stands for: the canonical thread
// holding the transcript, that run's outcome, and its 1-based call number.
// Reports false for an item with no run selector, for an alias whose canonical
// is gone, and for a selector naming a run the transcript no longer records.
//
// Which run that is depends on where the item stands, and on whether it has
// been read. The LAST of the parent's items referring to a session is its live
// view and answers for the run the transcript is on now (isTrailingViewOf), so a
// session resumed by a human — whose run no call named at all — reports to the
// item still waiting on it rather than to nobody. Every earlier item answers for
// the one run its selector names, frozen where that run settled, so a session
// resumed by a later call reports to the item that call appended.
//
// An item whose result has already gone to the provider (RunResultFed) is
// frozen too, wherever it stands. It is committed history: the live view is a
// licence to absorb news the parent has not heard yet, not a licence to correct
// something it has. A run that arrives after the parent has answered it gets a
// receipt item of its own instead (settleThreadRun) — and one that arrives after
// a turn read it and died still reports here, through the selector below.
//
// What it freezes ONTO is the run it actually reported, which need not be the
// one its call started: an item that absorbed a human's resume before anybody
// read it carries that run's selector (RunItemID, written at settle), and
// freezing back onto its own call would report something other than what it
// sent.
//
// The live view borrows the OUTCOME only. Its tool-use coordinates, its goal and
// its call number stay its own, because it is still the parent's view of the
// call it made: the emitted tool_use id must keep matching the one already
// committed to the parent's history.
func itemThreadRun(siblings []ConversationItem, item ConversationItem) (canonical ConversationItem, run threadRun, call int, ok bool) {
	if item.Type != ItemTypeThread || item.RunToolUseID == "" {
		return ConversationItem{}, threadRun{}, 0, false
	}
	canonical = item
	if item.AliasOf != "" {
		if canonical, ok = resolveAliasTarget(siblings, item); !ok {
			return ConversationItem{}, threadRun{}, 0, false
		}
	}
	run, call, ok = runByToolUseID(canonical, item.RunToolUseID)
	numbered := func() int {
		if ok {
			return call
		}
		// A selector no record answers still stands for a call that was made, so
		// it is numbered after the ones that are recorded.
		return len(threadRunRecords(canonical)) + 1
	}
	if !item.RunResultFed && isTrailingViewOf(siblings, item, canonical.ItemID) {
		if status, result, recorded := trailingRunOutcome(threadNestedItems(canonical)); recorded {
			return canonical, threadRun{call: itemRunCall(item), status: status, result: result}, numbered(), true
		}
	}
	if item.RunItemID != "" {
		// The run this item absorbed while it was still unread (settleThreadRun
		// names it there). Read once the item is frozen, so what it reports is
		// what it sent.
		if status, result, found := runRecordByItemID(canonical, item.RunItemID); found {
			return canonical, threadRun{call: itemRunCall(item), status: status, result: result}, numbered(), true
		}
	}
	if !ok {
		return canonical, threadRun{}, 0, false
	}
	return canonical, run, call, true
}

// runByToolUseID returns the canonical's run matching a selector, and its
// 1-based call number.
func runByToolUseID(canonical ConversationItem, toolUseID string) (threadRun, int, bool) {
	if toolUseID == "" {
		return threadRun{}, 0, false
	}
	for i, run := range threadRunRecords(canonical) {
		if run.call.ToolUseID == toolUseID {
			return run, i + 1, true
		}
	}
	return threadRun{}, 0, false
}

// itemRunSettled reports whether the run THIS item stands for has settled.
//
// A thread item stamped with a run selector answers for the run it stands for,
// wherever the transcript now is: an alias resolves to the canonical item
// standing earlier in the same array and reads the record there. A caller parks
// on the call it made, not on whatever the thread most recently did — a session
// resumed by a LATER CALL is finished as far as the earlier call is concerned,
// because that call has an item of its own to wait on it. The last item
// referring to the thread has no such successor, so it follows the session back
// into work when a human resumes it (itemThreadRun).
//
// A selector that resolves to nothing — the canonical deleted, or the run's
// record edited away — is settled: the wire answers such a call with an error
// rather than a placeholder, so there is nothing left to wait for. The one
// exception is a canonical whose transcript records no run at all, which is a
// thread mid-creation; that falls through to threadRunSettled, which reads it as
// still working.
//
// An item with no selector (a user- or strategy-created thread, a fold, every
// document written before aliases) falls back to threadRunSettled, which asks
// the thread's latest run and then its result.
func itemRunSettled(siblings []ConversationItem, item ConversationItem) bool {
	if item.Type == ItemTypeThread && item.RunToolUseID != "" {
		canonical, run, _, ok := itemThreadRun(siblings, item)
		if ok {
			return run.status != ""
		}
		if canonical.ItemID == "" {
			return true // the alias names a thread that is gone
		}
		if len(threadRunRecords(canonical)) > 0 {
			return true // the selector names a run the transcript no longer holds
		}
		return threadRunSettled(canonical)
	}
	if item.AliasOf != "" {
		return true // an alias with no selector stands for no run
	}
	return threadRunSettled(item)
}

// runSettlement reports whether the trailing run in items has settled, and
// whether items records any run at all. A run is settled when the message that
// started it — the trailing user item — carries a runStatus.
//
// Only user items count as run records here: a nested thread item may carry the
// same coordinates as its own run selector, and counting one would answer this
// thread's liveness with a question about a child's.
func runSettlement(items []ConversationItem) (settled, hasRuns bool) {
	seenStarter := false
	for i := len(items) - 1; i >= 0; i-- {
		it := items[i]
		if it.Type == ItemTypeUser && (it.RunStatus != "" || it.RunToolUseID != "") {
			hasRuns = true
		}
		if !seenStarter && it.Type == ItemTypeUser {
			seenStarter = true
			settled = it.RunStatus != ""
		}
		if hasRuns && seenStarter {
			break
		}
	}
	return settled, hasRuns
}

// threadRunSettledLocked is threadRunSettled against the live CRDT, for the
// deciders that hold a thread's Y.Map rather than a serialised item. Caller MUST
// hold ycrdtMu.
func threadRunSettledLocked(threadYMap *ycrdt.YMap) bool {
	if threadYMap == nil {
		return false
	}
	if bounded := yMapBool(threadYMap, keyBoundedCompaction); !bounded {
		nested, _ := yMapArray(threadYMap, keyItems)
		if settled, hasRuns := runSettlementLocked(nested); hasRuns {
			return settled
		}
	}
	result := yMapString(threadYMap, keyResult)
	return result != ""
}

// runSettlementLocked is runSettlement against the live CRDT. Caller MUST hold
// ycrdtMu.
func runSettlementLocked(nested *ycrdt.YArray) (settled, hasRuns bool) {
	if nested == nil {
		return false, false
	}
	seenStarter := false
	for i := int(nested.GetLength()) - 1; i >= 0; i-- {
		m, ok := nested.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		itemType := yMapString(m, keyType)
		status := yMapString(m, keyRunStatus)
		// Only user items carry run records; a nested thread item's identical
		// coordinates are its own run selector (ConversationItem.AliasOf).
		if itemType == ItemTypeUser {
			if status != "" {
				hasRuns = true
			} else if coordinates := yMapString(m, keyRunToolUseID); coordinates != "" {
				hasRuns = true
			}
		}
		if !seenStarter && itemType == ItemTypeUser {
			seenStarter = true
			settled = status != ""
		}
		if hasRuns && seenStarter {
			break
		}
	}
	return settled, hasRuns
}

// latestRunOutcomeLocked returns the status and result stored on the thread's
// most recent settled run. Empty status means no run has settled. Caller MUST
// hold ycrdtMu.
func latestRunOutcomeLocked(threadYMap *ycrdt.YMap) (status, result string) {
	if threadYMap == nil {
		return "", ""
	}
	nested, _ := yMapArray(threadYMap, keyItems)
	if nested == nil {
		return "", ""
	}
	for i := int(nested.GetLength()) - 1; i >= 0; i-- {
		m, ok := nested.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if s := yMapString(m, keyRunStatus); s != "" {
			r := yMapString(m, keyRunResult)
			return s, r
		}
	}
	return "", ""
}

// openRunMessagesLocked returns the messages of the thread's current run — the
// user items standing after the last run to settle, newest first. Empty when
// that run has already settled, or when the thread has no message to stamp (an
// empty thread, or one continued with no new message). Caller MUST hold
// ycrdtMu.
//
// A run is usually one message, but not always: a human can type into a child
// while its run is in flight, and the loop promotes that message and absorbs it
// into the same run. The outcome is recorded on every message the run gathered,
// because two different readers need to find it. The INVOCATION message must
// carry it — that is where the tool-use coordinates live, so it is where the
// wire reads this call's result, and a run stamped anywhere else would leave
// the caller's tool_use paired with the pending placeholder for good. The
// TRAILING message must carry it too, because runSettlement asks that item
// whether the thread is still working, and an unstamped one reads as a message
// nobody has answered. With a single message — the ordinary case — they are the
// same item.
func openRunMessagesLocked(nested *ycrdt.YArray) []*ycrdt.YMap {
	if nested == nil {
		return nil
	}
	var open []*ycrdt.YMap
	for i := int(nested.GetLength()) - 1; i >= 0; i-- {
		m, ok := nested.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if t := yMapString(m, keyType); t != ItemTypeUser {
			continue
		}
		if s := yMapString(m, keyRunStatus); s != "" {
			break
		}
		open = append(open, m)
	}
	return open
}

// openThreadContinuationRun makes an explicit Continue inside a stopped thread
// the next run of that session, by appending a continuation marker for that run
// to be recorded on (continuationMarker). Continue has no user message of its
// own, and the reducer will not advertise a thread as live without an open run
// record.
//
// The marker is appended rather than the previous record being reopened.
// Clearing that record would rewrite whatever the parent has already been told:
// its result would revert to the pending placeholder the moment Continue was
// clicked, and become a different run's answer under the same tool_use id when
// this run settled — the in-place rewrite receipts exist to prevent, arriving
// through the one gesture that has no message to append. Every earlier record
// stays exactly as it was read.
//
// A run already open in the thread is joined instead: no marker is appended.
// That check and the append share one hold (AppendRunStarterToThread).
//
// No-op at the root, which has no run records at all.
func (r *run) openThreadContinuationRun(dest threadContext) {
	if dest.itemID == "" {
		return
	}
	marker := []ConversationItem{continuationMarker()}
	r.stampTxnID(marker)
	r.tracker.AppendRunStarterToThread(dest.itemID, marker[0])
}

// lastSettlingItem returns the item that decides how a run ended: the last one
// that either records a state transition (effectiveItems) or is an error.
// Errors are included here and excluded there because an error does not choose
// the next action — the reducer rests on it exactly as it rests on assistant
// text — but it does decide what the run returns.
func lastSettlingItem(items []ConversationItem) (ConversationItem, bool) {
	for i := len(items) - 1; i >= 0; i-- {
		switch items[i].Type {
		case ItemTypeUser, ItemTypeAssistant, ItemTypeToolAction,
			ItemTypeMetaToolResult, ItemTypeThread, ItemTypeError:
			return items[i], true
		}
	}
	return ConversationItem{}, false
}

// resolveRunOutcome classifies how a run ended and what it returns. Every
// ending resolves to a status and a non-empty result: a run that came to rest
// returns its trailing assistant text, a run that stopped on an error returns
// the error text, a cancelled one returns whatever it had produced plus the
// reason, and one that settled with nothing clean says so. Nothing is
// fabricated, and no ending yields silence — an unpaired tool_use is
// wire-invalid, so a parent that called into this thread must always get
// something back. resultLimit is the cap on the returned text
// (runResultCharBudget); fullChars is the untrimmed length in characters when
// the cap cut it, 0 otherwise.
func resolveRunOutcome(items []ConversationItem, cancelled bool, resultLimit int) (status, result string, fullChars int) {
	if cancelled {
		// Capped BEFORE the note is appended, never after: the note is the part of
		// a cancelled result the caller cannot do without — it is what stops a
		// partial answer being read as a whole one — and a trim applied to the
		// finished string would take the note off the end and leave exactly that
		// misreading behind.
		if text := selectThreadFallbackResult(items); text != "" {
			capped, full := capRunResult(text, resultLimit)
			return runStatusCancelled, capped + "\n\n" + runCancelledNote, full
		}
		return runStatusCancelled, runCancelledNote, 0
	}
	if last, ok := lastSettlingItem(items); ok && last.Type == ItemTypeError {
		if last.Content != "" {
			capped, full := capRunResult(last.Content, resultLimit)
			// Appended after the cap, like runCancelledNote, so a trim can never
			// take it off the end.
			if provider.ClassifyFailureText(last.Content).Kind.Transient() {
				capped += "\n\n" + runTransientErrorNote
			}
			return runStatusError, capped, full
		}
		return runStatusError, "The run stopped on an error.", 0
	}
	if text := selectThreadFallbackResult(items); text != "" {
		capped, full := capRunResult(text, resultLimit)
		return runStatusRest, capped, full
	}
	return runStatusBarren, runBarrenNote, 0
}

// trailingSessionItemLocked returns the LAST of the parent's items referring to
// a session — its live view, the one item a settling run may still report to.
// The canonical thread and its aliases and receipts are the whole set, and they
// always stand in one array (resolveAliasTarget). Mirrors isTrailingViewOf,
// which asks the same question of an item snapshot. Caller MUST hold ycrdtMu.
func trailingSessionItemLocked(arr *ycrdt.YArray, canonicalID string) *ycrdt.YMap {
	if arr == nil {
		return nil
	}
	for i := int(arr.GetLength()) - 1; i >= 0; i-- {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if t := yMapString(m, keyType); t != ItemTypeThread {
			continue
		}
		id := yMapString(m, keyItemID)
		aliasOf := yMapString(m, keyAliasOf)
		if id != canonicalID && aliasOf != canonicalID {
			continue
		}
		return m
	}
	return nil
}

// fedResultUnansweredLocked reports whether the parent took the trailing item's
// result in and produced nothing from it: the turn that read it died, leaving an
// error item and no reply.
//
// runResultFed says the result went to the provider, which is what normally
// freezes an item. It is stamped as the wire is BUILT, so it is stamped by a turn
// that may then fail — and a turn that failed committed nothing. What the freeze
// actually protects is a result the parent has ANSWERED, and the three costs of
// rewriting one are all costs of an answer standing after it: messages sliding
// below it, a stateful provider cold-starting on the change, and the parent's own
// reasoning contradicting the result it now reads. Where the turn produced no
// answer, none of them are owed.
//
// The evidence for that is items, not their absence. Something must stand after
// the item — an error, a notice, whatever the dead turn left — and everything
// standing after it must emit nothing to the provider (itemWireMessages returns
// no messages, the same projection the wire is built from, so the two cannot
// drift). An item with NOTHING after it is not evidence of a turn that produced
// nothing; it is the ordinary shape of a turn whose reply has not arrived yet,
// and that reply must not land on a result that changed underneath it.
//
// A thread item is loud without asking, because a thread item after this one is
// another child the parent called, and because itemWireMessages needs the whole
// sibling slice to resolve an alias. Its answer would be "loud" either way.
//
// The parent must also not be mid-request. Conversation-wide serial dispatch
// makes that nearly impossible today — a child cannot settle while its parent
// holds the claim — but "nearly" is not a thing to build on: a pending request
// cancelled from elsewhere settles a run through cancelPendingEntry without
// touching an unrelated in-flight turn, and a turn writes a notice while it runs,
// which would otherwise read as a turn that ended saying nothing.
//
// Caller MUST hold ycrdtMu.
func (w *ConversationWorker) fedResultUnansweredLocked(threadItemID string, parentArr *ycrdt.YArray, trailingID string) bool {
	if parentArr == nil || trailingID == "" {
		return false
	}
	if w.threadActivityLocked(w.doc.findParentThreadID(threadItemID)) == ActivityCallingLLM {
		return false
	}
	silent := false
	for i := int(parentArr.GetLength()) - 1; i >= 0; i-- {
		m, ok := parentArr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if id := yMapString(m, keyItemID); id == trailingID {
			return silent
		}
		if t := yMapString(m, keyType); t == ItemTypeThread {
			return false
		}
		if len(itemWireMessages(yMapToConversationItem(m), nil)) > 0 {
			return false
		}
		silent = true
	}
	return false
}

// reportRunToParentLocked gives a settling run somewhere in the parent to report
// to, when the item that would otherwise report it has already answered the
// model.
//
// The live view absorbs a run nobody called for as long as its own result is
// still unsent: nothing has been read, so nothing moves, and the call still
// waiting gets the answer it is waiting for. Once that item's real result has
// gone to the provider (runResultFed) it is committed history — rewriting it
// would slide every message after it, cold-start a stateful provider, and leave
// the parent's own reasoning standing after a result that now contradicts it. So
// a further run is appended as a RECEIPT of its own instead, at the end of the
// parent's array where the model reads it as news.
//
// A result that was read but never ANSWERED is the exception, and it is the
// shape a failing child leaves: the parent's turn takes the child's error in,
// dies on its own error, and commits nothing. Retrying the child then reports to
// the item still standing for it rather than to a second one
// (fedResultUnansweredLocked).
//
// Appending on SETTLE rather than on resume is what keeps that promise cheap:
// there is never an unsettled receipt, so the parent never parks on work it did
// not ask for and no isError placeholder is ever emitted for one. Coalescing
// falls out of the same rule — an unread receipt is re-pointed at the newer run
// rather than joined by another, so a user who sends six prompts into a child
// leaves the parent one item to read, not six. A run that came out exactly as
// the one the trailing item already shows is dropped for the same reason read
// the other way: it is not news, so there is nothing for a receipt to carry.
//
// A thread item with no run selector at all is left alone: a user- or
// strategy-created thread answers no call, so it has no committed pair to
// protect and its tile is the only view of it there has ever been.
//
// Caller MUST hold ycrdtMu and be inside the settling transaction, so the run's
// outcome and the parent's view of it land as one change.
func (w *ConversationWorker) reportRunToParentLocked(threadItemID string, threadYMap *ycrdt.YMap, starterID, starterCall, status, result string) {
	if starterID == "" {
		return
	}
	parentArr := w.doc.parentArrayOfLocked(threadItemID)
	trailing := trailingSessionItemLocked(parentArr, threadItemID)
	if trailing == nil {
		return
	}
	selector := yMapString(trailing, keyRunToolUseID)
	runItemID := yMapString(trailing, keyRunItemID)
	if selector == "" && runItemID == "" {
		return
	}
	if runItemID == starterID {
		return // already the item this run reports to
	}
	trailingID := yMapString(trailing, keyItemID)
	fed := yMapBool(trailing, keyRunResultFed)
	nested, _ := yMapArray(threadYMap, keyItems)
	recovers := status == runStatusRest && lastReadRunFailedLocked(parentArr, nested, threadItemID)
	if !fed || w.fedResultUnansweredLocked(threadItemID, parentArr, trailingID) {
		// Unread, or read by a turn that produced nothing, so this item absorbs the
		// run — and now says which one it absorbed. Naming it is what makes the
		// absorption survive being read: the item is frozen the moment an answer
		// stands on its result, and an item frozen back onto the call it was made by
		// would report something other than what it sent. A call whose OWN run this
		// is needs no such note.
		if runItemID != "" || starterCall != selector {
			trailing.Set(keyRunItemID, starterID)
		}
		// An unread receipt reports the run it now names, so whether it recovers
		// an error is that run's question too.
		if selector == "" {
			if recovers {
				trailing.Set(keyRecoversError, true)
			} else {
				trailing.Delete(keyRecoversError)
			}
		}
		return
	}
	// A receipt earns its place by being news. A run that came out exactly as the
	// run the trailing item already shows is not news: the receipt would stand
	// next to a tile saying the same words, and cost the parent a second message
	// telling it what it has just been told. A child that stalls the same way
	// three times running is worth one item, not three.
	if shownStatus, shownResult, found := shownRunOutcomeLocked(nested, runItemID, selector); found &&
		shownStatus == status && shownResult == result {
		return
	}

	goal := yMapString(threadYMap, keyGoal)
	sessionName := yMapString(threadYMap, keySessionName)
	receipt := receiptItem(threadItemID, goal, sessionName, starterID)
	receipt.RecoversError = recovers
	parentArr.Insert(ycrdt.Number(int(parentArr.GetLength())), ycrdt.ArrayAny{conversationItemToYMap(receipt)})
}

// lastReadRunFailedLocked reports whether the last thing the parent read about a
// thread was a failure: the latest of its items for that thread whose result has
// gone to the provider shows an error run. A run that comes to rest after that
// is the work the parent was told had not been done, which is what makes its
// receipt a trigger rather than news (ConversationItem.RecoversError).
//
// Caller MUST hold ycrdtMu.
func lastReadRunFailedLocked(parentArr, nested *ycrdt.YArray, canonicalID string) bool {
	if parentArr == nil {
		return false
	}
	for i := int(parentArr.GetLength()) - 1; i >= 0; i-- {
		m, ok := parentArr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if t := yMapString(m, keyType); t != ItemTypeThread {
			continue
		}
		id := yMapString(m, keyItemID)
		aliasOf := yMapString(m, keyAliasOf)
		if id != canonicalID && aliasOf != canonicalID {
			continue
		}
		if fed := yMapBool(m, keyRunResultFed); !fed {
			continue
		}
		runItemID := yMapString(m, keyRunItemID)
		selector := yMapString(m, keyRunToolUseID)
		status, _, found := shownRunOutcomeLocked(nested, runItemID, selector)
		return found && status == runStatusError
	}
	return false
}

// threadTokenFigures sizes what a sub-thread built against what it handed back:
// its whole transcript, and the answer the parent receives as one tool_result.
//
// Both come from the same wire estimator, which is what makes the pair worth
// showing — the ratio between them is the point, not either number on its own.
// It is an estimate rather than a billed count on purpose: a billed total would
// need every one of the thread's transaction blobs read off disk at settle,
// under the document lock, and blobs are swept once nothing references them.
func threadTokenFigures(items []ConversationItem, result string) (int64, int64) {
	contextTokens := estimateItemsWireTokens(items, items)
	resultTokens := provider.EstimateMessageRequestTokenBreakdown(provider.MessageRequest{
		Messages: []provider.Message{{Type: "user", Content: result}},
	}, 0).Total
	return contextTokens, resultTokens
}

// settleThreadRun records how the run that just ended on threadItemID came out:
// runStatus/runResult onto the message that started it, and — for a run that
// came to rest — the same text onto the thread as its current summary.
//
// This is the sole producer of the completion signal every parked decider
// waits on, so it runs at EVERY ending: rest, error, and cancellation alike.
// A parked tool approval is not an ending — the child is still live and the
// caller stays parked, which is why the strategy loop returns before reaching
// here while an approval is outstanding.
//
// Only a resting run stamps the summary. An error, a cancellation or a barren
// end returns its text to the caller but leaves the tile's summary alone rather
// than passing failure off as a result. There is no other writer and no way to
// pin different words: a thread's summary is the last thing it said, so a
// different summary is a message away.
//
// A bounded-compaction fold settles nothing here. It is not a run but a
// container of folded transcript: its summary is written through the compaction
// path, and every decider asks whether it has one by reading `result` directly
// (threadRunSettled, pendingCompactionFold). Stamping its summarisation prompt
// with a run outcome would write a wrong-meaning record into the document on
// every /compact, /handoff and auto-compaction.
func (w *ConversationWorker) settleThreadRun(threadItemID string, cancelled bool) {
	if threadItemID == "" {
		return
	}
	resultLimit := w.runResultBudgetFor(threadItemID)

	var (
		wrote          bool
		status, result string
		fullChars      int
	)
	withYDoc(func() {
		threadYMap := findThreadYMap(w.doc.getItems(), threadItemID)
		if threadYMap == nil {
			return
		}
		if boundedCompaction := yMapBool(threadYMap, keyBoundedCompaction); boundedCompaction {
			return
		}
		nested, _ := yMapArray(threadYMap, keyItems)
		threadResult := yMapString(threadYMap, keyResult)

		var items []ConversationItem
		if nested != nil {
			items = w.doc.getItemsFromArrayLocked(nested)
		}
		status, result, fullChars = resolveRunOutcome(items, cancelled, resultLimit)
		open := openRunMessagesLocked(nested)
		_, recordsRun := runSettlementLocked(nested)

		// A run with no message to stamp reports through `result` or not at all: a
		// creation that appended no invocation message (a continuation creation, or a
		// call that supplied no prompt) records a run nowhere else, so a caller parked
		// on this child would be waiting on a run that can never report. That case
		// writes whatever the run came to; every other ending keeps failure out of
		// the summary. A human's Continue is not one of them — it appends a marker to
		// be recorded on (openThreadContinuationRun).
		orphanRun := len(open) == 0 && !recordsRun
		summarises := status == runStatusRest || orphanRun

		if len(open) == 0 && !summarises {
			return
		}
		starterID, starterCall := "", ""
		if len(open) > 0 {
			// openRunMessagesLocked walks backwards, so the last entry is the message
			// that STARTED this run — the one a parent item selects it by.
			starterID = yMapString(open[len(open)-1], keyItemID)
			starterCall = yMapString(open[len(open)-1], keyRunToolUseID)
		}
		contextTokens, resultTokens := threadTokenFigures(items, result)
		w.tracker.settleIntoThreadGroupLocked(threadItemID, func() {
			w.doc.transactTracked(func(_ *ycrdt.Transaction) {
				for _, m := range open {
					m.Set(keyRunStatus, status)
					m.Set(keyRunResult, result)
				}
				if summarises && result != threadResult {
					threadYMap.Set(keyResult, result)
				}
				threadYMap.Set(keyContextTokens, ycrdt.Number(contextTokens))
				threadYMap.Set(keyResultTokens, ycrdt.Number(resultTokens))
				w.reportRunToParentLocked(threadItemID, threadYMap, starterID, starterCall, status, result)
			})
		})
		wrote = true
	})
	if !wrote {
		return
	}

	// A trimmed result names the size it was cut from: the length handed on is
	// only the cap, and the log is where a cut is diagnosed after the fact.
	if fullChars > 0 {
		w.log.Info("[worker] Thread %s run settled: %s (%d chars, trimmed from %d to fit a %d-char cap)",
			threadItemID, status, utf8.RuneCountInString(result), fullChars, resultLimit)
		return
	}
	w.log.Info("[worker] Thread %s run settled: %s (%d chars)", threadItemID, status, utf8.RuneCountInString(result))
}
