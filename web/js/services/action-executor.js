//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { extractErrorInfo, extractErrorMessage } from '../../sdk/lib/error-utils.js';
import ContextItem from 'juggler/context-item';
import { OpsError } from './ops-api.js';
import wsService from './websocket.js';

/**
 * Class names already warned about an empty success summary, so the advisory
 * fires at most once per context-item type per session rather than per tool call.
 * @type {Set<string>}
 */
const _emptySummaryWarned = new Set();

/**
 * Warn (once per class) when a SUCCESSFUL tool produced an empty getSummary line.
 *
 * This is the observable symptom of the most common context-item authoring
 * mistake: execute() must return RAW result data, which the framework wraps into
 * the outcome `{ success, result, prepared, error }`. getSummary(outcome) must
 * therefore read its data from `outcome.result` — reading `outcome.foo` directly
 * yields `undefined`, so the `summary` (which is BOTH the UI line and the
 * tool_result text the model sees) comes back empty. We detect the empty summary
 * rather than guessing at execute()'s shape, so legitimate results that carry
 * their own `success` field (e.g. shell output) never false-positive.
 * @param {import('juggler/context-item').ItemSummary} rawSummary - getSummary()'s return, pre-validation
 * @param {string} className - the context item class name (for the once-key)
 */
function warnOnEmptySuccessSummary(rawSummary, className) {
  const s = rawSummary && /** @type {any} */ (rawSummary).summary;
  const empty = s === undefined || s === null || s === '' || s === 'undefined';
  if (!empty || _emptySummaryWarned.has(className)) return;
  _emptySummaryWarned.add(className);
  console.warn(
    `[ContextItem] ${className}.getSummary() returned an empty summary for a ` +
    `successful result, so the model receives an empty tool_result. Did you read ` +
    `your data from outcome.result (not outcome directly)? Remember execute() returns ` +
    `RAW data and the framework wraps it as { success, result, prepared, error }. ` +
    `See docs/extension_guide.md (the execute → outcome → getSummary contract).`);
}

/**
 * Base properties shared by all ActionStatus variants
 * @typedef {object} ActionStatusBase
 * @property {string} actionId - Action type ID
 * @property {string} [toolUseId] - Tool use ID from LLM (for protocol compliance)
 * @property {object} [displayData] - UI display context (from prepared.displayData)
 * @property {boolean} [pending] - True if action is pending/running (checked before success is known)
 * @property {boolean} [cancelled] - True if action was cancelled (checked before success is known)
 * @property {object} [result] - Result data (may exist on failure for partial results)
 * @property {number} [durationMs] - How long the action took in milliseconds
 * @property {import('./hook-runtime.js').HookRecord[]} [hookRecords] - What the afterTool hooks did (set by execute())
 */

/**
 * Successful action status
 * @typedef {ActionStatusBase & {success: true, result: object, formatted: FormattedActionResult, error?: undefined}} ActionStatusSuccess
 */

/**
 * Failed action status - error is REQUIRED (not optional)
 * @typedef {ActionStatusBase & {success: false, error: string, errorStack?: string, formatted?: FormattedActionResult, denied?: boolean, blocked?: boolean}} ActionStatusFailure
 */

/**
 * ActionStatus - discriminated union enforces error field when success=false
 * @typedef {ActionStatusSuccess | ActionStatusFailure} ActionStatus
 */

/**
 * @typedef {object} FormattedActionResult
 * @property {string} summary - Short summary for conversation
 * @property {string} [details] - Detailed information
 * @property {string} [icon] - Icon/emoji for display
 * @property {boolean} success - Whether action succeeded
 * @property {string} [feedbackForLLM] - Optional feedback message for LLM
 * @property {import('./ops-api.js').AssetRef[]} [attachments] - Image/binary asset refs produced by the tool (e.g. an image read), stored at the tool-action item level and emitted as image parts in the tool_result
 */

/**
 * Progress event emitted during action execution
 * @typedef {object} ActionProgressEvent
 * @property {'stdout'|'stderr'|'status'|'percent'} type - Type of progress event
 * @property {string} [content] - Content for stdout/stderr types
 * @property {string} [message] - Message for status type
 * @property {number} [percent] - Progress percentage (0-100) for percent type
 */

