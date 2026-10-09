//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * A single default permission rule contributed by a strategy. Mirrors the
 * runtime {@link import('../js/model/message-thread-permissions.js').PermissionRule}
 * shape except `id` is auto-generated when the defaults are realised. The
 * meaning of `kind` and `value` is owned by the context-item plugin named in
 * `itemType` — see that plugin's docs.
 * @typedef {object} DefaultRule
 * @property {string} itemType - Owning context-item id (e.g. 'execute', 'write-file')
 * @property {string} kind - Plugin-defined rule kind (e.g. 'glob', 'boolean')
 * @property {any} value - Plugin-defined rule value
 * @property {boolean} [enabled] - Whether the rule starts enabled (default true)
 */

/**
 * Strategy manifest - static metadata that describes a strategy plugin.
 * Define this as a static MANIFEST property on your strategy class.
 * @typedef {object} StrategyManifest
 * @property {string} id - Unique strategy identifier (kebab-case, e.g., 'default', 'read-only')
 * @property {string} name - Human-readable display name (e.g., 'Default Strategy')
 * @property {string} version - Semantic version (e.g., '1.0.0')
 * @property {string} description - Brief description of what the strategy does
 * @property {string} [author] - Optional author name (e.g., 'Juggler Team')
 * @property {StrategyRecommendations} [recommendations] - When/why to use this strategy
 * @property {string} [color] - CSS color for visual identification (hex or CSS variable, e.g., 'var(--accent-blue)')
 * @property {string} [icon] - CSS class for icon (e.g., 'icon-lightbulb', 'icon-play'). Used in strategy selector.
 * @property {boolean} [showsApprovalControls] - Whether UI shows permission toggles (default: true for strategies with write tools)
 * @property {DefaultRule[]} [defaultRules] - Initial permission rules for new conversations
 * @property {string[]} [defaultAllowedPaths] - Initial allowed filesystem roots (default: [session.projectPath])
 * @property {number} [order] - Soft display-order hint (lower = earlier in the
 *   strategy selector and command-editor strategy list). Every strategy —
 *   built-in or 3rd-party — uses the same field to declare its position; ties
 *   break by load order. Absent on every strategy, the list stays in load order.
 * @property {boolean} [hidden] - Exclude from every user-facing strategy list
 *   (selector, Shift+Tab ring, default picker, command editor) and from both
 *   first-available fallbacks. Still resolvable by id, so a subagent item can
 *   pin it on a delegated subthread. This is the autonomy axis staying a short
 *   list of things a human picks, while an item-owned strategy shapes one
 *   delegated run. Default: false.
 */

/**
 * Strategy recommendations - helps LLM decide when to use this strategy.
 * @typedef {object} StrategyRecommendations
 * @property {string[]} recommendedFor - Task types that fit this strategy
 * @property {string[]} exampleTriggers - Keywords/patterns that suggest this strategy
 * @property {string} approach - How this strategy works differently
 * @property {StrategyTradeoffs} tradeoffs - Pros and cons
 */

/**
 * Strategy tradeoffs - pros and cons for LLM to consider.
 * @typedef {object} StrategyTradeoffs
 * @property {string[]} pros - Benefits of using this strategy
 * @property {string[]} cons - Downsides of using this strategy
 */

/**
 * Result status for tool execution.
 * @typedef {'success' | 'error' | 'cancelled'} ResultStatus
 */

/**
 * Outcome from tool execution.
 * @typedef {object} ToolOutcome
 * @property {string} toolName - Name of the tool that was executed
 * @property {boolean} success - Whether the tool executed successfully
 * @property {unknown} [result] - Tool-specific result data
 * @property {string} [content] - Human-readable result content for LLM (preferred over stringifying result)
 * @property {string} [error] - Error message if tool failed
 * @property {ResultStatus} [resultStatus] - Outcome status (success, error, cancelled)
 * @property {string} [category] - Tool category: "read", "write", "meta"
 * @property {boolean} [breakLoop] - Signal to stop the current strategy loop (e.g., when a tool signals a phase is complete)
 */

/**
 * Result from strategy-handled tool call.
 * @typedef {object} StrategyToolCallResult
 * @property {boolean} success - Whether the tool executed successfully
 * @property {boolean} shouldContinue - Whether the loop should continue
 * @property {string} [message] - Human-readable message to display
 * @property {string} [error] - Error message if tool failed
 * @property {unknown} [result] - Tool-specific result data
 * @property {boolean} [includeInConversation] - Whether to include in conversation history (default true)
 */

