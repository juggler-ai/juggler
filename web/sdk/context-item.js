//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { extractErrorMessage } from './lib/error-utils.js';
import { FormattingHelpers } from './lib/formatting-helpers.js';
import { isEngine, isViewer } from './lib/client-role.js';
import { coerceToolInputToSchema } from './coerce-schema-types.js';

// ============================================================================
// Type Definitions
// ============================================================================
//
// The context-item type vocabulary lives in ./context-item-types.js. These
// aliases re-export it from this module so both this file's JSDoc and external
// `import('juggler/context-item').TypeName` references keep resolving.

/**
 * @typedef {import('./context-item-types.js').ItemSummary} ItemSummary
 * @typedef {import('./context-item-types.js').ApprovalConfig} ApprovalConfig
 * @typedef {import('./context-item-types.js').ApprovalSuggestion} ApprovalSuggestion
 * @typedef {import('./context-item-types.js').ValidationResult} ValidationResult
 * @typedef {import('./context-item-types.js').PreparedItem} PreparedItem
 * @typedef {import('./context-item-types.js').OutcomeSuccess} OutcomeSuccess
 * @typedef {import('./context-item-types.js').OutcomeFailure} OutcomeFailure
 * @typedef {import('./context-item-types.js').Outcome} Outcome
 * @typedef {import('./context-item-types.js').ResultStatus} ResultStatus
 * @typedef {import('./context-item-types.js').ResultStatusMessage} ResultStatusMessage
 * @typedef {import('./context-item-types.js').ToolCallResult} ToolCallResult
 * @typedef {import('./context-item-types.js').ToolCallContext} ToolCallContext
 * @typedef {import('./context-item-types.js').ContextParams} ContextParams
 * @typedef {import('./context-item-types.js').MergeOrReplaceResult} MergeOrReplaceResult
 * @typedef {import('./context-item-types.js').ItemContext} ItemContext
 * @typedef {import('./context-item-types.js').ModelConfig} ModelConfig
 * @typedef {import('./context-item-types.js').ItemJSON} ItemJSON
 * @typedef {import('./context-item-types.js').ToolActionRenderHelpers} ToolActionRenderHelpers
 * @typedef {import('./context-item-types.js').ToolActionRenderContext} ToolActionRenderContext
 * @typedef {import('./context-item-types.js').ContextItemManifest} ContextItemManifest
 * @typedef {import('./context-item-types.js').SubthreadSpec} SubthreadSpec
 * @typedef {import('./context-item-types.js').SubthreadBuildContext} SubthreadBuildContext
 * @typedef {import('./context-item-types.js').SubthreadErrorFallback} SubthreadErrorFallback
 */

// ============================================================================
// ContextItem Base Class — Universal base for ALL conversation items
// ============================================================================

