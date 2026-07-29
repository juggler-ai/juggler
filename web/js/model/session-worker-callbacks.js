//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Worker-callback wiring for Session. Two factory functions, one for the
 * engine role (handles context requests, tool definitions, and approvals)
 * and one for the viewer role (handles approvals only). Each takes the
 * Session instance and registers the appropriate handlers on workerManager.
 *
 * The internal helpers `updateToolActionApprovalOptions` and `formatToolInput`
 * live here too; they're used by the engine-role approval handlers below.
 * @module model/session-worker-callbacks
 */

import workerManager from '../services/worker-manager.js';

/** Fallback context-window size when the model config hasn't reported one yet. */
const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * How long the engine's context callback waits for a requested context item
 * whose yjs-sync from the worker is still in flight (the post-reload race)
 * before rendering without it. Context rendering is ENGINE-ONLY, so this
 * callback is the sole responder and MUST always reply: a silent bail has no
 * other client to answer and wedges the worker's turn for the full 30s
 * ContextTimeout, surfacing to the user as
 * "Failed to get context/tools: context/tools request timed out". Kept far
 * below that timeout so a genuinely dead engine still surfaces promptly.
 */
const CONTEXT_SYNC_WAIT_MS = 3000;
/** Poll interval while waiting for in-flight context-item syncs to arrive. */
const CONTEXT_SYNC_POLL_MS = 100;
import contextItemRegistry from '../registries/context-item-registry.js';
import { FormattingHelpers } from '../../sdk/lib/formatting-helpers.js';
import { generateToolDefinitions, resolveToolName } from '../services/tool-generator.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { buildApprovalButtons } from '../services/approval-options.js';
import { assembleSystemPrompt, systemPositionItems as systemPositionItemsOf } from '../services/system-prompt-builder.js';
import { buildExtensionSystemPromptContributions } from '../services/extensions.js';

/**
 * Format tool input for display in approval dialog.
 * @param {Record<string, unknown>} toolInput - Tool input parameters
 * @returns {string} Formatted string
 */
function formatToolInput(toolInput) {
  if ('command' in toolInput && toolInput.command) {
    return String(toolInput.command);
  }
  if ('path' in toolInput && toolInput.path) {
    return String(toolInput.path);
  }
  return JSON.stringify(toolInput, null, 2);
}

/**
 * Update tool-action in Yjs with approval options.
 * @param {any} conv - Conversation
 * @param {string} toolUseId - Tool use ID
 * @param {object} approvalOptions - Approval options
 */
function updateToolActionApprovalOptions(conv, toolUseId, approvalOptions) {
  const messageThread = conv.findMessageThreadForToolUse(toolUseId);
  if (!messageThread) {
    console.warn(`[Session] Could not find tool-action ${toolUseId} to update approval options`);
    return;
  }
  // Find the index of this tool-action within its context
  const items = messageThread.items;
  for (let i = 0; i < items.length; i++) {
    if (items[i].get('type') === 'tool-action' && items[i].get('toolUseId') === toolUseId) {
      messageThread.updateItemField(i, 'approvalOptions', approvalOptions);
      return;
    }
  }
  console.warn(`[Session] Could not find tool-action ${toolUseId} to update approval options`);
}

/**
 * The one-shot Allow / Deny option set — a fresh array each call. Used on
 * fallback paths where there is no owning plugin to define a meaningful "don't
 * ask again" choice (unknown tool, error building the UI), so the framework
 * offers only the one-shot decision.
 * @returns {Array<{label: string, value: string, style: string}>} A fresh option array
 */
function allowDenyOptions() {
  return [
    { label: 'Allow', value: 'yes', style: 'primary' },
    { label: 'Deny', value: 'no', style: 'secondary' }
  ];
}