/**
 * JSON Schema describing a tool's parameters.
 *
 * A tool is always called with a named parameter object, so the root schema is
 * always an object schema and `type` is always the literal `'object'`. It is
 * spelled out as a required property rather than left to `object` because the
 * keyword is pure ceremony to write and invisible to omit: a schema missing it
 * is still valid JSON, survives every boundary between here and the model, and
 * is refused only at the far end — where the error names neither the tool nor
 * the missing keyword. Requiring it here is what turns that into a lint error
 * at the definition site.
 * @typedef {object} JSONObjectSchema
 * @property {'object'} type - Always the literal 'object'
 * @property {Record<string, object>} properties - Parameter name → JSON Schema for that parameter
 * @property {string[]} [required] - Names of the mandatory parameters; each must appear in `properties`
 */

/**
 * Tool definition for LLM
 * @typedef {object} ToolDefinition
 * @property {string} name - Tool name
 * @property {string} description - Human-readable description
 * @property {JSONObjectSchema} input_schema - JSON Schema for parameters
 * @property {'read'|'write'|'meta'} [category] - Tool category
 * @property {boolean} [delegatesToSubthread] - Stamped from the owning item's
 *   MANIFEST: this tool's call MAY run as a delegated child thread
 * @property {boolean} [requiresDelegation] - Stamped from the owning item's
 *   MANIFEST: this tool has no inline path, so it is unusable on any turn that
 *   cannot delegate (inside a delegated thread, or at the thread-nesting cap)
 * @property {boolean} [readOnlySubthread] - Stamped from the owning item's
 *   MANIFEST: the child this tool delegates to only reads, so it may run
 *   alongside its siblings rather than after them
 */

/**
 * Context object for StrategyType constructor.
 * @typedef {object} StrategyConstructorContext
 * @property {import('../js/model/message-thread.js').default} messageThread - Message thread for this strategy
 */

/**
 * Result of validating a single tool call.
 * @typedef {object} ToolValidationResult
 * @property {string} toolId - Tool call ID
 * @property {string} toolName - Tool name
 * @property {boolean} valid - Whether the tool call is valid
 * @property {'unknown_tool'|'blocked_tool'|'invalid_params'|'malformed'|null} errorType - Type of LLM error, null if valid
 * @property {string} [error] - Error message if invalid
 */

/**
 * Result of validating multiple tool calls.
 * @typedef {object} ToolsValidationResult
 * @property {boolean} allValid - True if all tool calls are valid
 * @property {ToolValidationResult[]} results - Per-tool validation results
 * @property {boolean} hasLLMErrors - True if any errors are LLM errors (retryable)
 */

import { submitPendingRequest } from '../js/services/thread-orchestrator.js';
import { validateManifest } from './lib/manifest.js';

// ============================================================================
// Approval Policy Constants
// ============================================================================

/**
 * Approval policy values returned by getApprovalPolicy().
 * @type {{
 *   APPROVE: 'approve',
 *   REQUIRE_APPROVAL: 'require-approval',
 *   DEFAULT: 'default'
 * }}
 */
export const APPROVAL_POLICY = Object.freeze({
  /** Skip approval even if the default logic would require it */
  APPROVE: 'approve',
  /** Force approval even if the default logic would skip it */
  REQUIRE_APPROVAL: 'require-approval',
  /** Use the existing permission system's decision */
  DEFAULT: 'default'
});

// ============================================================================
// AbortError
// ============================================================================

/**
 * Error thrown when strategy execution is aborted by user.
 * Strategies should not catch this — let it propagate to the framework.
 */
export class AbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

// ============================================================================
// StrategyType Base Class
// ============================================================================

