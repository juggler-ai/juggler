//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
	"juggler/internal/logpaths"

	ycrdt "github.com/skyterra/y-crdt"
)

// sendReadyWithDocMetadata collects the standard set of metadata keys from the
// Yjs doc and calls sendReadyWithMetadata. Used on both the reconnect path and
// the first-init path so the two call sites stay in sync.
func (w *ConversationWorker) sendReadyWithDocMetadata() {
	metadata := make(map[string]any)
	for _, key := range []string{"created", "defaultModelConfig", "currentStrategyId"} {
		if v := w.doc.GetMetadata(key); v != nil {
			metadata[key] = v
		}
	}
	w.sendReadyWithMetadata(metadata)
}

func (r *run) handleInit(payload json.RawMessage) {
	var msg InitMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		r.log.Error("Failed to parse init message: %v", err)
		r.sendError("Failed to parse init message", "")
		return
	}

	// Reconnect path: viewer reconnected to an already-initialized worker.
	// Do NOT cancel processing, reload from disk, or reset processingState —
	// just update config, sync the reconnecting client, and return.
	if r.initialized {
		// Only an attach to a busy worker is worth a line. A page load inits
		// every conversation in the project, from every client, so logging the
		// idle case buries the log in one identical line per open tab per load.
		if state := r.anyRunState(); state != StateIdle {
			r.log.Debug("Client attached mid-turn (conv=%s, state=%s)", r.conversationID, state)
		}
		r.tape.Record("init", map[string]any{
			"path":         "reconnect",
			"origin":       r.replyTo,
			"loadFromDisk": msg.Conversation.LoadFromDisk,
			"delta":        len(msg.StateVector) > 0,
		})

		// Sync the attaching client with current Yjs state. That sync already
		// carries metadata.undoState, so no separate undo-state write is needed —
		// and none is safe: an attach must be read-only on the doc. Other viewers
		// can see this sync, so a doc mutation here would let one client's mere
		// attach perturb a turn (and its undo capture window) another viewer has
		// in flight.
		//
		// A client that already holds the document says so with its state vector
		// and gets only the ops it lacks, addressed to it alone. A client that
		// sends none holds nothing, so full state is what it needs — and that goes
		// out on the broadcast path, which is also how a freshly attached engine
		// picks up a conversation it has never seen.
		if len(msg.StateVector) > 0 {
			if delta := r.doc.GetStateUpdate(msg.StateVector); len(delta) > 0 {
				r.replyWS(marshalYjsSync(delta, false))
			}
		} else {
			r.broadcastFullState()
		}

		// Send ready with metadata if requested. The conversation name is
		// the folder name on disk and lives on the session manifest, not
		// in the Yjs doc — so we don't include it here.
		if msg.Conversation.LoadFromDisk {
			r.sendReadyWithDocMetadata()
		} else {
			r.sendReady()
		}
		return
	}

	// First-init path: full initialization
	r.tape.Record("init", map[string]any{
		"path":         "first",
		"origin":       r.replyTo,
		"loadFromDisk": msg.Conversation.LoadFromDisk,
	})
	r.projectPath = msg.Config.ProjectPath
	r.txnStore = NewTransactionStore(r.pathProvider)
	r.assetStore = NewAssetStore(r.pathProvider)

	// Open this conversation's own log file (in addition to the process-wide
	// server.log) so a conversation's worker activity can be read in isolation.
	// The filename is prefixed with the current tab name for easy browsing, with
	// the stable conv id as the authoritative suffix. Only when on-disk logging
	// is actually enabled; otherwise r.log stays nil and the nil-safe handle
	// routes to the process sink + console alone.
	if jlog.FileLoggingEnabled() {
		path := logpaths.ConversationLogPath(r.projectPath, r.conversationID, r.conversationName())
		r.log = jlog.NewLogger(path, 10, 5)
	}

	initStart := time.Now()

	// Track whether we loaded from disk to determine what metadata to send
	loadedFromDisk := false

	// Load existing Yjs state from disk (for existing conversations)
	// mustExist=true when loading from disk: missing file means the conversation
	// was orphaned (e.g. app quit before worker could save) — report error so
	// frontend removes it from conversationOrder.
	if err := r.loadStateFromDisk(msg.Conversation.LoadFromDisk); err != nil {
		r.log.Error("Failed to load state from disk: %v", err)
		if msg.Conversation.LoadFromDisk {
			r.sendError(fmt.Sprintf("Conversation data not found: %v", err), "")
			return
		}
	} else {
		// Successfully loaded from disk
		loadedFromDisk = true
	}

	// Initialize the items Y.Array on the worker side, making the worker the
	// SOLE creator of root["items"]. If both worker and browser independently
	// created the array, the Yjs Y.Map conflict resolution discards one (and
	// with it the browser's SYSTEM_1). Flushing the doc state to the viewer
	// before sendReady lets the viewer's activateYjsSync see the array as
	// already present so it doesn't try to create a competing one.
	r.tracker.EnsureInitialized()
	if !msg.Conversation.LoadFromDisk {
		r.batcher.Flush()
	}

	// Repair routines below all read items via doc.GetItems(), which is
	// backed by ensureItems() and would create an empty Y.Array for a new
	// conversation. That empty array races the browser's array (with
	// SYSTEM_1) for the items key on root. Only run repairs for loaded
	// conversations — new ones have nothing to repair.
	if msg.Conversation.LoadFromDisk {
		// Repair any duplicate messageIds from undo/redo bugs
		repairedCount := r.repairDuplicateItemIds()
		if repairedCount > 0 {
			r.log.Info("Repaired %d duplicate messageIds", repairedCount)
			// Save repaired state immediately to prevent re-corruption on next load
			if err := r.saveStateToDisk(); err != nil {
				r.log.Error("Failed to save repaired state: %v", err)
			}
			// Notify frontend about the repair
			r.sendCorruptionRepaired(repairedCount)
		}

		// A thread with no summary is stopped, not stuck — a thread is running
		// or stopped, never closed — so it must survive a reload / server
		// restart exactly as it was, free to run again. There is no repair to
		// do here. (A non-terminal tool-action left mid-flight is handled by
		// CancelStaleToolActions below + the requestLLM re-drive.)

		// Cancel tool-actions left running when the app was killed. Conversation-
		// wide ("") deliberately: nothing is running anywhere yet, so every thread's
		// leftovers are stale.
		r.CancelStaleToolActions("")
	}

	// Initialize the conversation-level DEFAULT model config in doc metadata for
	// new conversations (for existing conversations it is loaded from disk above).
	// The key is `defaultModelConfig`; threads override via their own Y.Map
	// `modelConfig` key. Guard on BOTH the new key and the legacy `modelConfig`
	// metadata key so a loaded pre-rename session is never re-seeded over its
	// persisted default.
	if msg.Conversation.ModelConfig != nil &&
		msg.Conversation.ModelConfig.Provider != "" &&
		msg.Conversation.ModelConfig.Model != "" &&
		r.doc.GetMetadata("defaultModelConfig") == nil &&
		r.doc.GetMetadata("modelConfig") == nil {
		seed := map[string]any{
			"provider": msg.Conversation.ModelConfig.Provider,
			"model":    msg.Conversation.ModelConfig.Model,
		}
		// Thinking and ServiceTier ride with the pair only when explicit —
		// absent means the model's default level / standard serving, matching
		// the live modelConfig shape.
		if msg.Conversation.ModelConfig.Thinking != "" {
			seed["thinking"] = msg.Conversation.ModelConfig.Thinking
		}
		if msg.Conversation.ModelConfig.ServiceTier != "" {
			seed["serviceTier"] = msg.Conversation.ModelConfig.ServiceTier
		}
		r.doc.SetMetadata("defaultModelConfig", seed)
	}

	// Initialize created timestamp in doc metadata for new conversations.
	// (Name lives on the on-disk folder name now, not the Yjs doc.)
	if msg.Conversation.Created != "" && r.doc.GetMetadata("created") == nil {
		r.doc.SetMetadata("created", msg.Conversation.Created)
	}

	// The name itself stays on the folder, but its PROVENANCE is doc state: seed
	// the marker that decides whether the auto-namer may replace this tab's name.
	// (Provisional = machine-derived and free to be replaced; cleared once a human
	// types a name.)
	// Absent-only, so a doc that already carries the marker keeps it. See
	// metaProvisionalName.
	r.seedNameIsProvisional()
	r.seedHasAutoNamed()

	// Seed the strategy-activation marker so onActivate fires only on a genuine,
	// non-baseline activation (matching the old "fires on a live switch, never on
	// initial load" rule):
	//   - reloaded conversation: treat the persisted strategy as already active,
	//     so reopening never re-injects its guidance;
	//   - new conversation: baseline `default`, so a plain default conversation
	//     never pays a no-op activation round-trip, while a switch to (or creation
	//     in) plan/research still fires onActivate.
	// Only seed when absent: a conversation activated under this feature has its
	// own persisted value that must win.
	if r.doc.GetMetadata("activatedStrategyId") == nil {
		seed := defaultStrategyID
		if loadedFromDisk {
			if cur, ok := r.doc.GetMetadata("currentStrategyId").(string); ok && cur != "" {
				seed = cur
			}
		}
		r.doc.SetMetadata("activatedStrategyId", seed)
	}

	// For new conversations, save the initial state immediately so the .yjs file
	// exists on disk before the frontend can write the conversation ID to
	// conversationOrder. This prevents orphaned IDs if the app quits quickly.
	if !msg.Conversation.LoadFromDisk {
		if err := r.saveStateToDisk(); err != nil {
			r.log.Error("Failed to save initial state for new conversation: %v", err)
		}
	}

	// Clear any undo history that accumulated during initialization (e.g. from
	// repairDuplicateItemIds, which uses authorID). The repair operations are
	// not user-initiated and should not be undoable.
	r.tracker.ClearHistory()

	// Reset processingState on first init (idle, plus a conditional crash-recovery
	// re-drive). Factored out so the fork-parked suppression is unit-testable.
	r.reconcileProcessingStateOnLoad()

	// Broadcast state to frontend so it can sync
	r.broadcastFullState()

	// Broadcast initial undo state so clients know undo availability after load
	r.sendUndoState(r.tracker.CanUndo(), r.tracker.CanRedo())

	r.initialized = true

	// Send ready message LAST (after all document mutations complete).
	// This prevents race with tests that start modifying document after
	// receiving "ready". The conversation name lives on the session
	// manifest (folder name on disk), not in the Yjs doc — so we don't
	// look it up here.
	if msg.Conversation.LoadFromDisk && loadedFromDisk {
		r.sendReadyWithDocMetadata()
		r.log.Debug("[worker] loaded conv=%s in %v", r.conversationID, time.Since(initStart).Round(time.Millisecond))
	} else {
		r.sendReady()
		r.log.Debug("[worker] created conv=%s in %v", r.conversationID, time.Since(initStart).Round(time.Millisecond))
	}
}

