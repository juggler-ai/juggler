# Conversation Yjs schema

The on-disk source of truth for a conversation is a single Yjs document
(`Y.Doc`). This file enumerates every well-known top-level structure, the
keys inside each, and the invariants the runtime maintains across them.

**Authoritative producers/consumers:** `web/js/model/conversation-document.js`
(top-level structure), `web/js/model/message-thread.js` (per-thread mutations),
`web/sdk/lib/message.js` (item-level typedefs), `web/js/model/conversation-observers.js`
(invariants). Tests under `web/js-tests/` exercise these shapes end-to-end —
treat `test/utilities/test-harness.js` as the executable schema reference.

Keep this file in sync when adding a new top-level key, new item type, or
new metadata field. The PR that introduces the key is the PR that updates
this doc.

---

## 1. Top-level structure

A `Y.Doc` for a single conversation exposes three named top-level shared
types (see `ConversationDocument` constructor):

| Top-level | Yjs type | Producer | Purpose |
|---|---|---|---|
| `root` | `Y.Map` | `doc.getMap('root')` | Container for the conversation items array. |
| `metadata` | `Y.Map` | `doc.getMap('metadata')` | Per-conversation settings (model, strategy, permissions, etc.). |
| `undoLog` | `Y.Array` | `doc.getArray('undoLog')` | Worker-managed undo log. Main thread does not own a `Y.UndoManager`; the worker mutates this log and the main thread observes it via the `undoState` metadata key. |

### `root` Y.Map

| Key | Type | Description |
|---|---|---|
| `items` | `Y.Array<Y.Map>` | Ordered conversation flow. Each entry is an item Y.Map (see §2). Created lazily via `MessageThread.ensureYarray()`. |
| `modelConfig` | `Y.Map` \| object | Active model selection: `{providerId, modelId, ...overrides}`. Optional `thinking` override (`'off'\|'low'\|'medium'\|'high'\|'max'`; absent ⇒ provider default) rides atomically with the pair. Mirrored on each thread container; the root copy is the conversation default. |
| `draft` | `Y.Map` \| object | Unsent composer-box draft as one record: `{text, attachments}` (staged image `AssetRef`s). Stored as a single object so text and attachments persist or clear together — never half. Root draft lives in `metadata.draft`; per-thread drafts live on the thread container. |

Note: the conversation **name** is **not** stored in the Y.Doc. It lives on
the on-disk folder name and is mutated via the rename API (see comment in
`conversation-observers.js:158-161`).

### `metadata` Y.Map

