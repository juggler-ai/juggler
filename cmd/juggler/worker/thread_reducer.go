//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"runtime/debug"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// ThreadAction is the reducer's decision for what the worker should do
// next given the current state of a MessageThread's items.
//
// The reducer is authoritative: decideNextAction is the pure decision
// function and tryReconcile dispatches the action it returns (call the
// LLM, complete a nested thread, or go idle). It runs at the top of the
// main event loop on every Yjs update, so the MessageThread's items are
// the single source of truth for what happens next.
type ThreadAction int

const (
	// ActionNone means the thread is at a resting state. Nothing for
	// the worker to do until items change again.
	ActionNone ThreadAction = iota

	// ActionCallLLM means the thread's last relevant item is a user
	// message or a completed tool batch, so the LLM should be called to
	// generate the next assistant turn.
	ActionCallLLM

	// ActionGoIdle means the thread's tools were all denied (cancelled)
	// while activity was "awaiting_llm". The reducer clears the activity
	// marker so the conversation returns to rest. Fires for both root
	// and nested threads — a denial is not a completion.
	ActionGoIdle
)

// String returns a human-readable action name for logging.
func (a ThreadAction) String() string {
	switch a {
	case ActionNone:
		return "None"
	case ActionCallLLM:
		return "CallLLM"
	case ActionGoIdle:
		return "GoIdle"
	default:
		return "Unknown"
	}
}