/**
 * @typedef {object} ExecutionContext
 * @property {import('../model/session.js').default} session - Current session
 * @property {import('../model/conversation.js').default} conversation - Current conversation
 * @property {import('../model/message-thread.js').MessageThread} messageThread - Message thread for scoped operations
 * @property {string} [toolUseId] - Tool use ID for progress event correlation
 * @property {string} [toolName] - Resolved tool name being executed; forwarded to the item so multi-tool classes can route (see ItemContext.toolName)
 * @property {number} [runningEpoch] - Execution generation (claimRunning's runningEpoch); scopes a later cancel-tool to this incarnation
 * @property {number} [runningStartedAt] - Claim stamp (claimRunning's runningStartedAt); feeds the worker's tool-execution-report happens-after guard
 * @property {AbortSignal} [signal] - Abort signal for cancellation
 * @property {(event: ActionProgressEvent) => void} [onProgress] - Progress callback
 * @property {boolean} [_approvalHandled] - INTERNAL: Set only by ResponseHandler/Conversation after approval was shown to user
 */

/**
 * @typedef {object} ActionManifest
 * @property {string} id - Action ID
 * @property {string} name - Action name
 * @property {string} version - Action version
 * @property {string} description - Action description
 * @property {boolean} requiresApproval - Whether action requires approval
 */

/**
 * Running action tracking info
 * @typedef {object} RunningAction
 * @property {AbortController} controller - Abort controller for cancellation
 * @property {import('juggler/context-item').default} action - Action instance (source of truth for accumulated output)
 * @property {string} actionId - Action type ID
 * @property {string} [toolUseId] - Tool use ID for progress event correlation
 * @property {string} [conversationId] - Conversation ID owning this action
 * @property {number} [runningEpoch] - Execution generation this action was claimed under (for generation-scoped cancellation)
 * @property {number} [runningStartedAt] - The tool-action's claim stamp (for the tool-execution-report happens-after guard)
 * @property {number} startTime - Start timestamp
 * @property {number} [overdueReportedAt] - When this execution was last flagged as overdue (see overdueRunningActions); absent until the first flag
 */

/**
 * How long one execution may run before the watchdog starts reporting it.
 *
 * Sized above every deadline a tool can legitimately be given — the bash tool's
 * 20-minute ceiling is the longest — so ordinary long work does not trip it. It
 * is not a hard limit and nothing is aborted when it elapses; see
 * {@link ActionExecutor#overdueRunningActions}.
 */
const OVERDUE_EXECUTION_MS = 21 * 60 * 1000;

/**
 * How often an execution that stays overdue is re-reported, so a wedge that
 * lasts hours leaves a trail in the log rather than one line at the start.
 */
const OVERDUE_REPEAT_MS = 10 * 60 * 1000;

/**
 * Action Executor Service
 *
 * Orchestrates action execution including approval, validation, and backend calls.
 * Uses plugin's prepare() to get PreparedAction - framework is agnostic
 * to what the parameters contain (diffs, previews, etc.).
 *
 * Supports cancellation via AbortController - actions receive context.signal and
 * should check signal.aborted or listen for 'abort' events during long operations.
 * @class
 */

// Cross-window bridge for test instrumentation. action-progress events fire
// on the engine document; viewers mirror them on their own document so
// test-page capture listeners observe them. Engine sends a single WS
// `engine-bridge` envelope; the server forwards it to every viewer, whose
// `websocket.js` handler replays it onto a same-window BroadcastChannel of
// this name. One transport, one delivery per peer — no duplicate events.
const __ACTION_PROGRESS_CHANNEL = 'juggler-action-progress';

/**
 * The text the model is sent for a finished action, before any hook's note: the
 * tool's summary, then its feedback for the model. One definition, because the
 * afterTool hooks are shown this text and the result write stores it, and a
 * hook must see exactly what the model will.
 * @param {FormattedActionResult|undefined} formatted - The action's formatted result
 * @returns {string} The result content
 */
export function toolResultContent(formatted) {
  let content = typeof formatted?.summary === 'string'
    ? formatted.summary
    : extractErrorMessage(formatted?.summary) || 'Action completed.';
  if (formatted?.feedbackForLLM) {
    const feedback = typeof formatted.feedbackForLLM === 'string'
      ? formatted.feedbackForLLM
      : extractErrorMessage(formatted.feedbackForLLM);
    content += '\n\n' + feedback;
  }
  return content;
}

class ActionExecutor {
  constructor() {
    /**
     * Map of execution ID to running action info
     * @type {Map<string, RunningAction>}
     * @private
     */
    this._runningActions = new Map();

    /**
     * Counter for generating unique execution IDs
     * @type {number}
     * @private
     */
    this._executionIdCounter = 0;
  }

