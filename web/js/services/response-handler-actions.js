//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Action tool pipeline: resolve → prepare → approve → execute → complete.
 *
 * ResponseHandler's other two tool kinds (context items, meta tools) are a
 * single call each; actions carry a multi-stage state machine with a user in
 * the middle of it, so it lives here and ResponseHandler delegates in one line.
 *
 * Each function takes the ResponseHandler instance (`rh`) as its first argument
 * — the same shape worker-manager-protocols.js uses for worker-manager. Only
 * `rh.conversation` is touched, never a private field.
 * @module services/response-handler-actions
 */

import actionExecutor, { toolResultContent } from './action-executor.js';
import { getBlockedToolReason, resolveToolName } from './tool-generator.js';
import { withMcpToolMissReason } from './mcp-availability.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import { extractErrorInfo } from '../../sdk/lib/error-utils.js';
import { buildApprovalButtons } from './approval-options.js';
import { RESULT_TYPES, ACTION_STATES, TOOL_STATES } from '../../sdk/lib/message.js';
import { INTERACTION_KIND } from '../../sdk/context-item.js';
import { plain } from '../model/item-accessor.js';
import workerManager from './worker-manager.js';
import wsService from './websocket.js';
import { APPROVAL_POLICY } from 'juggler/strategy-type';

/**
 * @typedef {import('./response-handler.js').ToolExecutionResult} ToolExecutionResult
 * @typedef {import('./response-handler.js').ResultStatus} ResultStatus
 * @typedef {import('./response-handler.js').default} ResponseHandler
 * @typedef {import('../model/message-thread.js').MessageThread} MessageThread
 * @typedef {import('../components/action-confirmation.js').ActionConfirmationOptions} ActionConfirmationOptions
 * @typedef {{id: string, name: string, input?: unknown}} ToolCall
 */

/**
 * Terminal failure for a tool-action: write the error to the document and build
 * the matching error ToolExecutionResult. Every failure exit shares that pair —
 * the item gets `isError: true` plus a `fullResult`, the caller gets
 * `success: false, resultStatus: 'error'`.
 *
 * `outcome` stays explicit at each call site because tool-executor.js reads both
 * of its fields and they are NOT interchangeable: `_toToolOutcome` passes
 * `content` straight through to the LLM (a site that omits it yields an outcome
 * with none), and derives `outcome.error` from `result` via
 * `extractErrorMessage` — so whether `result.error` carries the "Error: " prefix
 * decides what the strategy loop sees.
 * @param {MessageThread} messageThread - Message thread owning the tool-action
 * @param {ToolCall} toolCall - Tool call that failed
 * @param {object} spec - Failure specification
 * @param {string} spec.content - Error text written to the tool-action item
 * @param {string} spec.resultType - RESULT_TYPES value for the completed item
 * @param {import('../../sdk/lib/message.js').ActionFullResult} spec.fullResult - Structured result stored on the item
 * @param {{result: unknown, content?: string}} spec.outcome - Fields merged into the returned result
 * @returns {ToolExecutionResult} Error result for the orchestrator
 */
export function failToolAction(messageThread, toolCall, { content, resultType, fullResult, outcome }) {
  // DOCUMENT-DRIVEN FLOW: the worker created the tool-action; we complete it
  // with the error. Without this the conversation is unchanged and the LLM
  // retries the same thing.
  messageThread.completeToolAction(toolCall.id, {
    content,
    isError: true,
    resultType,
    fullResult
  });

  return {
    toolName: toolCall.name,
    success: false,
    resultStatus: /** @type {ResultStatus} */ ('error'),
    ...outcome
  };
}

/**
 * Execute an action tool with declarative state-driven pattern. Called by
 * ToolExecutor. Message state drives UI rendering - NO DOM manipulation here.
 * States: waiting_for_approval → running → completed/cancelled/error
 * @param {ResponseHandler} rh - Response handler instance
 * @param {ToolCall} toolCall - Tool call to execute
 * @param {MessageThread} messageThread - Message thread
 * @param {{onApproved?: () => void}} [outerOptions] - Callbacks
 * @returns {Promise<ToolExecutionResult>} Standardized result for orchestrator
 */