// decideNextAction is the reducer: a pure function over a thread's items,
// the current activity state from processingState, and whether this is
// the root thread. Returns the single next action the worker should take.
//
// Invariants:
//   - Pure. Reads its arguments only. Does not mutate anything.
//   - Idempotent: same inputs → same output.
//   - Does not consult worker in-memory flags (currentThreadItemID,
//     batchCompleteSignal, loopStoppedByDenial, etc.). Every decision
//     is derivable from items plus activity.
//
// The activity parameter (from processingState.activity in the Yjs doc)
// is what allows the reducer to distinguish "tools freshly completed,
// LLM call needed" (activity="awaiting_llm") from "tools completed long
// ago, conversation at rest" (activity=""). Without this, the reducer
// would re-dispatch after undo or after a previous LLM error.
func decideNextAction(items []ConversationItem, activity string, isRoot bool, explicitContinuation bool) ThreadAction {
	// In-flight guard: if an LLM call is already in progress, the
	// reducer must not launch another. It will re-fire when the call
	// finishes and activity is cleared.
	if activity == ActivityCallingLLM {
		return ActionNone
	}

	// Keep only items that affect the conversation flow. Thinking
	// blocks and context items (system-prompt, rule, tree, etc.) don't
	// drive the decision.
	effective := effectiveItems(items)
	if len(effective) == 0 {
		// If awaiting_llm, an LLM call was explicitly requested (e.g. a
		// continuation thread created with no seed prompt). Root threads
		// with no items have nothing to send — treat as idle.
		if activity == ActivityAwaitingLLM {
			if isRoot {
				return ActionGoIdle
			}
			return ActionCallLLM
		}
		return ActionNone
	}

	// Rule: if ANY tool-action in the thread is still non-terminal
	// (pending / approved / running / state-unset), rest. The
	// tool-action reducer (or the user's approval) will drive that
	// transition; the thread reducer re-fires when the result lands.
	// This covers both freshly-spawned tools and user-initiated retries
	// of older tools.
	for _, item := range effective {
		if item.Type == ItemTypeToolAction && !isToolTerminal(item) {
			return ActionNone
		}
	}

	// Inspect the effective last item to decide the next action.
	last := effective[len(effective)-1]

	// If awaiting_llm but the last effective item is an assistant message,
	// the tools were deleted (undo, user delete) unless this is an explicit
	// user-requested continuation. User messages and meta-tool-results are
	// valid triggers for CallLLM and should NOT clear the activity.
	if activity == ActivityAwaitingLLM && last.Type == ItemTypeAssistant {
		if explicitContinuation {
			return ActionCallLLM
		}
		return ActionGoIdle
	}

	switch last.Type {
	case ItemTypeError:
		// An error occurred (LLM failure, etc.). Rest by default — the user
		// must take action to proceed. But if continuation was explicitly
		// requested (activity="awaiting_llm"), allow the LLM to retry so
		// the "continue" button works after an error.
		if activity == ActivityAwaitingLLM {
			return ActionCallLLM
		}
		return ActionNone

	case ItemTypeUser:
		if activity == ActivityAwaitingLLM {
			return ActionCallLLM
		}
		return ActionNone

	case ItemTypeToolAction, ItemTypeThread, ItemTypeMetaToolResult:
		// A RECEIPT is never a trigger. It stands for a run nobody here asked for
		// — a human picked a child back up — and it is only ever appended once
		// this thread's own call has been answered, so nothing is waiting on it.
		// Waking an idle conversation to react to it would spend a turn the user
		// never asked for, on work they did in another column. It is news, and it
		// is read on this thread's next turn, in order, like any other item.
		if isReceiptItem(last) {
			if activity == ActivityAwaitingLLM {
				if explicitContinuation {
					return ActionCallLLM
				}
				return ActionGoIdle
			}
			return ActionNone
		}

		// Only dispatch when activity="awaiting_llm" — this distinguishes a
		// fresh completion from a stale one after undo or a previous turn.
		if activity != ActivityAwaitingLLM {
			return ActionNone
		}

		// Guard: EVERY member of the batch must have finished before the LLM can
		// continue — every tool terminal, every child thread's run settled. Asked
		// of the whole batch and not of its final item, because the order work is
		// dispatched in is not the order it finishes in: sub-agents run beside
		// each other, so any of them can be the last to answer, and a bash command
		// standing between two of them is waited on by the same rule. Resuming
		// early does not merely lose time — it sends the turn with the unfinished
		// members' results missing.
		//
		// This is also the mock/fast-mode gate: the reducer can fire before the
		// browser has evaluated tool states (pending/running/undefined).
		batch := currentBatch(effective)
		for _, member := range batch {
			if !batchMemberSettled(items, member) {
				return ActionNone // still in flight — wait
			}
		}
		if anyBatchCancelled(items, batch) {
			// At least one member was denied or stopped. Either stops the
			// automatic loop — the LLM shouldn't proceed with partial
			// information on its own. But an explicit user Continue means
			// "proceed anyway", so honour it (same as the assistant-last branch
			// above); otherwise clear the awaiting marker and rest.
			if explicitContinuation {
				return ActionCallLLM
			}
			return ActionGoIdle
		}
		return ActionCallLLM

	case ItemTypeAssistant:
		// Assistant text-only reply (no tool-actions after it). Rest at idle
		// for root AND nested threads alike: ending a turn with plain
		// assistant text is a thread's normal resting state. Coming to rest
		// settles the run — that text is what the run returns, and what it
		// writes as the thread's summary — but it ends nothing: the thread is
		// free to run again. A turn that ends on an error rests the same way
		// (see the ItemTypeError case): the error is just an item in the
		// thread's history, not a verdict on the thread.
		return ActionNone

	default:
		return ActionNone
	}
}

// effectiveItems filters to only the item types that affect the
// thread-level reducer's decision. Everything else (thinking, context
// items like system-prompt/rule/tree) is skipped because those items
// do not encode a state transition.
func effectiveItems(items []ConversationItem) []ConversationItem {
	out := make([]ConversationItem, 0, len(items))
	for _, item := range items {
		switch item.Type {
		case ItemTypeUser,
			ItemTypeAssistant,
			ItemTypeToolAction,
			ItemTypeMetaToolResult,
			ItemTypeThread:
			out = append(out, item)
		}
	}
	return out
}