func (r *run) handleSendMessage(payload json.RawMessage) {
	var msg SendMessageMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		r.sendError("Failed to parse send-message", "")
		return
	}

	// If a turn is already in flight (a live LLM call, or a tool batch awaiting
	// approval), don't drop the message — queue it. The strategy loop drains the
	// queue at its next boundary; Stop and Deny promote it and stay idle. Empty
	// messages and continuations have nothing to queue.
	input := msg.UserInput()
	skillsToLoad := dedupSkills(msg.Skills)
	// Both halves are asked of the TARGET thread: a message for an idle thread
	// must not queue behind an unrelated sibling's run. threadRunState answers for
	// the run writing to that thread and StateIdle for every other thread, so a
	// run streaming on a sibling is no longer a reason to refuse this one.
	// Whether this send asks for anything at all. An empty, skill-less,
	// non-continuation send is not a send: below the gate it is refused outright,
	// and above it there is nothing for it to queue.
	carriesIntent := msg.IsContinuation || !input.isEmpty() || len(skillsToLoad) > 0
	if r.threadActivity(msg.ThreadItemID) != ActivityNone || r.threadRunState(msg.ThreadItemID) != StateIdle {
		if !msg.IsContinuation {
			// Skills chosen while a turn is in flight ride the pending queue ahead
			// of the message, so they promote and execute before its turn.
			for _, name := range skillsToLoad {
				r.enqueuePendingSkill(msg.ThreadItemID, name)
			}
			if !input.isEmpty() {
				r.enqueuePendingMessage(msg.ThreadItemID, input)
				// A run backing off between LLM attempts has no boundary coming to
				// drain that queue — the wait is dead time on a request this message
				// has already superseded. Tell it so; every other busy run drains the
				// queue at its next turn boundary on its own.
				r.nudgeRetryWait(msg.ThreadItemID)
			}
		}

		// Busy is not always working. A thread whose child rested on a usage cap is
		// parked awaiting_llm on a run that will not settle until the child is
		// dispatched, and the latch refuses that child on every reducer pass — so
		// this branch is where the send that lifts the cap arrives. The lift is the
		// same "try anyway" the idle path makes below; the pass is asked for here
		// because queueing a message asks for none, and without one the thread the
		// cap was holding is never re-offered.
		if carriesIntent && r.liftRateLimitForSend(msg.ThreadItemID) {
			r.requestReconcile()
		}
		return
	}

	// Reaching here the worker is idle: an explicit send or Continue into this
	// thread is an unambiguous "resume now", so it lifts any pause standing over
	// it (D6, §10.5) — a mark outlives the rest it caused, and would otherwise
	// suppress this user-initiated turn. Only the marks covering THIS thread go: a
	// pause the user put on some other sub-agent is not something typing here
	// asked to lift.
	r.dropPoliteStopsCovering(msg.ThreadItemID)

	// Guard: empty message (no text AND no attachments) with no incomplete
	// tools = nothing to do. An explicit skills-only send is the exception — it
	// carries no text but must still load the chosen skills (handled below).
	if input.isEmpty() && !msg.IsContinuation && !r.hasIncompleteTools() && len(skillsToLoad) == 0 {
		return
	}

	// Resolve model config: check thread Y.Map → parent chain → conversation metadata
	modelConfig := r.doc.ResolveEffectiveModelConfig(msg.ThreadItemID)

	if modelConfig == nil || modelConfig.Model == "" {
		errMsg := "Please select a model before sending a message"
		if msg.IsContinuation {
			errMsg = "Please select a model before continuing"
		}
		// code "no-model" marks the recoverable divergence case: the client may
		// hold a valid model this worker's doc never received (outbound sync gap).
		// The client self-heals by re-broadcasting its config and retrying once.
		r.sendStatusWithCode("validation-error", errMsg, "no-model")
		return
	}

	// Same reasoning as the pause above, for the other thing that stops a
	// conversation without being asked to: a usage cap this conversation met
	// earlier is our record of a refusal, not the provider's current answer.
	// Sending is an explicit "try anyway", and one request is what it costs to
	// find out — far better than answering the user from a four-hour-old 429.
	r.clearRateLimit(modelConfig.Provider)

	// A send/continue is a fresh user intent to drive the LLM after any prior
	// undo/redo history navigation.
	r.suppressReconcileAfterHistoryNavUntilMs = 0

	// Set thread context for this request. Validate the target thread BEFORE
	// mutating r.t.thread, so an early return (missing items array) can't leave
	// r.t.thread pointing at a half-set thread from this request.
	//
	// Scoped to this intake and restored on return, the same discipline
	// createThread uses for its parent switch: the gate above admits a message for
	// an idle thread while a run streams on another one, and that run's own
	// destination must survive an intake arriving mid-stream.
	//
	// A thread carrying a result is NOT refused. A result is the thread's current
	// summary, not a terminal state: a thread is running or it is stopped, and a
	// stopped thread accepts a message and runs again. This is the same property
	// a parent LLM relies on to invoke a subthread more than once, so the human
	// path and the delegation path are one mechanism.
	prevThread := r.t.thread
	defer func() { r.t.thread = prevThread }()
	if msg.ThreadItemID != "" {
		itemsArray := r.doc.GetThreadItemsArray(msg.ThreadItemID)
		if itemsArray == nil {
			r.sendError(fmt.Sprintf("Thread item %s not found", msg.ThreadItemID), "")
			return
		}
		r.t.thread.itemID = msg.ThreadItemID
		r.t.thread.itemsArray = itemsArray
	} else {
		r.t.thread.itemID = ""
		r.t.thread.itemsArray = nil
	}

	// Add user message to doc before signaling the reducer.
	if !msg.IsContinuation && !input.isEmpty() {
		// Auto-name trigger: fire the injected server callback exactly once, on the
		// FIRST user message of the ROOT thread. "First" is recorded durably in doc
		// metadata (metaAutoNamed) rather than inferred from the items array,
		// because compaction folds the earlier user messages out of that array and
		// the next message would otherwise be read as a new conversation's first.
		// The server owns cheap-model resolution, the bounded completion, and the
		// rename; the worker only signals and hands off. Skipped for subthreads,
		// text-less (image-only) first messages, and any conversation whose name a
		// human has committed to (NameIsProvisional — the server re-checks it
		// before applying the title).
		if msg.ThreadItemID == "" && r.autoNameFunc != nil &&
			strings.TrimSpace(input.Text) != "" && !r.hasAutoNamed() &&
			r.NameIsProvisional() {
			r.fireAutoName(input.Text, modelConfig.Provider, modelConfig.Model, modelConfig.Thinking, false)
		}

		// Drain any queued items into this thread FIRST, then append the new user
		// message after them. The queue is normally empty on an idle send (the
		// turn boundary already promoted it), but a client that saw us as busy an
		// instant before we went idle may have enqueued this message's @-mention /
		// dropped-file reads onto pendingItems (so they'd ride the queue with the
		// message). Promoting here lands those reads immediately before the user
		// message instead of stranding them for the next boundary to promote out
		// of order. Harmless when the queue is empty.
		r.promotePendingItems(msg.ThreadItemID)
		r.addUserMessage(input)
		// Explicit skill preloads land immediately AFTER the user message, so the
		// transcript reads user → assistant(skill) → tool_result → reply and the
		// skill's instructions are in context before the assistant responds. The
		// reducer rests on these non-terminal tool-actions, drives them to
		// completion, then dispatches the LLM call (requestLLM below sets the
		// awaiting_llm activity that authorises that dispatch).
		r.injectSkillPreloads(skillsToLoad)
		r.batcher.Flush()
		r.handleItemsChange()

		// A human just sent a genuine message into this thread — promote it to
		// spawn-capable so its agent may itself use create_thread. The
		// non-recursive-thread rule keys on human steering, not thread provenance:
		// a thread a person has messaged may spawn, gating recursion on human
		// attention. No-op at root (full tool list already) and for delegated
		// subthreads. See promoteThreadSpawnCapable.
		r.promoteThreadSpawnCapable(msg.ThreadItemID)
	} else if !msg.IsContinuation && len(skillsToLoad) > 0 {
		// Skills-only send (no prose): load the chosen skills as visible
		// tool-actions but start NO turn. driveToolActions (via handleItemsChange)
		// evaluates, approves, and executes them; because we never requestLLM,
		// activity stays idle and the reducer rests on the completed tool-action
		// rather than dispatching an empty turn.
		r.promotePendingItems(msg.ThreadItemID)
		r.injectSkillPreloads(skillsToLoad)
		r.batcher.Flush()
		r.handleItemsChange()
		r.needsReconcile.Store(true)
		return
	}

	// Explicit Continue clicks have no new user item to make the reducer's
	// intent obvious. Open a run record for a stopped subthread before publishing
	// it as live, then remember the one-shot intent until the reducer claims the
	// turn. Root continuations have no run records to open.
	if msg.IsContinuation {
		r.openThreadContinuationRun(msg.ThreadItemID)
		r.markExplicitContinuation(msg.ThreadItemID)
	}

	// Signal the reducer to dispatch an LLM call. requestLLM sets
	// activity="awaiting_llm" atomically; the reducer picks it up on
	// the next event-loop tick via tryReconcile → dispatchCallLLM.
	r.requestLLM(msg.ThreadItemID)
	r.needsReconcile.Store(true)
}