export async function executeAction(rh, toolCall, messageThread, outerOptions = {}) {
  const toolInput = /** @type {Record<string, unknown>} */ (toolCall.input || {});

  // Wrap entire function in try-catch to ensure loop continues on any error
  try {
    return await executeActionCore(rh, toolCall, toolInput, messageThread, { onApproved: outerOptions.onApproved });
  } catch (error) {
    // Catch any uncaught errors and return a result that continues the loop
    const { message, stack } = extractErrorInfo(error);
    const errorContent = `Error: ${message}`;
    if (stack) console.error(`[ResponseHandler] Action error stack:\n${stack}`);
    return failToolAction(messageThread, toolCall, {
      content: errorContent,
      resultType: RESULT_TYPES.ACTION,
      fullResult: { state: ACTION_STATES.ERROR, success: false, error: message },
      outcome: { result: { error: errorContent } }
    });
  }
}

/**
 * Execute an action retry - runs the EXACT same flow as first time,
 * just skips creating the tool-use message (it already exists).
 * @param {ResponseHandler} rh - Response handler instance
 * @param {ToolCall} toolCall - Tool call to execute
 * @param {MessageThread} messageThread - Message thread
 * @param {ActionConfirmationOptions} [existingApprovalOptions] - Approval options from the existing tool-use message
 */
export async function executeActionRetry(rh, toolCall, messageThread, existingApprovalOptions) {
  const toolInput = /** @type {Record<string, unknown>} */ (toolCall.input || {});

  await executeActionCore(rh, toolCall, toolInput, messageThread, { existingApprovalOptions });
}

/**
 * Build approval options from action and prepared parameters.
 * Public for use by session.js worker flow.
 * @param {any} action - Action instance
 * @param {any} prepared - Prepared parameters from action.prepareParameters()
 * @returns {ActionConfirmationOptions} Approval options
 */
export function buildApprovalOptions(action, prepared) {
  const manifest = action.getManifest();
  const approval = prepared.approval || {};

  // A plugin can supply a fully custom button set via getApprovalConfig;
  // honour it verbatim. Otherwise build the standard, plugin-driven set
  // (Yes, one "Don't Ask Again" per suggestion, No) — see buildApprovalButtons.
  const options = approval.options || buildApprovalButtons(action, prepared.params || {});

  return {
    title: approval.title || `Approve: ${manifest.name}`,
    message: approval.message || '',
    options,
    ...approval.display // Extra display data (diffs, previews, etc.)
  };
}

/**
 * Core action execution logic - handles both approval and non-approval paths.
 * @param {ResponseHandler} rh - Response handler instance
 * @param {ToolCall} toolCall - Tool call to execute
 * @param {Record<string, unknown>} toolInput - Tool input parameters
 * @param {MessageThread} messageThread - Message thread
 * @param {{existingApprovalOptions?: ActionConfirmationOptions, onApproved?: () => void}} [options] - Options for retry flow
 * @returns {Promise<ToolExecutionResult>} Standardized result for orchestrator
 */
async function executeActionCore(rh, toolCall, toolInput, messageThread, options = {}) {
  const { existingApprovalOptions, onApproved } = options;

  const prep = await prepareAction(rh, toolCall, toolInput, messageThread);
  if (prep.result) return prep.result;
  const { ActionClass, action, actionId, prepared, resolvedName } = prep;

  const needsApproval = determineApprovalNeeded(
    toolCall, toolInput, resolvedName, ActionClass, action, messageThread, existingApprovalOptions
  );

  if (needsApproval) {
    const approvalOutcome = await handleApprovalFlow(
      rh, toolCall, action, prepared, messageThread, existingApprovalOptions
    );
    if (approvalOutcome) return approvalOutcome;
  }

  // Signal that the tool is now running (approval complete or not needed).
  // Allows the server to start its execution timeout from this point.
  onApproved?.();

  return runActionAndComplete(rh, toolCall, actionId, toolInput, messageThread);
}

/**
 * Resolve an action class and prepare its parameters — the pipeline shared by
 * execution (`prepareAction`).
 * When the class is unknown/blocked, `ActionClass` is null and `blockedReason`
 * carries the reason (if any); otherwise the instance is constructed with
 * `toolName` set (so a multi-tool class routes validate/approval to the invoked
 * tool) and `prepare()` has run. Purely computational — no document mutation.
 * @param {ResponseHandler} rh - Response handler instance
 * @param {ToolCall} toolCall - Tool call to execute
 * @param {Record<string, unknown>} toolInput - Tool input parameters
 * @param {MessageThread} messageThread - Message thread
 * @returns {Promise<{resolvedName: string, ActionClass: any, actionId?: string, action?: any, prepared?: any, blockedReason: string|null}>} Resolved action context (ActionClass null when unknown/blocked)
 */