// currentBatch returns the contiguous trailing run of work the turn dispatched:
// tool-actions, the child threads a delegating or create_thread call spawned,
// and the meta-tool results answered in the worker. All three are inserted
// consecutively after the assistant message that asked for them, so the current
// batch is the longest suffix of the three together.
//
// Child threads belong in it for exactly the reason tool-actions do. A turn that
// calls four sub-agents and a bash command is waiting on five things and is
// finished when the LAST of them finishes — not when the last-INSERTED one does.
// Children run side by side, so the last-spawned child need not be the last to
// settle, and asking only about the final item would resume the parent on
// whichever child happened to be quickest, discarding the rest.
//
// The suffix is also bounded by round-trip. A turn that answers with tool calls
// alone inserts no assistant item, and neither does an explicit Continue, so
// that turn's work sits directly after the previous turn's — and a member left
// cancelled by an earlier Stop would otherwise be judged with every batch after
// it, resting the loop each time. Members carry the TransactionID of the
// round-trip that produced them (the same key buildMessagesFromItems groups
// tool_use blocks by), so the walk stops at a member stamped by a different
// one. A member with no TransactionID bounds nothing, and neither does a
// receipt: it is appended after the batch by a run nobody here asked for.
func currentBatch(items []ConversationItem) []ConversationItem {
	end := len(items)
	start := end
	txnID := ""
	for start > 0 && isBatchMember(items[start-1]) {
		member := items[start-1]
		if member.TransactionID != "" && !isReceiptItem(member) {
			if txnID == "" {
				txnID = member.TransactionID
			} else if member.TransactionID != txnID {
				break
			}
		}
		start--
	}
	if start == end {
		return nil
	}
	return items[start:end]
}

// isBatchMember reports whether an item is a piece of dispatched work rather
// than a message. Receipts are members despite standing for no work of this
// turn's: excluding them would end the walk-back early and hide the batch behind
// one, which is the same class of mistake as stopping at the last item.
func isBatchMember(item ConversationItem) bool {
	switch item.Type {
	case ItemTypeToolAction, ItemTypeThread, ItemTypeMetaToolResult:
		return true
	default:
		return false
	}
}

// batchMemberSettled reports whether one member of a batch has finished, asking
// each kind the question that applies to it. siblings is the array the item
// stands in, which resolving an alias to the thread it is a view of needs.
func batchMemberSettled(siblings []ConversationItem, item ConversationItem) bool {
	switch {
	case item.Type == ItemTypeToolAction:
		return isToolTerminal(item)
	case item.Type == ItemTypeMetaToolResult:
		return true // answered in the worker, so it arrives finished
	case isReceiptItem(item):
		// A run nobody in this thread asked for. It is news, not work, so there
		// is nothing here waiting on it.
		return true
	default:
		return itemRunSettled(siblings, item)
	}
}

// isToolTerminal returns true if a tool-action is in a state that will
// not transition further without external input. Only completed and
// cancelled are terminal; pending/approved/running/"" are in flight.
func isToolTerminal(t ConversationItem) bool {
	return isTerminalToolState(t.State)
}

// isTerminalToolState is isToolTerminal's rule for a bare state string, for
// callers reading one straight off a YMap.
func isTerminalToolState(state string) bool {
	return state == StateCompleted || state == StateCancelled
}

// anyBatchCancelled returns true if at least one member of the batch came back
// cancelled: a tool-action the user denied, or a sub-thread whose run was
// stopped. A single one stops the automatic loop — the LLM shouldn't proceed
// with partial results — while an explicit Continue still proceeds.
//
// A stopped run has to count. It settles, because a caller parked on a thread
// nobody is driving would wait for good; but settling is how the caller stops
// WAITING, not a reason for it to start TALKING. Resuming on one spends a turn
// on "[The run was cancelled before it finished.]" with the work sitting undone
// — the exact turn the user's Stop was asking not to happen. A receipt is
// exempt: it stands for a run nobody here asked for, so it is news rather than
// this batch's answer.
func anyBatchCancelled(siblings, batch []ConversationItem) bool {
	for _, t := range batch {
		if t.Type == ItemTypeToolAction && t.State == StateCancelled {
			return true
		}
		if t.Type != ItemTypeThread || isReceiptItem(t) {
			continue
		}
		if _, run, _, ok := itemThreadRun(siblings, t); ok && run.status == runStatusCancelled {
			return true
		}
	}
	return false
}

// hasThreadResult reports whether a thread item has completed and written its result.
// Thread Y.Maps store their result under the "result" key as a plain string.
func hasThreadResult(item ConversationItem) bool {
	if len(item.Result) == 0 {
		return false
	}
	// A missing field can deserialise as literal JSON "null"; treat that as "no result".
	return string(item.Result) != "null"
}

