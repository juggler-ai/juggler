//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"

	ycrdt "github.com/skyterra/y-crdt"
)

// A thread is opened in one of two ways, and each has its own entry point:
//
//   - spawnThread: a model's tool call opened it (create_thread, or a
//     delegatesToSubthread tool). It is created in the calling run's own thread,
//     stamped llmCreated, and carries a toolSpawn: the tool_use it answers, and
//     the handle and claims its caller gave it. Nothing dispatches it here; the
//     strategy loop parks on hasIncompleteThreads and the reducer picks it up.
//   - dispatchThread: something outside a model's turn asked for it (the browser's
//     create-thread message, or a strategy's createThread through
//     pendingRequests). The whole conversation must be idle and a model chosen.
//     It is created at the root unless a parent is named, stamped
//     strategyCreated, and dispatched straight away.
//
// Both describe the thread itself with a threadSpec, and both insert it through
// insertThread. Only a spawn carries tool coordinates, which is why they are a
// separate argument rather than fields an external dispatch would leave empty.

// threadSpec is what a new thread is, whoever asks for it.
type threadSpec struct {
	Goal   string
	Prompt string

	// ResultSpec, when set, is the caller's contract for what the child's last
	// message must contain — the run's last message is what the caller
	// receives. It is appended to the invocation message so the child acts on it.
	// Optional: an empty spec changes nothing.
	ResultSpec string

	// IsContinuation opens the thread with no invocation message and no seeded
	// context: the items it continues already carry both.
	IsContinuation bool

	// ParentThreadItemID, if non-empty, names the thread the new one is created
	// in. Empty means the calling run's own thread for a spawn, and the root for
	// a dispatch.
	ParentThreadItemID string

	// StrategyID and ModelConfigJSON, when set, override the new thread's
	// strategy and model — stamped on its Y.Map as currentStrategyId /
	// modelConfig so getEffectiveStrategyId / ResolveEffectiveModelConfig
	// resolve them. Used by user-defined subthread commands and by subagent
	// specs to run a prompt under a different (e.g. read-only) strategy or model
	// than the parent. ModelConfigJSON is the JSON encoding of a
	// {provider, model, ...} object; empty/invalid leaves the thread inheriting
	// the parent's model.
	StrategyID      string
	ModelConfigJSON string
}

// toolSpawn is what a thread opened by a model's tool call carries beyond its
// spec: the call it answers, and what that call said about it.
type toolSpawn struct {
	// Tool-use coordinates: when set, these are stamped as a run record on the
	// invocation message this creation appends, so the parent's buildMessages can
	// reconstruct the tool_use/tool_result pair the LLM expects to see. Holding
	// them per-message rather than on the thread is what lets the thread be
	// invoked more than once — each call appends its own stamped message.
	// A creation with no invocation message (a continuation, or an empty prompt)
	// falls back to stamping the thread Y.Map, the scalar shape every document
	// written before run records existed uses.
	ToolUseID string
	ToolName  string
	ToolInput json.RawMessage
	// RunGoal is the resolved short label for this invocation. It is stored apart
	// from ToolInput because delegating tools may call their detailed instruction
	// field task, question, prompt, or anything else.
	RunGoal string

	// SessionName is the handle this thread answers to within the thread that
	// called it: a later call naming it invokes THIS thread again instead of
	// spawning a fresh one (see sessions.go). Stamped on the thread Y.Map, where
	// resolveSession reads it back.
	SessionName string

	// Delegated marks a thread spawned by a delegatesToSubthread tool (not the
	// create_thread meta-tool). It is stamped onto the thread Y.Map, where
	// withinDelegatedThread reads it to keep a delegated child from starting a
	// further delegation.
	Delegated bool

	// ReadOnly marks a thread whose run cannot change anything outside its own
	// transcript, carried from the spawning tool's readOnlySubthread manifest
	// claim. It is stamped onto the thread Y.Map rather than kept on the turn
	// because the child is dispatched long after the turn that asked for it, and
	// the reducer is what needs the answer: a read-only child may run alongside
	// its siblings, where any other child must wait its turn.
	//
	// Nothing verifies the claim. It is the spawning item's assertion about the
	// agent it seeds, and the cost of overstating it is siblings racing.
	ReadOnly bool
}