  /**
   * Execute an action - completely agnostic to plugin internals
   *
   * Flow: prepare → validate → approve → perform → format
   * Framework knows nothing about plugin internals (diffs, recovery, etc.)
   *
   * Actions receive context.signal (AbortSignal) for cancellation support.
   * Long-running actions should check signal.aborted periodically.
   * @param {string} actionId
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM tool call
   * @param {ExecutionContext} context
   * @returns {Promise<ActionStatus>} Result of action execution including success/failure status
   */
  async execute(actionId, toolInput, context) {
    const contextItemRegistry = (await import('../registries/context-item-registry.js')).default;

    /** @type {typeof import('juggler/context-item').default | undefined} */
    const ActionClass = /** @type {any} */ (contextItemRegistry.get(actionId));

    if (!ActionClass) {
      return {
        actionId,
        success: false,
        error: `Unknown action: ${actionId}`
      };
    }

    const { controller, action, executionId } = this._createTrackedAction(actionId, ActionClass, context);

    const startTime = Date.now();

    // _runningActions was populated above (before prepare) so that an in-flight
    // prepare() can be cancelled. Every exit path from here on — success,
    // validation-failure early return, prepare() throw, approval throw,
    // execute() throw — MUST delete the entry. Wrap the whole post-register
    // block in try/finally; the inner try/catch around execute() handles
    // result-shaping and is preserved as-is.
    try {
    // Step 1: Prepare (includes validation - plugin returns valid: true/false)
    // Context is now available on the action instance (this.session, this.conversation, etc.)
    /** @type {import('juggler/context-item').PreparedItem} */
      const prepared = await action.prepare(toolInput);

      // Check validation result
      if (!prepared.valid) {
        return this._buildValidationFailure(actionId, action, prepared, startTime);
      }

      // Step 2: Check approval requirement
      // Approval MUST be handled by the caller (ResponseHandler or session.js).
      // If we get here without _approvalHandled and approval is needed, throw an error.
      // This ensures ALL tool execution goes through the proper approval flow.
      if (!context._approvalHandled && action.requiresApproval() && !action.isPermitted(toolInput)) {
        throw new Error(`Action "${actionId}" requires approval. Run it as a tool-action (toolExecutor.executeToolCall) so it goes through the approval flow.`);
      }

      // Step 3: Execute - plugin handles its own recovery internally if desired
      // Signal and onProgress are already on the action instance from construction
      const actionResult = await this._performAction(actionId, action, prepared, controller);

      // Stamp duration on every result
      actionResult.durationMs = Date.now() - startTime;

      // Step 4: afterTool hooks. Here, inside the try and before the finally,
      // because this is the one place they can wait without breaking INV-C: the
      // execution is still in the executing set, so the call reads as running
      // while they think, and the await-free region between the delete below and
      // the caller's result write is left exactly as it was. Not for a cancelled
      // call (the worker owns its terminal state) nor outside a thread.
      if (!actionResult.cancelled && !controller.signal.aborted && context.messageThread && context.toolUseId) {
        actionResult.hookRecords = await this._runAfterToolHooks(actionId, toolInput, context, actionResult, controller.signal);
      }
      return actionResult;
    } finally {
      // Always clean up tracking — covers prepare()/approval throws and the
      // validation-failed early return in addition to the inner execute path.
      //
      // CONTIGUITY INVARIANT (tool-execution-report causality, INV-C): this
      // delete and the terminal doc write in ResponseHandler._runActionAndComplete
      // (completeToolAction) run in one await-free microtask region — the caller
      // does `const result = await execute(...)` then writes the result with no
      // await between. The tool-execution reporter emits ONLY from its timer
      // macrotask, which can never interleave into that region, so a report that
      // shows a tool absent from the executing set was necessarily sent AFTER the
      // tool's terminal doc write. Do NOT introduce an await between this delete
      // and that write, or the worker could finalize an already-completed tool.
      this._runningActions.delete(executionId);
    }
  }