/**
 * StrategyType - Base class for Juggler strategy plugins
 *
 * A strategy controls **how the agentic loop runs** — which tools the model may
 * call, whether those calls need approval, and what situational guidance the
 * model sees. The built-in strategies (`read-only`, `default`, `yolo`) form one
 * autonomy axis and are the reference implementations, under
 * `web/extensions/juggler-core/strategies/`.
 *
 * ## How strategies actually run (read this first)
 *
 * In a normal install the **Go worker owns the loop** (call → execute tools →
 * repeat). Your strategy does NOT drive that loop; it *shapes* it through a
 * static MANIFEST and a set of hooks the worker calls in the engine:
 *
 *   - **MANIFEST fields** configure defaults: `defaultRules`,
 *     `defaultAllowedPaths`, `showsApprovalControls`, `recommendations`,
 *     `color`, `icon`.
 *   - **static GUIDANCE** is what the strategy tells the model on activation —
 *     declared, so the user can read it in Settings → Extensions.
 *   - `filterTools(tools)` — restrict which tools the model may call (per phase).
 *   - `getApprovalPolicy(info)` — auto-approve or force-approve a tool call.
 *   - `onToolPending(info)` — react (async) once a tool has parked for approval;
 *     the seam for out-of-band auto-approval (classify, then `resolveApproval`).
 *   - `onActivate(prevId)` / `onWorkerIdle()` — inject guidance / drive follow-on
 *     work. Steer the model via `injectGuidance()` (a durable system-reminder),
 *     never by authoring system-prompt text.
 *   - `createThread()` / `continueConversation()` — worker-request primitives for
 *     multi-phase strategies.
 *
 * The built-ins work **purely** through manifest + these hooks —
 * `read-only-strategy-type.js` is the simplest and the best starting point.
 *
 * ## Creating a strategy
 *
 * Strategies ship inside an **extension** (a directory with a
 * `juggler.extension.json` manifest). Scaffold one with `juggler ext init` and
 * link it with `juggler ext link`; see `docs/extension_guide.md`.
 *
 * 1. Add a file named `*-strategy-type.js` under the extension's `strategies/`
 *    directory — the manifest's `provides` glob registers it automatically.
 * 2. `import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';`
 * 3. Define a static MANIFEST (id, name, version, description, author), and a
 *    static GUIDANCE if the model should be told anything.
 * 4. Override the hooks you need (`filterTools`, `getApprovalPolicy`,
 *    `onActivate`, …).
 * 5. Save — a linked extension hot-reloads in connected viewers; no restart.
 *
 * ## Example (production model: manifest + hooks)
 *
 * ```javascript
 * import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';
 *
 * // A "planning" strategy: expose only read/meta tools and auto-approve them,
 * // so the model investigates thoroughly without touching files or stopping
 * // for prompts. All behaviour comes from the manifest + hooks below.
 * class PlanningStrategyType extends StrategyType {
 *   static MANIFEST = {
 *     id: 'planning',
 *     name: 'Planning',
 *     version: '1.0.0',
 *     description: 'Read-only investigation before any changes',
 *     author: 'Your Name',
 *     showsApprovalControls: false
 *   };
 *
 *   static GUIDANCE = 'PLANNING MODE: investigate and propose a plan; do not modify anything.';
 *
 *   filterTools(tools) {
 *     return tools.filter(t => t.category === 'read' || t.category === 'meta');
 *   }
 *
 *   getApprovalPolicy({ category }) {
 *     return (category === 'read' || category === 'meta')
 *       ? APPROVAL_POLICY.APPROVE
 *       : APPROVAL_POLICY.DEFAULT;
 *   }
 * }
 *
 * export default PlanningStrategyType;
 * ```
 *
 * ## Hooks the worker calls (production path)
 *
 * | Hook | Description |
 * |------|-------------|
 * | filterTools(tools)         | Restrict the tools the model may call (each loop iteration) |
 * | getApprovalPolicy(info)    | Auto-approve / force-approve a tool call |
 * | onToolPending(info)        | React (async) after a tool parks for approval — classify + resolveApproval |
 * | onActivate(prevId)         | Injects static GUIDANCE when this strategy becomes active |
 * | onWorkerIdle()             | Drive follow-on work when the worker goes idle |
 * | injectGuidance(text)       | Write a durable system-reminder (the way to steer the model) |
 * | createThread(options)      | Spawn a sub-thread on the worker |
 * | continueConversation(opts) | Trigger a continue turn (no new user message) |
 * @class
 * @abstract
 */
class StrategyType {
  /**
   * Strategy manifest (static property set by subclasses)
   * @type {StrategyManifest}
   */
  static MANIFEST;

  /**
   * What this strategy tells the model when it becomes active — or `''` for one
   * that tells it nothing. {@link onActivate} injects it as a durable
   * system-reminder.
   *
   * It is declared rather than written inline in the hook so there is exactly
   * one copy of the text, and the user can be shown that copy: the strategy's
   * page in Settings → Extensions prints it verbatim. A description can only
   * claim a strategy merely gates tools; this is the claim the user can check.
   * A strategy that says nothing therefore visibly says nothing.
   *
   * A subclass that overrides `onActivate` must call `super.onActivate()`, or
   * the declared text and the injected text drift apart.
   * @type {string}
   */
  static GUIDANCE = '';