export async function resolveAndPrepare(rh, toolCall, toolInput, messageThread) {
  // Resolve aliases (e.g., 'Bash' -> 'bash') for registry lookup
  const resolvedName = resolveToolName(toolCall.name);
  const ActionClass = /** @type {any} */ (contextItemRegistry.getByToolName(resolvedName));
  if (!ActionClass) {
    return { resolvedName, ActionClass: null, blockedReason: getBlockedToolReason(resolvedName) || null };
  }

  const actionId = ActionClass.MANIFEST.id;
  const action = new ActionClass({
    id: actionId,
    session: rh.conversation.session,
    conversation: rh.conversation,
    messageThread,
    toolName: resolvedName  // Lets a multi-tool class route validate/approval to the invoked tool
  });
  const prepared = await action.prepare(toolInput);

  return { resolvedName, ActionClass, actionId, action, prepared, blockedReason: null };
}

/**
 * Resolve the action class and prepare its parameters. Returns `{result}`
 * to short-circuit (unknown/blocked tool or invalid params — after updating
 * the tool-action with the error), otherwise the prepared action context.
 * @param {ResponseHandler} rh - Response handler instance
 * @param {ToolCall} toolCall - Tool call to execute
 * @param {Record<string, unknown>} toolInput - Tool input parameters
 * @param {MessageThread} messageThread - Message thread
 * @returns {Promise<{result: ToolExecutionResult} | {result?: undefined, ActionClass: any, action: any, actionId: string, prepared: any, resolvedName: string}>} Short-circuit result or prepared action context
 */
async function prepareAction(rh, toolCall, toolInput, messageThread) {
  // ========== 1. RESOLVE ACTION CLASS AND PREPARE PARAMETERS ==========
  const { resolvedName, ActionClass, actionId, action, prepared, blockedReason } =
    await resolveAndPrepare(rh, toolCall, toolInput, messageThread);
  if (!ActionClass) {
    const errorMessage = blockedReason
      ? `Tool "${toolCall.name}" is not available: ${blockedReason}`
      : await withMcpToolMissReason(`Unknown action: ${toolCall.name}`, toolCall.name);

    return {
      result: failToolAction(messageThread, toolCall, {
        content: errorMessage,
        resultType: RESULT_TYPES.ACTION,
        fullResult: { state: ACTION_STATES.ERROR, success: false, error: errorMessage, blocked: !!blockedReason },
        outcome: { result: { error: errorMessage, blocked: !!blockedReason } }
      })
    };
  }

  // ========== 2. HANDLE INVALID PARAMETERS ==========
  if (!prepared.valid) {
    const errorMessage = prepared.error || 'Validation failed';

    return {
      result: failToolAction(messageThread, toolCall, {
        content: errorMessage,
        resultType: RESULT_TYPES.ACTION,
        fullResult: { state: ACTION_STATES.ERROR, success: false, error: errorMessage, actionId },
        outcome: { result: { error: errorMessage } }
      })
    };
  }

  return { ActionClass, action, actionId: /** @type {string} */ (actionId), prepared, resolvedName };
}

/**
 * Determine whether this action requires user approval, consulting the
 * action's own policy and the strategy's master approval policy.
 * @param {ToolCall} toolCall - Tool call to execute
 * @param {Record<string, unknown>} toolInput - Tool input parameters
 * @param {string} resolvedName - Alias-resolved tool name
 * @param {any} ActionClass - Resolved action class
 * @param {any} action - Action instance
 * @param {MessageThread} messageThread - Message thread
 * @param {ActionConfirmationOptions} [existingApprovalOptions] - Approval options from an existing tool-use message (retry)
 * @returns {boolean} Whether approval is needed
 */