  /**
   * Run the afterTool hooks on a finished execution and return their records.
   * A hook that marks the call failed turns the result into a failure here, so
   * every reader downstream — the stored state, `isError` on the wire — agrees.
   * Never throws: hooks fail open.
   * @param {string} actionId
   * @param {Record<string, unknown>} toolInput
   * @param {ExecutionContext} context
   * @param {ActionStatus} actionResult - Mutated when a hook marks the call failed
   * @param {AbortSignal} signal - The execution's signal (cancelling the call cancels its hooks)
   * @returns {Promise<import('./hook-runtime.js').HookRecord[]>} The hooks' records (empty when none matched)
   * @private
   */
  async _runAfterToolHooks(actionId, toolInput, context, actionResult, signal) {
    try {
      const { runAfterToolHooks } = await import('./hook-runtime.js');
      const thread = /** @type {any} */ (context.messageThread);
      const { records, markError } = await runAfterToolHooks({
        messageThread: thread,
        conversationId: /** @type {any} */ (context.conversation)?.id ?? '',
        threadId: thread?.threadItemId || /** @type {any} */ (context.conversation)?.id || '',
        toolUseId: /** @type {string} */ (context.toolUseId),
        toolName: context.toolName || actionId,
        toolInput,
        result: { content: toolResultContent(actionResult.formatted), isError: !actionResult.success },
        signal,
      });
      if (markError && actionResult.success) {
        const marker = records.find(r => r.markError);
        const failed = /** @type {any} */ (actionResult);
        failed.success = false;
        failed.error = `Marked as failed by hook "${marker?.name}"`;
      }
      return records;
    } catch (err) {
      console.error('[ActionExecutor] afterTool hooks failed:', err);
      return [];
    }
  }

  /**
   * Create the action instance with full execution context and register it in
   * _runningActions so it can be cancelled and correlated with progress events.
   * @param {string} actionId
   * @param {typeof import('juggler/context-item').default} ActionClass
   * @param {ExecutionContext} context
   * @returns {{controller: AbortController, action: import('juggler/context-item').default, executionId: string}} The tracked action handle.
   * @private
   */
  _createTrackedAction(actionId, ActionClass, context) {
    // Create abort controller for this execution (BEFORE action creation so signal is available)
    const controller = new AbortController();
    const executionId = `exec-${++this._executionIdCounter}`;

    // Create action instance with full context (single object for easy subclass pass-through)
    const action = new ActionClass(/** @type {any} */ ({
      id: actionId,
      session: context.session,
      conversation: context.conversation,
      messageThread: context.messageThread,
      toolUseId: context.toolUseId,  // For filtering self from items during validation
      toolName: context.toolName,    // Lets a multi-tool class route to the invoked tool
      signal: controller.signal,
      onProgress: (/** @type {ActionProgressEvent} */ event) => this._emitProgress(executionId, event)
    }));

    // Track this running action for cancellation and progress correlation.
    // conversationId is carried into _emitProgress so multi-tab (and the
    // multi-iframe test pool) listeners can filter out events belonging to
    // OTHER conversations — without it, every BroadcastChannel subscriber
    // in the same browsing context sees every conversation's tool-progress.
    this._runningActions.set(executionId, {
      controller,
      action,
      actionId,
      toolUseId: context.toolUseId,
      conversationId: /** @type {any} */ (context.conversation)?.id,
      // The execution generation claimRunning stamped on the tool-action (read
      // from the ymap where the execute context is built). Lets cancelByToolUseId
      // scope an abort to this exact incarnation so a stale cancel can't kill a
      // re-run of the same toolUseId. Undefined when the caller didn't supply one
      // (e.g. a direct execute() outside the command-driven path) → unscoped.
      runningEpoch: /** @type {any} */ (context).runningEpoch,
      // The doc's runningStartedAt claim stamp (browser Date.now(), same clock as
      // a report's sentAt). Carried into the tool-execution-report so the worker's
      // happens-after guard can tell a claim that predates a report from one that
      // postdates it, without a wall-clock skew.
      runningStartedAt: /** @type {any} */ (context).runningStartedAt,
      startTime: Date.now()
    });

    return { controller, action, executionId };
  }

  /**
   * Format the error result for a prepare() that reported valid: false.
   * @param {string} actionId
   * @param {import('juggler/context-item').default} action
   * @param {import('juggler/context-item').PreparedItem} prepared
   * @param {number} startTime
   * @returns {ActionStatus} The validation-failure result.
   * @private
   */
  _buildValidationFailure(actionId, action, prepared, startTime) {
    // Validation failed - format and return error
    const formatted = ContextItem.validateSummary(action.getSummary({
      success: false,
      error: prepared.error || 'Validation failed',
      prepared
    }));
    /** @type {ActionStatus} */
    const errorResult = {
      actionId,
      success: false,
      error: prepared.error || 'Validation failed',
      formatted,
      displayData: prepared.displayData
    };
    errorResult.durationMs = Date.now() - startTime;
    return errorResult;
  }