/**
 * Shared approval-request handler for BOTH the engine and viewer roles. The
 * worker broadcasts an approval request to every client; each builds the
 * approval options from the owning action plugin (which runs on the main
 * thread) and writes them onto the tool-action in Yjs. The two roles need
 * identical logic, so it lives here once and the engine/viewer setups can't
 * drift apart.
 * @param {any} session - Session instance
 * @param {*} request - Approval request from the worker
 * @param {string} conversationId - Conversation the request targets
 * @returns {Promise<void>} Resolves once approval options are written (or the action is auto-approved)
 */
export async function handleApprovalRequest(session, request, conversationId) {
  /** @type {{toolUseId: string, toolName: string, toolInput: object, config?: object}} */
  const req = /** @type {*} */ (request);
  const conv = session.conversations.get(conversationId);

  if (!conv) {
    console.error(`[Session] Approval request for unknown conversation: ${conversationId}`);
    return;
  }

  try {
    const ActionClass = contextItemRegistry.getByToolName(req.toolName);
    if (!ActionClass) {
      console.warn(`[Session] No action class for tool ${req.toolName}`);
      updateToolActionApprovalOptions(conv, req.toolUseId, {
        title: `Approve: ${req.toolName}`,
        message: JSON.stringify(req.toolInput),
        options: allowDenyOptions()
      });
      return;
    }

    // Find the message thread containing this tool-action (fall back to root)
    const messageThread = conv.findMessageThreadForToolUse(req.toolUseId) || conv.rootMessageThread;

    /** @type {import('juggler/context-item').ItemContext} */
    const actionContext = {
      id: req.toolUseId,
      session,
      conversation: conv,
      messageThread,
      toolUseId: req.toolUseId,
      // Lets a multi-tool class (e.g. the MCP bridge) route validate/approval to
      // the invoked tool. Omitting it makes such a class validate with an empty
      // name and reject its own call.
      toolName: resolveToolName(req.toolName)
    };
    const action = new ActionClass(actionContext);

    const toolInput = /** @type {Record<string, unknown>} */ (req.toolInput);
    const validation = await action.validate(toolInput);
    if (!validation.valid) {
      updateToolActionApprovalOptions(conv, req.toolUseId, {
        title: `Invalid: ${action.getTitle()}`,
        message: validation.error || 'Invalid parameters',
        options: [{ label: 'Cancel', value: 'cancel', style: 'secondary' }]
      });
      return;
    }

    // Already permitted (wildcard patterns, write-file toggle, etc.) — auto-approve.
    if (action.isPermitted(toolInput)) {
      if (messageThread) {
        messageThread.resolveApproval(req.toolUseId, 'yes');
      }
      return;
    }

    const approvalConfig = await action.getApprovalConfig(validation.params || toolInput);
    updateToolActionApprovalOptions(conv, req.toolUseId, {
      title: approvalConfig?.title || action.getTitle(),
      message: approvalConfig?.message || formatToolInput(toolInput),
      options: approvalConfig?.options || buildApprovalButtons(action, validation.params || toolInput),
      display: approvalConfig?.display
    });
  } catch (error) {
    const errorMsg = extractErrorMessage(error);
    console.error(`[Session] Error building approval options for ${req.toolUseId}:`, errorMsg);
    updateToolActionApprovalOptions(conv, req.toolUseId, {
      title: req.toolName,
      message: 'Error building approval UI',
      options: allowDenyOptions()
    });
  }
}

/**
 * Install engine-role worker callbacks: context requests, tool definitions,
 * and approval requests. Idempotent w.r.t. the workerManager API — each
 * setter replaces any prior handler.
 * @param {any} session - Session instance
 */