function determineApprovalNeeded(toolCall, toolInput, resolvedName, ActionClass, action, messageThread, existingApprovalOptions) {
  // ========== 3. CHECK IF APPROVAL NEEDED ==========
  // Check if this is a retry (already has approval options)
  const isRetry = !!existingApprovalOptions;
  const defaultApproval = isRetry || (action.requiresApproval() && !action.isPermitted(toolInput));

  // Consult strategy approval policy (strategy has master control)
  const toolDefs = ActionClass.getToolDefinitions?.() || [];
  const toolDef = toolDefs.find((/** @type {{name: string}} */ t) => t.name === resolvedName);
  const strategyPolicy = messageThread.strategy?.getApprovalPolicy?.({
    toolName: toolCall.name,
    toolInput,
    category: toolDef?.category,
    defaultApproval,
    // The parked-state kind (gate vs elicitation), so a policy can decline to
    // stand in for the user on an elicitation whose resolution IS the user's
    // own answer (e.g. AskUserQuestion) — see getApprovalPolicy's contract.
    interactionKind: action.interactionKind(),
    // Whether this call may be silently auto-approved. False for a deliberate
    // human checkpoint (a plan submit; a catastrophic delete) — so a blanket
    // auto-approve (YOLO) returns DEFAULT for it and it still parks for review.
    autoApprovable: action.autoApprovable?.(toolInput) ?? true
  });

  let needsApproval;
  if (strategyPolicy === APPROVAL_POLICY.APPROVE) {
    needsApproval = false;
  } else if (strategyPolicy === APPROVAL_POLICY.REQUIRE_APPROVAL) {
    needsApproval = true;
  } else {
    needsApproval = defaultApproval;
  }
  return needsApproval;
}

/**
 * Run the approval path: wait for user approval if needed, then either
 * short-circuit (rejection, or an already-executed result) or fall through
 * to execution.
 * @param {ResponseHandler} rh - Response handler instance
 * @param {ToolCall} toolCall - Tool call to execute
 * @param {any} action - Action instance
 * @param {any} prepared - Prepared parameters from action.prepare()
 * @param {MessageThread} messageThread - Message thread
 * @param {ActionConfirmationOptions} [existingApprovalOptions] - Approval options from an existing tool-use message (retry)
 * @returns {Promise<ToolExecutionResult|null>} Result to return, or null to continue to execution
 */
async function handleApprovalFlow(rh, toolCall, action, prepared, messageThread, existingApprovalOptions) {
  // ========== 4. HANDLE APPROVAL PATH ==========
  // Check if approval is already done (observer flow - called after user approved)
  const existingAction = messageThread.getToolAction(toolCall.id);
  const existingState = existingAction?.get('state');
  const approvalAlreadyDone = existingState === TOOL_STATES.APPROVED ||
                                    existingState === TOOL_STATES.RUNNING ||
                                    existingState === TOOL_STATES.COMPLETED ||
                                    existingState === TOOL_STATES.CANCELLED;

  let approvalResult = 'yes';  // Default for already-approved case

  if (!approvalAlreadyDone) {
    // Need to wait for user approval
    const approvalOptions = existingApprovalOptions || buildApprovalOptions(action, prepared);

    // DOCUMENT-DRIVEN FLOW: For retries, approval state is already set by observer.
    // For initial execution, observer's handleNewToolAction sets state to 'pending'.
    // Create promise BEFORE updating message (prevents race condition)
    // waitForApproval polls message state - no options needed (they're on the message)
    const approvalPromise = messageThread.waitForApproval(toolCall.id);

    // Update existing tool-action with approval options (both first-time and retry)
    // Worker created the item, we add the UI-specific approval options
    workerManager.updateToolActionForRetry(
      rh.conversation.id,
      toolCall.id,
      approvalOptions,
      prepared.displayData
    );

    approvalResult = await approvalPromise;
  } else if (existingState === TOOL_STATES.CANCELLED) {
    approvalResult = 'cancel';
  }

  // resolveApproval already executed/added tool-result for all cases
  // We just need to read the result and return

  // Handle rejection (no or cancel) - both use 'cancelled' now
  if (approvalResult === 'no' || approvalResult === 'cancel') {
    return {
      toolName: toolCall.name,
      success: false,
      resultStatus: /** @type {ResultStatus} */ ('cancelled'),
      result: { cancelled: true }
    };
  }

  // Check if tool-action already exists (approval path creates it)
  // CRITICAL: Check existence first to prevent duplication bug
  const existingToolAction = messageThread.getToolAction(toolCall.id);

  if (existingToolAction) {
    // Tool-action already exists from approval flow
    // Check if already executed (result set with actual content)
    // Note: Yjs sync can result in {} when result is unset, so check for content
    const existingResult = existingToolAction.get('result');
    const hasRealResult = existingResult !== null &&
                existingResult !== undefined &&
                (existingResult.get?.('content') !== undefined ||
                 existingResult.get?.('cancelled') === true);
    if (hasRealResult) {
      // Already executed by resolveApproval - return result
      const result = plain(existingResult);

      return {
        toolName: toolCall.name,
        success: !result.isError,
        resultStatus: result.isError
          ? /** @type {ResultStatus} */ ('error')
          : /** @type {ResultStatus} */ ('success'),
        content: result.content,
        result: result.fullResult
      };
    }

    // Exists but not executed yet (approval just resolved)
    // Fall through to execution - don't create duplicate
  }
  // Tool-action was already created when approval was requested, but Yjs sync
  // delay can make getToolAction() return undefined. DO NOT create a duplicate
  // here — just fall through to execution.
  return null;
}