| Key | Type | Producer | Notes |
|---|---|---|---|
| `modelConfig` | object | `Conversation.setModelConfig` | `{providerId, modelId, options?}`. Triggers `_fetchContextWindow` on change. |
| `currentStrategyId` | string | `Conversation.setStrategy` / strategy plugins | One of the registered strategy IDs (`default`, `plan`, `research`). Change reinstantiates the root thread's `strategy`. |
| `permissions` | object | `MessageThreadPermissions` | Persisted tool-approval grants keyed by tool name/path. |
| `processingState` | `Y.Map` | Worker | `{status: 'idle'|'busy', ..., runs}`. On the root idle transition the worker dispatches `onWorkerIdle` to the engine (run-strategy-hook), never to a viewer. See below. |
| `activatedStrategyId` | string | Worker | Last strategy whose `onActivate` hook the worker has run. Drives once-per-switch activation; survives reload/re-exec. |
| `undoState` | object | Worker | `{canUndo, canRedo, seq}`. Pushed FROM worker; main thread only reads. `seq` changes on every emit, so a client can tell "the stack moved" from "the same state re-emitted" (`canUndo` stays true across a new operation). |
| `nextSteps` | string \| null | Strategy plugins | Hint text rendered in the column header until a new turn starts. |
| `draft` | `Y.Map` \| object | Composer | Root conversation's unsent draft: `{text, attachments}`. Per-thread drafts live on the thread container instead. |
| `gitReviewDraft` | `Y.Map` \| object | Git review (`MessageThread.gitReviewDraft`) | Root thread's unsent working-tree review: `{version, base, comments[]}`, each comment a line or range on one file carrying the source it quoted and the `revision` of the patch it was written against. A separate key from `draft` because the two are sent as separate messages — folded together, discarding one would discard the other. Per-thread reviews live on the thread container. Emptied to the empty record rather than deleted: metadata has no delete. |
| `isProvisionalName` | boolean | Worker (seed) / `Session.setNameIsProvisional` | Whether the name is still provisional (machine-derived) and so may be replaced by the auto-namer. Seeded on first init from the `Untitled N` shape; cleared by a rename, set by the "Auto-name" button and `/handoff`. |
| `completedTurns` | number | Worker (`bumpTurnCounterAtIdle`) | Monotonic count of turns that have reached idle. A durable fence observers use to detect "a turn happened" when Yjs batching merged the busy→idle window away. Never resets. |
| `spendNewInputTokens` | number | Worker (`recordTurnSpend`) | Cumulative NEW input tokens for the whole conversation — root, every sub-thread, and compaction's hidden calls — counting each prompt less whatever the provider served from cache. Monotonic and durable. Server-side only: it feeds the spend ceiling, which withholds tools from a runaway delegated thread and refuses calls that would open a new one (`worker/spend.go`), and nothing in the UI reads it. Not a context-fullness measure. |
| `spendOutputTokens` | number | Worker (`recordTurnSpend`) | The same for output tokens. Kept separate from input rather than summed: they are not the same resource. Recorded but unused — the ceiling meters input only. |

#### `processingState.runs` — the per-thread run registry

`runs` holds one entry per thread that currently holds an LLM claim, keyed by
thread item id (`"root"` for the root thread):

```js
runs: {
  "<threadItemId>": {
    activity, threadItemId, claimedAt, explicitContinuation,
    status, message, code, startedAt,
    description, phase, inputTokens, outputTokens, cachedTokens
  }
}
```

It is the **source of truth**, and **several entries at once is ordinary**: the
worker admits any number of read-only child threads alongside one write-capable
run, so a parent and its children stream together. Claims are taken, released
and queued as a compare-and-set against one thread's entry, so an idle thread is
never refused because an unrelated sibling is busy.

Each entry describes **its own run**, which is why the spinner fields live
there: what it is doing (`status`, `message`, `code`), since when (`startedAt` —
absent while parked on an approval, so the elapsed digit disappears rather than
counting the wait), and what has flowed (`description`, `phase`, and the token
counts, all dropped when the run moves to its next phase). Two runs streaming at
once each report their own totals.

The top-level fields — `activity`, `threadItemId`, `claimedAt`, plus a copy of
the spinner fields above — are a **projection** of whichever single run is live:
the thread just touched if it still holds a claim, else a run actually calling
the LLM, else one awaiting dispatch, breaking ties on the most recent claim.

Read the projection for "is this conversation doing anything" and for readers
that can only act on one run (which column to reveal, which run a bare Escape
interrupts). Read `runs` for what one named thread is doing — a spinner, an
elapsed digit, a per-column busy check. A reader that asks the projection about
a specific thread is wrong whenever a sibling is running. Every field is
worker-written and rebuilt from scratch on load, so nothing here is durable
state.

#### `processingState.politeStops` — the Pause marks

`politeStops` holds one entry per paused thread, keyed exactly as `runs` is
(`"root"` for the root thread):

```js
politeStops: { "<threadItemId>": { landed } }
```

A mark stands over its thread **and everything nested below it**, so a mark on
`"root"` is the whole conversation. Its thread and its descendants finish what is
in flight and then rest before the next LLM turn; a mark is never consumed by the
work it stops, only lifted by a human (the Pause toggle, a send or Continue into
a covered thread, a hard cancel inside it, undo/redo).