// reconcileThread is called from the document observer (handleItemsChange)
// on every Yjs update. Because the observer fires synchronously — even
// during a strategy-loop write — this method MUST NOT block. It just
// raises the scheduler's reconcile bit; the main event loop's tryReconcile()
// dispatches the actual action at the top level.
func (w *ConversationWorker) reconcileThread() {
	w.sched.markReconcile()
}

// updateApprovalWaitAnchor keeps the spinner's elapsed digit measuring active
// work, not the time the user spends deciding at a tool-approval prompt. It runs
// once per reconcile tick and acts only on the park/resume edges:
//
//   - Enter park (a tool pending, nothing executing): record when the wait began
//     and HIDE the digit (remove startedAt) — clients show no elapsed time while
//     awaiting approval.
//   - Resume to real work: advance startedAt forward by the wait just ended and
//     show it again, so the digit continues with the deliberation excluded.
//   - Park ended without resuming (cancel at the prompt): just clear the marker;
//     the idle transition drops startedAt anyway.
//
// An auto-approved tool goes Unevaluated→Approved without ever sitting pending,
// so the turn is never blockedOnlyByApprovals, no edge fires, and its timer keeps
// running. The deduction is computed from in-memory state alone (processingStartedAt
// + approvalWaitStartedAt); only the single derived startedAt field touches the doc.
func (r *run) updateApprovalWaitAnchor() {
	r.updateApprovalWaitAnchorForThread(r.t.thread.itemID)
}

// updateApprovalWaitAnchorForThread applies the approval edges for this run
// without reading its mutable thread context. The actor uses the immutable
// live-run registry copy while the turn goroutine is unwinding.
func (r *run) updateApprovalWaitAnchorForThread(threadItemID string) {
	// Asked of this turn's own subtree: the anchor it adjusts is this turn's, so
	// a sibling parked at its own approval prompt must not move it.
	hasPending, hasExecuting := r.approvalBlockState(threadItemID)
	parked := hasPending && !hasExecuting
	if parked == r.t.wasBlockedOnApprovals {
		return // no edge this tick
	}
	r.t.wasBlockedOnApprovals = parked
	if r.t.processingStartedAt.Load() == 0 {
		return // no active turn to anchor
	}
	now := time.Now().UnixMilli()
	if parked {
		r.t.approvalWaitStartedAt.Store(now)
		r.hideElapsedAnchor()
		return
	}
	// Park ended. Exclude the wait only when real work resumed; on a cancel at
	// the prompt there is nothing to resume.
	waitStart := r.t.approvalWaitStartedAt.Swap(0)
	if hasExecuting && waitStart != 0 {
		r.advanceElapsedAnchor(now - waitStart)
	}
}

// tryReconcile is called from the main event loop after every event. If
// the reducer has been tickled (the reconcile bit is set), it evaluates the
// current thread's items, decides what action to take, and dispatches.
//
// Walk-down: if the reducer returns ActionNone because the last effective
// item is an incomplete child thread, tryReconcile walks into the child
// and evaluates it. This enables the reducer to dispatch on nested threads
// without recursive strategy loop calls.

// maxReconcilePasses bounds a drain loop so observer re-triggering can't spin
// forever. A dispatch may complete and raise the reconcile bit again (e.g. a child
// thread completes → parent needs dispatch), so we loop until quiet or capped.
const maxReconcilePasses = 10

// drainReconcile runs tryReconcile until the reducer is quiet, bounded by
// maxReconcilePasses. The run() loop drains after every event.
//
// A pass may run while turns are live, but admission rejects their own threads
// and preserves the single write-capable slot. This lets the walk-down discover
// stamped read-only siblings without letting it dispatch over an owned thread.
//
// It returns the number of passes it ran, for the run() loop's slow-iteration
// report.
func (r *run) drainReconcile() int {
	passes := 0
	for ; passes < maxReconcilePasses && r.sched.reconcilePending(); passes++ {
		r.tryReconcile()
	}
	return passes
}

// requestReconcile asks for a reducer pass without running one here. It wakes
// the run loop (runScheduler.wakeReconcile), so the pass — and any dispatch it decides on — happens as
// a fresh iteration of the event loop instead of as recursion on the caller's
// stack. That is what lets a turn hand the reducer back at its end rather than
// driving the next turn from inside the one that just finished. A post to a loop
// that has since stopped is dropped, which is what shutdown wants.
func (r *run) requestReconcile() {
	r.sched.wakeReconcile()
}