  /**
   * Create a new strategy instance
   * @param {StrategyConstructorContext} context - Context containing session and conversation
   */
  constructor(context) {
    if (new.target === StrategyType) {
      throw new Error('StrategyType is an abstract class and cannot be instantiated directly');
    }

    /**
     * Message thread for this strategy
     * @type {import('../js/model/message-thread.js').default}
     */
    this.messageThread = context.messageThread;

    /**
     * Conversation using this strategy
     * @type {import('../js/model/conversation.js').default}
     * @protected
     */
    this.conversation = context.messageThread.conversation;

    /**
     * Session for this strategy
     * @type {import('../js/model/session.js').default}
     */
    this.session = this.conversation.session;

    /**
     * Strategy instance state (for persistence)
     * @type {object}
     * @protected
     */
    this.state = {};

    /**
     * Abort controller for cancellation, consulted by the worker-request
     * primitives (createThread/continueConversation) via optional chaining.
     * @type {AbortController|null}
     * @protected
     */
    this._abortController = null;

    // Validate manifest on construction. FallbackStrategy reaches the app
    // without ever being registered, so this is its only check.
    validateManifest(this.constructor);
  }

  // ============================================================================
  // LIFECYCLE HOOKS (override in subclasses)
  // ============================================================================

  /**
   * Filter tool definitions before they are sent to the worker.
   * Called by the session's tool-request handler each iteration of the
   * worker strategy loop. Override to restrict available tools by phase.
   * @param {ToolDefinition[]} tools - All available tool definitions
   * @returns {ToolDefinition[]} Filtered tool definitions
   */
  filterTools(tools) {
    return tools;
  }

  /**
   * Called when the Go worker transitions to idle for this conversation.
   * Override to trigger post-idle work (e.g., a multi-phase strategy driving
   * follow-on work once the worker's loop has settled).
   * @returns {void|Promise<void>} Nothing
   */
  onWorkerIdle() {
    // Default: no-op
  }

  /**
   * Called when this strategy becomes the active strategy via a live switch
   * (not on initial load of an already-set strategy).
   *
   * Injects {@link GUIDANCE} as a durable system-reminder, which is all most
   * strategies need from this hook — declare the text, and both the model and
   * the user see the same string. Strategies steer the model through injected
   * messages, tool gating, and loop control, never by authoring system-prompt
   * text. The worker drives this hook in the engine exactly once per switch (at
   * the first turn under the new strategy), so the guidance is written once —
   * no per-viewer election.
   *
   * Override it to inject something the declaration cannot cover (text built
   * from the previous strategy, say), and call `super.onActivate()` so the
   * declared guidance is still delivered.
   * @param {string|null} [_previousStrategyId] - The strategy that was active before
   * @returns {void|Promise<void>} Nothing
   */
  onActivate(_previousStrategyId) {
    const guidance = /** @type {typeof StrategyType} */ (this.constructor).GUIDANCE;
    if (guidance) this.injectGuidance(guidance);
  }

  // ============================================================================
  // WORKER-REQUEST PRIMITIVES (multi-phase strategies)
  // ============================================================================

  /**
   * Create a sub-thread that runs autonomously on the worker.
   * The thread appears in the conversation UI. Blocks until thread completes.
   * @param {{goal: string, prompt: string, parentThreadItemId?: string|null, isContinuation?: boolean}} options - `goal` is a short UI label; `prompt` is the complete task.
   * @returns {Promise<{threadItemId: string, result: string}>} Thread result with item ID
   * @throws {AbortError} If cancelled
   */
  async createThread({ goal, prompt, parentThreadItemId = this.messageThread.threadItemId, isContinuation = false }) {
    this._checkAborted();
    return submitPendingRequest(this.messageThread, 'createThread', (reqMap) => {
      reqMap.set('goal', goal);
      reqMap.set('prompt', prompt);
      if (parentThreadItemId !== null && parentThreadItemId !== undefined) reqMap.set('parentThreadItemId', parentThreadItemId);
      reqMap.set('isContinuation', isContinuation === true);
    }, this._abortController?.signal);
  }