// firstRootUserMessageText returns the text of the conversation's first
// root-level user message, or "" when there is none yet (or it was image-only).
// Reads root items directly (not the active-thread target) so it is correct
// regardless of any thread context left set by a prior message.
//
// Descends into a compaction summary's folded items, because the conversation's
// opening message is exactly what compaction folds away first: reading only the
// live array would make the tab bar's "Auto-name" button a silent no-op on any
// conversation long enough to have been compacted.
func (w *ConversationWorker) firstRootUserMessageText() string {
	var first func(items []ConversationItem, skipID string) string
	first = func(items []ConversationItem, skipID string) string {
		for _, it := range items {
			// A fold appends a synthesized summarization prompt as a user item.
			// It is the compaction's own instruction, never the human's words.
			if it.ItemID == skipID && skipID != "" {
				continue
			}
			if it.Type == ItemTypeUser {
				return it.Content
			}
			if it.Type == ItemTypeThread && it.BoundedCompaction {
				if found := first(threadNestedItems(it), it.CompactionPromptItemID); found != "" {
					return found
				}
			}
		}
		return ""
	}
	return first(w.doc.GetItems(), "")
}

// handleRequestAutoName services a request-auto-name message: it re-derives a tab
// title from the conversation's first user message, out-of-band, via the injected
// server callback. Force is passed straight through — true (the tab bar's
// "auto-name now") bypasses the server's enable gate and its name-provenance
// guard so the rename always applies, while false (/handoff, once its summary has
// landed as the continued tab's first message) is subject to both, and is
// additionally gated here on the name still being machine-derived. A no-op when
// auto-naming isn't wired or there is no user message to summarise yet — there is
// nothing to name before the first turn.
func (w *ConversationWorker) handleRequestAutoName(payload json.RawMessage) {
	if w.autoNameFunc == nil {
		return
	}
	var msg RequestAutoNameMessage
	if len(payload) > 0 {
		if err := json.Unmarshal(payload, &msg); err != nil {
			w.log.Error("Failed to parse request-auto-name message: %v", err)
			return
		}
	}
	if !msg.Force && !w.NameIsProvisional() {
		return
	}
	first := w.firstRootUserMessageText()
	if strings.TrimSpace(first) == "" {
		return
	}
	mc := w.doc.ResolveEffectiveModelConfig("")
	provider, model, thinking := "", "", ""
	if mc != nil {
		provider, model, thinking = mc.Provider, mc.Model, mc.Thinking
	}
	w.fireAutoName(first, provider, model, thinking, msg.Force)
}