// structuredToolInput converts a tool input's raw JSON to the structured value a
// thread Y.Map stores it as, the way conversationItemToYMap stores every other
// json.RawMessage field. Returns nil for empty or non-object input, which the
// caller stamps as absent.
//
// Storing the raw bytes as a Go string would round-trip through yMapRawJSON as a
// JSON-encoded *string literal*, which buildToolUseMap then fails to unmarshal
// into map[string]any — the wire payload reaches the provider with "input": null
// and the model rejects/ignores the tool_use block.
func structuredToolInput(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	return convertToYcrdt(parsed)
}

// spawnThread opens the thread a model's tool call asked for, in the calling
// run's own thread unless spec names another, and returns its itemId. It leaves
// the dispatch to the reducer. The caller has already applied the runaway guards
// (executeCreateThread, tryDelegateTool).
func (r *run) spawnThread(spec threadSpec, call toolSpawn) (string, error) {
	if call.RunGoal == "" {
		call.RunGoal = spec.Goal
	}
	parent, err := r.creationParent(spec.ParentThreadItemID, r.t.thread)
	if err != nil {
		return "", err
	}
	return r.insertThread(spec, call, parent, "llmCreated"), nil
}

// dispatchThread opens a thread nobody's turn asked for (see the comment above
// threadSpec), at the root unless spec names a parent, and dispatches its run.
//
// Conversation-wide: it starts a run of its own, so any run in flight anywhere
// refuses it, and so does a conversation with no model to run it on.
func (r *run) dispatchThread(spec threadSpec) (string, error) {
	if state := r.anyRunState(); state != StateIdle {
		return "", fmt.Errorf("worker not idle (state=%s)", state)
	}
	parent, err := r.creationParent(spec.ParentThreadItemID, threadContext{})
	if err != nil {
		return "", err
	}
	mc := r.doc.ResolveEffectiveModelConfig(spec.ParentThreadItemID)
	if mc == nil || mc.Model == "" {
		return "", fmt.Errorf("please select a model before creating a thread")
	}

	// Auto-name trigger for the conversation whose FIRST user action was to
	// dispatch a subthread — a `run: subthread` command typed into an empty
	// tab, which asks for work without ever appending a root user message,
	// so the trigger in handleSendMessage never sees it and the tab stays
	// "Untitled N" for a conversation that plainly has a subject. The prompt
	// is that subject. Restricted to a dispatch from root scope, because a
	// child of some existing thread is not what the conversation is about,
	// and to the same once-only and name-provenance guards the message path
	// uses (metaAutoNamed, NameIsProvisional), so the later root message
	// that usually follows does not retitle the tab.
	if spec.ParentThreadItemID == "" && !spec.IsContinuation && r.autoNameFunc != nil &&
		strings.TrimSpace(spec.Prompt) != "" && !r.hasAutoNamed() && r.NameIsProvisional() {
		r.fireAutoName(spec.Prompt, mc.Provider, mc.Model, mc.Thinking, false)
	}

	threadItemID := r.insertThread(spec, toolSpawn{}, parent, "strategyCreated")
	r.requestLLM(threadItemID)
	r.requestReconcile()
	return threadItemID, nil
}

// creationParent resolves the thread a new one is created in: the named one
// when parentThreadItemID is set, and fallback otherwise.
func (r *run) creationParent(parentThreadItemID string, fallback threadContext) (threadContext, error) {
	if parentThreadItemID == "" {
		return fallback, nil
	}
	named, ok := r.resolveThread(parentThreadItemID)
	if !ok {
		return threadContext{}, fmt.Errorf("thread item %s not found", parentThreadItemID)
	}
	return named, nil
}