/**
 * ContextItem — base class for all conversation items.
 *
 * Provides universal capabilities: identity, token counting, timestamps,
 * brief summaries, serialization, item-behavior methods (validation,
 * execution, approval, status UI, result formatting), manifest system,
 * and plugin lifecycle (tool definitions, merge/replace, tool call handling).
 *
 * ## Creating a Context Item
 *
 * Context items ship inside an **extension** (a directory with a
 * `juggler.extension.json` manifest). Scaffold one with `juggler ext init` and
 * link it with `juggler ext link`; see `docs/extension_guide.md`.
 *
 * 1. Add a file named `*-context-item.js` under the extension's `context-items/`
 *    directory — the manifest's `provides` glob registers it automatically.
 * 2. Import and extend ContextItem: `import ContextItem from 'juggler/context-item';`
 * 3. Define static MANIFEST with required fields (id, name, version, description)
 * 4. Implement static `getToolDefinitions()`, `execute()`, and `getSummary()`
 * 5. Save — a linked extension hot-reloads in connected viewers; no restart.
 *
 * ## Quick Start — Minimal Context Item
 *
 * ```javascript
 * import ContextItem from 'juggler/context-item';
 *
 * class WordCountContextItem extends ContextItem {
 *   static MANIFEST = {
 *     id: 'word-count',
 *     name: 'Word Count',
 *     version: '1.0.0',
 *     description: 'Count words in a text string'
 *   };
 *
 *   static getToolDefinitions() {
 *     return [{
 *       name: 'word_count',
 *       category: 'read',
 *       description: 'Count words in a text string',
 *       input_schema: {
 *         type: 'object',
 *         properties: {
 *           text: { type: 'string', description: 'Text to count words in' }
 *         },
 *         required: ['text']
 *       }
 *     }];
 *   }
 *
 *   // execute() returns RAW result data; the framework wraps it as the outcome
 *   // { success, result: <return value>, prepared, error }.
 *   async execute(params) {
 *     const count = params.text.split(/\s+/).filter(Boolean).length;
 *     return { count };
 *   }
 *
 *   // Read your data from outcome.result (NOT outcome.count). `summary` is both
 *   // the UI line and the tool_result text the model sees.
 *   getSummary(outcome) {
 *     if (!outcome.success) return { summary: outcome.error, success: false };
 *     return { summary: `${outcome.result.count} words`, success: true };
 *   }
 * }
 *
 * export default WordCountContextItem;
 * ```
 *
 * ## Required vs Optional Methods
 *
 * | Override               | Required? | Purpose                                    |
 * |------------------------|-----------|--------------------------------------------|
 * | `static MANIFEST`      | Yes       | Plugin identity and metadata               |
 * | `static getToolDefinitions()` | Yes | LLM tool schemas                     |
 * | `execute(params)`      | Yes       | Perform the operation                      |
 * | `getSummary(outcome)`  | Yes       | Format result for LLM + UI                 |
 * | `validate(toolInput)`  | Usually   | Normalize and validate parameters          |
 * | `getStatusUI()`        | Optional  | Rich UI rendering in viewer                |
 * | `getApprovalConfig()`  | Optional  | Approval dialog (if requiresApproval)      |
 * | `createContextText()`  | Optional  | Custom LLM context text                    |
 * | `mergeOrReplace()`     | Optional  | Handle duplicate requests                  |
 * | `getBadgeOptions()`    | Optional  | Custom badge color/icon                    |
 *
 * ## Execution Contexts
 *
 * Plugin code is loaded in **two** browser instances:
 *
 * - **Viewer** — the user-facing UI. Has full DOM access.
 * - **Engine** — a headless Chrome instance that executes tools. No DOM.
 *
 * The framework transparently routes calls to the correct instance; plugins
 * generally do not need to check which context they are in. The table below
 * shows which context each overridable method runs in:
 *
 * | Method               | Context  | Notes                                      |
 * |----------------------|----------|--------------------------------------------|
 * | `execute()`          | engine   | No DOM — don't use `document.*` here       |
 * | `getStatusUI()`      | viewer   | Return UI config for the viewer to render   |
 * | `validate()`         | shared   | Runs in whichever context initiates it      |
 * | `getToolDefinitions()` | shared | Static — called during tool registration    |
 * | `mergeOrReplace()`   | shared   | Static — called during item creation        |
 * | `createContextText()`| shared   | Generates LLM context in either instance    |
 * | `getSummary()`       | shared   | Formats results for LLM and UI              |
 * | `getApprovalConfig()`| shared   | Builds approval dialog data                 |
 *
 * The `METHOD_CONTEXT` static property declares these assignments and can be
 * overridden by subclasses that add custom context-exclusive methods.
 *
 * In dev mode (`window.__jugglerDevMode`), context-exclusive methods are
 * wrapped with guards that throw if called in the wrong instance.
 *
 * For rare cases where a method needs context-specific behavior, import
 * `isEngine()` / `isViewer()` from `web/sdk/lib/client-role.js`.
 * @class
 */
class ContextItem {
  /**
   * Item manifest (static property set by subclasses)
   * @type {ContextItemManifest|undefined}
   */
  static MANIFEST;

  /**
   * Declares which execution context each overridable method runs in.
   * Subclasses can override to declare context for custom methods.
   *
   * - `'engine'`  — headless Chrome (no DOM)
   * - `'viewer'`  — user-facing browser (has DOM)
   * - `'shared'`  — runs in both (default for unlisted methods)
   * @type {Record<string, 'engine'|'viewer'|'shared'>}
   */
  static METHOD_CONTEXT = {
    execute:     'engine',
    getStatusUI: 'viewer',
  };

  /**
   * Validate ItemSummary has string fields (defensive, catches plugin bugs)
   * @static
   * @param {ItemSummary} summary - Summary object from getSummary()
   * @returns {ItemSummary} Validated summary with guaranteed string fields
   */
  static validateSummary(summary) {
    if (!summary || typeof summary !== 'object') {
      console.error('[ContextItem] getSummary returned non-object:', summary);
      return { summary: 'Error formatting result', details: '', success: false, icon: '✗' };
    }

    const validated = { ...summary };

    if (typeof validated.summary !== 'string') {
      console.error('[ContextItem] summary field is not string:', typeof validated.summary);
      validated.summary = extractErrorMessage(validated.summary);
    }

    if (validated.details !== undefined && typeof validated.details !== 'string') {
      console.error('[ContextItem] details field is not string:', typeof validated.details);
      validated.details = extractErrorMessage(validated.details);
    }

    if (validated.feedbackForLLM !== undefined && typeof validated.feedbackForLLM !== 'string') {
      console.error('[ContextItem] feedbackForLLM is not string:', typeof validated.feedbackForLLM);
      validated.feedbackForLLM = extractErrorMessage(validated.feedbackForLLM);
    }

    return validated;
  }