/**
 * Fold an elicitation tool's captured answer (its approval response) into the
 * tool input before execution. A gate tool's approval response is a bare
 * verdict carrying no data, so it passes through unchanged.
 *
 * Kind-driven, not name-driven: the tool declares `interaction: 'elicitation'`
 * and owns the parse via its static `applyApprovalResponse` — there is no
 * per-tool special-casing here.
 * @param {ToolCall} toolCall - Tool call to execute
 * @param {Record<string, unknown>} toolInput - Tool input parameters
 * @param {MessageThread} messageThread - Message thread
 * @returns {Record<string, unknown>} Final tool input for execution
 */
function resolveFinalToolInput(toolCall, toolInput, messageThread) {
  const ActionClass = /** @type {any} */ (contextItemRegistry.getByToolName(toolCall.name));
  if (ActionClass?.interactionKind?.() !== INTERACTION_KIND.ELICITATION) {
    return toolInput;
  }
  const approvalResponse = messageThread.getToolAction(toolCall.id)?.get('approvalResponse');
  if (!approvalResponse) return toolInput;
  return ActionClass.applyApprovalResponse(toolInput, approvalResponse);
}

/**
 * Strip large arrays from result object for storage efficiency.
 * UI renders `content` (same as the LLM sees), so large data needn't be
 * duplicated in fullResult. Keeps counts and metadata.
 * @param {unknown} result - Raw result from action
 * @returns {unknown} Result with large arrays stripped
 */
function stripLargeArrays(result) {
  if (!result || typeof result !== 'object') {
    return result;
  }

  const stripped = /** @type {Record<string, unknown>} */ ({});
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) && value.length > 5) {
      // Replace large arrays with count
      stripped[key + 'Count'] = value.length;
    } else {
      stripped[key] = value;
    }
  }
  return stripped;
}

/**
 * The hook record to store on a completed call: the beforeTool records already on
 * the tool-action, followed by this execution's afterTool records. Earlier
 * afterTool records are dropped — they described a previous run of the call.
 * @param {any} toolAction - The tool-action Y.Map (may be absent)
 * @param {import('./hook-runtime.js').HookRecord[]|undefined} afterRecords - This execution's afterTool records
 * @returns {import('./hook-runtime.js').HookRecord[]|undefined} The record to write, or undefined when there is none
 */
function mergeHookRecords(toolAction, afterRecords) {
  const existing = plain(toolAction?.get?.('hooks'));
  const before = Array.isArray(existing) ? existing.filter(r => r?.event === 'beforeTool') : [];
  const merged = [...before, ...(afterRecords || [])];
  return merged.length || (Array.isArray(existing) && existing.length) ? merged : undefined;
}

/**
 * Execute the action and update the tool-action with the final result,
 * handling the success, cancellation (no Yjs write), and error paths.
 * @param {ResponseHandler} rh - Response handler instance
 * @param {ToolCall} toolCall - Tool call to execute
 * @param {string} actionId - Resolved action manifest id
 * @param {Record<string, unknown>} toolInput - Tool input parameters
 * @param {MessageThread} messageThread - Message thread
 * @returns {Promise<ToolExecutionResult>} Standardized result for orchestrator
 */