// insertThread writes a new thread into parent and returns its itemId: the
// container, its stamped fields, the seeded context and the invocation message,
// as one undo unit. createdBy is the flag that says which entry point opened it
// ("llmCreated" or "strategyCreated"). It decides nothing; both entry points
// have already done that.
func (r *run) insertThread(spec threadSpec, call toolSpawn, parent threadContext, createdBy string) string {
	if spec.Goal == "" {
		spec.Goal = "Thread"
	}

	// A thread creation is one undo unit: the thread container, its stamped
	// fields, the cloned seed context, and the seed prompt all collapse into a
	// single group so one undo removes the whole child (no orphaned seeds or seed
	// prompt left behind). Close the prior capture window and snapshot the stack
	// height; every tracked write below lands at or after this index, and
	// MergeFromIndex folds them together once creation completes.
	r.tracker.StopCapturing()
	createMergeFrom := r.tracker.UndoStackLen()

	// Whether this creation appends an invocation message to carry the run
	// record. It normally does — every tool-driven creation supplies a prompt —
	// and then the tool-use coordinates live there, one set per run, so the
	// thread can be invoked again later. A continuation or an empty prompt has no
	// message to stamp, so those fall back to the scalar thread-level fields and
	// describe the single invocation they always did.
	stampsInvocation := !spec.IsContinuation && spec.Prompt != ""

	// Create thread item with nested Y.Array (in the parent's array). Use the
	// tracker (authorID origin) so the insertion is tracked by the UndoManager and
	// can be undone independently.
	targetArr := r.itemsArrayIn(parent)
	insertIdx := r.itemsLengthIn(parent)
	nestedItems := r.tracker.InsertThreadIntoArray(targetArr, insertIdx, spec.Goal)

	// Get the thread's itemId and store tool_use coordinates (for LLM-created
	// threads) on the thread Y.Map.
	var threadItemID string
	var threadYMap *ycrdt.YMap
	ycrdtMu.Lock()
	raw := targetArr.Get(ycrdt.Number(insertIdx))
	if m, ok := raw.(*ycrdt.YMap); ok {
		threadYMap = m
		threadItemID, _ = m.Get("itemId").(string)
		r.doc.transactTracked(func(_ *ycrdt.Transaction) {
			if spec.ResultSpec != "" {
				m.Set("resultSpec", spec.ResultSpec)
			}
			if call.SessionName != "" {
				m.Set("sessionName", call.SessionName)
			}
			m.Set(createdBy, true)
			// Optional per-thread strategy/model overrides (user-defined
			// subthread commands). Stamped so getEffectiveStrategyId /
			// ResolveEffectiveModelConfig resolve them on the new thread.
			if spec.StrategyID != "" {
				m.Set("currentStrategyId", spec.StrategyID)
			}
			if spec.ModelConfigJSON != "" {
				var mc map[string]any
				if err := json.Unmarshal([]byte(spec.ModelConfigJSON), &mc); err == nil && len(mc) > 0 {
					m.Set("modelConfig", convertToYcrdt(mc))
				}
			}
			if call.Delegated {
				m.Set("delegated", true)
			}
			if call.ReadOnly {
				m.Set("readOnly", true)
			}
			if call.ToolUseID != "" {
				if stampsInvocation {
					// The run selector: this item is the parent's view of the run
					// the invocation message below starts. A later call into the
					// same session appends its own alias item carrying its own
					// selector, so each parent item answers for one run and the
					// wire emits each call's pair where the call was made.
					m.Set("runToolUseId", call.ToolUseID)
					m.Set("runToolName", call.ToolName)
					if call.RunGoal != "" {
						m.Set("runGoal", call.RunGoal)
					}
					if input := structuredToolInput(call.ToolInput); input != nil {
						m.Set("runToolInput", input)
					}
				} else {
					// No invocation message to select: the coordinates live on the
					// thread itself and describe the single invocation they always
					// did.
					m.Set("toolUseId", call.ToolUseID)
					m.Set("toolName", call.ToolName)
					if input := structuredToolInput(call.ToolInput); input != nil {
						m.Set("toolInput", input)
					}
				}
			}
		})
	}
	ycrdtMu.Unlock()

	// Seed the new thread's starting context by cloning the parent's standing
	// items (system prompt, agents files, memory) into the head of the child's
	// array, each with a fresh id. targetArr is the parent array (root array
	// when creating at root scope). Continuations already carry their seeds.
	if !spec.IsContinuation {
		r.tracker.SeedThreadFromParent(targetArr, nestedItems, threadYMap)
	}

	// Insert the invocation message into the child thread's items array, AFTER
	// the seeds so the starting context reads top-to-bottom and stays the leading
	// run at this depth. When a resultSpec is set, append it as an explicit
	// return contract at the point of action (the child's own first message):
	// the run's last message is what the caller receives, so the contract is a
	// contract on that message.
	//
	// The tool-use coordinates ride on THIS message rather than the thread Y.Map,
	// so the pairing belongs to the run this message starts rather than to the
	// thread for all time — which is what lets the thread be invoked again later,
	// each invocation appending its own stamped message (resumeSession appends
	// the identical shape).
	if stampsInvocation {
		r.tracker.AppendMessageIntoArray(nestedItems, invocationMessage(spec, call))
	}

	// Collapse the container insert, field stamps, seeds, and seed prompt into one
	// undo group, then close it so any subsequent dispatch or turn content forms
	// its own separate groups.
	r.tracker.MergeFromIndex(createMergeFrom)
	r.tracker.StopCapturing()

	return threadItemID
}