  /**
   * Run the prepared action's execute() and shape its raw result (or a thrown
   * error) into an ActionStatus. Honours cancellation throughout.
   * @param {string} actionId
   * @param {import('juggler/context-item').default} action
   * @param {import('juggler/context-item').PreparedItem} prepared
   * @param {AbortController} controller
   * @returns {Promise<ActionStatus>} The shaped execution result.
   * @private
   */
  async _performAction(actionId, action, prepared, controller) {
    try {
      // Check if already aborted before starting
      if (controller.signal.aborted) {
        const formatted = ContextItem.validateSummary(action.getSummary({ success: false, error: 'Action cancelled', cancelled: true, prepared }));
        return /** @type {ActionStatus} */ ({
          actionId,
          success: false,
          error: 'Action cancelled',
          cancelled: true,
          formatted,
          displayData: prepared.displayData
        });
      }

      const result = await this._raceExecuteAgainstAbort(action, prepared, controller);
      return this._formatExecutionResult(actionId, action, prepared, result);
    } catch (error) {
      return this._handleExecutionError(actionId, action, prepared, error);
    }
  }

  /**
   * Race action.execute() against the abort signal so a non-cooperative tool
   * still settles the instant the controller aborts. Returns the raw result, or
   * rejects with an AbortError if the abort wins.
   * @param {import('juggler/context-item').default} action
   * @param {import('juggler/context-item').PreparedItem} prepared
   * @param {AbortController} controller
   * @returns {Promise<any>} The raw execute() result.
   * @private
   */
  async _raceExecuteAgainstAbort(action, prepared, controller) {
    // Robustness backstop: a tool whose execute() ignores its abort signal —
    // a non-cooperative tool, or a backend op that genuinely can't be
    // interrupted — must STILL settle the instant the controller aborts, or
    // it wedges the turn (its read-tool Promise.all never resolves and every
    // later tool in the conversation queues behind it forever). Race
    // execute() against an abort-rejection: if abort wins, the race rejects
    // with an AbortError that flows into the shared catch below and produces
    // the cancelled result. The orphaned execute() promise is detached with a
    // no-op catch so a late rejection can't surface as unhandled; its
    // eventual value is discarded and can't overwrite the cancelled state.
    // Cooperative tools that honour the signal settle first, so this race is
    // invisible to them.
    /** @type {() => void} */
    let onAbortRace = () => {};
    const abortRace = new Promise((_resolve, reject) => {
      onAbortRace = () => {
        // A plain Error tagged with name='AbortError' — the shared catch
        // below dispatches on the name alone (DOMException isn't reliably
        // instanceof Error and isn't an eslint global in this layer).
        const abortErr = new Error('Action cancelled');
        abortErr.name = 'AbortError';
        reject(abortErr);
      };
      controller.signal.addEventListener('abort', onAbortRace, { once: true });
    });
    const execPromise = action.execute(prepared.params || {});
    execPromise.catch(() => {}); // detach orphan: swallow any late rejection
    const result = await Promise.race([execPromise, abortRace]);
    // execute() won the race; drop the abort listener (the once:true handler
    // already self-removes if abort fired and the race rejected instead).
    controller.signal.removeEventListener('abort', onAbortRace);
    return result;
  }

  /**
   * Shape a raw execute() result into an ActionStatus: cancelled-during-execution,
   * a backend structured error, or success.
   * @param {string} actionId
   * @param {import('juggler/context-item').default} action
   * @param {import('juggler/context-item').PreparedItem} prepared
   * @param {any} result
   * @returns {ActionStatus} The shaped success/error result.
   * @private
   */
  _formatExecutionResult(actionId, action, prepared, result) {
    // Check if action was cancelled during execution (streaming actions)
    if (result && result.cancelled) {
      const formatted = ContextItem.validateSummary(action.getSummary({ success: false, error: 'Action cancelled', cancelled: true, result, prepared }));
      return /** @type {ActionStatus} */ ({
        actionId,
        success: false,
        error: 'Action cancelled',
        cancelled: true,
        result,
        formatted,
        displayData: prepared.displayData
      });
    } else if (result && typeof result === 'object' && result.success === false && result.errorCode) {
      // Check if backend returned structured error (success: false with errorCode)
      // This allows backends to return detailed error data instead of throwing
      // Get dual messages from action if formatError() is implemented
      let userMessage = /** @type {string} */ (result.error) || 'Operation failed';
      /** @type {string|null} */
      let llmFeedback = null;

      // Get tool name from action's tool definitions
      const toolDefs = /** @type {any} */ (action.constructor).getToolDefinitions?.() || [];
      const toolName = toolDefs[0]?.name || actionId;
      const formatted = action.formatError(result, toolName);
      if (formatted) {
        userMessage = formatted.userMessage;
        llmFeedback = formatted.llmMessage;
      }

      const formattedSummary = ContextItem.validateSummary(action.getSummary({ success: false, error: userMessage, result, prepared }));
      return /** @type {ActionStatus} */ ({
        actionId,
        success: false,
        error: userMessage,
        result: llmFeedback ? { ...result, llmFeedback } : result,
        formatted: formattedSummary,
        displayData: prepared.displayData
      });
    } else {
      // Success - format result
      const rawSummary = action.getSummary({ success: true, result, prepared });
      warnOnEmptySuccessSummary(rawSummary, action.constructor.name);
      const formatted = ContextItem.validateSummary(rawSummary);
      return /** @type {ActionStatus} */ ({
        actionId,
        success: true,
        result,
        formatted,
        displayData: prepared.displayData
      });
    }
  }