async function runActionAndComplete(rh, toolCall, actionId, toolInput, messageThread) {
  // ========== 6. EXECUTE ACTION (SHARED - NO DUPLICATION!) ==========
  try {
    const finalToolInput = resolveFinalToolInput(toolCall, toolInput, messageThread);

    // Carry the execution generation + claim stamp claimRunning wrote onto the
    // tool-action into the executor's running-action registry. runningEpoch
    // scopes a later cancel-tool to this exact incarnation (cancelByToolUseId's
    // epoch guard); runningStartedAt feeds the worker's tool-execution-report
    // happens-after guard. Both read live from the ymap — the single source of
    // truth the worker's signals are generated against.
    const ta = messageThread.getToolAction(toolCall.id);
    const runningEpoch = Number(ta?.get('runningEpoch')) || undefined;
    const runningStartedAt = Number(ta?.get('runningStartedAt')) || undefined;

    const result = await actionExecutor.execute(
      actionId,
      finalToolInput,
      {
        session: rh.conversation.session,
        conversation: rh.conversation,
        messageThread,
        toolUseId: toolCall.id,
        toolName: resolveToolName(toolCall.name),  // route multi-tool classes to the invoked tool
        runningEpoch,
        runningStartedAt,
        _approvalHandled: true
      }
    );

    // CONTIGUITY INVARIANT (tool-execution-report causality, INV-C): there must
    // be NO await between the execute() completion above and completeToolAction
    // below. The executing-set entry is removed inside execute()'s finally, and
    // the terminal doc write happens in completeToolAction; keeping them in one
    // await-free region guarantees any report showing this tool absent was sent
    // after its terminal write (see action-executor.js execute() finally).

    // Build content from result
    const content = toolResultContent(result.formatted);

    // On cancellation, do NOT write to the Yjs doc. The Go worker
    // is the sole writer of cancellation state (via CancelStaleToolActions
    // in the strategy loop defer). Having the frontend also write creates
    // a CRDT merge conflict that can overwrite a rerun's state='approved'
    // back to 'cancelled', causing an infinite restart loop.
    if (result.cancelled) {
      // Diagnostic breadcrumb: this is the one exit that leaves the
      // tool-action without a result on purpose. If the worker isn't
      // about to stamp 'cancelled' (e.g. a rerun whose execution got
      // spuriously aborted), the tool wedges at running-with-no-result
      // — surface the decision on every viewer's tape.
      wsService.sendEngineBridge('juggler-tool-exec', {
        toolUseId: toolCall.id,
        toolName: toolCall.name,
        conversationId: /** @type {any} */ (rh.conversation)?.id,
        phase: 'cancelled-no-write'
      });
      return {
        toolName: toolCall.name,
        success: false,
        resultStatus: /** @type {ResultStatus} */ ('cancelled'),
        content,
        result: result.result
      };
    }

    // Determine state
    let state = 'completed';
    if (!result.success) {
      state = 'error';
    }

    // Extract llmFeedback if present
    const resultData = /** @type {{llmFeedback?: string}} */ (result.result);
    const llmFeedback = resultData?.llmFeedback;

    // Strip large arrays from result: UI renders `content` (same as the LLM
    // sees), so duplicating them in fullResult is wasted storage.
    const minimalResult = stripLargeArrays(result.result);

    // Update tool-action with final result (summary omitted — redundant with content)
    /** @type {import('../../sdk/lib/message.js').ActionFullResult} */
    const fullResult = {
      state,
      actionId: result.actionId,
      success: result.success,
      result: minimalResult,
      displayData: result.displayData,
      error: result.error,
      llmFeedback,
      durationMs: result.durationMs
    };
    // A tool that produced image output surfaces AssetRefs via getSummary's
    // `attachments`. Carry them into the tool-action so they are stored at the
    // item level (same field user attachments use) and emitted as image parts
    // in the tool_result.
    const attachments = Array.isArray(result.formatted?.attachments)
      ? result.formatted.attachments.filter((/** @type {any} */ a) => a && a.id)
      : undefined;

    // The call's hook record: what the beforeTool hooks said at evaluation (kept
    // on the item since), plus what the afterTool hooks just said. A re-run
    // replaces the afterTool part rather than piling a second one on.
    const hooks = mergeHookRecords(ta, result.hookRecords);

    messageThread.completeToolAction(toolCall.id, {
      content,
      isError: !result.success,
      resultType: RESULT_TYPES.ACTION,
      fullResult,
      ...(attachments && attachments.length ? { attachments } : {}),
      ...(hooks ? { hooks } : {})
    });

    // Determine result status
    /** @type {ResultStatus} */
    let resultStatus = 'success';
    if (!result.success) {
      resultStatus = 'error';
    }

    return {
      toolName: toolCall.name,
      success: result.success,
      resultStatus,
      content,
      result: result.result
    };
  } catch (error) {
    const { message, stack } = extractErrorInfo(error);
    const errorContent = `Error: ${message}`;
    if (stack) console.error(`[ResponseHandler] Action error stack:\n${stack}`);
    return failToolAction(messageThread, toolCall, {
      content: errorContent,
      resultType: RESULT_TYPES.ACTION,
      fullResult: { state: ACTION_STATES.ERROR, success: false, error: message, actionId },
      outcome: { result: { error: message }, content: errorContent }
    });
  }
}