// handleProviderTurn lands a turn the provider surfaced out-of-band — an
// autonomous wake/monitor turn the backend emitted with no Submit in flight —
// into the root conversation as a normal assistant turn. Delivering it as it
// completes prevents turn mis-attribution: the next foreground Submit can no
// longer dequeue it as its own reply. The relative inbound-FIFO ordering
// vs. a near-simultaneous send-message is best-effort, not guaranteed: a wake
// turn can occasionally land just after the user message instead of before.
// It can also be dispatched from inside a wait loop (waitForLLMResponse /
// waitForRetryDelay route inbound through dispatchMessage), so a wake turn may
// splice in mid-solicited-loop — it still inserts cleanly at root with its own
// txnID, just at an uncontrolled position. Both are cosmetic, not corrupting.
//
// Autonomous turns belong to the root conversation, not whatever thread a
// prior turn happened to run in, so blocks are appended at root.
//
// RISK — autonomous tool_use is not yet driven through the approval pipeline.
// The claudecode drain stops on tool_use, so in practice such turns rarely
// reach here; when one does we log+skip its tool_use blocks. Note this is a
// latent wedge, not a clean no-op: a wake turn that emits ONLY tool_use leaves
// the CLI parked inside an MCP tools/call awaiting a result nobody will send,
// and the next Submit resumes a session stuck mid-tool. Acceptable only because
// autonomous tool turns are rare.
//
// Cost is finalized exactly as for a solicited turn: every landed item is
// stamped with one shared transactionId and a transaction blob carrying the
// turn's usage is persisted. An autonomous turn spends real tokens (a
// wake/monitor can drive a multi-million-token agentic loop), so it must be
// billed, not lost — the footer reads the latest blob's inputTokens. There is
// no juggler request behind an autonomous turn, so the blob's input context is
// empty; the output blocks + usage come from the turn itself.
func (r *run) handleProviderTurn(payload json.RawMessage) {
	var msg ProviderTurnMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		r.log.Error("Failed to parse provider-turn: %v", err)
		return
	}

	txnID := generateTransactionID()

	inserted := false
	for _, block := range msg.Blocks {
		switch block.Type {
		case provider.ContentBlockTypeThinking:
			content := block.Content
			if content == "" {
				content = block.Thinking
			}
			if content == "" {
				continue
			}
			r.tracker.AppendMessage(ConversationItem{
				Type:   ItemTypeThinking,
				ItemID: generateItemID(),
				// The block's signature / reasoning item id, kept so the next
				// turn can replay this reasoning to the provider.
				ProviderData:  block.Metadata,
				Content:       content,
				TransactionID: txnID,
				Timestamp:     time.Now().Format(time.RFC3339),
			})
			inserted = true
		case provider.ContentBlockTypeProviderState:
			if len(block.Metadata) == 0 {
				continue
			}
			r.tracker.AppendMessage(ConversationItem{
				Type:          ItemTypeProviderState,
				ItemID:        generateItemID(),
				ProviderData:  block.Metadata,
				TransactionID: txnID,
				Timestamp:     time.Now().Format(time.RFC3339),
			})
			inserted = true
		case provider.ContentBlockTypeText:
			if block.Content == "" {
				continue
			}
			r.tracker.AppendMessage(ConversationItem{
				Type:          ItemTypeAssistant,
				ItemID:        generateItemID(),
				Content:       block.Content,
				TransactionID: txnID,
				Timestamp:     time.Now().Format(time.RFC3339),
			})
			inserted = true
		case provider.ContentBlockTypeToolUse:
			r.log.Info("provider-turn: autonomous tool_use %q not yet driven through approval pipeline (deferred); skipping", block.Name)
		}
	}

	if !inserted {
		return
	}

	// Persist the transaction blob so the turn is billable and "View
	// Transaction" resolves. StartTime is now / Duration is zero: the turn ran
	// in the CLI, so juggler has no real wall-clock for it (cosmetic fields).
	// SaveBlob no-ops on a nil store (tests without persistence).
	response := &LLMResponse{
		Blocks:                 msg.Blocks,
		InputTokens:            msg.InputTokens,
		InputTokensApproximate: msg.InputTokensApproximate,
		OutputTokens:           msg.OutputTokens,
		CachedTokens:           msg.CachedTokens,
		CacheWriteTokens:       msg.CacheWriteTokens,
		StopReason:             msg.StopReason,
	}
	if err := r.txnStore.SaveBlob(TransactionBlobInput{
		ConversationID: r.conversationID,
		TxnID:          txnID,
		Response:       response,
		StartTime:      time.Now(),
		ModelConfig:    r.resolveModelConfig(),
	}); err != nil {
		r.log.Error("Failed to save autonomous-turn transaction blob: %v", err)
	}

	// A turn the CLI ran on its own behalf is still this conversation's spend,
	// and the provider billed it the same way. Counting only the turns juggler
	// dispatched would understate a claudecode conversation by everything it did
	// autonomously.
	r.recordTurnSpend(response)

	// Flush so the autonomous turn syncs to the browser promptly; the items
	// observer will drive the reducer on the next tick (an assistant message at
	// root with no pending activity is inert).
	r.batcher.Flush()
}

// logCancel records who stopped the turn, with enough state to tell a mid-turn
// cancel from one that landed on an already-parked turn. Every path that can
// cancel writes exactly one of these; without it a cancelled turn simply stops,
// leaving no trace anywhere in the logs.
func (r *run) logCancel(reason cancelReason) {
	r.log.Info("🛑 Cancel requested (%s) — state=%s activity=%s llmInFlight=%v",
		reason, r.loadState(), r.getActivity(), r.t.cancelLLM.Load() != nil)
}

func (r *run) handleCancel(reason cancelReason) {
	// The run this cancel applies to. A turn executes on a goroutine of its own,
	// so the run handling this message is never the one streaming; the live-run
	// registry is what names it. With nothing live — between turns, or a strategy
	// loop driven inline by a test — this run is its own target, which is exactly
	// what it has always been.
	target := r
	threadID := r.getProcessingThreadItemID()
	if threadID == "" {
		threadID = r.t.thread.itemID
	}
	if live := r.liveRunForThread(threadID); live != nil {
		target = r.runFor(live.t)
	}
	target.logCancel(reason)

	// The thread this cancel applies to. A cancel frame carries no thread of its
	// own — the browser decides whose Stop it is and only sends one when that
	// thread owns the active work — so the worker resolves it from the run it is
	// about to stop: that run's own thread while it is processing, otherwise the
	// thread the document names as the current operation's target. Everything
	// below is scoped to it, so stopping one thread leaves a sibling's tools,
	// provider session and turn alone.
	if target.loadState() != StateProcessing {
		threadID = r.getProcessingThreadItemID()
	}

	// A hard cancel supersedes any polite stop (Pause) inside what it stops: the
	// user escalated from "finish then pause" to "stop now", so those marks go
	// before the destructive teardown below runs (D6, D7) and the turn after the
	// cancel is never spuriously suppressed. Scoped like the cancel itself, and
	// downward only — a pause standing OVER this thread is a request about the
	// conversation, which stopping one thread inside it does not withdraw.
	r.dropPoliteStopsUnder(threadID)

	// Unwind any engine-driven strategy execution (e.g. plan onWorkerIdle's
	// _driveExecution loop): the worker cancels the turn/tools below, but the
	// driver loop lives in the engine and must abort its controller so it stops
	// rather than continuing to the next step. Fire-and-forget to the engine.
	r.dispatchCancelStrategyExecution()

	if target.loadState() == StateProcessing {
		// acceptCancel both records the decision and releases whichever wait loop
		// the turn is parked in — its own goroutine is not reading this mailbox.
		target.acceptCancel()
		if p := target.t.cancelLLM.Swap(nil); p != nil {
			(*p)()
		}
		// Release any parked provider subprocess that the ctx-cancel above
		// doesn't reach. Critical for claudecode: between the CLI emitting
		// stop_reason=tool_use and the strategy loop transitioning to
		// AwaitingLLM, state is still Processing but turn.cancelLLM has
		// already been nil'd by callLLM's defer. Without this call the
		// claudecode session is left in memory with pendingToolIDs set and
		// a live CLI parked inside MCP — the next user message would route
		// through isContinuation/continueSession and the CLI would resume
		// the abandoned turn, never seeing the new user input. The release is
		// warm-preserving: sessionUUID survives so the next turn --resumes warm.
		if r.cancelLLMSession != nil {
			r.cancelLLMSession(r.conversationID, threadID)
		}
		return
	}

	// Non-blocking tool wait: the worker is idle but a turn is parked in
	// activity="awaiting_llm" (a tool batch awaiting approval, or in-flight
	// tools/threads). How we cancel depends on what is actually blocking.
	if r.threadActivity(threadID) == ActivityAwaitingLLM {
		// Decide BEFORE cancelling — cancelling flips pending → cancelled. Asked
		// of this thread's subtree: a sibling parked on its own approval is not
		// evidence about what is blocking here.
		pureApproval := r.blockedOnlyByApprovals(threadID)

		// Stop everything in this parked turn, including approvals the browser
		// hasn't resolved (the test path has no browser-side approval cancel).
		r.CancelAllToolActions(threadID)
		// The provider may have a live subprocess parked inside an MCP
		// tools/call awaiting a result that will now never come — release it so
		// handlers don't block until their 5-minute timeout. The release is
		// warm-preserving: it kills the parked CLI but keeps the resume anchor
		// (sessionUUID/sentCount/sentHash + sidecar). The sidecar always points at
		// the last completed end_turn — a tool_use pause never commits one — so it
		// is a clean prefix the next turn resumes from via regimeResumeDelta, the
		// delta carrying the [cancelled-tool-result, user-new] shape. This holds
		// whether the turn was parked purely on approvals or had real work in
		// flight: re-driving the interrupted tools is prevented by the parking
		// below, NOT by discarding the session. Dropping the warm anchor here
		// would force a multi-minute cold start that re-sends the whole
		// conversation — and that is the common case, since Claude emits
		// multi-tool batches where one tool executes while a sibling still awaits
		// approval, so "real work in flight" is the norm at an approval prompt.
		if r.cancelLLMSession != nil {
			r.cancelLLMSession(r.conversationID, threadID)
		}

		if pureApproval {
			// The turn was parked purely on approvals — nothing was executing.
			// Dropping the approvals means "run what I queued, if anything":
			// hand off to the reducer, which continues a queued turn or rests.
			// Deliberately does NOT write idle here — that would clear
			// awaiting_llm before the reducer runs and strand the continuation.
			r.needsReconcile.Store(true)
			return
		}

		// Real work was in flight (an approved/running tool, or an open
		// sub-thread). Park: keep any queued messages by promoting them into
		// the thread, then rest — don't silently re-drive the interrupted work.
		r.promotePendingItems(threadID)
		// Release the target claim explicitly. The ambient actor run does not carry
		// the parked descendant's thread context, so its idle status alone would
		// otherwise clear the root entry and leave this thread awaiting forever.
		r.releaseLLM(threadID)
		r.sendStatus("idle", "")
		r.resetThreadContext()
	}
}