  /**
   * Shape a thrown error from execution into an ActionStatus, distinguishing an
   * abort (cancelled result, partial output preserved) from a genuine failure.
   * @param {string} actionId
   * @param {import('juggler/context-item').default} action
   * @param {import('juggler/context-item').PreparedItem} prepared
   * @param {unknown} error
   * @returns {ActionStatus} The shaped error result.
   * @private
   */
  _handleExecutionError(actionId, action, prepared, error) {
    // Check if this was an abort error. A fetch() abort rejects with a
    // DOMException whose name is 'AbortError'; DOMException is not reliably
    // `instanceof Error` across engines, so match on the name alone.
    if (/** @type {any} */ (error)?.name === 'AbortError') {
      // Try to preserve any partial output (e.g., streamed stdout before cancellation)
      const partialOutput = /** @type {any} */ (action).output || undefined;

      const partialResult = partialOutput
        ? { stdout: partialOutput, cancelled: true }
        : undefined;

      const formatted = ContextItem.validateSummary(action.getSummary({
        success: false,
        error: 'Action cancelled',
        cancelled: true,
        result: partialResult,
        prepared
      }));

      return /** @type {ActionStatus} */ ({
        actionId,
        success: false,
        error: 'Action cancelled',
        cancelled: true,
        result: partialResult,
        formatted,
        displayData: prepared.displayData
      });
    } else {
      // Execution failed - capture full error including stack trace
      const { message: errorMessage, stack: errorStack } = extractErrorInfo(error);

      // Only log unexpected errors (actual bugs), not backend operational errors
      if (!(error instanceof OpsError)) {
        console.error(`[ActionExecutor] Action failed: ${actionId} - ${errorMessage}`);
        if (errorStack) {
          console.error(`[ActionExecutor] Stack trace:\n${errorStack}`);
        }
      }

      const formatted = ContextItem.validateSummary(action.getSummary({
        success: false,
        error: errorMessage,
        prepared
      }));

      return /** @type {ActionStatus} */ ({
        actionId,
        success: false,
        error: errorMessage,
        errorStack: errorStack || undefined,
        formatted,
        displayData: prepared.displayData
      });
    }
  }

  /**
   * Emit a progress event for a running action
   * @param {string} executionId - Execution ID
   * @param {ActionProgressEvent} event - Progress event
   * @private
   */
  _emitProgress(executionId, event) {
    const runningAction = this._runningActions.get(executionId);
    if (!runningAction) return;

    // Emit progress event - UI elements can listen to this for streaming display
    // Include accumulated output so listeners display current state instead of reassembling chunks
    const detail = {
      executionId,
      actionId: runningAction.actionId,
      toolUseId: runningAction.toolUseId, // For UI element correlation
      conversationId: runningAction.conversationId,
      event,
      accumulatedOutput: /** @type {any} */ (runningAction.action).output || '',
      startTime: runningAction.startTime
    };
    // The local document event drives same-process UI; the engine worker has
    // no document, so progress reaches viewers solely via the engine bridge.
    if (typeof document !== 'undefined') {
      document.dispatchEvent(new CustomEvent('action-progress', { detail }));
    }
    wsService.sendEngineBridge(__ACTION_PROGRESS_CHANNEL, detail);
  }