  /**
   * Trigger the worker to perform a continue turn (an LLM call against the
   * current thread state, with no new user message). Resolves once the
   * response has started streaming (an item is appended). Used by a
   * multi-phase strategy at the end of a phase to produce a summary turn.
   * @param {{threadItemId?: string|null}} [options]
   * @returns {Promise<void>}
   * @throws {AbortError} If cancelled
   */
  async continueConversation({ threadItemId = null } = {}) {
    this._checkAborted();
    await submitPendingRequest(this.messageThread, 'continue', (reqMap) => {
      if (threadItemId !== null && threadItemId !== undefined) reqMap.set('threadItemId', threadItemId);
    }, this._abortController?.signal);
  }

  /**
   * Inject situational guidance into the conversation as a durable
   * system-reminder message, rather than authoring system-prompt text.
   *
   * This is the sanctioned way for a strategy to steer a turn (mode notices,
   * phase transitions, read-only warnings). Because it writes a message into
   * the doc — which the worker re-reads each turn — the guidance reaches the
   * LLM on the production worker path, and it leaves the cached system prefix
   * untouched (so a strategy swap or phase change doesn't bust the cache).
   * @param {string} content - Guidance text
   * @param {object} [opts] - Options
   * @param {string} [opts.source] - Provenance tag (defaults to the strategy id)
   */
  injectGuidance(content, { source } = {}) {
    this.messageThread.addSystemReminder(content, source ?? this.getManifest?.()?.id ?? 'strategy');
  }

  /**
   * Get the approval policy for a tool call.
   * The framework computes the default approval decision using the existing
   * permission system (action.requiresApproval() + action.isPermitted()), then
   * calls this method with the full context. The strategy has master control:
   * it can override in either direction.
   * Override this to customize approval behavior per strategy. For example,
   * the read-only strategy auto-approves all read/meta tools; the YOLO
   * strategy auto-approves every gate.
   *
   * ELICITATIONS ARE NOT DELEGABLE. `interactionKind` distinguishes a go/no-go
   * **gate** from an **elicitation** — a tool whose parked state awaits the
   * user's own input (e.g. AskUserQuestion), where the "approval" IS that
   * answer (see {@link import('./context-item.js').INTERACTION_KIND}). Returning
   * `APPROVE` for an elicitation runs the tool with no answer, silently deciding
   * for the user; a blanket auto-approve strategy must exclude them (return
   * `DEFAULT` so it still parks). This mirrors `onToolPending`, which the
   * framework never fires for elicitations at all.
   *
   * NON-AUTO-APPROVABLE CHECKPOINTS. `autoApprovable` is false for a call the
   * action marks as a deliberate human review point (a plan `submit`; a
   * catastrophic delete). A blanket auto-approve strategy should likewise return
   * `DEFAULT` for these so they still park — the same floor `onToolPending`'s
   * `autoApprovable` guard applies to the out-of-band reviewer.
   * @param {{toolName: string, toolInput: Record<string, unknown>, category: string|undefined, defaultApproval: boolean, interactionKind: string, autoApprovable: boolean}} info
   *   - toolName: Name of the tool being called
   *   - toolInput: Input parameters for the tool
   *   - category: Tool category ('read', 'write', 'meta', or undefined)
   *   - defaultApproval: What the existing permission system decided (true = needs approval)
   *   - interactionKind: The parked-state kind — one of {@link import('./context-item.js').INTERACTION_KIND} ('gate' or 'elicitation')
   *   - autoApprovable: false when the action forbids silent auto-approval (a deliberate human checkpoint) — a blanket auto-approve should return DEFAULT so it parks
   * @returns {'approve'|'require-approval'|'default'} Policy decision (use APPROVAL_POLICY constants)
   */
  getApprovalPolicy({ toolName, toolInput, category, defaultApproval, interactionKind, autoApprovable }) {
    void toolName; void toolInput; void category; void defaultApproval; void interactionKind; void autoApprovable;
    return APPROVAL_POLICY.DEFAULT;
  }