export function setupWorkerCallbacks(session) {
  // Handle context requests from workers
  // Worker needs context text from context items (plugins on main thread)
  workerManager.setOnContextRequest(async (request, conversationId) => {
    /** @type {{requestId: string, itemIds?: string[], contextParams?: object}} */
    const req = /** @type {any} */ (request);
    const conv = session.conversations.get(conversationId);
    if (!conv) {
      // Context rendering is ENGINE-ONLY: this callback is the sole responder,
      // so it must ALWAYS reply. handleRenderContextItemsRequest already awaited
      // the engine's load of this conversation (loadAndFlush); if it's still
      // absent the load genuinely failed and waiting cannot help. Respond with
      // empty context so the turn proceeds degraded rather than leaving the
      // worker's reply channel unfed — an unanswered request wedges the turn for
      // the full 30s ContextTimeout and surfaces as
      // "Failed to get context/tools: context/tools request timed out".
      console.warn(`[ContextCallback] conv ${conversationId} not loaded (req=${req.requestId}); responding empty so the turn is not wedged`);
      workerManager.sendRenderContextItemsResponse(conversationId, req.requestId, [], '');
      return;
    }

    const requestedIds = req.itemIds || [];
    // Resolve requested-item presence across EVERY thread — a sub-thread turn
    // requests its own (and inherited) items, whose ids never live on root.
    // Message items aren't context items and are always skipped: both worker-
    // minted ids (`msg_TIMESTAMP_NUM`) and viewer-minted ids (`msg-TIMESTAMP-RANDOM`,
    // from conversation._nextItemId, e.g. a strategy-injected system-reminder).
    const isMessageId = (/** @type {string} */ id) => id.startsWith('msg_') || id.startsWith('msg-');
    const missingContextIds = () => {
      const localIds = new Set(
        conv.getAllMessageThreads().flatMap((/** @type {any} */ t) => t.contextItems).map((/** @type {any} */ f) => f.id)
      );
      return requestedIds.filter((/** @type {string} */ id) => !isMessageId(id) && !localIds.has(id));
    };

    // A requested item can be missing purely because its yjs-sync from the
    // worker is still in flight — the post-reload race: the app reloaded, the
    // engine is re-hydrating, and the item's sync hasn't landed yet. Wait
    // briefly, re-flushing batched syncs each tick, for it to arrive. We do NOT
    // bail: context is engine-only, so bailing wedges the turn (see above). After
    // the budget we render whatever HAS synced — the render loop below simply
    // skips any still-missing id, and it'll be present on the next turn.
    let missing = missingContextIds();
    if (missing.length > 0) {
      const deadline = Date.now() + CONTEXT_SYNC_WAIT_MS;
      while (missing.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, CONTEXT_SYNC_POLL_MS));
        /** @type {any} */ (conv)._doc?.flushPendingUpdates?.();
        missing = missingContextIds();
      }
      if (missing.length > 0) {
        console.warn(`[ContextCallback] conv ${conversationId} rendering without ${missing.length} not-yet-synced item(s) [${missing.join(', ')}] after ${CONTEXT_SYNC_WAIT_MS}ms (req=${req.requestId}); turn proceeds rather than wedging`);
      }
    }

    const allContextItems = conv.getAllMessageThreads().flatMap((/** @type {any} */ t) => t.contextItems);

    try {
      // Build proper contextParams with helpers
      const contextParams = {
        contextWindowSize: conv.contextWindow || DEFAULT_CONTEXT_WINDOW,
        modelConfig: conv.modelConfig || null,
        helpers: FormattingHelpers,
        ...(req.contextParams || {})
      };

      // Assemble the system prompt from the PROCESSING thread's own items. The
      // worker's GetContextItemIDsForThread already sent us exactly that
      // thread's item ids in req.itemIds (its own seeded system prompt +
      // agents/memory + tool-produced items); resolve them across all threads.
      // A root turn's req.itemIds is every root item, so this is identical to
      // the old root-only path there.
      const requested = (req.itemIds || [])
        .map((/** @type {string} */ id) => allContextItems.find((/** @type {any} */ f) => f.id === id))
        .filter(Boolean);
      // Sync-race fallback: a sub-thread's cloned system-prompt item is minted
      // worker-side and may not have synced to the frontend yet. If the
      // requested set carries no system-prompt item, degrade to root's items so
      // the turn still gets a system prompt rather than an empty identity. The
      // exclusion set below is derived from the SAME list, so content is never
      // double-sent or dropped.
      const hasSystemPrompt = requested.some((/** @type {any} */ f) => f.type === 'system-prompt');
      const contextItems = hasSystemPrompt ? requested : conv.rootMessageThread.contextItems;

      // Assemble the system prompt via the shared builder — the single source
      // of truth shared with context-builder.js prepare().
      const systemPositionItems = systemPositionItemsOf(contextItems);
      const extensionContributions = await buildExtensionSystemPromptContributions();
      const systemPrompt = await assembleSystemPrompt({
        contextItems,
        contextParams,
        extensionContributions
      });

      // Get context from each context item via the conversation
      // Only include non-system-position context items (system-position ones are in systemPrompt)
      /** @type {Array<{itemId: string, content: string, tokens: number}>} */
      const contexts = [];
      const itemIds = req.itemIds || [];

      // Create a set of system-position context item IDs to exclude
      const systemItemIds = new Set(systemPositionItems.map((/** @type {any} */ f) => f.id));

      for (const itemId of itemIds) {
        // Skip system-position context items - their content is already in systemPrompt
        if (systemItemIds.has(itemId)) continue;

        // Resolve the item across all threads — a sub-thread turn's requested
        // ids include items that live on the sub-thread, not root.
        const item = allContextItems.find((/** @type {any} */ f) => f.id === itemId);
        if (item && typeof item.getContextText === 'function') {
          // getContextText is async
          const text = await item.getContextText(contextParams);
          // Estimate tokens (rough: 4 chars per token)
          const tokens = Math.ceil((text || '').length / 4);
          contexts.push({ itemId, content: text || '', tokens });
        }
      }

      workerManager.sendRenderContextItemsResponse(conversationId, req.requestId, contexts, systemPrompt);
    } catch (error) {
      console.error(`[Session] Error getting context for ${conversationId}:`, error);
      workerManager.sendRenderContextItemsResponse(conversationId, req.requestId, [], '');
    }
  });

  // DOCUMENT-DRIVEN FLOW: the worker creates tool-action items in the doc; the
  // frontend observes them via the Yjs observer and executes once approved.
  // There is deliberately no tool-execution message handler here.

  // Handle tool definitions requests from workers
  workerManager.setOnToolsRequest(async (request, conversationId) => {
    /** @type {{requestId: string}} */
    const req = /** @type {*} */ (request);

    try {
      let tools = await generateToolDefinitions();

      // Let the active strategy filter tools (e.g., plan strategy restricts to read-only during planning)
      const conv = session.conversations.get(conversationId);
      const strategy = conv?.rootMessageThread?.strategy;
      if (strategy?.filterTools) {
        tools = /** @type {typeof tools} */ (strategy.filterTools(tools));
      }

      workerManager.sendToolsResult(conversationId, req.requestId, tools);
    } catch (error) {
      console.error(`[Session] Error generating tools for ${conversationId}:`, error);
      workerManager.sendToolsResult(conversationId, req.requestId, []);
    }
  });

  // Handle subthread-spec build requests from workers (engine-only). For a
  // delegatesToSubthread tool call, instantiate the owning item, run
  // validate + buildSubthreadSpec, and reply with the spec (or null → the
  // worker runs the ordinary client-side tool-action).
  workerManager.setOnSubthreadSpecRequest(async (request, conversationId) => {
    /** @type {{requestId: string, toolUseId: string, toolName: string, toolInput?: Record<string, unknown>}} */
    const req = /** @type {*} */ (request);
    const conv = session.conversations.get(conversationId);
    // Engine-targeted (never broadcast), so replying null on a missing/failed
    // conversation is safe and fast — the worker falls back to normal execution
    // rather than stalling until the round-trip times out.
    if (!conv) {
      workerManager.sendBuildSubthreadSpecResponse(conversationId, req.requestId, null);
      return;
    }
    try {
      const ItemClass = contextItemRegistry.getByToolName(req.toolName);
      if (!ItemClass) {
        workerManager.sendBuildSubthreadSpecResponse(conversationId, req.requestId, null);
        return;
      }
      const messageThread = conv.findMessageThreadForToolUse(req.toolUseId) || conv.rootMessageThread;
      /** @type {import('juggler/context-item').ItemContext} */
      const itemContext = {
        id: req.toolUseId,
        session,
        conversation: conv,
        messageThread,
        toolUseId: req.toolUseId,
        // Lets a multi-tool class route validate/buildSubthreadSpec to the
        // invoked tool (see the approval handler above).
        toolName: resolveToolName(req.toolName)
      };
      const item = new (/** @type {any} */ (ItemClass))(itemContext);
      const toolInput = /** @type {Record<string, unknown>} */ (req.toolInput || {});
      const validation = await item.validate(toolInput);
      if (!validation.valid) {
        // Invalid input: don't delegate — let the normal tool path surface the
        // validation error to the LLM.
        workerManager.sendBuildSubthreadSpecResponse(conversationId, req.requestId, null);
        return;
      }
      const spec = await item.buildSubthreadSpec(validation.params || toolInput, {
        conversation: conv,
        session,
        signal: item.signal
      });
      workerManager.sendBuildSubthreadSpecResponse(conversationId, req.requestId, spec || null);
    } catch (error) {
      const errorMsg = extractErrorMessage(error);
      console.error(`[Session] Error building subthread spec for ${req.toolName}:`, errorMsg);
      workerManager.sendBuildSubthreadSpecResponse(conversationId, req.requestId, null, errorMsg);
    }
  });

  // Handle subthread-error fallback requests from workers (engine-only). When a
  // delegated child ended without a result, give the owning tool a chance to
  // degrade gracefully via onSubthreadError; reply with the fallback text (or
  // '' → the worker writes a default error result).
  workerManager.setOnSubthreadErrorRequest(async (request, conversationId) => {
    /** @type {{requestId: string, toolName: string, toolInput?: Record<string, unknown>, reason?: string}} */
    const req = /** @type {*} */ (request);
    const conv = session.conversations.get(conversationId);
    if (!conv) {
      workerManager.sendSubthreadErrorResponse(conversationId, req.requestId, '');
      return;
    }
    try {
      const ItemClass = contextItemRegistry.getByToolName(req.toolName);
      if (!ItemClass) {
        workerManager.sendSubthreadErrorResponse(conversationId, req.requestId, '');
        return;
      }
      /** @type {import('juggler/context-item').ItemContext} */
      const itemContext = {
        id: req.requestId,
        session,
        conversation: conv,
        messageThread: conv.rootMessageThread,
        // Lets a multi-tool class route onSubthreadError to the invoked tool.
        toolName: resolveToolName(req.toolName)
      };
      const item = new (/** @type {any} */ (ItemClass))(itemContext);
      if (typeof item.onSubthreadError !== 'function') {
        workerManager.sendSubthreadErrorResponse(conversationId, req.requestId, '');
        return;
      }
      const error = new Error(req.reason || 'the delegated sub-agent failed');
      const fallback = await item.onSubthreadError(error, /** @type {Record<string, unknown>} */ (req.toolInput || {}));
      const result = fallback && typeof fallback.result === 'string' ? fallback.result : '';
      workerManager.sendSubthreadErrorResponse(conversationId, req.requestId, result);
    } catch (error) {
      console.error(`[Session] Error running onSubthreadError for ${req.toolName}:`, extractErrorMessage(error));
      workerManager.sendSubthreadErrorResponse(conversationId, req.requestId, '');
    }
  });

  // Handle approval requests from workers (shared engine/viewer logic).
  // Worker needs approval options from action plugins (which run on main thread).
  workerManager.setOnApprovalRequest((request, conversationId) =>
    handleApprovalRequest(session, request, conversationId));
}

/**
 * Install viewer-role worker callbacks. Viewer only handles approval
 * requests — context rendering and tool definitions are owned by the engine.
 * @param {any} session - Session instance
 */
export function setupViewerWorkerCallbacks(session) {
  // Same approval logic as the engine role — shared so the two can't drift.
  workerManager.setOnApprovalRequest((request, conversationId) =>
    handleApprovalRequest(session, request, conversationId));
}