// promoteThreadSpawnCapable stamps canSpawnThreads=true on the thread a human
// just sent a genuine message into, so that thread's agent may itself call
// create_thread. The non-recursive-thread rule keys on whether a human is
// STEERING a thread, not on who CREATED it: a thread a person has messaged (or
// created via /thread) may spawn, so recursion is gated on human attention.
//
// An LLM-spawned child is still born a leaf (canSpawnThreads unset) — it only
// becomes spawn-capable once a human opens it and drives it directly, so LLM→LLM
// →LLM recursion still cannot happen without a person in the loop. maxThreadDepth
// and maxLiveThreads remain the backstops behind this gate.
//
// No-ops that must never promote:
//   - Root ("") already has the full tool list; nothing to stamp.
//   - Delegated subthreads (delegated=true) are tool-result-bound — each run
//     settles into the caller's tool_result — so making one spawn-capable would
//     be a nonsensical state; the withinDelegatedThread guard is the sole
//     authority there.
//
// Called from handleSendMessage on the genuine-user-message path only (never the
// parent-LLM seed insert in createThread), so the seed prompt a parent injects
// into its child can never trip this — that separation is the safety argument.
func (w *ConversationWorker) promoteThreadSpawnCapable(threadItemID string) {
	if threadItemID == "" {
		return // root: full tool list already
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	m := findThreadYMap(w.doc.getItems(), threadItemID)
	if m == nil {
		return
	}
	if delegated, _ := m.Get("delegated").(bool); delegated {
		return // delegated subthread: never promote
	}
	if already, _ := m.Get("canSpawnThreads").(bool); already {
		return // already spawn-capable (e.g. a /thread-created thread)
	}
	w.doc.transactTracked(func(_ *ycrdt.Transaction) {
		m.Set("canSpawnThreads", true)
	})
	w.log.Info("[worker] promoted thread %s to spawn-capable (user-steered)", threadItemID)
}

// maxThreadDepth caps how deeply create_thread may nest threads. Root is depth
// 0, a thread directly under it depth 1; a thread at this depth may no longer
// spawn a child. It is a runaway backstop, not a workflow limit — the deepest
// legitimate nesting in practice is two or three levels — so an LLM that keeps
// delegating instead of doing the work itself is stopped before it recurses
// without bound. Guards only the LLM tool path, not user/orchestrator dispatch.
// The per-thread canSpawnThreads capability filter (filterToolsForThread in
// llm_request.go) withholds create_thread from every thread except root and
// human-steered threads (those a user created via /thread or has sent a message
// into), so this and maxLiveThreads mainly bound the fan-out reachable from those
// threads — they are the backstop behind that capability gate.
const maxThreadDepth = 3

// maxLiveThreads caps how many LLM-spawned threads may be in flight (llmCreated,
// no result yet) across the whole document at once. Where maxThreadDepth bounds
// nesting along a single chain, this bounds fan-out across the whole tree: a
// model that keeps decomposing one task into fresh subthreads without ever
// deepening the chain stays within the depth cap but explodes in breadth (N
// children per level ≈ N^depth threads). This is the backstop the depth cap
// misses. It counts only in-flight threads, so it self-heals as children settle
// — legitimate sequential delegation never approaches it, while a runaway
// fan-out trips it fast. Guards only the LLM tool path.
//
// EVERY tool that opens a thread is charged against it — create_thread and the
// delegating tools (Explore, Research, WebFetch) alike. They all spawn the same
// kind of child and all count toward liveThreadCount, so a budget one of them
// was exempt from was not a budget: the exempt tools could fill it and then keep
// going, while starving the one tool that did check.
//
// Set below the point at which the children could all be running, because
// maxConcurrentReadOnlyThreads holds the simultaneous ones to a handful: past
// this many in flight, a model is opening work it cannot get to, and the honest
// answer is to say so rather than to queue it out of sight.
const maxLiveThreads = 8

// threadBreadthRefusal is what a caller is told when maxLiveThreads turns its
// call down. One wording for every tool that can trip it, because the cap is one
// budget and a model reading two different explanations of the same limit would
// have to work out that they are the same limit.
//
// It names the count, since a refusal a model cannot act on just gets retried:
// this one says what stopped the call, what to do instead, and that waiting
// fixes it — which is true, the count drops as children settle.
func threadBreadthRefusal(toolName string, live int) string {
	return fmt.Sprintf("%s refused: too many threads (%d) are already in progress. "+
		"Do this work inline in the current thread, or wait for running threads "+
		"to finish before calling it again.", toolName, live)
}

// executeCreateThread handles the create_thread tool: parses tool input and
// either continues the session it names or opens a new thread via
// spawnThread. Called from processLLMResponse when the LLM emits a
// create_thread block.
func (r *run) executeCreateThread(toolUseID, toolName string, toolInput json.RawMessage) error {
	var input struct {
		Goal       string `json:"goal"`
		Prompt     string `json:"prompt"`
		ResultSpec string `json:"resultSpec"`
		Session    string `json:"session"`
	}
	if err := json.Unmarshal(toolInput, &input); err != nil {
		return fmt.Errorf("failed to parse create_thread input: %w", err)
	}
	if input.Prompt == "" {
		return fmt.Errorf("create_thread: prompt is required")
	}

	// A named session that already exists is invoked again rather than
	// respawned: this call's prompt becomes the next message in the transcript
	// that thread already has. Resolved before the guards below because
	// continuing a thread creates nothing — it neither deepens the tree nor
	// widens it, so neither cap has anything to say about it.
	session := r.resolveSession(toolName, input.Session)
	spec := threadSpec{
		Goal:       input.Goal,
		Prompt:     input.Prompt,
		ResultSpec: input.ResultSpec,
	}
	call := toolSpawn{
		ToolUseID:   toolUseID,
		ToolName:    toolName,
		ToolInput:   toolInput,
		RunGoal:     input.Goal,
		SessionName: session.name,
	}
	if session.busy {
		r.addMetaToolResult(toolUseID, toolName, toolInput, sessionBusyMessage(session.name), true)
		return nil
	}
	if session.resumeThreadID != "" {
		return r.resumeSession(session.resumeThreadID, spec, call)
	}

	// Runaway-recursion guard. The would-be child sits one level below the
	// current processing thread; refuse if that parent is already at the depth
	// cap. The refusal is emitted as a meta-tool-result so the parent's next
	// turn sees a tool_result paired with its own create_thread tool_use (not a
	// dangling tool_use the provider would reject) and is told to continue the
	// sub-task inline rather than spawn another thread.
	if depth := r.doc.threadDepth(r.t.thread.itemID); depth >= maxThreadDepth {
		msg := fmt.Sprintf("create_thread refused: thread nesting depth limit (%d) reached. "+
			"Do this sub-task inline in the current thread instead of spawning another thread.", maxThreadDepth)
		r.addMetaToolResult(toolUseID, toolName, toolInput, msg, true)
		return nil
	}

	// Runaway fan-out guard. The depth cap above bounds a single chain but not
	// breadth: a model that re-delegates the same task into ever more sibling
	// subthreads stays shallow yet explodes in count. Refuse once too many
	// create_thread children are already in flight, using the same paired
	// meta-tool-result so the parent turn isn't stranded. Self-heals: the count
	// drops as children settle, so this throttles a runaway without
	// permanently disabling the tool.
	if live := r.doc.liveThreadCount(); live >= maxLiveThreads {
		r.addMetaToolResult(toolUseID, toolName, toolInput, threadBreadthRefusal(toolName, live), true)
		return nil
	}

	// Runaway SPEND guard. Depth bounds the shape of the tree, breadth its width,
	// and the run budget how far one child runs; none of them bounds what the
	// conversation as a whole has cost, which is the figure the person paying is
	// actually exposed to. Past the ceiling, opening another thread is the one
	// thing worth refusing outright — a fresh transcript to grow and re-send every
	// turn — while the runs already going are landed at their next boundary
	// (announceSpendCeiling) rather than cut off mid-sentence.
	if r.spendCeilingReached() {
		spent, _ := r.conversationSpend()
		r.addMetaToolResult(toolUseID, toolName, toolInput, spendCeilingRefusal(toolName, spent, r.spendCeiling()), true)
		return nil
	}

	_, err := r.spawnThread(spec, call)
	return err
}

// handleCreateThread handles a create-thread request from the browser.
// Non-blocking: creates the thread item + user message, signals the reducer to
// dispatch, and returns the threadItemId via WS response.
//
// None of the three runaway guards above applies here — no depth cap, no breadth
// cap, no spend ceiling — and that is the difference between a request and a
// decision. Those guards bound a MODEL decomposing work inside its own turn
// loop, where each refusal has a tool_use to answer and the next turn to act on
// it. A request that arrives over the wire has already been decided somewhere
// else, and it cannot join a runaway in any case: dispatchThread requires the
// whole conversation to be idle, and a fan-out is by definition runs in flight.
//
// The same is true of the pending-request route (claimAndDispatchPendingEntry's
// createThread arm), which calls dispatchThread directly. Between them they are
// every way a thread is opened without a model asking.
//
// The only sender of this message is WorkerManager#createThread
// (web/js/services/worker-manager.js), which nothing in the tree calls: strategy
// plugins open threads through the SDK's createThread primitive, which takes the
// pending-request route instead.
func (r *run) handleCreateThread(payload json.RawMessage) {
	var msg CreateThreadMessage
	if !r.decodePayload("create-thread", payload, &msg) {
		return
	}
	// A thread the human asked for is human intent, so it lifts the pause
	// standing over the thread it is created under, as a send into that thread
	// does. Asked of the PARENT because the child does not exist yet,
	// and a mark over the parent stands over the child. This lives here rather
	// than in dispatchThread because dispatchThread also serves the
	// pendingRequests orchestrator, which is not a human asking.
	r.dropPoliteStopsCovering(msg.ThreadItemID)

	threadItemID, err := r.dispatchThread(threadSpec{
		Goal:               msg.Goal,
		Prompt:             msg.Prompt,
		IsContinuation:     msg.IsContinuation,
		ParentThreadItemID: msg.ThreadItemID,
	})
	if err != nil {
		r.send(map[string]any{
			"type":      "create-thread-response",
			"requestId": msg.RequestID,
			"error":     err.Error(),
		})
		return
	}
	r.send(map[string]any{
		"type":         "create-thread-response",
		"requestId":    msg.RequestID,
		"threadItemId": threadItemID,
	})
}