  /**
   * Create a new context item
   * @param {ItemContext} context - Required context: id, session, conversation, messageThread
   */
  constructor(context) {
    const className = this.constructor.name;

    if (!context.id) {
      throw new Error(`${className}: id is required`);
    }
    if (!context.session) {
      throw new Error(`${className}: session is required`);
    }
    if (!context.conversation) {
      throw new Error(`${className}: conversation is required`);
    }
    if (!context.messageThread) {
      throw new Error(`${className}: messageThread is required`);
    }

    /** @type {string} */
    this.id = context.id;

    /** @type {import('../js/model/session.js').default} */
    this.session = context.session;

    /** @type {import('../js/model/conversation.js').default} */
    this.conversation = context.conversation;

    /** @type {import('../js/model/message-thread.js').MessageThread} */
    this.messageThread = context.messageThread;

    /** @type {string} */
    this.type = context.type || /** @type {any} */ (this.constructor).MANIFEST?.id || 'unknown';

    /**
     * Tool use ID for filtering self from items during validation
     * @type {string|undefined}
     */
    this.toolUseId = context.toolUseId;

    /**
     * The (resolved) name of the tool this instance was created to handle.
     * Set by the framework at tool-execution construction sites so a class that
     * exposes multiple tools can route to the right one (the MCP bridge relies
     * on this). Undefined for non-tool instantiations.
     * @type {string|undefined}
     */
    this.toolName = context.toolName;

    /**
     * Abort signal for cooperative cancellation. The framework aborts this
     * when the user cancels (Escape) or the worker writes state='cancelled'
     * on this tool-action. A long-running execute() should forward it to its
     * backend op call so an in-flight fetch unwinds immediately instead of
     * running to completion and overwriting the cancelled state.
     * @type {AbortSignal|undefined}
     */
    this.signal = context.signal;

    /**
     * Progress callback for streaming output, set by the ActionExecutor.
     * @type {((event: any) => void)|undefined}
     */
    this.onProgress = context.onProgress;

    /**
     * Callback invoked when item content changes (set by conversation)
     * @type {Function|null}
     */
    this.onContentChange = null;

    /**
     * Item result data
     * @type {Record<string, any>}
     */
    this.data = {};

    // Validate manifest if the subclass defines one
    if (/** @type {any} */ (this.constructor).MANIFEST) {
      this._validateManifest();
    }

    // Dev-mode: wrap context-exclusive methods with guards that throw
    // a clear error when called in the wrong browser instance.
    if (typeof window !== 'undefined' && /** @type {any} */ (window).__jugglerDevMode) {
      const contexts = /** @type {any} */ (this.constructor).METHOD_CONTEXT || {};
      /** @type {any} */ const self = this;
      for (const [method, ctx] of Object.entries(contexts)) {
        if (typeof self[method] !== 'function') continue;
        const name = method;
        if (ctx === 'engine' && isViewer()) {
          self[method] = () => { throw new Error(`${name}() is engine-only — cannot call in viewer`); };
        } else if (ctx === 'viewer' && isEngine()) {
          self[method] = () => { throw new Error(`${name}() is viewer-only — cannot call in engine`); };
        }
      }
    }
  }

  /**
   * The caller's standing allowed-paths grant — the merged session +
   * conversation + project-root list the user has authorised. Pass this as
   * `params.allowedPaths` to read/search/tree backend ops so they may reach
   * user-approved locations outside the project root (the same grant that
   * auto-approves shell commands touching those paths). Returns an empty array
   * when no message thread is bound.
   * @returns {string[]} Allowed filesystem roots.
   */
  getAllowedPaths() {
    return this.messageThread?.getAllowedPaths?.() || [];
  }

  /**
   * The allowed roots to send to read/search/tree backend ops as
   * `params.allowedPaths`. Unlike {@link getAllowedPaths} (which prepends the
   * implicit project root, e.g. for display), this omits the project root: the
   * backend PathScope is already rooted at the server's LIVE project path, so
   * the root is supplied authoritatively server-side and must NOT be re-sent by
   * the engine — which, being persistent across a project switch, may still
   * hold the previous project's path and would otherwise re-authorise reads
   * across the old tree. See message-thread-permissions.getExplicitAllowedPaths.
   * @returns {string[]} Explicit allowed roots (no implicit project root).
   */
  getToolAllowedRoots() {
    return this.messageThread?.getExplicitAllowedPaths?.() || [];
  }

