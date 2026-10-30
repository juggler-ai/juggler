//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { extractErrorMessage } from './lib/error-utils.js';
import { FormattingHelpers } from './lib/formatting-helpers.js';
import { isEngine, isViewer } from './lib/client-role.js';
import { coerceToolInputToSchema } from './coerce-schema-types.js';
import { smartTruncate } from './lib/smart-truncate.js';
import { validateManifest } from './lib/manifest.js';
import { createBoundOps } from './ops.js';
import { t, markUntranslated, markForTranslation } from './lib/i18n.js';

/**
 * Fallback character budget for LLM-facing tool output (~7500 tokens). The live
 * value belongs to the conversation (`Conversation#truncationBudget`); this is
 * what `ContextItem#truncationBudget()` falls back to when an item is
 * constructed against a conversation stub that has no budget of its own.
 * @type {number}
 */
export const DEFAULT_TRUNCATION_BUDGET = 30000;

/**
 * How a tool that parks for the human suspends — the two are resolved the same
 * way (`resolveApproval`) but mean opposite things:
 *
 *   - `GATE`: awaiting a **delegable decision**. The action is fully specified;
 *     the human (or a stand-in: a saved permission rule, an auto-approve
 *     reviewer, YOLO) answers go/no-go. The resolution is a *verdict*.
 *   - `ELICITATION`: awaiting **non-delegable input**. The tool yielded because
 *     it is missing an argument that exists only in the user's head (e.g.
 *     AskUserQuestion). The resolution *is* that content — no proxy can supply
 *     it, so automation must never resolve one on the user's behalf.
 *
 * A tool declares its kind via `MANIFEST.interaction` (default `GATE`). This is
 * the single discriminant behind form rendering, resolution-payload folding
 * (`applyApprovalResponse`), and whether `onToolPending` fires at all.
 * @enum {string}
 */
export const INTERACTION_KIND = {
  GATE: 'gate',
  ELICITATION: 'elicitation'
};

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
 * @typedef {import('./context-item-types.js').RevisedApprovalSuggestion} RevisedApprovalSuggestion
 * @typedef {import('./context-item-types.js').ValidationResult} ValidationResult
 * @typedef {import('./context-item-types.js').PreparedItem} PreparedItem
 * @typedef {import('./context-item-types.js').OutcomeSuccess} OutcomeSuccess
 * @typedef {import('./context-item-types.js').OutcomeFailure} OutcomeFailure
 * @typedef {import('./context-item-types.js').Outcome} Outcome
 * @typedef {import('./context-item-types.js').ResultStatus} ResultStatus
 * @typedef {import('./context-item-types.js').ResultStatusMessage} ResultStatusMessage
 * @typedef {import('./context-item-types.js').StatusBranch} StatusBranch
 * @typedef {import('./context-item-types.js').StatusUIConfig} StatusUIConfig
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
 */

// ============================================================================
// ContextItem Base Class — Universal base for ALL conversation items
// ============================================================================

/**
 * Call one tool from a program. With `withAttachments` it resolves to the
 * content and the asset refs of any images the call produced; without, to the
 * content alone.
 * @typedef {{
 *   (name: string, args: Record<string, unknown>, how: {withAttachments: true, tag?: unknown, answer?: string}): Promise<{content: string, attachments: import('../js/services/ops-api.js').AssetRef[]}>,
 *   (name: string, args: Record<string, unknown>, how?: {withAttachments?: false, tag?: unknown, answer?: string}): Promise<string>
 * }} ToolInvoke
 */