// tryReconcile is one pass of the reducer, and one of the two ways a sub-thread
// reaches the LLM. Threads stamped needsStrategyRun (compaction and handoff
// folds, plugin inserts) are picked up by checkForNewThreads below; delegated
// children — any delegatesToSubthread tool, via tryDelegateTool — set no such
// flag and are dispatched only by the walk further down this function. The two
// share no dispatch code, so exercising one proves nothing about the other:
// test both.
func (r *run) tryReconcile() {
	if !r.sched.takeReconcile() {
		return
	}

	// Guard: the reducer fires on every event-loop tick via handleItemsChange.
	// During partial Yjs sync (mid-update, reconnect, etc.) the items array
	// can contain half-populated Y.Maps that panic in yMapToConversationItem.
	// Recover gracefully — the next observer tick will retry.
	defer func() {
		if panicValue := recover(); panicValue != nil {
			stack := debug.Stack()
			r.log.Error("[reducer] recovered from panic in tryReconcile: %v\n%s", panicValue, stack)
			requireDocLockAfterPanic("a reducer pass", panicValue, stack)
		}
	}()

	liveThreads := r.sched.liveThreads()
	for _, live := range r.sched.runs() {
		r.runFor(live.t).updateApprovalWaitAnchorForThread(live.threadItemID)
	}
	if len(liveThreads) == 0 {
		r.updateApprovalWaitAnchor()
	}

	// Command the engine only for inactive threads. Live runs own their thread's
	// tool state; the actor retains sole ownership of the shared command tracker.
	r.driveToolActionsExcept(liveThreads)

	// Doc-driven threads (a /compact or /handoff fold, any plugin-inserted
	// needsStrategyRun thread) are picked up here as well as from the items
	// observer. The observer alone is not enough: the claim such a thread needs
	// can be held at the moment it is inserted, and the release that frees it
	// writes processingState, not items — so no further observer tick arrives and
	// the thread waits forever, unrun, while the conversation reports idle. This
	// tick is the retry. It self-guards on idle, so it is inert mid-turn.
	if r.checkForNewThreads() {
		// The pickup claimed a thread and marked the conversation busy; re-evaluate
		// from scratch rather than walking down with items read before it.
		r.sched.markReconcile()
		return
	}

	// The thread the projection names is only meaningful when an operation is in
	// flight; when nothing is, the pass starts at the root.
	//
	// It is a starting point, not the only one. The projection describes
	// ONE run and a conversation may hold several, so a pass anchored on it alone
	// spends itself inside whichever subtree it happens to name and never looks at
	// the siblings — which is precisely the state a batch of read-only children
	// arrives in, the first of them running and the rest waiting on a pass that
	// never reaches them. The root is therefore always walked too.
	//
	// The anchor is still walked FIRST, and is not redundant with the root: it is
	// the only way to reach a thread the descent deliberately refuses to walk into.
	// continueInNewThread points the projection at a brand-new EMPTY child, and an
	// empty child is never a descent target (see below).
	anchor := ""
	if r.getActivity() != ActivityNone {
		anchor = r.getProcessingThreadItemID()
	}

	// walkTarget is one thread the pass has yet to evaluate, carrying the activity
	// it was reached with.
	type walkTarget struct {
		threadItemID string
		activity     string
	}

	queue := []walkTarget{{threadItemID: anchor, activity: r.threadActivity(anchor)}}
	if anchor != "" {
		queue = append(queue, walkTarget{threadItemID: "", activity: r.threadActivity("")})
	}

	// Walk: evaluate a thread, and where it has nothing to do itself, queue the
	// incomplete children below it. Both branches can reach the same thread, so
	// each is evaluated once.
	visited := make(map[string]bool, len(queue))
	for len(queue) > 0 {
		target := queue[0]
		queue = queue[1:]
		if visited[target.threadItemID] {
			continue
		}
		visited[target.threadItemID] = true

		// Read through the reducer's view (reducer_view.go): this runs after every
		// event, and the full conversion would copy every sub-thread's transcript.
		var items []ConversationItem
		if target.threadItemID != "" {
			// A claim outlives the thread it names: processingState is not part of
			// the items tree, so deleting the thread's host item (a rewind, a
			// delete-range) leaves a queued awaiting_llm standing. Read as an empty
			// thread, that is the reducer's continuation trigger, and it would run a
			// turn on nothing — no messages, no system prompt. A deleted thread has
			// nothing to run; drop its queued claim. One mid-call is left to the
			// cancel handleItemsChange raises for it.
			if r.doc.GetThreadYMap(target.threadItemID) == nil {
				if target.activity != ActivityCallingLLM {
					r.releaseLLM(target.threadItemID)
				}
				continue
			}
			if arr := r.doc.GetThreadItemsArray(target.threadItemID); arr != nil {
				items = r.doc.GetReducerItemsFromArray(arr)
			}
		} else {
			items = r.doc.GetReducerItems()
		}
		isRoot := target.threadItemID == ""

		action := decideNextAction(items, target.activity, isRoot, r.isExplicitContinuation(target.threadItemID))

		switch action {
		case ActionNone:
			// Queue EVERY incomplete child, not the first one only. A parent that
			// spawned several children in one multi-tool-use turn parks on all of
			// them at once, and stopping at the first would let whichever child ran
			// hide the rest for as long as it ran: they would be dispatched in spawn
			// order, one per completion, whatever their capability. Admission is
			// what decides how many of them may then go at once — read-only
			// siblings together, a write-capable one alone (canAdmitThread) — and it
			// cannot decide anything about a thread the walk never offers it.
			//
			// A child a live run already owns is queued like any other and refused
			// by admission; walking through it is how a thread nested below one is
			// still reached.
			for _, item := range effectiveItems(items) {
				// Asked of the THREAD, not of one call into it: descending is about
				// finding a transcript with work left to do, and the thread's
				// latest run is what says whether there is any. An alias holds no
				// transcript at all — the thread it is a view of stands in this
				// same array and is considered on its own.
				if item.Type != ItemTypeThread || item.AliasOf != "" || threadRunSettled(item) {
					continue
				}
				// Never descend into a brand-new EMPTY child thread. The only
				// legitimate auto-run of an empty thread is an explicit
				// continuation (continueInNewThread / the pendingRequests
				// orchestrator): those call requestLLM(newThreadID) so the
				// thread is the walk's ANCHOR, seeded above — never reached
				// by descending here. Descending into an empty child instead
				// borrows the PARENT's awaiting_llm marker (left by the parent's
				// own pending tool/turn) and fires an LLM call on a thread the
				// user just created via the "New Thread" button and has not yet
				// sent a message to — the "new thread immediately starts running"
				// bug. An empty/unreadable child is therefore not a descent
				// target; it rests until the user sends a message.
				childArr := r.doc.GetThreadItemsArray(item.ItemID)
				if childArr == nil || len(effectiveItems(r.doc.GetReducerItemsFromArray(childArr))) == 0 {
					continue
				}
				// A child holding a run of its own is evaluated on that run's
				// activity; one holding none inherits its parent's, which is what
				// carries a parked parent's awaiting_llm down to the children it is
				// parked on. Inheriting unconditionally would hand every sibling
				// whichever activity the anchor happened to carry — so a child
				// reached below a sibling mid-call would read as calling_llm and be
				// refused by the reducer's own in-flight guard, before admission
				// ever saw it.
				childActivity := r.threadActivity(item.ItemID)
				if childActivity == ActivityNone {
					childActivity = target.activity
				}
				queue = append(queue, walkTarget{threadItemID: item.ItemID, activity: childActivity})
			}

		case ActionCallLLM:
			// Dispatch and keep walking. The queue behind this thread holds its
			// siblings, and they are dispatched in this same pass rather than one
			// per pass — so a batch of read-only children all start together
			// instead of arriving staggered across reconcile ticks. A dispatch the
			// admission gate refuses re-raises the reconcile bit itself.
			r.dispatchCallLLMOnThread(target.threadItemID)

		case ActionGoIdle:
			// All tools were denied/cancelled while activity was "awaiting_llm".
			// If the user queued a follow-up while the turn was parked, a denial
			// means "drop these, run what I just said": continue the turn instead
			// of resting (the strategy loop promotes the queue at its top). With
			// nothing queued, this is a plain stop — promote (a no-op) and rest.
			//
			// Park-on-executing is enforced upstream in handleCancel: an Escape
			// while a tool is actually running cancels everything and writes idle
			// (clearing awaiting_llm) BEFORE the reducer runs, so this continue
			// only ever fires when the block was purely tool approvals.
			//
			// Resting writes conversation-wide state, so the pass ends here rather
			// than carrying on with a queue built before it. The reconcile bit brings
			// the next pass, which sees what resting left behind.
			if r.hasPendingItems(target.threadItemID) {
				r.dispatchCallLLMOnThread(target.threadItemID)
				return
			}
			r.restPromotingQueue(target.threadItemID)
			r.sched.markReconcile()
			return
		}
	}
}