  /**
   * Cancel a running action by its tool-use ID, scoped to one conversation and
   * (optionally) one execution generation.
   *
   * The worker (sole writer of cancellation state) flips a tool-action to
   * `state='cancelled'` and commands `cancel-tool`; this aborts the matching
   * in-flight action. Without it the action's op fetch runs to completion and
   * the reducer overwrites the worker's `cancelled` with `completed`, so the
   * strategy loop continues as if no cancel happened.
   *
   * The conversationId match is load-bearing: this executor is an engine-wide
   * singleton running actions for EVERY conversation, and tool-use IDs are
   * only unique within one provider conversation (OpenAI-style `call_1`
   * recurs constantly; the mock LLM reuses ids across tests). Matching on
   * toolUseId alone let a cancel in conversation A abort an identically-named
   * in-flight tool in conversation B — whose worker never stamps a result, so
   * B's tool wedged at running-with-no-result forever.
   *
   * The runningEpoch match is the generation guard: a cancel issued against one
   * execution must never abort a *different* incarnation of the same toolUseId.
   * A re-run claims a strictly higher epoch (claimRunning bumps it), so a stale
   * cancel meant for the previous execution mismatches and is skipped. When the
   * caller supplies no epoch (0/undefined), the guard is disabled and the abort
   * is unscoped — the pre-generation behaviour, kept for pre-claim cancels of an
   * approved tool (no epoch stamped yet) and for engine-local cancelAllActions.
   * @param {string} toolUseId - Tool use ID to cancel
   * @param {string} conversationId - Conversation the cancel belongs to
   * @param {number} [runningEpoch] - Execution generation to scope the abort to
   * @returns {'hit'|'miss'|'epoch-mismatch'} 'hit' if a matching action was
   *   aborted; 'epoch-mismatch' if the id was running under a different
   *   generation (left alone); 'miss' if nothing matched.
   */
  cancelByToolUseId(toolUseId, conversationId, runningEpoch) {
    for (const runningAction of this._runningActions.values()) {
      if (runningAction.toolUseId === toolUseId &&
          runningAction.conversationId === conversationId) {
        // Only enforce the generation guard when BOTH sides carry an epoch: an
        // absent caller epoch means "unscoped", and an absent entry epoch means
        // the running execution predates generation tracking — either way fall
        // back to the id+conversation match (today's behaviour).
        if (runningEpoch && runningAction.runningEpoch &&
            runningAction.runningEpoch !== runningEpoch) {
          return 'epoch-mismatch';
        }
        runningAction.controller.abort();
        return 'hit';
      }
    }
    return 'miss';
  }

  /**
   * The in-flight execution for one tool-use id in one conversation, or null.
   *
   * The engine's re-entrancy witness. A re-driven `execute-tool` is normally
   * made harmless by the doc's APPROVED → RUNNING compare-and-set
   * (claimRunning), but that only holds while the doc keeps the `running` that
   * claim wrote. This map is the stronger witness: it belongs to the thing
   * actually running the tool, so it stays true across any doc-state loss.
   * handleExecuteTool consults it before claiming and declines to start a
   * second concurrent run of an id already executing here.
   *
   * Conversation-scoped for the same reason as {@link cancelByToolUseId}:
   * tool-use IDs are unique only within one provider conversation.
   * @param {string} toolUseId - Tool use ID to look up
   * @param {string} conversationId - Conversation the lookup belongs to
   * @returns {{runningEpoch: number|undefined, runningStartedAt: number|undefined}|null} The
   *   in-flight execution's generation stamps, or null if this executor is not running that id.
   */
  runningActionFor(toolUseId, conversationId) {
    for (const a of this._runningActions.values()) {
      if (a.toolUseId === toolUseId && a.conversationId === conversationId) {
        return { runningEpoch: a.runningEpoch, runningStartedAt: a.runningStartedAt };
      }
    }
    return null;
  }

  /**
   * The executing set for one conversation. Returns one entry per in-flight action
   * in the conversation, carrying the fields the worker's tool-execution-report
   * rule needs: the tool-use id, its execution generation, and its claim stamp.
   * Conversation-scoped for the same reason as {@link cancelByToolUseId} —
   * tool-use IDs are unique only within one conversation.
   * @param {string} conversationId - Conversation to filter by
   * @returns {Array<{toolUseId: string, runningEpoch: number|undefined, runningStartedAt: number|undefined}>} One entry per in-flight action in the conversation.
   */
  executingSetFor(conversationId) {
    /** @type {Array<{toolUseId: string, runningEpoch: number|undefined, runningStartedAt: number|undefined}>} */
    const out = [];
    for (const a of this._runningActions.values()) {
      if (a.conversationId === conversationId && a.toolUseId) {
        out.push({ toolUseId: a.toolUseId, runningEpoch: a.runningEpoch, runningStartedAt: a.runningStartedAt });
      }
    }
    return out;
  }