  // ============================================================================
  // TITLES AND SUMMARIES
  // ============================================================================

  /**
   * Get display title for this item
   * @returns {string} Display title
   */
  getTitle() {
    return /** @type {any} */ (this.constructor).MANIFEST?.name || this.type;
  }

  /**
   * Get brief summary string for display (override in subclasses)
   * @returns {string} Brief summary
   */
  getBriefSummary() {
    return this.getTitle();
  }

  // ============================================================================
  // VALIDATION AND PREPARATION
  // ============================================================================

  /**
   * Validate and normalize parameters for execution
   * [Context: shared]
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM tool call
   * @returns {Promise<ValidationResult>} Validation result with normalized params
   */
  async validate(toolInput) {
    return { valid: true, params: toolInput };
  }

  /**
   * Build approval UI configuration for this item
   * [Context: shared]
   * @param {Record<string, unknown>} _params - Validated/normalized params from validate()
   * @returns {Promise<ApprovalConfig|null>} Approval config, or null for default dialog
   */
  async getApprovalConfig(_params) {
    return null;
  }

  /**
   * Validate, normalize params, and build approval config in one step.
   * Combines validate() + getApprovalConfig() for callers that need both.
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM tool call
   * @returns {Promise<PreparedItem>} Prepared item with validation state and approval config
   */
  async prepare(toolInput) {
    // Schema-driven type coercion at the single shared boundary: an LLM that
    // emits a numeric/boolean param as a string (offset: "40") is corrected
    // against this item's own declared schema before validate() ever runs, so
    // no tool needs its own string-parsing. Conservative + lossless — a value
    // that can't cleanly coerce is left untouched and still surfaces as an
    // error. See sdk/coerce-schema-types.js.
    const coerced = coerceToolInputToSchema(
      toolInput,
      /** @type {any} */ (this.constructor).getToolDefinitions().map((/** @type {{input_schema?: object}} */ d) => d.input_schema)
    );

    const validation = await this.validate(coerced);
    if (!validation.valid) {
      return validation;
    }

    const approval = await this.getApprovalConfig(validation.params || coerced);

    return {
      valid: true,
      params: validation.params,
      approval: approval || undefined,
      displayData: approval?.display
    };
  }

  // ============================================================================
  // SUBTHREAD DELEGATION
  // ============================================================================

  /**
   * Decide whether this invocation runs as a subthread, and how to seed it.
   * Only consulted when the MANIFEST sets `delegatesToSubthread: true`. Runs in
   * the browser (engine), after `validate()`. Returning a spec delegates the
   * call to a child agent turn (whose `return_result` becomes this tool's
   * result); returning `null` runs the ordinary client-side `execute()`.
   * [Context: engine]
   * @param {Record<string, unknown>} toolInput - Validated tool input.
   * @param {SubthreadBuildContext} ctx - { conversation, session, signal }.
   * @returns {Promise<SubthreadSpec | null> | SubthreadSpec | null} Spec → delegate; null → run execute(). May be async (e.g. to fetch and inline data).
   */
  buildSubthreadSpec(toolInput, ctx) {
    void toolInput;
    void ctx;
    return null;
  }

  /**
   * Optional fallback invoked when a delegated child ends without a result
   * (it errored, or ended without calling return_result and left no clean
   * trailing text). Return `{ result }` to deliver that text as the tool_result
   * instead of a default error, or `null` to accept the default.
   * [Context: engine]
   * @param {Error} error - Why the child failed / ended open.
   * @param {Record<string, unknown>} toolInput - The original validated input.
   * @returns {Promise<SubthreadErrorFallback | null> | SubthreadErrorFallback | null} Fallback result, or null for the default (base: null)
   */
  onSubthreadError(error, toolInput) {
    void error;
    void toolInput;
    return null;
  }

  // ============================================================================
  // EXECUTION
  // ============================================================================

