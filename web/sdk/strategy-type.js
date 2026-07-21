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
 * @property {'default'|'all-parallel'|'all-sequential'} [toolExecution] - How tool calls are executed: 'default' = reads parallel/writes sequential, 'all-parallel' = all concurrent, 'all-sequential' = one at a time
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
 * Tool definition for LLM
 * @typedef {object} ToolDefinition
 * @property {string} name - Tool name
 * @property {string} description - Human-readable description
 * @property {object} input_schema - JSON Schema for parameters
 * @property {'read'|'write'|'meta'} [category] - Tool category
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
import { bindWorkspace, unbindWorkspace } from './ops.js';

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
 *     `defaultAllowedPaths`, `toolExecution`, `showsApprovalControls`,
 *     `recommendations`, `color`, `icon`.
 *   - `filterTools(tools)` — restrict which tools the model may call (per phase).
 *   - `getApprovalPolicy(info)` — auto-approve or force-approve a tool call.
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
 * 3. Define a static MANIFEST (id, name, version, description, author).
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
 *   filterTools(tools) {
 *     return tools.filter(t => t.category === 'read' || t.category === 'meta');
 *   }
 *
 *   getApprovalPolicy({ category }) {
 *     return (category === 'read' || category === 'meta')
 *       ? APPROVAL_POLICY.APPROVE
 *       : APPROVAL_POLICY.DEFAULT;
 *   }
 *
 *   onActivate() {
 *     this.injectGuidance('PLANNING MODE: investigate and propose a plan; do not modify anything.');
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
 * | onActivate(prevId)         | Inject guidance when this strategy becomes active |
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

    // Validate manifest on construction
    this._validateManifest();
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
   * This is the sanctioned place to inject situational guidance — a mode notice,
   * a phase change — via {@link injectGuidance}, which writes a durable
   * system-reminder to the conversation. Strategies steer the model through
   * injected messages, tool gating, and loop control, never by authoring
   * system-prompt text. The worker drives this hook in the engine exactly once
   * per switch (at the first turn under the new strategy), so the guidance is
   * written once — no per-viewer election.
   * @param {string|null} [_previousStrategyId] - The strategy that was active before
   * @returns {void|Promise<void>} Nothing
   */
  onActivate(_previousStrategyId) {
    // Default: no-op
  }

  // ============================================================================
  // WORKER-REQUEST PRIMITIVES (multi-phase strategies)
  // ============================================================================

  /**
   * Create a sub-thread that runs autonomously on the worker.
   * The thread appears in the conversation UI. Blocks until thread completes.
   * @param {{goal: string, prompt: string, parentThreadItemId?: string|null, isContinuation?: boolean}} options
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
   * Bind this conversation's execution root to `root`. While bound, the
   * conversation's file/shell/search/tree ops run under `root` instead of the
   * project directory (paths are still validated in real-project space, so the
   * security boundary is unchanged). This is how a strategy adds a worktree-style
   * workflow: prepare an alternate root (e.g. `git worktree add` via the `shell`
   * op), then bind it here — typically from {@link onActivate}. Pair with
   * {@link unbindWorkspace} on teardown.
   * @param {string} root - Absolute path of the alternate execution root.
   * @returns {Promise<{ok: boolean, root?: string, error?: string}>} Bind result.
   */
  async bindWorkspace(root) {
    return bindWorkspace(this.messageThread.conversationId, root);
  }

  /**
   * Clear this conversation's workspace binding; ops revert to the project root.
   * @returns {Promise<{ok: boolean, error?: string}>} Unbind result.
   */
  async unbindWorkspace() {
    return unbindWorkspace(this.messageThread.conversationId);
  }

  /**
   * Inject situational guidance into the conversation as a durable
   * system-reminder message, rather than authoring system-prompt text.
   *
   * This is the sanctioned way for a strategy to steer a turn (mode notices,
   * phase transitions, read-only warnings). Because it writes a message into
   * the doc — which the worker re-reads each turn — the guidance reaches the
   * LLM on the production worker path, and it leaves the cached system prefix
   * untouched (a strategy swap or phase change no longer busts the cache).
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
   * strategy auto-approves every tool.
   * @param {{toolName: string, toolInput: Record<string, unknown>, category: string|undefined, defaultApproval: boolean}} info
   *   - toolName: Name of the tool being called
   *   - toolInput: Input parameters for the tool
   *   - category: Tool category ('read', 'write', 'meta', or undefined)
   *   - defaultApproval: What the existing permission system decided (true = needs approval)
   * @returns {'approve'|'require-approval'|'default'} Policy decision (use APPROVAL_POLICY constants)
   */
  getApprovalPolicy({ toolName, toolInput, category, defaultApproval }) {
    void toolName; void toolInput; void category; void defaultApproval;
    return APPROVAL_POLICY.DEFAULT;
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

  /**
   * Validate that the strategy class has a properly structured MANIFEST
   * @private
   * @throws {Error} If MANIFEST is missing or has missing required fields
   */
  _validateManifest() {
    const className = this.constructor.name;
    const manifest = this.getManifest();

    if (!manifest) {
      throw new Error(`${className} must define a static MANIFEST`);
    }
    // Required fields match the other capability types (id/name/version/
    // description). `author` is optional metadata.
    const requiredFields = [
      'id',
      'name',
      'version',
      'description'
    ];

    const missingFields = requiredFields.filter(field => !(field in manifest));

    if (missingFields.length > 0) {
      throw new Error(
        `${className}.MANIFEST is missing required fields: ${missingFields.join(', ')}`
      );
    }
  }
}

export default StrategyType;