`landed` is the difference between the two things a user needs to tell apart:
`false` while something under the mark still holds a claim (**Pausing…**), `true`
once nothing does (**Paused**). It is therefore the one part of `processingState`
that is meaningful on an idle frame — a landed pause is by definition on a
resting conversation.

Each covered run also carries `politePending: true` in its own `runs` entry, so a
column renders its own state rather than the projection's; the top-level
`politePending` is the conversation-wide alias, true while any covered run is
still winding down.

Like everything else here the marks are worker-owned and **not durable**: a
worker that has just loaded is running nothing, and a pause restored onto it
would suppress the user's next turn.

`undoLog` and `metadata.undoState` are split deliberately: the log is a CRDT
that survives sync; the state is the worker's view of "what can be
undone/redone right now" and is replaced wholesale on each worker tick.

The conversation **name** is not in the doc, but `isProvisionalName` — its
*provenance* — is. That is deliberate: the marker then rides the doc copy into a
duplicate (so a `/handoff` clone stays eligible for a derived title), and the
worker holding the doc is what the server asks before renaming a tab.

---

## 2. Item Y.Map shapes

Every entry in an `items` Y.Array is a `Y.Map` discriminated by its `type`
key. Always access fields via `item.get(key)` / `item.set(key, value)` —
the typedefs in `message.js` document the schema but the literal property
syntax is for type-checking only.

All items may optionally carry:
- `itemId` (string) — stable identifier used by the renderer for DOM diffing
  and selection. Some types (thread, context-item) make this required.
- `transactionId` (string) — groups items inserted in the same Yjs
  transaction; used by undo/redo to undo a turn as a unit.

### `type: 'user'` — `UserMessage`
| Key | Type | Notes |
|---|---|---|
| `content` | string | The user's typed text. |
| `runToolUseId` | string | Optional. Present on an **invocation message**: a user item appended by a parent's tool call (`create_thread`, or a `delegatesToSubthread` tool) to start one run of this thread. The parent's tool-use id, which `buildMessages` pairs its `tool_result` against. |
| `runToolName` | string | The tool the parent called. |
| `runToolInput` | object | That call's input, replayed verbatim in the parent's `tool_use` block. |
| `runGoal` | string | Resolved short user-facing label for this run. Kept separately because an extension's detailed instruction field need not be called `goal`. |
| `runStatus` | `'rest' \| 'error' \| 'cancelled' \| 'barren'` | How the run this message belongs to settled; absent while it is still going. This is the completion signal every decider reads — a parent parked on a child, the reducer's next action, the tile's busy state. A thread whose transcript carries no run record at all falls back to `result`, which is all a document written before run records recorded. Stamped on every user item the run gathered, not only the one that started it: a message typed while the run is in flight is absorbed into it, and liveness is read off the thread's TRAILING user item while the caller's pairing is read off the invocation message. A run a human starts in a stopped thread has no invocation message at all — it is recorded here and nowhere else, and reaches the parent through the last item referring to the thread (see `runToolUseId` under `ThreadMessage`). |
| `runResult` | string | What that run returned to the parent. Stored rather than re-derived, because the run's trailing items are user-editable: the pair must stay reconstructable after an edit. |

A thread accumulates one invocation message per call, in transcript order, so N
invocations produce N `tool_use`/`tool_result` pairs on the parent — one per
parent item, because the parent carries one item per call too (see `aliasOf`).
They are deliberately **not** named `toolUseId`/`toolName`/`toolInput`: those
keys mean "this item *is* a tool call", and both the compaction leading-run
classifier and the browser's context-item scans treat their mere presence as
exactly that. The item type is part of every read: a **thread** item carries the
same three keys to mean its run *selector* (below), and a child thread standing
in a transcript is not a call made into the thread holding it.

A compaction fold takes invocation messages like any other content and carries
their run records forward on itself (`foldedRuns`), so a thread that folds its
own history converges to one summary without losing a call. The single
exception is the thread's **most recent** invocation message, which is pinned:
the settling run stamps its outcome there, and a thread's liveness is read by
walking back to it.