/**
 * What {@link ContextItem#createToolInvoker} returns.
 * @typedef {object} ToolInvoker
 * @property {ToolInvoke} invoke - Call one offered tool
 * @property {{calls: Array<Record<string, unknown>>, omitted: number, omittedEffects: number}} record - Every call made, for display
 * @property {() => Promise<Map<string, Record<string, unknown>>>} offered - The tools a call is admitted to, by name, with their definitions
 * @property {() => void} end - Refuse whatever is still waiting on the user
 */

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
 * | `static onTurnEnd(ctx)`| Optional  | Per-turn side-effect hook (e.g. retain memory) |
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
 * | `static onTurnEnd()` | engine   | No DOM — fires once per turn at root idle    |
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
      return { summary: markUntranslated('Error formatting result'), details: '', success: false, icon: '✗' };
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
    this.type = context.type || /** @type {typeof ContextItem} */ (this.constructor).MANIFEST?.id || 'unknown';

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
     * The character budget this instance's output is cut to, when its caller
     * sets one rather than the conversation's (truncationBudget).
     * @type {number|undefined}
     * @private
     * @internal
     */
    this._truncationBudget = context.truncationBudget;

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
     * @type {((event: import('../js/services/action-executor.js').ActionProgressEvent) => void)|undefined}
     */
    this.onProgress = context.onProgress;

    /**
     * Callback invoked when item content changes (set by conversation)
     * @type {Function|null}
     */
    this.onContentChange = null;

    /**
     * Item result data
     * @type {Record<string, unknown>}
     */
    this.data = {};

    /**
     * Lazily built by the {@link ContextItem#ops} getter.
     * @type {import("./ops.js").BoundOps|null}
     */
    this._ops = null;

    // Validate the manifest only when the subclass defines one: the abstract
    // bases other items extend (edit-base.js, subagent-item.js) declare none of
    // their own, and it is their concrete subclasses the registry checks.
    if (/** @type {typeof ContextItem} */ (this.constructor).MANIFEST) {
      validateManifest(this.constructor);
    }

    // Dev-mode: wrap context-exclusive methods with guards that throw
    // a clear error when called in the wrong browser instance.
    if (typeof window !== 'undefined' && /** @type {{__jugglerDevMode?: boolean}} */ (/** @type {unknown} */ (window)).__jugglerDevMode) {
      /** @type {Record<string, string>} */
      const contexts = /** @type {typeof ContextItem} */ (this.constructor).METHOD_CONTEXT || {};
      // Indexed by method name, so read as a plain record of members.
      const self = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (this));
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

  /**
   * The workspace this item's operations run in — its conversation's binding,
   * or, for one not yet bound, the tree it is about to work in.
   *
   * `''` is the project, which is what every tool meant before workspaces
   * existed. The id travels to the backend rather than the root it resolves to:
   * the root is the server's to decide, and an id is the only form that cannot
   * be pointed somewhere the user never authorised.
   * @returns {string} The workspace id, or '' for the project.
   */
  getWorkspaceId() {
    return this.conversation?.workingWorkspaceId ?? this.conversation?.workspaceId ?? '';
  }

  /**
   * Where this item's operations land on disk — its conversation's workspace
   * root, and the project when it is bound to nothing.
   *
   * Ops do not need this: they travel by id and the server resolves it, which is
   * the form that cannot be pointed somewhere the user never authorised. It is
   * for the rare caller that must hand a root to something else — query_code's
   * `projectRoot` binding, the one root the model is given rather than confined
   * by.
   *
   * `null` means the binding cannot be honoured: still being created, closed,
   * its root gone, or an id the session has never heard of. Such a caller must
   * refuse on `null` rather than substitute the project, for the reason the
   * whole indirection exists — work that quietly went to the project would look
   * exactly like work that succeeded.
   * @returns {string|null} The root, or null if the binding is unusable.
   */
  getWorkspaceRoot() {
    return this.conversation?.workingWorkspaceRoot ?? this.conversation?.workspaceRoot ?? null;
  }

  /**
   * The host operations, already scoped to where this item works: its
   * conversation's workspace, and the roots its user has granted.
   *
   * Use this rather than importing the operations from `juggler/ops` directly.
   * Both halves of an op's scope belong to the item, not to the call, and a call
   * site that omits them does not fail — it runs in the project and looks like
   * it worked. Inside this repo's own `context-items/` an ESLint rule makes the
   * direct import an error for exactly that reason.
   * @returns {import("./ops.js").BoundOps} Operations scoped to this item.
   */
  get ops() {
    // Built once per item, but the scope inside it is read per call: an item
    // outlives a permission being granted, and can outlive a rebind.
    if (!this._ops) {
      this._ops = createBoundOps(() => ({
        allowedPaths: this.getToolAllowedRoots(),
        workspaceId: this.getWorkspaceId()
      }));
    }
    return this._ops;
  }

  /**
   * An invoker that runs this conversation's tools on this item's behalf, for a
   * tool whose work is itself a program of tool calls (`programSdk`).
   *
   * Each call is admitted against the tools this item's thread was offered, put
   * to the same approval decision the model's own call would get, and run
   * through the ordinary execute path. Nothing is written to the transcript;
   * the invoker's `record` lists the calls (never their results). A call a
   * hook refuses ends the program: `invoke` rejects with a `ToolRefused` error
   * and `onRefused` is told. A call the gate would hold for a person does the
   * same unless `waitForUser` is set: then the call is held, and this item
   * waits on the user with the call's own approval form while `execute` goes
   * on, awaiting the call. Their answer runs it; a denial cancels this item
   * and ends the program. `beforeHold(request, tag)` is awaited before each
   * hold is put to the user, with the `tag` its call was made with
   * (`invoke(name, args, {tag})`), and `afterHold()` is told when it ends. A
   * program that ends, other than by this item's cancel, calls `end()`, which
   * refuses anything still held and puts this item back to running.
   * `invoke(name, args, {answer})` makes a call with the user's answer to it,
   * already given on this item's card, rather than putting it to the decision:
   * for the held call of a program resuming after its engine was lost. Aborting
   * `signal` (by default this item's own) cancels every call. `offered()`
   * resolves to the tools a call is admitted to, by name, with their
   * definitions. `invoke(name, args, {withAttachments: true})` resolves to
   * `{content, attachments}` instead of the text alone: the asset refs of any
   * images the call produced (an image read), which this item may attach to
   * its own result through its summary's `attachments`.
   *
   * Provided by the host engine; throws where no host provides one.
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal] - Cancels every call when aborted
   * @param {(err: Error) => void} [opts.onRefused] - Told once when a refusal ends the program
   * @param {boolean} [opts.waitForUser] - Hold a call that waits on the user, rather than refuse it
   * @param {(request: Record<string, unknown>, tag: unknown) => Promise<void>|void} [opts.beforeHold] - Awaited before each hold is put to the user
   * @param {() => void} [opts.afterHold] - Told when each hold has ended
   * @returns {ToolInvoker} The invoker
   */
  createToolInvoker(opts = {}) {
    const host = /** @type {{__hostToolInvoker?: unknown}} */ (globalThis).__hostToolInvoker;
    if (typeof host !== 'function') {
      throw new Error('This host cannot run tools from a program.');
    }
    // tool-invoker.js installs the binding, with exactly this signature.
    const createInvoker = /** @type {(options: Record<string, unknown>) => ToolInvoker} */ (host);
    return createInvoker({
      parentToolUseId: this.toolUseId || this.id,
      signal: opts.signal ?? this.signal,
      onRefused: opts.onRefused,
      waitForUser: opts.waitForUser,
      beforeHold: opts.beforeHold,
      afterHold: opts.afterHold,
      conversation: this.conversation,
      messageThread: this.messageThread
    });
  }

  /**
   * Called when this item's conversation moves to another workspace.
   *
   * Almost nothing needs it, which is why the default does nothing: an item that
   * reads through {@link ContextItem#ops} or resolves its paths at use time
   * follows the binding on its own. It is for the item that has materialised
   * something root-derived into its own `data` — a frozen snapshot of a file, a
   * cached listing — which would otherwise go on describing a tree the
   * conversation has left.
   *
   * Best-effort: a move must not fail because one item could not catch up.
   * @returns {Promise<void>} When it has caught up.
   */
  async onWorkspaceChanged() {}

  // ============================================================================
  // TITLES AND SUMMARIES
  // ============================================================================

  /**
   * Get display title for this item
   * @returns {string} Display title
   */
  getTitle() {
    return /** @type {typeof ContextItem} */ (this.constructor).MANIFEST?.name || this.type;
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
      /** @type {typeof ContextItem} */ (this.constructor).getToolDefinitions().map((/** @type {{input_schema?: object}} */ d) => d.input_schema)
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
   * call to a child agent run (whose last message becomes this tool's result);
   * returning `null` runs the ordinary client-side `execute()`.
   *
   * The spec may pin the child's `strategyId` and `modelConfig`; omitting them
   * inherits from the calling thread. Naming a hidden strategy this item owns
   * (see {@link ContextItem.getStrategies}) is what turns a delegating tool into
   * a subagent — a named context boundary with its own tool filter.
   *
   * An item that never returns null here has no inline path, so it should also
   * set `requiresDelegation: true` in its MANIFEST — that is what stops the tool
   * being offered on turns that cannot delegate, where `execute()` could only
   * report the failure.
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
        return this.failureSummary(markUntranslated('Action denied by user'));
      }
      if (outcome.cancelled) {
        return this.failureSummary(markUntranslated('Action cancelled'));
      }
      return this.failureSummary(markUntranslated(`Action failed: ${outcome.error}`));
    }
    return this.successSummary(markUntranslated('Action completed'));
  }

  /**
   * Build a failed ItemSummary in the standard shape (no details, ✗ icon).
   * Pass `extra` to add or override fields — e.g. `{ details }` for a command
   * echo, or `{ feedbackForLLM }` to steer the model's next move.
   * @param {string} message - Result message for the LLM and simple UI display
   * @param {Partial<ItemSummary>} [extra] - Fields merged over the defaults
   * @returns {ItemSummary} Failed summary
   */
  failureSummary(message, extra) {
    return { summary: message, details: '', success: false, icon: '✗', ...extra };
  }

  /**
   * Build a successful ItemSummary in the standard shape (no details, ✓ icon).
   * Pass `extra` to add or override fields — e.g. `{ icon: '○' }` for an empty
   * result, or `{ attachments }` for a tool that produced an image.
   * @param {string} summary - Result message for the LLM and simple UI display
   * @param {Partial<ItemSummary>} [extra] - Fields merged over the defaults
   * @returns {ItemSummary} Successful summary
   */
  successSummary(summary, extra) {
    return { summary, details: '', success: true, icon: '✓', ...extra };
  }

  /**
   * The character budget for this item's LLM-facing output. The conversation
   * owns the live value (`Conversation#truncationBudget`); an item constructed
   * against a stub conversation falls back to {@link DEFAULT_TRUNCATION_BUDGET}.
   * An item whose output goes to a program rather than the model is given the
   * program's budget at construction (ItemContext.truncationBudget), and that
   * wins. Use it directly only when passing a budget to an op (e.g. file
   * extraction); for output you already have in hand, call
   * {@link ContextItem#truncateForLLM}.
   * @returns {number} Maximum characters of output to hand the LLM
   */
  truncationBudget() {
    const own = Number(this._truncationBudget);
    if (Number.isFinite(own) && own > 0) return own;
    const budget = Number(this.conversation?.truncationBudget);
    return Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_TRUNCATION_BUDGET;
  }

  /**
   * Truncate tool output to this item's budget, appending the standard
   * "(Output truncated from X to Y chars)" note when truncation bit. Returns
   * the content unchanged when it already fits.
   * @param {string} content - Full output
   * @param {{keywords?: string[], note?: boolean}} [options] - `keywords`: keep windows around lines matching these; `note`: false to omit the truncation note (for output embedded in a larger message)
   * @returns {string} Output within budget
   */
  truncateForLLM(content, options = {}) {
    const text = content || '';
    const { content: truncated, truncated: wasTruncated } = smartTruncate(text, {
      maxChars: this.truncationBudget(),
      keywords: options.keywords
    });
    if (!wasTruncated) return text;
    if (options.note === false) return truncated;
    return markUntranslated(`${truncated}\n\n(Output truncated from ${text.length} to ${truncated.length} chars)`);
  }

  /**
   * Get result details for successful tool call
   * @returns {Record<string, unknown>} Tool result details
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
    return /** @type {typeof ContextItem} */ (this.constructor).MANIFEST?.requiresApproval ?? false;
  }

  /**
   * The interaction kind for this item's parked-approval state — `'gate'`
   * (delegable decision) or `'elicitation'` (non-delegable user input). See
   * {@link INTERACTION_KIND}. Instance convenience over the static accessor.
   * @returns {string} One of {@link INTERACTION_KIND}
   */
  interactionKind() {
    return /** @type {typeof ContextItem} */ (this.constructor).interactionKind();
  }

  /**
   * Check if this item cannot be deleted by the user
   * @returns {boolean} True if user deletion is prevented
   */
  preventUserDeletion() {
    return /** @type {typeof ContextItem} */ (this.constructor).MANIFEST?.preventUserDeletion ?? false;
  }

  /**
   * Get the permission key for this item
   * @param {Record<string, unknown>} _toolInput - Tool input parameters
   * @returns {string} Permission key
   */
  getPermissionKey(_toolInput) {
    return /** @type {typeof ContextItem} */ (this.constructor).MANIFEST?.id || this.type;
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
   * May this call be *silently* auto-approved by an unattended approval path —
   * the conversation-wide auto-approve toggle or a strategy's out-of-band
   * reviewer? Returns true by default. Override to return false for a call that
   * must always reach a human decision even in auto-approve mode, because the
   * mistake is irreversible or the step is a deliberate checkpoint (a plan
   * submit; a recursive delete of the project root or home). This is a HARD
   * gate on the silent paths only — the call is still approvable explicitly by
   * the human, by a saved permission rule, or under YOLO, all of which are
   * deliberate grants. It is orthogonal to {@link isPermitted}: a call can be
   * both not-permitted and non-auto-approvable (the common case here).
   * @param {Record<string, unknown>} _toolInput - Tool input parameters
   * @returns {boolean} False to force a human decision on the silent paths
   */
  autoApprovable(_toolInput) {
    return true;
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

  // OPTIONAL HOOK — reviseApprovalSuggestion({ index, original, editedText, params })
  //
  // Implement this to make a single-pattern "don't ask again" suggestion
  // editable in the approval dialog. When present, the framework renders a
  // pencil affordance on each single-pattern button, turns the pattern into a
  // text input, and calls this hook (debounced) on every edit; it gates the
  // button on the returned `valid` flag, styles `notice` by `valid`, and
  // persists the returned `rules`/`allowedPaths` verbatim on approval. Return a
  // RevisedApprovalSuggestion (or a Promise of one; `null` is treated as
  // invalid). `original` is the untouched suggestion at that index — inspect its
  // `rules` vs `allowedPaths` to tell a command-glob edit from a folder-grant
  // edit. `params` is the validated tool input the suggestions derive from.
  //
  // It is deliberately NOT defined on the base: an action WITHOUT this method
  // keeps today's fixed buttons (the framework only wires the edit UI when the
  // method exists). See ExecuteContextItem for a reference implementation.

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
    return this.MANIFEST?.name || markForTranslation('Item');
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
   * The interaction kind for this tool type — see {@link INTERACTION_KIND}.
   * Reads `MANIFEST.interaction`, defaulting to `'gate'` (a delegable
   * approval). Override via the manifest (`interaction: 'elicitation'`) for
   * tools whose approval surface is a user-input form rather than a go/no-go
   * gate; those are never resolved by approval automation.
   * @returns {string} One of {@link INTERACTION_KIND}
   */
  static interactionKind() {
    return this.MANIFEST?.interaction ?? INTERACTION_KIND.GATE;
  }

  /**
   * Fold an elicitation's resolution payload back into the tool input before
   * execution. For a `'gate'` tool the approval response is a bare verdict and
   * carries no data, so the default is identity. An `'elicitation'` tool
   * (e.g. AskUserQuestion) overrides this to parse its captured answer out of
   * the response string and merge it into the params `execute()` receives.
   *
   * Pure and static: it is a type-level transform, not per-invocation behaviour
   * needing item context — mirroring {@link rerunRequiresReprompt}.
   * @param {Record<string, unknown>} toolInput - The original tool input
   * @param {string} _response - The `resolveApproval` response string
   * @returns {Record<string, unknown>} The tool input to execute with
   */
  static applyApprovalResponse(toolInput, _response) {
    return toolInput;
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
   * What this item type offers to put on the Pinboard, or null (the default) for
   * one that offers nothing.
   *
   * The properties panel adds a "Pin to Pinboard" control for whatever this
   * returns, on both the item's own panel and the tool-action row that wrote it.
   * Return a source descriptor rather than a pin type: the registry decides which
   * enabled type claims it, so an item never names a pin class and the control
   * disappears by itself when nothing can take it.
   *
   * Worth overriding where the item's panel shows a snapshot of something that
   * goes on changing — a plan, a checklist — and the pin is the only place the
   * live one stands still.
   * @returns {import('./pinboard-item-type.js').PinSource|null} What to pin, or null.
   */
  static getPinSource() {
    return null;
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
   * An action type whose status follows the usual pending / success / failure
   * ladder should build its result with {@link ContextItem#buildStatusUI}
   * rather than open-coding the branches.
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
    el.textContent = this.type || t('Unknown item');
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
   * Return `{ controls: [element, …] }` to add buttons of your own to the
   * panel's controls block, ahead of the framework's Re-run and Delete — for
   * an action on what the call produced rather than on the call itself.
   *
   * IMPORTANT: this is the polymorphism boundary that keeps tool-name
   * branching out of generic UI code. If you find yourself adding
   * `if (toolName === 'foo')` to a component, override this method instead.
   *
   * [Context: viewer]
   * @param {HTMLElement} wrapper - Section wrapper to append details into
   * @param {ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean, controls?: HTMLElement[] }|void} Render result; set skipResultSection to true when output is rendered inline, and controls to add buttons to the controls block
   */
  renderToolActionDetails(wrapper, ctx) {
    const inputText = JSON.stringify(ctx.input ?? {}, null, 2);
    if (inputText !== '{}') {
      ctx.helpers.addSubsection(wrapper, t('Input'), inputText, 'properties-panel-code', { language: 'json' });
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
    return t('Result');
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
   * Whether this tool's output is the contents of files — what a reader would
   * call "my source code" rather than a report about it. A conversation export
   * leaves such output out unless the user asks for file contents, separately
   * from tool details in general. Default false; a tool that reads files back
   * verbatim overrides it.
   * @param {string} _toolName - The (lowercased) tool name being exported
   * @returns {boolean} True when the output is file contents
   */
  static resultIsFileContent(_toolName) {
    return false;
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
   * What of an executed action's result to keep in the conversation, under the
   * tool-action's `result.fullResult.result`. The result content the model was
   * handed is stored beside it, and every client that opens the conversation
   * loads both, so a tool whose raw result repeats text that content already
   * carries can leave that text out here. What is returned must still hold every
   * field this tool's own renderers and guards read back from the stored item.
   *
   * Called once, when the action completes; the result the model and the
   * afterTool hooks see is unaffected. Default: the result unchanged.
   * @param {unknown} result - The raw result `execute` returned.
   * @param {{toolName: string, content: string}} _context - The name of the
   *   tool invoked, and the result content stored beside it.
   * @returns {unknown} The result to store.
   */
  static storedResult(result, _context) {
    return result;
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
      return { summary: cancelledMessage || t('Cancelled'), status: /** @type {ResultStatus} */ ('cancelled') };
    }
    const error = actionStatus.error || t('unknown error');
    const summary = failurePrefix ? t('{prefix}: {error}', { prefix: failurePrefix, error }) : error;
    return { summary, status: /** @type {ResultStatus} */ ('error') };
  }

  /**
   * Build a getStatusUI() result from the standard pending / success / terminal
   * ladder: 'running' while the action is pending, 'success' when it succeeded,
   * and {@link ContextItem#resolveTerminalStatus} (cancelled or error) otherwise.
   * Returns null when there is no action status, as getStatusUI must.
   *
   * Branches are strings, elements, or thunks returning one — a thunk runs only
   * if its branch applies, so the success branch can read `actionStatus.result`
   * freely. Return a ResultStatusMessage from a branch to override its status
   * (e.g. a call that "succeeded" but reports a tool-side error).
   * @param {import('../js/services/action-executor.js').ActionStatus|null|undefined} actionStatus - Action status
   * @param {StatusUIConfig} config - Type label and per-branch content
   * @returns {ResultStatusMessage|null} Status config, or null when there is no status
   */
  buildStatusUI(actionStatus, config) {
    if (!actionStatus) return null;

    let branch;
    if (actionStatus.pending) {
      branch = ContextItem._resolveStatusBranch(config.pending, 'running');
    } else if (actionStatus.success) {
      branch = ContextItem._resolveStatusBranch(config.success, 'success');
    } else {
      branch = this.resolveTerminalStatus(actionStatus, config.failurePrefix, config.cancelledMessage);
    }

    return { typeName: config.typeName, ...branch };
  }

  /**
   * Normalize one {@link StatusBranch} into a ResultStatusMessage fragment.
   * @param {StatusBranch|(() => StatusBranch)|undefined} branch - Branch value or thunk
   * @param {ResultStatus} defaultStatus - Status to apply when the branch doesn't name one
   * @returns {ResultStatusMessage} Summary + status fragment
   * @private
   * @internal
   */
  static _resolveStatusBranch(branch, defaultStatus) {
    const value = typeof branch === 'function' ? branch() : branch;
    const isMessage = !!value
      && typeof value === 'object'
      && !(typeof Node !== 'undefined' && value instanceof Node);
    if (isMessage) {
      const message = /** @type {ResultStatusMessage} */ (value);
      return { ...message, status: message.status || defaultStatus };
    }
    return { summary: /** @type {string|HTMLElement} */ (value ?? ''), status: defaultStatus };
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
   * Whether this type's tool rows may be folded into a collapsed group when the
   * transcript collapses a run of adjacent tool uses into one tile.
   *
   * Grouping is otherwise inferred from the item's type, so an ordinary tool
   * needs to declare nothing: its row records that the tool ran, and a run of
   * such records is exactly what is worth folding away. Override this to false
   * for a type whose row must stay on screen in its own right — the two cases
   * are an item whose row IS its only visible surface (a type that opts out of
   * a standing card with `isVisible()`, and so renders its whole state on the
   * row, where folding would hide the item itself rather than a record of it),
   * and a row the user is meant to keep in sight (a question they answered, an
   * artifact created outside the transcript).
   *
   * A type that opts out is left unfolded and, being a visible row, breaks the
   * run around it — so a group tile never spans it.
   * @returns {boolean} True if rows of this type may be folded into a group
   */
  static isGroupable() {
    return true;
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
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('./strategy-type.js').JSONObjectSchema}>} Array of tool definitions
   */
  static getToolDefinitions() {
    return [];
  }

  /**
   * Make {@link getToolDefinitions} ready to answer, if it needs fetching first.
   *
   * Awaited before every tool list is built, so an item whose tools are
   * discovered rather than declared — the MCP bridge, whose tools live on
   * servers that take time to connect — can hold the list until it knows what it
   * has. Without it such an item can only publish whatever a background refresh
   * happened to have finished, and a turn taken during discovery silently offers
   * the model fewer tools than the app is showing the user.
   *
   * Override only when there is something to wait for; resolve as fast as
   * possible, and never reject — a slow or broken item must cost its own tools,
   * not the whole tool list. Called once per tool-list build, so anything past
   * the first load should return immediately.
   * [Context: shared]
   * @static
   * @returns {Promise<void>|void} Resolves when the tool definitions are ready
   */
  static prepareToolDefinitions() {}

  /**
   * Strategy classes this item owns — registered on load and forced hidden.
   *
   * This is how a delegating item becomes a **subagent**: return a strategy
   * class here, name its id from {@link buildSubthreadSpec}, and the delegated
   * child runs under a tool filter, approval policy and guidance the item
   * itself defines — without that strategy ever appearing in the strategy
   * selector, the Shift+Tab ring, the default picker or the command editor.
   * The id is an implementation detail the user never sees; the tool's own name
   * and description are the whole user-facing surface.
   *
   * Put the class in a module next to the item (NOT under the extension's
   * `strategies/` directory, whose glob would register it as an ordinary
   * visible strategy) and import it here.
   *
   * A subagent thread has no human steering it, so its strategy must be able to
   * auto-approve everything it exposes: any tool it offers but cannot approve
   * is a hang, not a prompt. Expose only what `getApprovalPolicy` returns
   * `APPROVE` for, and use `onToolPending` to deny anything that parks.
   * [Context: shared]
   * @static
   * @returns {Array<typeof import('./strategy-type.js').default>} Strategy classes to register hidden
   */
  static getStrategies() {
    return [];
  }

  /**
   * Check if new params can be merged with or should replace an existing item.
   * May be async, for a decision that depends on more than the items' data.
   * [Context: shared]
   * @static
   * @param {Record<string, unknown>} newParams - Parameters for the new request
   * @param {ContextItem[]} existingItems - All existing items of this type
   * @param {{projectPath?: string}} [context] - Optional context with project info
   * @returns {MergeOrReplaceResult|null|Promise<MergeOrReplaceResult|null>} Merge result or null if no merge possible
   */
  static mergeOrReplace(newParams, existingItems, context) {
    void newParams, existingItems, context;
    return null;
  }

  /**
   * Turn-end lifecycle hook — fires once, in the engine, each time the root
   * conversation goes idle (one call per completed turn).
   *
   * This is a **static** hook, and that is deliberate. Context items are
   * per-tool-call — there is no canonical per-conversation instance to call an
   * instance method on — and the hook must fire even on turns where this type
   * produced no items at all (the motivating case is a memory extension that
   * retains a summary of every turn, whether or not its own tool was used). So
   * the framework invokes it once per registered TYPE per turn, regardless of
   * item activity. A type opts in purely by defining this method; types that
   * don't are skipped, so the per-turn fan-out costs nothing unless you opt in.
   *
   * Keep conversation-scoped state (e.g. a stable id for an external memory
   * document) in session/conversation metadata keyed off `ctx.conversation.id`
   * — that survives viewer reload and worker re-exec, unlike instance state.
   *
   * Contract:
   *   - **Side-effects only.** Do external work here (call an op, POST to a
   *     server). Do NOT write conversation/doc items — the worker is the single
   *     doc writer at this boundary. To feed content back INTO the next turn,
   *     use {@link getContextText} (it runs every render); onTurnEnd is the
   *     write-out half, getContextText the read-in half.
   *   - **Fire-and-forget.** Nothing awaits the result. It can still be running
   *     when the next turn starts; that next run aborts `ctx.signal`, so forward
   *     the signal to your async work to bail out of a superseded run.
   *   - **Isolated.** A throw or rejection is logged and swallowed — it can
   *     neither wedge the turn nor stop other types' hooks.
   *
   * [Context: engine — no DOM]
   * @static
   * @param {import('./context-item-types.js').TurnEndContext} ctx - Turn-end context
   * @returns {void|Promise<void>} Nothing (the result is discarded)
   */
  static onTurnEnd(ctx) {
    void ctx;
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
      name: manifest?.name || markForTranslation('Unknown Item'),
      version: manifest?.version || '0.0.0',
      description: manifest?.description || '',
      requiresApproval: manifest?.requiresApproval ?? false,
      author: manifest?.author || '',
      permissions: manifest?.permissions || [],
      exampleData: manifest?.exampleData || {},
      refreshable: manifest?.refreshable || false,
      contextPosition: manifest?.contextPosition || 'prefix',
      watchesFileChanges: manifest?.watchesFileChanges || false,
      autoInstantiate: manifest?.autoInstantiate || false
    };
  }

  // ============================================================================
  // TOOL CALL LIFECYCLE
  // ============================================================================

  /**
   * Whether this class is an **action**: an item that does its tool work in
   * `execute()`, rather than one that seeds a standing context block through
   * `onToolCall()`. The tool dispatcher routes on this.
   *
   * The check walks the prototype chain instead of looking for an own `execute`
   * on the class itself, so an item that inherits its implementation from an
   * intermediate base — a family of related tools sharing one — is an action
   * just as much as one that spells `execute()` out. Only the abstract
   * `execute()` on this class doesn't count, and it is recognised by being the
   * one whose prototype inherits straight from `Object`.
   * @returns {boolean} True when this class, or a base above it but below this one, implements execute()
   */
  static isActionItem() {
    for (let proto = this.prototype; proto; proto = Object.getPrototypeOf(proto)) {
      if (Object.getPrototypeOf(proto) === Object.prototype) return false;
      if (Object.prototype.hasOwnProperty.call(proto, 'execute')) return true;
    }
    return false;
  }

  /**
   * Execute a tool call and store results in this.data.
   *
   * Action-style items do their tool work in `execute()`, which the tool
   * dispatcher routes to directly (see {@link ContextItem.isActionItem}) — they
   * never need `onToolCall()`. Seeding, however, always runs through
   * `handleToolCall()` -> `onToolCall()` before rendering the standing block, so
   * a base throw here would abort seeding for an `execute()`-only item before it
   * is registered, silently dropping its context from the system prompt. So this
   * is a no-op for items that define `execute()`. An item that defines neither
   * `execute()` nor its own `onToolCall()` is genuinely incomplete, so it still
   * throws.
   * @param {string} _toolName - Name of the tool being called
   * @param {Record<string, unknown>} _params - Tool parameters from LLM
   * @returns {Promise<void>}
   */
  async onToolCall(_toolName, _params) {
    if (/** @type {typeof ContextItem} */ (this.constructor).isActionItem()) {
      return;
    }
    throw new Error('onToolCall() must be implemented by subclass');
  }

  /**
   * Handle a tool call for this plugin (framework entry point for refreshable items)
   * @param {string} toolName - Name of the tool being called
   * @param {Record<string, unknown>} params - Tool parameters from LLM
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