// restPromotingQueue is the promote-and-idle exit: it drains any queued
// ("interject while busy") messages into the thread as ordinary user items and
// rests at idle. Shared by the reducer's ActionGoIdle rest branch and the polite
// stop (Pause) boundaries — a polite stop reaches the SAME exit a hard stop
// reaches via finalizeCancellation's tail, so queued messages simply become
// normal user bubbles sitting at idle with no polite-specific handling.
func (r *run) restPromotingQueue(threadItemID string) {
	r.promotePendingItems(threadItemID)
	// Release the NAMED thread's claim. An idle frame drops only the claim its
	// own run holds, and the reducer rests threads it is not itself running —
	// so leaving this to the frame would keep the entry standing, keep the
	// projection reporting it, and hand the next reconcile pass the same
	// ActionGoIdle it just handled.
	r.releaseLLM(threadItemID)
	r.sendStatus("idle", "")
}

// dispatchCallLLMOnThread is the reducer's action handler for ActionCallLLM.
// It claims the in-flight marker for the given thread, sets up thread
// context, and runs a single LLM turn. If the LLM creates async tools
// or a child thread, the loop sets activity="awaiting_llm" and returns.
// The reducer re-dispatches when all work completes.
func (r *run) dispatchCallLLMOnThread(threadItemID string) {
	// Only dispatch when the worker is idle. If state is mid-transition
	// (the previous turn's deferred cleanup hasn't flipped back to Idle yet),
	// re-tickle the reducer so the next event-loop tick retries — otherwise
	// the request is orphaned until some other event re-wakes the loop, which
	// presents to the user as "user message appended but LLM loop never starts;
	// hitting Continue kicks it off".
	//
	// The live registry is what admits a thread: one run per thread, one
	// write-capable run at a time, and the read-only ceiling.
	if !r.canAdmitThread(threadItemID) {
		r.sched.markReconcile()
		return
	}

	// Polite stop (Pause): a mark stands over this thread, so it rests before the
	// next LLM turn. This is the sole entry into runStrategyLoop, and the reducer
	// only reaches ActionCallLLM once every tool in the batch is terminal — so
	// in-flight work has already drained and committed its real results.
	// Take the shared promote-and-idle exit instead of driving a fresh turn; the
	// transcript is a clean, resumable prefix.
	//
	// The mark is left standing (only a human lifts one), so this branch is
	// reached again every time the walk offers this thread — hence the guard:
	// resting a thread that holds no claim and has nothing queued would write an
	// idle frame per reconcile pass, for a thread already at rest.
	if r.politeStopCovers(threadItemID) {
		if r.threadActivity(threadItemID) != ActivityNone || r.hasPendingItems(threadItemID) {
			r.restPromotingQueue(threadItemID)
		}
		return
	}

	// A usage cap this conversation has already met stands over every thread on
	// that provider until it lifts. The thread that met it reported it; the rest
	// take the same promote-and-idle exit a pause takes, leaving a clean,
	// resumable prefix, because there is nothing they could send that the account
	// would answer. Same guard as the pause branch: resting a thread that holds no
	// claim and has nothing queued would write an idle frame per reconcile pass.
	//
	// Nothing wakes the conversation when the cap lifts, and that is deliberate —
	// the reset is hours away and the user's next message is what starts it again.
	//
	// Gated on there being any hold at all, so the ordinary dispatch — every
	// dispatch, on every turn — does not pay for a document read to resolve a
	// provider name nothing is going to be compared against.
	if mc := r.rateLimitedModelConfig(threadItemID); mc != nil {
		if r.threadActivity(threadItemID) != ActivityNone || r.hasPendingItems(threadItemID) {
			r.restPromotingQueue(threadItemID)
		}
		return
	}

	// Transition this thread from "awaiting_llm" → "calling_llm".
	// Consume the one-shot continuation marker only once we are actually going
	// to dispatch; if the dispatch is refused, leave it for the next reconcile tick.
	//
	// The live registry reserves the capability slot; the document claim is the
	// same-thread compare-and-set backstop.
	if !r.claimLLM(threadItemID) {
		// A turn is already in flight — re-tickle so the next reconcile
		// tick picks this up after that call completes.
		r.sched.markReconcile()
		return
	}
	explicitContinuation := r.consumeExplicitContinuation(threadItemID)

	// Set up the run this turn executes on, from doc state. Under a live run loop
	// that is a goroutine of its own, so the mailbox keeps being served — a
	// cancel, a pause or a sync update arriving mid-stream is handled while the
	// turn streams rather than after it.
	tr := r.beginTurn(threadItemID)

	// Turn-scoped anchor: only stamp the start when beginning a fresh turn (from
	// idle, where it was zeroed). Preserving it across re-dispatches within a turn
	// keeps the spinner's elapsed digit measuring the whole turn, instead of
	// resetting to 0 every time a tool completes and the next LLM call dispatches.
	// seedTurnBoundary is what carries it from one dispatch to the next.
	if tr.t.processingStartedAt.Load() == 0 {
		tr.t.processingStartedAt.Store(time.Now().UnixMilli())
	}
	tr.storeState(StateProcessing)
	tr.sendStatus("preparing", "")
	tr.batcher.Flush()
	r.runTurn(tr, func(tr *run) {
		tr.runStrategyLoopWithIntent("", true, explicitContinuation)
	})
}