// Client replies are offered to the slot for the round-trip they answer, which
// takes one and only if it is the answer to the request in flight. Every rule
// that makes that safe lives in reply_slot.go, so these handlers are the routing
// and nothing else.

func (w *ConversationWorker) handleRenderContextItemsResponse(payload json.RawMessage) {
	reportRoundTrip("context", payload)
	w.contextReply.deliver(payload)
}

func (w *ConversationWorker) handleToolsResult(payload json.RawMessage) {
	reportRoundTrip("tools", payload)
	w.toolsReply.deliver(payload)
}

func (w *ConversationWorker) handleStrategyHookResponse(payload json.RawMessage) {
	w.strategyHookReply.deliver(payload)
}

func (w *ConversationWorker) handleBuildSubthreadSpecResponse(payload json.RawMessage) {
	w.subthreadSpecReply.deliver(payload)
}

func (r *run) handleYjsSync(payload json.RawMessage) {
	var msg YjsSyncMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	var applyErr error
	if msg.EngineDerived {
		applyErr = r.doc.ApplyEngineDerivedSyncUpdate(msg.Bytes)
	} else {
		applyErr = r.doc.ApplySyncUpdate(msg.Bytes)
	}
	// `origin` identifies WHICH client's sync this was — when a flake's
	// worker doc diverges from a viewer's, the writer of the divergent
	// update is the whole question.
	r.tape.Record("yjs-apply", map[string]any{
		"bytes":         len(msg.Bytes),
		"engineDerived": msg.EngineDerived,
		"err":           applyErr != nil,
		"origin":        r.replyTo,
	})
	if applyErr != nil {
		r.log.Error("Failed to apply sync update: %v", applyErr)
		return
	}

	// Refresh the UndoManager scope after applying remote state. On the first
	// sync the browser may send its own items Y.Array which wins the Yjs
	// conflict, replacing the Go-created array. Without this call the manager
	// keeps watching the stale (tombstoned) array and canUndo stays false.
	r.tracker.RefreshScope()

	// Schedule save to persist frontend updates (metadata, context items, etc.)
	r.scheduleSave()

	// Explicitly check for items changes after applying sync update.
	// ycrdt's items.Observe may not fire for remote updates applied via ApplyUpdate,
	// so we manually trigger change detection to ensure undo tracking works.
	r.handleItemsChange()
}

// handleResyncRequest answers a client's reconnect catch-up in both directions:
// the reply carries the Yjs ops the client lacks (the delta since the client's
// state vector) AND the worker's own state vector, from which the client
// computes the ops the WORKER lacks and returns them as an ordinary yjs-sync.
// Both halves are deltas, so this is the cheap path back to consistency after a
// transient WS drop — no full-state re-broadcast, no page reload. A nil/empty
// client vector degenerates to full state in the outbound half (equivalent to
// request-full-state).
//
// The reply is sent even when the client is already up to date: an empty delta
// still carries the vector the client needs to push the edits it made while its
// socket was down, which nothing else replays.
//
// The two doc reads are separate snapshots of a document that only ever gains
// ops, and either order is safe. Ops the doc gains between them are the
// worker's own: the client receives them on the ordinary broadcast path, and
// the vector merely tells the client not to send them back.
func (w *ConversationWorker) handleResyncRequest(payload json.RawMessage) {
	var msg ResyncRequestMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		w.log.Error("Failed to parse resync-request: %v", err)
		return
	}
	// Targeted at the requester: only the client that reconnected asked, and its
	// catch-up delta is meaningless (and potentially large) to everyone else.
	w.reply(ResyncResponseMessage{
		Type:        "resync-response",
		Bytes:       w.doc.GetStateUpdate(msg.StateVector),
		StateVector: w.doc.GetStateVector(),
	})
}

// handleResyncToOrigin tells ONLY the client that asked (w.replyTo), not every
// viewer, that this conversation is loaded here. It seeds a freshly
// (re)connected engine with the conversations that were already loaded before
// it attached: an on-demand engine that was torn down and recreated starts
// empty and would otherwise never re-load them, so their approved tool-actions
// would never execute. Skips uninitialized workers (their doc isn't loaded yet
// — handleInit's broadcastFullState will cover the engine once init runs).
//
// The offer carries no state. What the engine needs depends on what it already
// has, and only the engine knows that: after a link drop its realm has survived
// and it holds the document, so it answers with a resync-request naming what it
// lacks and gets a delta; after a genuine restart it holds nothing, ignores the
// offer, and loads the conversation the ordinary way. Sending full state here
// instead served neither case — see ResyncOfferMessage.
//
// The tool re-attach below does NOT wait for that exchange, and must not: it is
// the wedge this handler exists to prevent, and every worker-driven engine
// command loads its conversation before acting anyway (loadAndFlush in
// web/js/services/worker-manager-protocols.js), so a command may safely arrive
// before the document does.
//
// INTERIM (Phase 0.3): superseded by the worker-driven stateless tool executor,
// after which the engine holds no conversation state and needs no seeding.
func (w *ConversationWorker) handleResyncToOrigin() {
	if !w.initialized {
		return
	}
	w.reply(ResyncOfferMessage{Type: "resync-offer"})
	// A freshly (re)attached engine has commanded none of this conversation's
	// tools yet. Drop all command bookkeeping so every non-terminal tool-action is
	// dispatched afresh against the new engine instance (the previous engine's
	// dispatch state must not suppress the first command to the new one).
	w.tools.resetAll()

	// A tool stuck in state=running with no result was being executed by the
	// PREVIOUS engine instance, which has gone away (it never wrote a result).
	// The new engine has no in-flight execution for it and would never command
	// it (driveToolActions only acts on ""/approved). Reset such tools to
	// approved so the drive below re-issues execute-tool against the new engine.
	// This preserves the documented crash-mid-execution double-exec property: a
	// side-effecting tool that partially ran before the engine died is re-run.
	w.resetRunningToolsForReattach()

	// Re-drive: command evaluate-tool ("") / execute-tool (approved) for every
	// non-terminal tool-action (including the ones just reset above) so an
	// approved/running tool the new engine never observed still executes.
	w.driveToolActions()
}