  /**
   * Execute the operation
   * [Context: engine]
   * @abstract
   * @param {Record<string, unknown>} params - Prepared params from prepare().params
   * @returns {Promise<Record<string, unknown>>} Result data (passed to getSummary)
   * @throws {Error} If execution fails or not implemented
   */
  async execute(params) {
    void params;
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * Format a structured error from the backend into dual messages
   * @param {Record<string, unknown>} _result - Structured error result from backend
   * @param {string} _toolName - Name of the tool that failed
   * @returns {{userMessage: string, llmMessage: string}|null} Dual messages, or null if not handled
   */
  formatError(_result, _toolName) {
    return null;
  }

  // ============================================================================
  // RESULT FORMATTING
  // ============================================================================

  /**
   * Format any outcome for display (action pattern)
   * [Context: shared]
   * @param {Outcome} outcome - Outcome object
   * @returns {ItemSummary} Formatted result
   */
  getSummary(outcome) {
    if (!outcome.success) {
      if (outcome.denied) {
        return { summary: 'Action denied by user', details: '', success: false, icon: '✗' };
      }
      if (outcome.cancelled) {
        return { summary: 'Action cancelled', details: '', success: false, icon: '✗' };
      }
      return { summary: `Action failed: ${outcome.error}`, details: '', success: false, icon: '✗' };
    }
    return { summary: 'Action completed', details: '', success: true, icon: '✓' };
  }

  /**
   * Get result details for successful tool call
   * @returns {Record<string, any>} Tool result details
   */
  getToolResult() {
    return { id: this.id };
  }

  // ============================================================================
  // PERMISSION SYSTEM
  // ============================================================================

  /**
   * Check if this item requires approval
   * @returns {boolean} True if approval is required
   */
  requiresApproval() {
    return /** @type {any} */ (this.constructor).MANIFEST?.requiresApproval ?? false;
  }

  /**
   * Check if this item cannot be deleted by the user
   * @returns {boolean} True if user deletion is prevented
   */
  preventUserDeletion() {
    return /** @type {any} */ (this.constructor).MANIFEST?.preventUserDeletion ?? false;
  }

  /**
   * Get the permission key for this item
   * @param {Record<string, unknown>} _toolInput - Tool input parameters
   * @returns {string} Permission key
   */
  getPermissionKey(_toolInput) {
    return /** @type {any} */ (this.constructor).MANIFEST?.id || this.type;
  }

  /**
   * Check if this item is permitted by conversation permissions
   * @param {Record<string, unknown>} _toolInput - Tool input parameters
   * @returns {boolean} True if item is auto-approved
   */
  isPermitted(_toolInput) {
    return false;
  }

  /**
   * Return auto-approval suggestions for this tool input — an escalating-breadth
   * list of rule-sets the user can choose from when clicking "don't ask again".
   * The framework renders one button per suggestion (narrowest breadth first);
   * on selection it persists exactly that suggestion's rules under its
   * `itemType`. Each suggestion's rules, once added, must make
   * `isPermitted(toolInput)` return true.
   *
   * This is the single approval-persistence surface: a bare "yes-always" with no
   * chosen button persists the narrowest suggestion, and a plugin that returns
   * `[]` gets a framework boolean default under its `getPermissionKey`. Override
   * to offer smart, input-aware choices (see `ExecuteContextItem`, which
   * decomposes the shell command).
   * @param {Record<string, unknown>} _toolInput - Tool input parameters
   * @returns {ApprovalSuggestion[]} Suggestions, narrowest breadth first
   */
  getApprovalSuggestions(_toolInput) {
    return [];
  }

  // ============================================================================
  // PERMISSION UI (plugin-owned)
  // ============================================================================
  //
  // The permission-controls component (host shell) iterates every registered
  // context-item class and asks each to contribute its own UI fragment. A
  // plugin that has no auto-approval surface returns null and stays invisible
  // in the popup. The host owns layout, boxed cards, and the section header
  // (sourced from `getTypeName()` so the popup heading matches the label
  // printed on the corresponding item card); the plugin owns the contents.
  //
  // The contract is intentionally narrow: a single static method that takes
  // the MessageThread and returns one HTMLElement (or null). The plugin uses
  // the generic `getRulesFor` / `addRule` / `removeRule` / `updateRule`
  // helpers on the thread to read and write its own rules.

  /**
   * Short label for this plugin used wherever the framework needs to name the
   * item type — most prominently as the `typeName` on the item card and as
   * the heading of this plugin's section in the permissions popup. Override
   * to return a shorter or more colloquial label than `MANIFEST.name`
   * (e.g. "Bash" instead of "Execute Command").
   * @returns {string} Short type label
   */
  static getTypeName() {
    return /** @type {any} */ (this).MANIFEST?.name || 'Item';
  }

  /**
   * Whether re-running a completed tool-action of this type must re-prompt the
   * user rather than silently replay the prior outcome.
   *
   * The default (false) re-runs by re-executing with the original input — the
   * right behaviour for tools whose result is a pure function of their input
   * (bash, grep, edit). Override to return true for tools whose result IS the
   * user's input (e.g. AskUserQuestion): re-running such a tool resets it to
   * its pending/approval state so the user can give a fresh answer, instead of
   * reusing the stored response.
   * @returns {boolean} True if re-run should reset to pending and re-ask
   */
  static rerunRequiresReprompt() {
    return false;
  }

  /**
   * Whether re-running a completed tool-action of this type is a meaningful
   * operation the UI should offer a "Re-run" button for.
   *
   * The default (true) suits any tool whose result can differ or is worth
   * regenerating on re-execution: reads re-read a possibly-changed file,
   * grep/glob re-scan, bash/thread/monitor re-execute, writes/edits re-apply,
   * and prompt-driven tools (see {@link rerunRequiresReprompt}) re-ask. Override
   * to return false for tools whose execution is pure instruction-injection or
   * idempotent bookkeeping — a skill load, a memory write, a static manual dump,
   * defining an already-defined command — where re-running changes nothing the
   * user can observe and the button is just noise.
   * @returns {boolean} True if the "Re-run" control should be offered
   */
  static isRerunnable() {
    return true;
  }

  /**
   * Return a UI fragment that lets the user manage this plugin's permission
   * rules. The host inserts the returned element directly into the
   * permission-controls popup, between sibling plugins' sections. Return
   * `null` (the default) if this plugin has no permission UI.
   *
   * The element is responsible for its own event wiring and for observing
   * `messageThread.conversation` metadata if it wants to re-render on
   * external changes (peer sync, undo/redo). Keep it self-contained — the
   * host will not call back in.
   * Returns a `PermissionSection` — `{id, title?, element, dispose?}`. The
   * host shell mounts `element` into the popup and calls `dispose()` when
   * the popup closes; plugins should put Yjs observer teardown in `dispose`
   * rather than wiring DOM-lifecycle observers themselves.
   *
   * `id` is the dedup key: when several plugins return sections with the
   * same `id` (e.g. every edit-family plugin shares `'write-file'`), the
   * host renders only the first in registry order. `title`, when present,
   * becomes the card heading; omit it for self-describing single-control
   * sections (e.g. a lone toggle).
   * @param {import('../js/model/message-thread.js').MessageThread} _messageThread Owning thread
   * @returns {{id: string, title?: string, element: HTMLElement, dispose?: () => void} | null} Section, or null to opt out
   */
  static getPermissionSection(_messageThread) {
    return null;
  }

  // ============================================================================
  // UI RENDERING
  // ============================================================================

  /**
   * Get status UI configuration for rendering.
   * Action types receive execution status; context item types call with no args.
   * [Context: viewer]
   * @param {import('../js/services/action-executor.js').ActionStatus|null} [_actionStatus] - Full execution status
   * @param {Record<string, unknown>} [_toolInput] - Original tool input parameters
   * @param {{conversation?: unknown, session?: unknown, toolUseId?: string}} [_context] - Optional context
   * @returns {ResultStatusMessage|null} Status message config
   */
  getStatusUI(_actionStatus, _toolInput, _context) {
    return null;
  }

  /**
   * Create the properties panel view of this item. Override in subclasses.
   * @returns {HTMLElement} The properties panel element
   */
  createPropertiesPanelElement() {
    const el = document.createElement('div');
    el.textContent = this.type || 'Unknown item';
    return el;
  }

  /**
   * Render the input/details portion of the tool-action properties panel.
   *
   * The framework calls this for every tool action; plugins override it to
   * render their own input UI (file paths, diffs, code blocks, custom panels).
   * The default implementation falls back to a raw JSON dump of `ctx.input`.
   *
   * Return `{ skipResultSection: true }` if your implementation already
   * displays the result inline (e.g. via `createPropertiesPanelElement` on
   * the action data) — the framework will then skip the generic Result
   * section that normally follows the input.
   *
   * IMPORTANT: this is the polymorphism boundary that keeps tool-name
   * branching out of generic UI code. If you find yourself adding
   * `if (toolName === 'foo')` to a component, override this method instead.
   *
   * [Context: viewer]
   * @param {HTMLElement} wrapper - Section wrapper to append details into
   * @param {ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean }|void} Render result; set skipResultSection to true when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const inputText = JSON.stringify(ctx.input ?? {}, null, 2);
    if (inputText !== '{}') {
      ctx.helpers.addSubsection(wrapper, 'Input', inputText, 'properties-panel-code', { language: 'json' });
    }
  }

  /**
   * Label for the result section that follows `renderToolActionDetails`.
   * Receives the (lowercased) tool name so plugins that register multiple
   * tools (e.g. batch_read vs batch_grep) can return different labels.
   * Override per-plugin (e.g. 'Output' for execute, 'Matches' for grep,
   * 'Content' for read, 'Results' for websearch).
   * @param {string} _toolName - The (lowercased) tool name being rendered
   * @returns {string} Section label for the result/output area
   */
  static getResultSectionLabel(_toolName) {
    return 'Result';
  }

  /**
   * Language id for syntax-highlighting this plugin's result/output section
   * (e.g. 'json' for a tool whose output is a JSON document). The generic
   * renderer passes it to the shared highlighter, which degrades to escaped
   * plain text for unbundled/unknown languages — so '' (the default) means
   * "don't highlight". Mutually exclusive with {@link rendersTerminalOutput};
   * ANSI terminal rendering takes precedence when both are set.
   * @param {string} _toolName - The (lowercased) tool name being rendered
   * @returns {string} Prism language id, or '' for plain text
   */
  static resultSectionLanguage(_toolName) {
    return '';
  }

  /**
   * Human-readable title for a tool-action in the properties-panel header and
   * item card. Lets a plugin that drives several distinct operations through
   * one tool (e.g. the plan tool's submit vs step actions) label each one for
   * what it does, rather than all sharing the raw tool name. Receives the
   * parsed tool input and the (lowercased) tool name. Return null to fall back
   * to the tool name.
   * @param {Record<string, unknown>} _toolInput - Parsed tool input
   * @param {string} _toolName - The (lowercased) tool name being rendered
   * @returns {string|null} Display title, or null to use the tool name
   */
  static getToolActionTitle(_toolInput, _toolName) {
    return null;
  }

  /**
   * Whether this plugin's result/output is raw terminal output that may carry
   * ANSI escape sequences (SGR colour codes, cursor moves). When true, the
   * properties panel renders the output through the ANSI parser so colours
   * display correctly and non-display escapes don't show as literal garbage.
   * Default false — most tools return plain text or structured data.
   * @returns {boolean} True to render the result section as terminal output
   */
  static rendersTerminalOutput() {
    return false;
  }

  /**
   * Resolve terminal (cancelled/error) status from an action status object.
   * @param {import('../js/services/action-executor.js').ActionStatus} actionStatus - Action status
   * @param {string} [failurePrefix] - Prefix for error messages
   * @param {string} [cancelledMessage] - Custom cancelled message
   * @returns {{summary: string, status: ResultStatus}} Terminal status config
   */
  resolveTerminalStatus(actionStatus, failurePrefix, cancelledMessage) {
    if (actionStatus.cancelled) {
      return { summary: cancelledMessage || 'Cancelled', status: /** @type {ResultStatus} */ ('cancelled') };
    }
    const error = actionStatus.error || 'unknown error';
    const summary = failurePrefix ? `${failurePrefix}: ${error}` : error;
    return { summary, status: /** @type {ResultStatus} */ ('error') };
  }

  /**
   * Get badge display options (color and icon) for this item.
   * Delegates to the static method on the class so both instance and
   * class-level lookups use the same source.
   * @returns {{color: string, icon?: string}} Badge options
   */
  getBadgeOptions() {
    return /** @type {typeof ContextItem} */ (this.constructor).getBadgeOptions();
  }

  /**
   * Static badge options — override in subclasses to customize.
   * @returns {{color: string, icon?: string}} Badge options
   */
  static getBadgeOptions() {
    return /** @type {{color: string, icon?: string}} */ ({ color: 'slate' });
  }

  /**
   * Whether new items of this type should auto-select in the conversation list.
   * Override in subclasses (e.g., execute actions) to enable auto-selection.
   * @returns {boolean} True if items should auto-select when they appear
   */
  static shouldAutoSelect() {
    return false;
  }

  /**
   * Whether this item is currently visible in the conversation.
   * Override in subclasses to conditionally hide items (e.g., transaction markers).
   * @returns {boolean} True if the item should be rendered
   */
  isVisible() {
    return true;
  }

  // ============================================================================
  // CONTEXT TEXT
  // ============================================================================

  /**
   * Get context text for this item instance.
   * Calls createContextText() and validates the return type.
   * @async
   * @param {ContextParams} contextParams - Runtime context
   * @returns {Promise<string>} Context text for LLM
   */
  async getContextText(contextParams) {
    const content = await this.createContextText(contextParams);

    if (typeof content !== 'string') {
      console.error(`[ContextItem:${this.constructor.name}] createContextText returned ${typeof content}:`, content);
      return typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content ?? '');
    }

    return content;
  }