  /**
   * Called (fire-and-forget, engine-only) the moment a tool call has parked
   * awaiting approval — i.e. the permission system decided it needs approval
   * and this strategy did not auto-approve or force-approve it via
   * {@link getApprovalPolicy}.
   *
   * This is the sanctioned seam for out-of-band approval automation. Unlike
   * `getApprovalPolicy` — which must return its decision synchronously — this
   * hook may be async and do real work. For example, an auto-approve strategy
   * can classify the parked action with a cheap out-of-band model (via
   * `generateText` from `juggler/ops`) and then approve or deny it by calling
   * {@link import('../js/model/message-thread.js').default#resolveApproval}:
   * `this.messageThread.resolveApproval(toolUseId, 'yes' | 'no')`.
   *
   * The framework does not await this hook. The tool stays parked until
   * something resolves it — this strategy, or the user. That makes the safe
   * default **fail-closed**: if the hook errors, times out, or never resolves,
   * the tool simply waits for human approval. Because the hook runs only on the
   * authoritative engine (never in passive viewers), it fires exactly once per
   * park; no viewer election is needed.
   *
   * While the returned promise is in flight the approval card shows a transient
   * "reviewing…" indicator (labelled from `static REVIEW_LABEL`, else the
   * manifest `name`), with the approval buttons fully live so the user can
   * always decide instantly and race the hook. For that span the parked call
   * also does not count as waiting on the user: the attention alert (chime,
   * flash, dock bounce) holds until the review ends and leaves it parked, so a
   * call this hook goes on to approve never interrupts anyone. A hook that
   * never settles therefore never alerts either — the call sits showing
   * "reviewing…" until the user or the strategy resolves it. Resolving with `{note}` swaps
   * that indicator for the note and leaves it in the card — the way to tell the
   * user why a call is still parked (e.g. an out-of-band reviewer declined, and
   * its reason). Resolve with nothing to clear the indicator instead. A note is
   * display only: it is shown as plain text (never markup), is trimmed to a
   * single capped line, and can neither resolve nor block the parked call.
   *
   * Note: worker-managed tools (e.g. `create_thread`) are driven entirely by
   * the Go worker and are not routed through this hook — it covers the
   * browser-executed tools (`bash`, `write`, `edit`, …) that park at the
   * engine approval gate, which is where command auto-approval applies.
   *
   * GATE INTERACTIONS ONLY. This hook fires solely for tools whose parked state
   * is a delegable go/no-go **gate**. It is never called for an *elicitation*
   * (a tool whose approval surface is a user-input form, e.g. AskUserQuestion,
   * declared via `MANIFEST.interaction: 'elicitation'` — see `INTERACTION_KIND`):
   * that resolution is the user's own answer, which no strategy can stand in
   * for. So a strategy may resolve anything it is handed here without risk of
   * silently answering a question — the framework has already excluded them.
   * @param {{toolUseId: string, toolName: string, toolInput: Record<string, unknown>, category: string|undefined, permissionKey: string, autoApprovable?: boolean}} info
   *   - toolUseId: id to pass to `messageThread.resolveApproval` (a human's
   *     verdict: `'yes'` runs it, `'no'` cancels it and stops the turn) or to
   *     `messageThread.refuseApproval` (automation declining on an absent
   *     user's behalf: the call fails, the turn continues)
   *   - toolName: name of the parked tool
   *   - toolInput: the tool's input parameters (plain object)
   *   - category: tool category ('read', 'write', 'meta', or undefined)
   *   - permissionKey: the action's permission key (e.g. 'write-file' for every
   *     edit-family tool). Discriminates classes of parked call that share a
   *     category — edits and shell commands are both category 'write'.
   *   - autoApprovable: false when the action forbids silent auto-approval (a
   *     plan submit, a project-root/home deletion). A strategy reviewer must NOT
   *     resolve such a call — leave it parked for a human.
   * @returns {void|Promise<{note?: string}|void>} Resolve with `{note}` to leave that
   *   message in the approval card; anything else clears the review indicator
   */
  onToolPending(info) {
    void info;
    // Default: no-op — the tool stays parked until the user (or an overriding
    // strategy) resolves it.
  }

  // ============================================================================
  // INTERNAL HELPERS
  // ============================================================================

  /**
   * Check if operation was aborted and throw if so.
   * @private
   * @throws {AbortError} If aborted
   */
  _checkAborted() {
    if (this._abortController?.signal?.aborted) {
      throw new AbortError('Strategy execution was cancelled');
    }
  }

  // ============================================================================
  // MANIFEST & SERIALISATION
  // ============================================================================

  /**
   * Serialize strategy state for persistence
   * @returns {{id: string, state: object}} JSON representation
   */
  toJSON() {
    return {
      id: this.getManifest().id,
      state: this.state
    };
  }

  /**
   * Restore strategy state from JSON
   * @param {{id?: string, state?: object}} json - Saved strategy data
   */
  fromJSON(json) {
    this.state = json?.state || {};
  }

  /**
   * Get strategy manifest
   * @returns {StrategyManifest} Strategy manifest
   */
  getManifest() {
    const ctor = /** @type {typeof StrategyType} */ (this.constructor);
    return ctor.MANIFEST;
  }
}

export default StrategyType;