// resetRunningToolsForReattach walks all items (root + nested threads) and
// resets every tool-action in state=running with no result back to approved
// (clearing runningStartedAt), so driveToolActions re-commands execute-tool on
// the freshly attached engine. The previous engine that claimed these tools is
// gone, so leaving them "running" would strand them forever. Worker-managed
// tools (create_thread) are skipped — the worker, not the engine, executes
// them, so an attach doesn't strand them. Clears the dedup entry for each reset
// tool so the subsequent drive re-dispatches.
func (w *ConversationWorker) resetRunningToolsForReattach() {
	// Read the current turn outside the walk's lock (docTurnCounter acquires
	// ycrdtMu itself). A running tool stamped with this turn already had a
	// result delivered to the provider this turn and must NOT be re-executed.
	currentTurn := w.docTurnCounter()

	var ids []string
	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, _ string) bool {
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		if state, _ := m.Get("state").(string); state != StateRunning {
			return false
		}
		if m.Get("result") != nil {
			return false // already finished
		}
		// A result for this still-running tool was already delivered to the
		// provider this turn (buildMessages' auto-continue placeholder feed stamps
		// resultFedTurn). Re-executing it on reattach would double-fire the side
		// effect and re-feed a duplicate — so treat it as terminal-for-this-turn.
		// This is the resultFedTurn CURE (doc.go's "Tool-delivery desync" section,
		// claudecode provider). Field absence (rawFed == nil) means never fed →
		// fall through and reset.
		if rawFed := m.Get("resultFedTurn"); rawFed != nil {
			var fedTurn int64
			switch v := rawFed.(type) {
			case int64:
				fedTurn = v
			case float64:
				fedTurn = int64(v)
			case int:
				fedTurn = int64(v)
			}
			if fedTurn == currentTurn {
				return false
			}
		}
		// Worker-executed tools are re-driven by the worker itself, not the
		// engine's executor, so they must not be reset back to approved here.
		// Prefer the executor='worker' stamp (written at evaluate); fall back to
		// the create_thread name for docs predating the stamp. Only create_thread
		// is worker-managed today, so these two cover every worker-executed tool.
		if ex, _ := m.Get("executor").(string); ex == "worker" {
			return false
		}
		if name, _ := m.Get("toolName").(string); name == "create_thread" {
			return false // worker-managed: not executed by the engine
		}
		if id, _ := m.Get("toolUseId").(string); id != "" {
			ids = append(ids, id)
		}
		return false
	})
	ycrdtMu.Unlock()

	for _, id := range ids {
		// UpdateToolActionFieldsRecursive acquires ycrdtMu internally, so this
		// must run with the lock released.
		w.doc.UpdateToolActionFieldsRecursive(id, map[string]any{
			"state":            StateApproved,
			"runningStartedAt": nil,
		})
		w.tools.clear(id)
	}
}

// engineTraceToolOverdue is the trace event the engine's execution watchdog
// emits for a tool it has been running longer than any tool's legitimate
// deadline (reportOverdueExecutions in
// web/js/services/worker-manager-protocols.js). A wire contract with the engine:
// the string must match the event name sent there.
const engineTraceToolOverdue = "tool-overdue"

// handleEngineTrace persists a diagnostic event the engine emits over its WS
// (sendEngineTrace) into the per-project server log, tagged with this worker's
// conversation. The engine's WebView console is not captured anywhere, so this
// is the only durable record of the engine-side tool-execution lifecycle —
// claim → execute-start → execute-done, and cancel HIT/MISS. A wedge shows up as
// a lifecycle that stops early (e.g. execute-start with no execute-done means the
// tool is stranded inside executeToolAction). Logged raw so new fields the engine
// adds appear without a Go change.
// Logged at Trace: this is a file-only durable record (3–4 events per tool, plus
// a failed tool's full error blob), kept out of the console even under --verbose.
// Recover it with the file log when diagnosing a wedge.
//
// The payload is diagnostic, but the RECEIPT is not: the arrival time is stamped
// on the worker (lastEngineTraceAt) and is the evidence that the engine is
// reaching its handlers at all. driveToolActions requires it before failing a
// tool for going unhandled, so that a command which never reached the engine is
// never reported as the tool's fault (see answeredSincePrevDispatch).
//
// The toolUseId is pulled out for the same reason, and stamped per-tool
// (tools.recordTrace): conversation-wide receipt cannot tell "the engine
// declined THIS tool" from "the engine was busy with a sibling tool while this
// one's commands vanished", and those have opposite causes.
//
// The reason is pulled out because not every decline says the same thing about
// the engine. A no-act reason in engineUnreachableReasons means the engine could
// not reach the tool at all — its conversation is still loading — which is a
// statement about the engine's readiness, not the tool's; recordTrace files
// those separately so the tool is held rather than blamed for them.
//
// Decoding is best-effort and never gates the log line — the payload is still
// logged raw, so fields the engine adds appear without a Go change.
func (w *ConversationWorker) handleEngineTrace(payload json.RawMessage) {
	now := time.Now()
	w.lastEngineTraceAt = now
	var probe struct {
		Event     string  `json:"event"`
		ToolUseID string  `json:"toolUseId"`
		ActionID  string  `json:"actionId"`
		Reason    string  `json:"reason"`
		RunningMs float64 `json:"runningMs"`
	}
	decoded := json.Unmarshal(payload, &probe) == nil
	if decoded && probe.ToolUseID != "" {
		w.tools.recordTrace(probe.ToolUseID, probe.Event, probe.Reason, now)
	}
	if decoded {
		// On the tape, because this is the only account of what the engine did
		// with a command and the tape is the only one of these records a failing
		// browser test can read. Without it a failure block shows `tool-command`
		// repeating every six seconds and nothing at all about the answer — so an
		// engine that declined, an engine that never got there, and an engine that
		// evaluated the tool and lost the write all leave identical evidence. The
		// summaries that would separate them (tool-command-held, the escalation
		// verdict) need more than thirty seconds of attempts and so cannot fire
		// inside a test's budget at all.
		w.tape.Record("engine-trace", map[string]any{
			"event":  probe.Event,
			"id":     probe.ToolUseID,
			"reason": probe.Reason,
		})
	}
	if decoded && probe.Reason == engineReasonConvNotLoaded {
		// The engine says it holds no copy of this conversation, so the ops the
		// worker believes it has, it does not — every later delta would build on a
		// base that is gone. This is the only signal that the engine released a
		// conversation, since it releases one without dropping its socket and tells
		// the server nothing directly. Forget the vector and the next push re-seeds
		// full state. Deliberately NOT routed through recordTrace, which ignores
		// any toolUseId not currently under command: a decline for a tool the
		// worker has stopped driving still proves the document is gone.
		w.engineDocVector = nil
	}
	if decoded && probe.Event == engineTraceToolOverdue {
		// The one engine-trace that is not merely part of a lifecycle: the engine's
		// watchdog reporting an execution that has outlived every deadline a tool
		// can legitimately be given. Nothing acts on it — a running tool has no
		// safe kill threshold — so its whole value is being findable, which Trace
		// (file-only, and only under --verbose) would not deliver. Info rather than
		// Error because the same line covers a genuinely long build.
		w.log.Info("[engine] tool %s (%s) in %s has been executing for %s with nothing back yet — long-running work, or an execution that will never return",
			probe.ToolUseID, probe.ActionID, w.conversationID,
			(time.Duration(probe.RunningMs) * time.Millisecond).Round(time.Second))
		return
	}
	w.log.Trace("[engine-trace] conv=%s %s", w.conversationID, string(payload))
}

// conversationName returns the current human-readable tab name as the session
// store reports it. Empty when unknown — with no name provider, or for a
// conversation the store doesn't have — in which case the log file falls back
// to a bare conv-id filename.
func (w *ConversationWorker) conversationName() string {
	if w.nameProvider == nil {
		return ""
	}
	name, ok := w.nameProvider(w.conversationID)
	if !ok {
		return ""
	}
	return name
}

