//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Worker-callback wiring for Session, engine role only: the handlers that
 * answer the worker's context, tool-definition and sub-thread-spec requests,
 * registered on workerManager. A viewer registers none — those requests are
 * broadcast, and the turn would run on whichever realm answered first.
 *
 * Approval options are not built here: the worker commands `evaluate-tool`,
 * and the engine's tool-call gate (model/conversation-tool-actions.js) writes
 * them onto the tool action.
 * @module model/session-worker-callbacks
 */

import workerManager from '../services/worker-manager.js';

/** Fallback context-window size when the model config hasn't reported one yet. */
const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * How long the conversation's document may go without a change before the
 * engine's context callback stops waiting for a requested context item whose
 * yjs-sync from the worker is still in flight (the post-reload race), and
 * renders without it. While syncs keep landing the item may be among them; once
 * the document has gone quiet this long it is not coming (see
 * {@link waitForSyncedItems}). Context rendering is ENGINE-ONLY, so this
 * callback is the sole responder and MUST always reply: a silent bail has no
 * other client to answer and leaves the worker's turn waiting until its
 * ceiling.
 */
const CONTEXT_SYNC_QUIET_MS = 3000;

/** The most the callback waits for in-flight items however busy the document. */
const CONTEXT_SYNC_CEILING_MS = 2 * 60_000;
import contextItemRegistry from '../registries/context-item-registry.js';
import { FormattingHelpers } from '../../sdk/lib/formatting-helpers.js';
import { resolveToolName } from '../services/tool-generator.js';
import { buildToolInventory } from '../services/thread-tool-inventory.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { assembleSystemPrompt, systemPositionItems as systemPositionItemsOf, contextPositionOf } from '../services/system-prompt-builder.js';
import { buildExtensionSystemPromptContributions } from '../services/extensions.js';
import { estimateTokens } from '../utils/token-estimate.js';

/**
 * Wait for requested context items still being synced into `conv`'s document.
 *
 * Bounded by the document, not the clock: the wait goes on while the document
 * keeps changing — syncs landing, any of which may carry the item — and ends
 * once it has been quiet for `quietMs`, or at `ceilingMs` however busy it is.
 * A fixed span left the item out of the model's context whenever a slow core
 * took longer than the span to apply the syncs in front of it.
 * @param {any} conv - The conversation (whenDocument and onDocumentChange).
 * @param {() => boolean} done - Whether every requested item is present.
 * @param {{quietMs: number, ceilingMs: number, now?: () => number}} opts - The quiet span, the ceiling, and the clock (a test's own).
 * @returns {Promise<boolean>} Whether they all arrived.
 */
export async function waitForSyncedItems(conv, done, { quietMs, ceilingMs, now = Date.now }) {
  const started = now();
  let lastChange = started;
  const off = conv.onDocumentChange(() => { lastChange = now(); });
  try {
    for (;;) {
      if (done()) return true;
      const quietLeft = quietMs - (now() - lastChange);
      const ceilingLeft = ceilingMs - (now() - started);
      if (quietLeft <= 0 || ceilingLeft <= 0) return false;
      if (await conv.whenDocument(done, Math.min(quietLeft, ceilingLeft))) return true;
    }
  } finally {
    off();
  }
}

/**
 * Install engine-role worker callbacks: context requests, tool definitions
 * and sub-thread specs. Idempotent w.r.t. the workerManager API — each
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
      // worker's reply channel unfed — an unanswered request leaves the turn
      // waiting until the worker's ceiling (ContextCeiling) and then fails it.
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
    // for it while syncs keep landing (waitForSyncedItems). We do NOT bail:
    // context is engine-only, so bailing wedges the turn (see above). Once the
    // document has gone quiet we render whatever HAS synced — the render loop
    // below simply skips any still-missing id, and it'll be present on the next
    // turn.
    if (missingContextIds().length > 0) {
      await waitForSyncedItems(conv, () => missingContextIds().length === 0,
        { quietMs: CONTEXT_SYNC_QUIET_MS, ceilingMs: CONTEXT_SYNC_CEILING_MS });
      const missing = missingContextIds();
      if (missing.length > 0) {
        console.warn(`[ContextCallback] conv ${conversationId} rendering without ${missing.length} not-yet-synced item(s) [${missing.join(', ')}] after the document went quiet for ${CONTEXT_SYNC_QUIET_MS}ms (req=${req.requestId}); turn proceeds rather than wedging`);
      }
    }

    const allContextItems = conv.getAllMessageThreads().flatMap((/** @type {any} */ t) => t.contextItems);

    try {
      // Build proper contextParams with helpers. `forRequest` marks this as the
      // dispatch path: an item that snapshots itself (a seeded agents file, an
      // @-mentioned file) freezes on the first render carrying this flag, so the
      // snapshot is taken when the model is handed it rather than when the item
      // was created or when someone happened to open the properties panel.
      const contextParams = {
        contextWindowSize: conv.contextWindow || DEFAULT_CONTEXT_WINDOW,
        modelConfig: conv.modelConfig || null,
        helpers: FormattingHelpers,
        forRequest: true,
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
      // of truth shared with the tests' context-builder.js prepare().
      const systemPositionItems = systemPositionItemsOf(contextItems);
      const extensionContributions = await buildExtensionSystemPromptContributions();
      const systemPrompt = await assembleSystemPrompt({
        contextItems,
        contextParams,
        extensionContributions
      });

      // Get context from each standing context item that contributes request
      // content — including @-mentioned and dropped files, which are ordinary
      // 'prefix' items (file-content-context-item.js), not history records. The
      // worker injects each at the position its item stands in the conversation,
      // inside the cached prefix. System-position items are excluded (their
      // content is already in systemPrompt); 'none' items are excluded (their
      // state lives in the model's own tool_use history, e.g. todo/plan).
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
          // 'none' items carry no request content.
          if (contextPositionOf(item) === 'none') continue;
          // getContextText is async
          const text = await item.getContextText(contextParams);
          const tokens = estimateTokens(text);
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
    /** @type {{requestId: string, threadItemId?: string}} */
    const req = /** @type {*} */ (request);

    try {
      // Let the strategy of the thread this turn belongs to filter the tools
      // (e.g. plan restricts to read-only while planning; a sub-agent is offered
      // only what its brief needs). Resolved per thread rather than from root,
      // because a sub-thread carries its own strategy: filtering its turn
      // through the root's would hand it tools its own strategy withholds, and
      // the approval gate — which resolves the OWNING thread (findThreadForTool
      // → handleNewToolAction) — would then be the only thing standing between
      // the sub-agent and a tool it was never meant to see.
      //
      // buildToolInventory is shared with the System Prompt panel's Tools
      // section, so what the user is shown is produced by the same call that
      // decides what to send.
      const conv = session.conversations.get(conversationId);
      const thread = req.threadItemId
        ? conv?.getAllMessageThreads?.().find((/** @type {any} */ mt) => mt.threadItemId === req.threadItemId)
        : conv?.rootMessageThread;
      const { offered } = await buildToolInventory(thread || conv?.rootMessageThread);

      workerManager.sendToolsResult(conversationId, req.requestId, offered);
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
}