// selectThreadFallbackResult returns a run's trailing assistant text — what a
// run at rest returns to its caller, and what it writes as the thread's
// summary. It yields the content ONLY when the last effective item is a
// non-empty assistant message, i.e. the LLM produced a final reply. Any
// trailing tool-action, meta-tool-result, user, or thread item means there is
// no clean trailing reply, so it returns "" and the run settles as barren
// rather than passing stale or unrelated text off as an answer.
func selectThreadFallbackResult(items []ConversationItem) string {
	eff := effectiveItems(items)
	if len(eff) == 0 {
		return ""
	}
	last := eff[len(eff)-1]
	if last.Type != ItemTypeAssistant || last.Content == "" {
		return ""
	}
	return last.Content
}

// clearThreadResult discards a thread's summary — the first half of a
// re-summarise — along with the mark that says a human authored it, so the run
// that writes the new one is free to. It does not change what the thread can do:
// a thread is running or stopped, and a stopped thread always accepts work.
// Uses authorID as the transaction origin so the operation is tracked by the
// UndoManager and can be undone. The null item created here has Go's clientID,
// which is required for RedoItem to succeed when undoing the clear.
func (w *ConversationWorker) clearThreadResult(threadItemID string) bool {
	// StopCapturing must be called outside ycrdtMu (it takes its own internal
	// lock against the undo manager's afterTransaction handler).
	ycrdtMu.Lock()
	threadYMap := findThreadYMap(w.doc.getItems(), threadItemID)
	if threadYMap == nil {
		ycrdtMu.Unlock()
		return false
	}
	if existingResult, _ := threadYMap.Get("result").(string); existingResult == "" {
		ycrdtMu.Unlock()
		return false // already open
	}
	ycrdtMu.Unlock()

	w.tracker.StopCapturing()

	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	// Re-resolve under the same lock window as the write. The pointer from
	// the existence-check above could have been invalidated by a sync update
	// applied between releasing and re-acquiring.
	threadYMap = findThreadYMap(w.doc.getItems(), threadItemID)
	if threadYMap == nil {
		return false
	}
	w.doc.transactTracked(func(_ *ycrdt.Transaction) {
		threadYMap.Set("result", nil)
	})
	return true
}