  /**
   * Create context text content for this item. Override in subclasses.
   * [Context: shared]
   * @param {ContextParams} contextParams - Runtime context
   * @returns {string|Promise<string>} Context text for LLM
   */
  createContextText(contextParams) {
    void contextParams;
    return '';
  }

  // ============================================================================
  // STATIC METHODS (PLUGIN)
  // ============================================================================

  /**
   * Get tool definitions for this item type
   * [Context: shared]
   * @static
   * @returns {Array<{name: string, category: string, description: string, input_schema: object}>} Array of tool definitions
   */
  static getToolDefinitions() {
    return [];
  }

  /**
   * Check if new params can be merged with or should replace an existing item
   * [Context: shared]
   * @static
   * @param {Record<string, any>} newParams - Parameters for the new request
   * @param {ContextItem[]} existingItems - All existing items of this type
   * @param {{projectPath?: string}} [context] - Optional context with project info
   * @returns {MergeOrReplaceResult|null} Merge result or null if no merge possible
   */
  static mergeOrReplace(newParams, existingItems, context) {
    void newParams, existingItems, context;
    return null;
  }

  // ============================================================================
  // MANIFEST AND METADATA
  // ============================================================================

  /**
   * Get item manifest
   * @returns {ContextItemManifest} Item manifest
   */
  getManifest() {
    const ctor = /** @type {typeof ContextItem} */ (this.constructor);
    const manifest = ctor.MANIFEST;

    return {
      id: manifest?.id || 'unknown',
      name: manifest?.name || 'Unknown Item',
      version: manifest?.version || '0.0.0',
      description: manifest?.description || '',
      requiresApproval: manifest?.requiresApproval ?? false,
      author: manifest?.author || '',
      permissions: manifest?.permissions || [],
      exampleData: manifest?.exampleData || {},
      refreshable: manifest?.refreshable || false,
      contextPosition: manifest?.contextPosition || 'user',
      watchesFileChanges: manifest?.watchesFileChanges || false,
      autoInstantiate: manifest?.autoInstantiate || false
    };
  }