### `type: 'assistant'` — `AssistantMessage`
| Key | Type | Notes |
|---|---|---|
| `content` | string | Assistant prose. Streamed in chunks; the renderer treats `content` updates specially via `BaseMessage._supportsStreaming`. |

### `type: 'thinking'` — `ThinkingMessage`
| Key | Type | Notes |
|---|---|---|
| `content` | string | Extended-thinking text. |
| `providerData` | object \| undefined | Opaque provider blob (e.g. signed thinking token for Anthropic). Round-tripped verbatim. |

### `type: 'tool-action'` — `ToolActionMessage`
Unified lifecycle for one tool call. See `TOOL_STATES` for state machine.

| Key | Type | Notes |
|---|---|---|
| `toolUseId` | string | Provider-assigned tool-use ID. |
| `toolName` | string | Plugin tool name (`read-file`, `glob`, `execute`, …). |
| `toolInput` | object | Plugin-specific input. |
| `state` | `'pending' \| 'approved' \| 'running' \| 'completed' \| 'cancelled'` | Undefined before approval flow starts. |
| `category` | `'read' \| 'write' \| 'meta'` \| undefined | The tool's declared category, stamped by the engine on evaluation. The worker orders a turn's calls by it: reads and meta calls overlap, anything else (including an unstamped call) waits for every earlier unfinished call in its turn and holds back every later one, so an `approved` call can sit uncommanded until its turn. A `pending` call holds nothing back. |
| `approvalResponse` | string \| undefined | Last user response to the approval modal. |
| `approvalOptions` | object \| undefined | Approval UI options snapshot. |
| `displayData` | object \| undefined | Renderer hints. |
| `result` | `Y.Map` \| object \| null | Populated on terminal states. `result.resultType` distinguishes `'context'`, `'action'`, `'meta-tool'`, `'drop'`, `'strategy-tool'` (see `RESULT_TYPES`). For `'context'`, `result.itemType` carries the produced context item's type. |
| `contextItemId` | string \| undefined | Set when the action emits / mutates a context item. |

State machine (command-driven: the Go worker observes every doc update and
drives the lifecycle by commanding the engine — `evaluate-tool` →
`execute-tool` → `cancel-tool`; the engine has no reactive tool reducer):
```
undefined → pending → approved → running → completed
                              ↘            ↘ cancelled
                  (auto-approve)
undefined → approved → running → completed | cancelled
```

### `type: 'thread'` — `ThreadMessage`
A nested sub-conversation.