// handleRenameLog re-asks the store for the (already-renamed) tab name and
// moves the per-conversation log file to match, so its filename tracks the tab
// title. Triggered by the rename API via the manager. Runs on the worker's run
// goroutine; jlog.Logger.Rename itself serializes against concurrent writes.
func (w *ConversationWorker) handleRenameLog() {
	if w.log == nil {
		return
	}
	newPath := logpaths.ConversationLogPath(w.projectPath, w.conversationID, w.conversationName())
	w.log.Rename(newPath)
}

func (r *run) handleUndo(payload json.RawMessage) {
	r.handleUndoOrRedo(r.tracker.Undo, payload)
}

func (r *run) handleRedo(payload json.RawMessage) {
	r.handleUndoOrRedo(r.tracker.Redo, payload)
}

func (r *run) handleUndoOrRedo(fn func() bool, payload json.RawMessage) {
	var msg struct {
		AckID string `json:"ackId,omitempty"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		r.log.Error("Failed to parse undo/redo message: %v", err)
		return
	}
	// Stop any in-flight strategy loop before we start mutating the document.
	// Without this, an undo issued while the worker is mid-turn would race
	// the rollback against the worker's writes, and worse, when the strategy
	// loop's defers finally run (writing a fallback result, transitioning to
	// idle, etc.) they would overwrite the just-restored state. Cancelling
	// first puts the worker on a path to Idle so the undo lands cleanly.
	if !r.cancelAndWaitForIdle() {
		r.reply(map[string]any{"type": "ack", "ackId": msg.AckID, "result": false})
		return
	}

	// Suppress the items observer for the duration of the undo. Otherwise
	// the UndoManager's restoration of items (e.g. a thread with a trailing
	// user message) immediately tickles the reducer, which dispatches a new
	// LLM turn — the user's undo would visibly do nothing because the worker
	// fights it. Same reason we clear needsReconcile afterwards.
	r.suppressItemsChange = true
	success := fn()
	// The Yjs items observer fires synchronously inside fn(), enqueueing
	// docChangeChan signals. Drain them before clearing suppressItemsChange
	// so the next event-loop tick doesn't run handleItemsChange against
	// the post-undo state and tickle the reducer.
	select {
	case <-r.docChangeChan:
	default:
	}
	r.suppressItemsChange = false
	r.needsReconcile.Store(false)

	// Clear any in-flight activity marker. The user explicitly reverted
	// state; awaiting_llm or calling_llm semantics from before the undo
	// no longer apply. Without this, the reducer would dispatch a new LLM
	// turn the moment the next docChangeChan signal arrives — because the
	// post-undo doc ([..., user]) plus activity="awaiting_llm" matches
	// decideNextAction's ItemTypeUser-AwaitingLLM = CallLLM branch.
	// Note: this is a no-op if no thread held a claim.
	r.releaseAllLLM()
	// Keep suppressing reducer advancement for immediate post-undo/redo Yjs sync
	// echoes. This is time-bounded so later Yjs-originated user actions (approval
	// clicks) still drive the reducer normally.
	r.suppressReconcileAfterHistoryNavUntilMs = time.Now().UnixMilli() + 500

	// Flush Yjs sync BEFORE ACK so frontend state is updated when undo()/redo() returns
	r.batcher.Flush()
	r.reply(map[string]any{
		"type":   "ack",
		"ackId":  msg.AckID,
		"result": success,
	})
}

// handleBeginUndoCoalesce snapshots the current undo-stack height so a
// browser-driven multi-step command (e.g. /clear: wipe history + re-seed auto
// items) can be collapsed into a single undo group by the matching end marker.
// Closes the capture window first so the command's first mutation starts a
// fresh group exactly at the snapshotted index. The command's mutations arrive
// as ordered yjs-sync frames on the same channel after this marker, so the
// snapshot reflects state strictly before the command's first write.
func (w *ConversationWorker) handleBeginUndoCoalesce() {
	w.tracker.StopCapturing()
	w.undoCoalesceFromIdx = w.tracker.UndoStackLen()
}

// handleEndUndoCoalesce collapses every undo group added since the matching
// begin marker into one, so the bracketed command reverts in a single undo.
// Structurally identical to the compaction merge (see MergeFromIndex); a no-op
// when zero or one group was added. Acks so the browser can await completion.
func (w *ConversationWorker) handleEndUndoCoalesce(payload json.RawMessage) {
	var msg struct {
		AckID string `json:"ackId,omitempty"`
	}
	_ = json.Unmarshal(payload, &msg)
	if w.undoCoalesceFromIdx >= 0 {
		w.tracker.MergeFromIndex(w.undoCoalesceFromIdx)
		w.tracker.StopCapturing()
		w.undoCoalesceFromIdx = -1
	}
	w.batcher.Flush()
	w.reply(map[string]any{
		"type":  "ack",
		"ackId": msg.AckID,
	})
}

// cancelAndWaitForIdle stops any in-flight strategy loop and blocks (briefly)
// until the worker reaches StateIdle. Called before undo/redo so the document
// rollback can't be raced by the strategy's deferred writes.
func (r *run) cancelAndWaitForIdle() bool {
	runs := r.liveRuns()
	if len(runs) == 0 {
		if r.anyRunState() != StateIdle {
			r.handleCancel(cancelReasonUndoRedo)
		}
		return true
	}

	// Undo is conversation-wide: address every live run directly rather than
	// trusting the lossy top-level processing-state projection to choose one. The
	// pause marks go with them — the intent behind every run is being withdrawn.
	r.dropAllPoliteStops()
	r.dispatchCancelStrategyExecution()
	for _, live := range runs {
		target := r.runFor(live.t)
		target.logCancel(cancelReasonUndoRedo)
		target.acceptCancel()
		if p := target.t.cancelLLM.Swap(nil); p != nil {
			(*p)()
		}
		if r.cancelLLMSession != nil {
			r.cancelLLMSession(r.conversationID, live.threadItemID)
		}
	}
	for _, live := range runs {
		select {
		case <-live.t.finished:
		case <-time.After(time.Second):
			r.log.Error("Timed out waiting for thread %s before history navigation", live.threadItemID)
			return false
		}
	}
	return true
}

// handleResummarizeCompactionThread re-runs the folded-compaction summarizer
// over a compaction thread's existing source: clear the committed summary,
// re-arm the one-shot needsStrategyRun trigger, then drive the pickup. When the
// worker is busy the pickup is a no-op and a later handleItemsChange runs it, so
// the re-arm alone is enough to guarantee the run.
func (r *run) handleResummarizeCompactionThread(payload json.RawMessage) {
	var msg ResummarizeCompactionThreadMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		r.log.Error("Failed to parse resummarize-compaction-thread message: %v", err)
		return
	}
	handled := r.isBoundedCompactionThread(msg.ThreadItemID)
	if handled {
		// Pressing Re-summarise is human intent, so it lifts any pause standing
		// over this thread the way a send does (D6, §10.5). A mark left here
		// re-arms the trigger for a run that rests at its first boundary, which
		// is the state the button exists to get out of.
		r.dropPoliteStopsCovering(msg.ThreadItemID)
		r.clearThreadResult(msg.ThreadItemID)
		// Drop any unsummarized marker from a previous attempt: this run is
		// about to decide the question again, and the marker is re-set if it
		// ends the same way.
		r.clearCompactionUnsummarized(msg.ThreadItemID)
		r.setThreadNeedsStrategyRun(msg.ThreadItemID)
	}
	r.batcher.Flush()
	r.reply(map[string]any{
		"type":   "ack",
		"ackId":  msg.AckID,
		"result": handled,
	})
	if handled {
		r.checkForNewThreads()
	}
}

// handleClearHistory clears all items (unified storage includes context items).
// Clear is the one thread-wide mutator that must also remember the pending
// (queued-message) staging array — wipe it alongside the items.
func (w *ConversationWorker) handleClearHistory() {
	w.tracker.ClearAll()
	w.clearPendingItems("")
}

// resetToolActionAndRedrive is the shared tail of the retry handlers: it writes
// the given field reset onto the tool-action (recursively, so sub-thread tools
// are found), drops the tool's command bookkeeping so the retry isn't suppressed
// as already-dispatched, then re-requests the LLM for the owning thread and
// re-commands the tool via driveToolActions. Callers supply only the field map
// that distinguishes a re-ask (state="") from a re-run (state="approved").
func (w *ConversationWorker) resetToolActionAndRedrive(toolUseID string, fields map[string]any) {
	w.doc.UpdateToolActionFieldsRecursive(toolUseID, fields)

	// Drop the command bookkeeping so driveToolActions re-dispatches immediately
	// even though the tool was already dispatched at its prior state.
	w.clearToolCommandBookkeeping(toolUseID)

	// Signal that the reducer should dispatch CallLLM once the tool reaches a
	// terminal state again. "" targets the root thread.
	threadID, _ := w.doc.FindThreadIDForToolUseID(toolUseID)

	// A retry is human intent — the user asked for this tool to run again — so it
	// lifts the pause standing over the thread that owns it, as a send does (D6,
	// §10.5). Without this the tool re-runs and its result lands, but the turn
	// that would read it rests at the reducer's gate.
	w.dropPoliteStopsCovering(threadID)

	if w.requestLLM(threadID) {
		// A retry may target an older tool followed by assistant text. The ordinary
		// reducer treats that shape as resting unless the continuation intent is
		// explicit; retry is exactly such an intent and must survive until the
		// rerun reaches terminal state.
		w.markExplicitContinuation(threadID)
	}

	// The reset is driven by the worker: driveToolActions pushes the new state
	// to the engine and re-commands the tool so the retry actually runs.
	w.driveToolActions()
}

// handleRetryToolApproval re-asks a completed tool-action (e.g.
// AskUserQuestion) by resetting it to the *unevaluated* state ("") and
// clearing every derived field: the result and approvalResponse (so the prior
// answer isn't reused), plus the approvalOptions and displayData (the cached
// approval form). This is deliberately a full reset rather than a patch to
// 'pending': the empty state makes the frontend reducer treat the tool-action
// as brand-new and re-run handleNewToolAction, which re-derives a fresh
// approval form from the tool's (immutable) toolInput — exactly like a
// first-time ask. A mere patch to 'pending' would keep the stale derived
// fields, rendering the question form from a post-completion displayData and
// dropping its questions.
func (w *ConversationWorker) handleRetryToolApproval(payload json.RawMessage) {
	var msg struct {
		ToolUseID string `json:"toolUseId"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	// Empty state = "not yet evaluated". The frontend reducer's empty-state
	// branch re-runs handleNewToolAction, which rebuilds approvalOptions +
	// displayData and writes 'pending'. Clearing the derived fields (result,
	// approvalResponse, approvalOptions, displayData) makes the re-ask look
	// brand-new so a fresh approval form is derived from the immutable toolInput.
	w.resetToolActionAndRedrive(msg.ToolUseID, map[string]any{
		"state":            StateUnevaluated,
		"result":           nil,
		"approvalResponse": nil,
		"approvalOptions":  nil,
		"displayData":      nil,
	})
}

// handleMoveContextItemMessageToEnd moves a context item placeholder message to the end of items
func (w *ConversationWorker) handleMoveContextItemMessageToEnd(payload json.RawMessage) {
	var msg struct {
		ItemID string `json:"itemId"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	items := w.doc.GetItems()
	for i, item := range items {
		if item.ItemID == msg.ItemID && item.Type != ItemTypeToolAction {
			// Remove from current position and add to end
			w.doc.DeleteMessages([]int{i})
			w.tracker.AppendMessage(item)
			break
		}
	}
}

// handleUpdateAndRepositionToolActions updates tool actions with new hash and repositions changed ones
func (w *ConversationWorker) handleUpdateAndRepositionToolActions(payload json.RawMessage) {
	var msg struct {
		ItemID  string `json:"itemId"`
		NewHash int    `json:"newHash"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	// Find all tool-actions for this context item, update hash on data, reposition if changed
	items := w.doc.GetItems()
	for i := len(items) - 1; i >= 0; i-- {
		item := items[i]
		if item.ItemID == msg.ItemID && item.Type == ItemTypeToolAction {
			// Update the hash in data
			var data map[string]any
			if item.Data != nil {
				_ = json.Unmarshal(item.Data, &data)
			}
			if data == nil {
				data = make(map[string]any)
			}

			oldHash, _ := data["hash"].(float64)
			if int(oldHash) != msg.NewHash {
				data["hash"] = msg.NewHash
				newData, _ := json.Marshal(data)
				item.Data = newData
				// Remove and re-add at end
				w.doc.DeleteMessages([]int{i})
				w.tracker.AppendMessage(item)
				// Refresh items since we modified the array
				items = w.doc.GetItems()
			}
		}
	}
}

// handleRetryToolAction resets a tool action for re-run. It writes the
// doc change (state=approved, result=nil) and sets activity="awaiting_llm"
// so the thread reducer dispatches the LLM call when the tool completes.
func (w *ConversationWorker) handleRetryToolAction(payload json.RawMessage) {
	var msg struct {
		ToolUseID string `json:"toolUseId"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	w.tape.Record("retry-tool", map[string]any{
		"toolUseId": msg.ToolUseID,
		"origin":    w.replyTo,
	})

	// Set state='approved' and clear result. Writing 'approved' (the
	// "ready to run" state) lets the frontend reducer atomically
	// claim it → 'running' → execute exactly once.
	//
	// Clear runningStartedAt too: it anchors the properties panel's "Running…
	// Xs" elapsed digit and is re-stamped by the frontend's claimRunning on the
	// next APPROVED→RUNNING transition. Clearing it authoritatively here (single
	// writer) means a re-run's elapsed timer restarts from zero rather than
	// carrying on from the prior run — and if the engine is slow to re-claim,
	// the viewer shows a plain "Running…" instead of a stale climbing number.
	w.resetToolActionAndRedrive(msg.ToolUseID, map[string]any{
		"state":            StateApproved,
		"result":           nil,
		"runningStartedAt": nil,
	})
}

// handleUpdateToolActionForRetry updates approval options and display data for retry
func (w *ConversationWorker) handleUpdateToolActionForRetry(payload json.RawMessage) {
	var msg struct {
		ToolUseID       string          `json:"toolUseId"`
		ApprovalOptions json.RawMessage `json:"approvalOptions"`
		DisplayData     json.RawMessage `json:"displayData"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	fields := map[string]any{}
	if msg.ApprovalOptions != nil {
		fields["approvalOptions"] = msg.ApprovalOptions
	}
	if msg.DisplayData != nil {
		fields["displayData"] = msg.DisplayData
	}
	if len(fields) > 0 {
		w.doc.UpdateToolActionFieldsRecursive(msg.ToolUseID, fields)
	}
}

// handleBackgroundTaskSnapshot records the bounded output and terminal state on
// the originating tool action. The live process registry is deliberately not the
// historical source of truth: it is reaped and cannot survive a server restart.
func (w *ConversationWorker) handleBackgroundTaskSnapshot(payload json.RawMessage) {
	var snapshot BackgroundTaskSnapshot
	var displayData map[string]any
	if err := json.Unmarshal(payload, &snapshot); err != nil || snapshot.TaskID == "" || snapshot.ToolUseID == "" {
		return
	}
	if err := json.Unmarshal(payload, &displayData); err != nil {
		return
	}
	if snapshot.Status != "running" && snapshot.Status != "completed" && snapshot.Status != "failed" {
		return
	}
	w.doc.UpdateToolActionDisplayDataRecursive(snapshot.ToolUseID, "backgroundTask", displayData)
}

// handleRepositionContextItemPlaceholder clears itemId and sets placeholder content for a context item
func (w *ConversationWorker) handleRepositionContextItemPlaceholder(payload json.RawMessage) {
	var msg struct {
		ItemID string `json:"itemId"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}

	w.doc.UpdateToolActionByItemIDRecursive(msg.ItemID, map[string]any{
		"itemId":  "",
		"content": "(context item was repositioned)",
	})
}