  // ============================================================================
  // TOOL CALL LIFECYCLE
  // ============================================================================

  /**
   * Execute a tool call and store results in this.data
   * @param {string} _toolName - Name of the tool being called
   * @param {Record<string, any>} _params - Tool parameters from LLM
   * @returns {Promise<void>}
   */
  async onToolCall(_toolName, _params) {
    throw new Error('onToolCall() must be implemented by subclass');
  }

  /**
   * Handle a tool call for this plugin (framework entry point for refreshable items)
   * @param {string} toolName - Name of the tool being called
   * @param {Record<string, any>} params - Tool parameters from LLM
   * @param {ToolCallContext} context - Execution context
   * @returns {Promise<ToolCallResult>} The result of executing the tool call
   */
  async handleToolCall(toolName, params, context) {
    try {
      await this.onToolCall(toolName, params);

      const contextParams = {
        modelConfig: context.conversation?.modelConfig || null,
        helpers: FormattingHelpers
      };

      const content = await this.getContextText(contextParams);
      const message = typeof content === 'string' ? content : JSON.stringify(content);

      return {
        success: true,
        shouldContinue: true,
        includeInConversation: false,
        message: message,
        result: this.getToolResult()
      };
    } catch (err) {
      return {
        success: false,
        shouldContinue: false,
        includeInConversation: true,
        error: extractErrorMessage(err)
      };
    }
  }

  // ============================================================================
  // MANIFEST VALIDATION
  // ============================================================================

  /**
   * Validate that the item class has a properly structured MANIFEST
   * @private
   * @throws {Error} If MANIFEST is missing or has missing required fields
   */
  _validateManifest() {
    /** @type {any} */
    const ctor = this.constructor;
    const className = ctor.name;
    const manifest = ctor.MANIFEST;

    if (!manifest) {
      throw new Error(`${className} must define a static MANIFEST`);
    }

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

  // ============================================================================
  // SERIALIZATION
  // ============================================================================

  /**
   * Serialize item to JSON
   * @returns {ItemJSON} Serialized item object
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      data: this.data
    };
  }

  /**
   * Restore item from JSON
   * @param {ItemJSON} json - Serialized item object
   */
  fromJSON(json) {
    this.id = json.id || this.id;
    this.type = json.type || this.type;
    this.data = json.data || {};
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  /**
   * Destroy item and clean up resources (no-op base)
   */
  destroy() {
    // Base: no-op
  }
}

export default ContextItem;