  /**
   * Snapshot every in-flight action grouped by conversation. The engine's
   * tool-execution reporter uses this to emit one report per conversation that
   * has running work — the executor is an engine-wide singleton spanning every
   * loaded (and unloaded-but-still-executing) conversation, so grouping here is
   * what lets a single reporter serve them all.
   * @returns {Map<string, Array<{toolUseId: string, runningEpoch: number|undefined, runningStartedAt: number|undefined}>>} In-flight actions grouped by conversation id.
   */
  snapshotRunningByConversation() {
    /** @type {Map<string, Array<{toolUseId: string, runningEpoch: number|undefined, runningStartedAt: number|undefined}>>} */
    const byConv = new Map();
    for (const a of this._runningActions.values()) {
      if (!a.conversationId || !a.toolUseId) continue;
      let arr = byConv.get(a.conversationId);
      if (!arr) { arr = []; byConv.set(a.conversationId, arr); }
      arr.push({ toolUseId: a.toolUseId, runningEpoch: a.runningEpoch, runningStartedAt: a.runningStartedAt });
    }
    return byConv;
  }

  /**
   * Executions that have outrun {@link OVERDUE_EXECUTION_MS} and are due to be
   * reported, stamping each so it is not reported again for OVERDUE_REPEAT_MS.
   *
   * This is the engine's only witness to the wedge nothing else can see. A tool
   * that reaches `running` and then hangs — inside `execute()`, or on an await
   * that never settles — leaves every other ladder satisfied: the worker's
   * tool-command escalation covers only tools stuck at a DELIVERY state ("" or
   * approved) and skips `running` entirely; the worker's tool-execution-report
   * rule finalizes only a tool ABSENT from the engine's executing set, and a hung
   * tool is present in every report forever; and the engine's own heartbeat keeps
   * firing, because a stuck await leaves the event loop free. The execution is
   * invisible to all three, so age is the only signal left.
   *
   * It reports and does not act, deliberately. There is no threshold at which
   * aborting a running tool is safe: the tools that hang are the same ones that
   * legitimately run for a very long time (a build under `bash`, a large grep, a
   * slow model call), so a watchdog that killed them would trade a rare wedge for
   * routinely destroying work the user was waiting on. The user already has a
   * cancel that reaches this executor. What was missing was any record that the
   * execution existed, which is what the caller turns into an engine-trace.
   * @param {number} [now] - Clock override for tests
   * @returns {Array<{toolUseId: string|undefined, conversationId: string, actionId: string, runningMs: number}>}
   *   One entry per overdue execution due for reporting; empty when nothing is overdue.
   */
  overdueRunningActions(now = Date.now()) {
    /** @type {Array<{toolUseId: string|undefined, conversationId: string, actionId: string, runningMs: number}>} */
    const out = [];
    for (const a of this._runningActions.values()) {
      // An execution with no conversation (a direct execute() outside the
      // command-driven path) has nowhere to be reported to.
      if (!a.conversationId) continue;
      const runningMs = now - a.startTime;
      if (runningMs < OVERDUE_EXECUTION_MS) continue;
      if (a.overdueReportedAt !== undefined && now - a.overdueReportedAt < OVERDUE_REPEAT_MS) continue;
      a.overdueReportedAt = now;
      out.push({
        toolUseId: a.toolUseId,
        conversationId: a.conversationId,
        actionId: a.actionId,
        runningMs
      });
    }
    return out;
  }

  /**
   * Cancel every in-flight action belonging to one conversation.
   *
   * Used when the engine releases a conversation the user has deleted or binned.
   * Those executions have nowhere left to report: their worker is gone and their
   * Yjs document is about to be destroyed, so letting them run to completion
   * writes a result into a torn-down doc. Conversation-scoped for the same reason
   * as {@link ActionExecutor#cancelByToolUseId} — this executor is engine-wide
   * and every other conversation's work must be left strictly alone.
   * @param {string} conversationId - Conversation whose work is being abandoned
   * @returns {number} How many executions were aborted
   */
  cancelConversationActions(conversationId) {
    let aborted = 0;
    for (const runningAction of this._runningActions.values()) {
      if (runningAction.conversationId !== conversationId) continue;
      runningAction.controller.abort();
      aborted++;
    }
    // Entries are removed by execute()'s finally as each abort unwinds.
    return aborted;
  }

  /**
   * Cancel all currently running actions
   */
  cancelAllActions() {
    for (const [executionId, runningAction] of this._runningActions) {
      runningAction.controller.abort();
      console.log(`[ActionExecutor] Cancelled action: ${runningAction.actionId} (${executionId})`);
    }
    // Map will be cleaned up by finally blocks in execute()
  }


  /**
   * Check if there are any running actions
   * @returns {boolean} True if there are running actions
   */
  hasRunningActions() {
    return this._runningActions.size > 0;
  }

}

// Export singleton instance
const actionExecutor = new ActionExecutor();
export default actionExecutor;