| Key | Type | Notes |
|---|---|---|
| `itemId` | string | **Required.** Format: `thread_<ts>_<rand>`. |
| `goal` | string | Very short, single-line, user-facing label for the thread. It is the column header and moves with the latest call. Per-call surfaces prefer the frozen `runGoal`; legacy records fall back to `runToolInput.goal`, then this field. Detailed instructions stay in the invocation message and never become the header. |
| `result` | string \| null | The thread's current summary: the reply the last run to come to rest ended on, written by that run and by nothing else. A run that errored, was cancelled or ended barren returns its outcome to its caller but leaves this standing. Null until a run has rested. There is no way to pin different words — a different summary is a message away — and a fold is the one exception, its summary written by the folded-compaction summariser. It is **not** a terminal state, and **not** the completion signal — that is the latest run's `runStatus` (see `UserMessage`): a thread is running or stopped, there is no closed/open flag, and a stopped thread carrying a summary still accepts messages and runs again. |
| `items` | `Y.Array<Y.Map>` | The nested conversation. Every thread is isolated. A sub-thread is born empty (no `SYSTEM_1`); its system prompt is sourced from the root thread at LLM-call time. |
| `contextTokens` | number | Estimated size of this thread's own transcript, stamped when a run settles. Shown with `resultTokens` on the resting tile, where the pair is the whole economics of delegating: the child does not inherit the parent transcript and returns one `tool_result`, so a child that reads a great deal costs its caller only the answer. Both come from the wire estimator rather than a billed count — a billed total would need every one of the thread's transaction blobs read off disk at settle, and blobs are swept once nothing references them. Absent until a run has settled; absent figures show nothing, never a zero. |
| `resultTokens` | number | Estimated size of the answer this thread last handed back, stamped alongside `contextTokens`. |
| `resultSpec` | string | Optional legacy/current-session copy of the caller's return contract. The operative contract is appended to that call's invocation message; it is not shown as a second user-facing goal. |
| `sessionName` | string | Optional. The thread's handle within the thread that called it — a later call naming it appends one more invocation message here and runs, instead of spawning a sibling. Stamped at creation on every tool-spawned thread (auto-named from the tool: `explore-1`, `thread-2`, or the caller's own word), unique among its siblings, and reported at the head of every result the thread returns. Which tool owns the session is read back off the run records, so one tool can never resume another's. Absent on user-, strategy- and orchestrator-created threads: nothing calls into those. |
| `modelConfig` | object | Per-thread override of the root model. May carry an optional `thinking` level (`'off'\|'low'\|'medium'\|'high'\|'max'`) that overrides atomically with the model. Set at creation from `CreateThreadOptions.ModelConfigJSON` — a user-defined subthread command, or a `SubthreadSpec` that pinned one. |
| `currentStrategyId` | string | Optional per-thread strategy override; absent means inherit (thread → parent → … → `metadata.currentStrategyId`, resolved by `getEffectiveStrategyId` / `ResolveEffectiveStrategyID`). Written by the user switching this column's strategy, and stamped at creation from `CreateThreadOptions.StrategyID` — a user-defined subthread command, or a delegating tool's `SubthreadSpec.strategyId`, which is how a sub-agent tool runs its child under a hidden strategy the tool owns. Paired with `activatedStrategyId`, the worker's record of which strategy has had its `onActivate` run for this thread. |
| `delegated` | boolean | Marks a thread spawned by a `delegatesToSubthread` tool rather than by `create_thread` or a human. Read server-side by `withinDelegatedThread`, which stops sub-agents recursing in two paired ways anywhere below it: a delegating tool that has an inline path (`WebFetch`) stays offered but loses its delegation, while a tool whose definition carries `requiresDelegation` — no inline path, so it could only fail — is withheld from the tool list outright (`filterToolsForThread` in `llm_request.go`, which applies the same rule at `maxThreadDepth`). Read client-side by `MessageThread.isDelegated`, which hides that column's strategy selector: the thread's strategy belongs to the tool that called it and is not the user's to change. |
| `readOnly` | boolean | Marks a delegated thread whose run changes nothing outside its own transcript, stamped at creation from the spawning tool's `readOnlySubthread` manifest claim (`CreateThreadOptions.ReadOnly`). It is what lets the reducer dispatch a batch of such siblings alongside each other rather than one per tick — two agents that only read cannot land on each other's work. Stamped on the thread rather than kept on the turn because the child is dispatched long after the call that asked for it, when the tool definition carrying the claim is gone. Nothing verifies it; an item that overstates it trades a serialisation guarantee for a race. |
| `draft` | `Y.Map` \| object | Per-thread unsent input draft as one record: `{text, attachments}`. |
| `gitReviewDraft` | `Y.Map` \| object | Per-thread unsent working-tree review: `{version, base, comments[]}`. See `metadata.gitReviewDraft`, which is the root thread's. Deleted when the last comment goes, so a thread that has never been reviewed carries nothing. |
| `needsStrategyRun` | boolean | One-shot flag: the worker auto-runs the strategy loop for this thread, then clears it. Set by plugins that create a self-driving thread (e.g. `/compact`). |
| `noAutoSelect` | boolean | The UI must not auto-select into this thread on creation. Set by every fold — `/compact` folds in place, and an automatic one is spliced where the folded history began, far above a reader who never asked for it. |
| `canSpawnThreads` | boolean | Optional. Marks a **human-steered** thread whose LLM may itself call `create_thread`. Set up front by `/thread` (user-created), or stamped when a human sends a genuine message into any non-delegated thread (`promoteThreadSpawnCapable`, called from the worker's send handler). Absent on threads born from LLM `create_thread`, delegated subthreads, strategies, orchestrator, or compaction/handoff until a human engages them ⇒ the worker withholds `create_thread` from that thread's tool list (see `filterToolsForThread` in `llm_request.go`). Delegated threads are never promoted. |
| `forceTool` | string | Tool name the model **must** call on every strategy turn of this thread. The worker translates it into a provider `tool_choice`, withheld from providers that cannot honour one (`ForcedToolChoiceUnsupported`, and claudecode degrades to text) — those turns run unforced. Generic: any plugin may set it, and nothing in the core does. |
| `boundedCompaction` | boolean | Marks a `/compact` (or `/handoff`) fold: the worker summarises it with the folded-compaction summariser — one tool-free probe of the whole transcript, map/reduced only if the provider rejects it as too large — and commits the result here. |
| `foldedRuns` | array | Present only on a fold. The run records of the invocation messages this fold swallowed, each a verbatim copy of that message's `runToolUseId`/`runToolName`/`runToolInput`/`runStatus`/`runResult`, in the order they stood in the transcript. A fold stands where those messages did, so a thread's calls are still read in call order from its own items — some live, some carried here. Survives being condensed into a later fold, which is what lets repeated folds converge to one summary. A fold has no runs of its own: these describe calls made into the thread that folded them. |
| `runToolUseId` | string | Optional. This item's **run selector**: which run of the transcript this item is the parent's view of. Stamped at creation on a tool-spawned thread, and on every alias. The wire emits exactly one `tool_use`/`tool_result` pair for such an item, and the tile shows one run's result. WHICH run depends on where the item stands: the **last** item referring to a thread is its live view and answers for the run the transcript is on now, whoever started it — including a run a human started by typing into the thread, which is recorded on a plain user message carrying no coordinates at all. Every earlier item answers for the run its selector names, frozen where that run settled. So a resumed session reports to the item still waiting on it, while no pair already committed above it ever moves. Only the outcome is borrowed: the tool-use id, the goal and the call number stay the item's own. A thread item without a selector (user-, strategy- or orchestrator-created, a fold, every document written before aliases) emits one pair per run of the whole transcript, as it always did. |
| `runToolName` / `runToolInput` | string / object | The rest of that call's coordinates, replayed verbatim in the `tool_use` block. |
| `runGoal` | string | The resolved short user-facing label from `SubthreadSpec.goal`, frozen per call. Tiles, panels, context entries, and returned-thread captions prefer it. Legacy documents fall back to `runToolInput.goal`, then the thread's `goal`; detailed `task`, `question`, and `prompt` fields are never promoted into UI chrome. |
| `aliasOf` | string | Optional. The `itemId` of the thread this item is a second view of. Its presence *is* what makes an item an **alias**: a thread item owning no `items`, no `result` and no `llmCreated`, inserted by a later call into a session so the parent carries one item per call. Selecting it opens the canonical's column — they are views of one transcript — but each answers for a single run, so five calls read as five results down the parent rather than one tile whose text keeps being overwritten. An alias and its canonical are always **siblings**: a session is scoped to the thread that called it, so a resume can only be issued from the array the thread already sits in. Deleting one of them deletes one item: deleting the canonical hands its transcript to the oldest remaining view, which stops being a view, and re-points the rest at that one. The `goal`/`sessionName` an alias carries are frozen display copies; its per-call label comes from `runGoal` when present. |

### `type: 'guidance'` — `GuidanceMessage`
| Key | Type | Notes |
|---|---|---|
| `content` | string | Plugin/strategy-injected context. |
| `source` | string | Producer name (plugin/strategy ID). |

### `type: 'system-reminder'` — `SystemReminderMessage`
| Key | Type | Notes |
|---|---|---|
| `content` | string | Reminder body. |
| `source` | string | Producer name. |

### `type: 'error'` — `ErrorMessage`
| Key | Type | Notes |
|---|---|---|
| `message` | string | Short error text. |
| `content` | string \| undefined | Long form / detail. |
| `summary` | string \| undefined | Renderer subtitle. |
| `stack` | string \| undefined | Stack trace. |
| `data` | JSON \| undefined | Worker-supplied detail: `provider`, `model`, `duration` (ms), and `errorKind`. |

`errorKind` is the worker's classification of the failure, and the only thing the
row keys its extra actions off — matching on the error text in the client would
put the taxonomy in two places and let them disagree. Two values are acted on:
`auth`, the provider refused on authentication grounds, so the row also offers a
Provider settings action; and `setup`, the provider can't run on this machine (a
CLI it drives isn't installed), so the row offers Choose another model ahead of
Provider settings.

The row offers a Retry — delete this error and continue the thread — only while
the error is the **last** item in its thread, since that is the only position
where continuing resumes the turn that failed rather than simply carrying on and
quietly dropping a piece of history.

### `type: 'notice'` — `NoticeMessage`
A durable record of something that happened to a turn and is worth reading after
the fact — a provider rebuilding its context cache, a reply stopped at its output
limit, a serving tier the backend declined. It stands in the
transcript at the point the event occurred (the worker's `insertCacheMissNotice`
appends it mid-turn, so it lands after the message that triggered the turn and
before the reply it paid for) rather than as a transient badge, because the
reader is rarely looking at the moment it happens.

| Key | Type | Notes |
|---|---|---|
| `summary` | string | A one-line explanation, e.g. `Claude Code re-read the whole conversation, so this turn cost more than it needed to.` It is the transcript row's only text — the lozenge beside the warning triangle is a fixed `Warning` — so it has to say why the notice is there, in a sentence that fits a row. |
| `content` | string | The detail: the same plain-English lead, then the underlying reason or measured values verbatim. Read in the properties panel, not the row. |
| `source` | string | What reported it (provider or plugin id). |

Purely for the reader, in two senses that both need holding: the worker's
`itemWireMessages` has no case for it, so it emits **nothing** to the provider;
and `buildPrefixFingerprint` (`services/context-cache-impact.js`) skips it, so
adding or deleting one never reads as a change to the cached prefix. Both are
what let a notice be freely inserted and freely tidied away. It IS conversational
for `isConversationalItemType`, so it never gets mistaken for standing starting
context by the leading-run scan.

### `type: <context-item-type>` — `ContextItemMessage`
For non-tool context items (`rule`, `system-prompt`, `file-content`, …), the
`type` field IS the context-item type id (no `'context-item'` wrapper).
Tool-produced context items use `type: 'tool-action'` with
`result.resultType === 'context'` instead.

| Key | Type | Notes |
|---|---|---|
| `itemId` | string | Required for diffing & selection. |
| `data` | object \| undefined | Inline context item payload. |
| `isNew` | boolean \| undefined | Set once on insert; cleared after first render. |
| `error` | string \| undefined | Creation error, if any. |
| `preventUserDeletion` | boolean \| undefined | If true, the delete control is hidden. |

### LLM-only output types (`tool-use`, `tool-result`)
`tool-use` and `tool-result` items are produced by the context-builder when
preparing a request payload — they are **not** stored in `items`. They split
a `tool-action` into the request/response pair the LLM API expects. Listed
here only to document why `MESSAGE_TYPES` enumerates them.

---

## 3. Invariants

The rule is: **co-varying state is reconciled in observers, not click
handlers** (see `CLAUDE.md`). Click handlers set the trigger property; the
observer derives the consequence. This makes invariants hold for click,
undo, redo, and peer sync uniformly.

Live invariants (each maintained by a Yjs observer):

| Invariant | Maintained by | Trigger |
|---|---|---|
| Tool-actions are evaluated, executed, and cancelled at most once per state transition. | Go worker `driveToolActions` (in `tool_commands.go`) observes every doc update and commands the engine: `evaluate-tool` → `handleNewToolAction`, `execute-tool` → `claimRunning` + `executeToolAction`, `cancel-tool`. The engine has no reactive tool reducer. | worker doc-update observer |
| Approval cascades (cancelling a parent cancels children) and permission grants are persisted. | Worker commands `cancel-tool` for the cascade; `saveAutoApprovalPermission` runs in the engine's `handleExecuteTool` on a `yes-always` response. | worker doc-update observer |
| The root thread owns exactly one `SYSTEM_1` system-prompt placeholder; sub-threads own none. | Root seeds `SYSTEM_1` at creation (`initBuiltInContextItems`/`ensureSystemPromptPlaceholder`). Sub-threads carry no `SYSTEM_1` — the worker assembles their system prompt from the root thread's context items, so a per-sub-thread copy was vestigial. | thread creation |
| `nextSteps` UI indicator follows `metadata.nextSteps`. | `ConversationArea._metadataObserver` | metadata observe |
| Root thread's strategy follows `metadata.currentStrategyId`. | `setupYjsObservers` metadata observer | metadata observe |
| Context window fetches follow `metadata.modelConfig`. | `setupYjsObservers` metadata observer → `_fetchContextWindow` | metadata observe |
| When the root conversation goes idle, the strategy's `onWorkerIdle()` runs once in the engine. | Worker dispatches `run-strategy-hook` to the engine at its idle chokepoint; the engine runs the hook on its loaded copy. No per-viewer election. | worker idle transition |
| At the same idle moment, every context-item type's static `onTurnEnd()` runs once in the engine (one call per completed turn). | Worker dispatches `run-context-hook` from the same idle chokepoint; the engine fans it out over `contextItemRegistry` (types without the hook are skipped). Fire-and-forget, side-effects only. No per-viewer election. | worker idle transition |
| On a live strategy switch, the strategy's `onActivate()` runs once in the engine before the next turn. | Worker compares `currentStrategyId` vs `activatedStrategyId` at turn-start, dispatches `run-strategy-hook`, and blocks until the injected guidance syncs back. | worker turn-start |

**Engine vs viewer:** several reactions are gated to one side. The engine
must not autonomously insert items (it races viewer-driven mutations); the
viewer must not drive strategy execution that the engine would also drive.
The `isViewer()` / `isEngine()` checks in `utils/client-role.js` are the
single source of truth.

---

## 4. Versioning / migration

There is **no `version` field** on the doc today, and no in-place migration
machinery. Compatibility is maintained by:

- Additive changes only: new keys are introduced with safe defaults,
  consumed defensively (`item.get(key) ?? fallback`).
- Removed keys are tolerated (old docs may still carry them; readers ignore).
- Type changes are forbidden without a coordinated worker + UI deploy.

If a real migration is ever required, the path is: introduce a
`metadata.schemaVersion` key on writes, gate readers behind it, and ship a
one-shot rewrite step. This is intentionally unbuilt; do not paper over
schema drift here without that step.

---

## 5. Keeping this honest

- `web/js-tests/utilities/test-harness.js` builds docs end-to-end. Every key
  the harness writes should appear in §1/§2 above; if you add a new key in
  production code, add it here AND to a harness scenario.
- `cmd/juggler/worker/document.go` is the Go-side mirror. The same key names
  are used; if you rename here, rename there in the same change.
- Run the unit suites under `web/js-tests/unit-tests/` (especially
  `yjs-compat-test.js`, `item-accessor-test.js`, `thread-nested-array-test.js`)
  before assuming a structural change is safe.
