//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Test Helpers - Shared infrastructure for framework-level tests
 *
 * These helpers enable end-to-end testing of the FULL framework pipeline:
 * Tool execution → ContextBuilder → messages
 *
 * Tests directly invoke tool execution, bypassing LLM round-trips.
 * The Go worker handles LLM calls directly via LLMCallFunc.
 * @module unit-tests/test-helpers
 */

import contextItemRegistry from '../../js/registries/context-item-registry.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import { markRegistriesReady } from '../../js/registries/registry-ready.js';
import { registerItemOwnedStrategies } from '../../js/registries/reload-registries.js';
import { ContextBuilder } from '../../js/services/context-builder.js';
import {
  createToolActionMessage,
  createUserMessage,
  isToolResultMessage,
  isToolUseMessage,
  isToolActionMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
import workerManager from '../../js/services/worker-manager.js';
import { plainToYMap } from '../../js/model/item-accessor.js';
import toolExecutor from '../../js/services/tool-executor.js';
import { closeAllPopups, __resetPopupManagerForTests } from '../../js/utils/popup-manager.js';
import { noteProjectSize } from './project-size.js';
import { forgetOwnConversation } from './conversation-claims.js';
import { pollPatiently, racePatiently, whyGivingUp } from './test-patience.js';


/**
 * @typedef {import('../../model/session.js').default} Session
 * @typedef {import('../../model/conversation.js').default} Conversation
 * @typedef {import('../../services/response-handler.js').default} ResponseHandler
 * @typedef {import('../../model/message.js').Message} Message
 */

/**
 * @typedef {object} FrameworkTestContext
 * @property {Session} session - Session instance
 * @property {Conversation} conversation - Conversation instance
 * @property {ResponseHandler} responseHandler - Response handler for tool execution
 * @property {string} fixtureDir - Path to fixture directory
 * @property {function(string): Promise<string>} readFile - Read file helper
 */

/**
 * Initialize all registries (context items, actions, strategies)
 * Should be called once at the start of tests.
 * @returns {Promise<void>}
 */
export async function initializeRegistries() {
  if (!contextItemRegistry.isInitialized()) {
    await contextItemRegistry.init();
  }
  if (!strategyRegistry.isInitialized()) {
    await strategyRegistry.init();
  }
  // Context items may own (hidden) strategies of their own — the sub-agent
  // pattern. Production runs this pass inside initAllRegistries(); this harness
  // inits the two registries by hand, so it has to run it too or a sub-agent's
  // strategy is simply missing under test.
  registerItemOwnedStrategies();
  // The unit harness initializes registries directly (not via app.js /
  // engine-app.js / reload-registries.js), so it must also flip the
  // registries-ready signal. Without this, buildExtensionSystemPromptContributions
  // awaits whenRegistriesReady() forever and any system-prompt assembly
  // (buildContext, extension-system-prompt) hangs to the test timeout.
  markRegistriesReady();
}

/**
 * Create mock services for headless testing (no UI needed)
 * @returns {Promise<import('../../model/session.js').ConversationServices>} Mock services object
 */
async function createMockServices() {
  const { default: LLMState } = await import('../../js/services/llm-state.js');
  const { default: realActionExecutor } = await import('../../js/services/action-executor.js');

  return /** @type {any} */ ({
    llmState: new LLMState(),
    animationService: {
      observeHeight: () => {},
      unobserveHeight: () => {},
      observeScrollPosition: () => {},
      animateThinking: () => {},
      stopThinking: () => {}
    },
    actionExecutor: realActionExecutor,
    wsService: createMockWebSocketService()
  });
}

/**
 * A stand-in for the WebSocket service that actually remembers what subscribed
 * to it, so a test can deliver the server broadcast a behaviour is built on
 * (`workspaces-changed`, `providers-update`, …) and watch what it does.
 *
 * No socket is involved: `emit` is the test playing the server's part. Nothing
 * else emits, so a suite that never calls it sees exactly the silence the old
 * no-op stub gave it.
 * @returns {{sendCancel: () => void, on: (type: string, cb: Function) => void, off: (type: string, cb: Function) => void, emit: (type: string, data?: any) => void}} The stub
 */
function createMockWebSocketService() {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  return {
    sendCancel: () => {},
    on: (type, cb) => {
      let set = handlers.get(type);
      if (!set) handlers.set(type, set = new Set());
      set.add(cb);
    },
    off: (type, cb) => { handlers.get(type)?.delete(cb); },
    emit: (type, data) => {
      for (const cb of handlers.get(type) || []) cb(data);
    }
  };
}

/**
 * Every Session a unit test has built and not yet destroyed.
 *
 * A lane page is never reloaded between the tests of a suite, so a Session
 * left alive is left alive for the rest of the lane's life — and it is not
 * cheap company. Session.load() builds a stub Conversation, and in time a
 * hydrated Yjs doc, for EVERY conversation in the pool's shared project, so
 * one undestroyed Session retains a document per sibling lane's work, not
 * just its own. Across a suite run that is the difference between a lane
 * holding tens of megabytes and holding hundreds.
 *
 * Integration tests are covered by runIntegrationTest's finally{}, which
 * tears its harness down. Unit suites have no such per-test frame, so they
 * register here instead and the suite runner sweeps the survivors.
 * @type {Set<Session>}
 */
const trackedTestSessions = new Set();

/**
 * Put a Session under the suite-end sweep. Sessions from createTestSession
 * are tracked already; this is for tests that construct their own.
 * @param {Session} session - Session to track
 * @returns {Session} The same session, for chaining
 */
export function trackTestSession(session) {
  trackedTestSessions.add(session);
  return session;
}

/**
 * Destroy every tracked Session still alive and empty the registry. Session
 * destroy() is idempotent, so sweeping one a test already tore down is a
 * no-op. Best-effort per session: one that throws must not strand the rest.
 * @returns {void}
 */
export function destroyTrackedTestSessions() {
  for (const session of trackedTestSessions) {
    try {
      session.destroy();
    } catch (err) {
      console.error('[test-helpers] session sweep failed:', err);
    }
  }
  trackedTestSessions.clear();
}

/**
 * Return the shared unit-test realm to "nothing is overlaying the page".
 *
 * Two things can outlive a suite, and only one of them is an element.
 *
 * `<modal-dialog>` is a reused singleton: close(null) removes the
 * `show`/`is-notice` classes, releases its popup-manager token, clears the
 * notice timer and resolves any pending promise; removing the element then
 * guarantees the next showConfirm/showAlert recreates a pristine one.
 *
 * The open-state token is the other, and it is the one that bites. It lives in
 * the popup manager rather than in the DOM, so no amount of tidying elements
 * reaches it — and `suppressedByOverlay()` reads it, which means a single stray
 * token silently disables every keyboard shortcut for the rest of the lane. A
 * suite the harness abandons at its 45s timeout never runs its own cleanup, so
 * this is the only thing that will.
 *
 * Best-effort throughout — a throw here must never mask the suite's own result.
 * @returns {void}
 */
export function neutralizeStrayOverlays() {
  document.querySelectorAll('modal-dialog').forEach((modal) => {
    try {
      const m = /** @type {any} */ (modal);
      if (typeof m.close === 'function') m.close(null);
    } catch (_) { /* ignore — fall through to removal */ }
    modal.classList.remove('show');
    modal.remove();
  });

  // Dismiss by the app's own route first, so each surface tears itself down as
  // it would on Escape and leaves no overlay behind on <body>.
  try {
    closeAllPopups();
  } catch (err) {
    console.error('[test-helpers] popup sweep failed:', err);
  }
  // Then the backstop, for a token no handler can release: an id-less
  // markPopupOpen that registered no onClose, or a surface whose element a
  // suite tore out from under it without going through close().
  __resetPopupManagerForTests();
}

/**
 * A probe document wearing the app's stylesheets, at a chosen viewport width.
 *
 * Some rules can only be measured at a width the test page itself never has —
 * the phone breakpoints, in practice, since a lane is wider than 36rem. A child
 * iframe narrow enough to match the query, linking the same sheets as its
 * parent, is the only place `getComputedStyle` will report them.
 *
 * It resolves once every sheet has arrived, counted rather than named: a sheet
 * that fails to load contributes no entry to `styleSheets`, so an equal count
 * means all of them applied. Naming one instead stops waiting the day that
 * sheet is renamed or split, and measures an unstyled document — which reads
 * every geometry as `auto` and quietly satisfies whatever it was asked.
 * @param {number} width - The frame's width in px.
 * @param {number} [height] - The frame's height in px.
 * @param {number} [timeout] - How long to wait for the sheets, in ms.
 * @returns {Promise<{doc: Document, frame: HTMLIFrameElement}>} The probe document, and the frame to remove when done with it.
 */
export async function styledProbeFrame(width, height = 600, timeout = 4000) {
  const frame = document.createElement('iframe');
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;border:0`;
  document.body.appendChild(frame);
  const doc = /** @type {Document} */ (frame.contentDocument);
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .map((l) => l.outerHTML).join('');
  doc.open();
  doc.write(`<!doctype html><html><head>${links}</head><body style="margin:0"></body></html>`);
  doc.close();

  const wanted = doc.querySelectorAll('link[rel="stylesheet"]').length;
  const loaded = await pollPatiently(() => doc.styleSheets.length >= wanted,
    { nominalMs: timeout, intervalMs: 20 });
  // Say so rather than measuring on: without the sheets every geometry
  // assertion reads `auto`, and reports a layout mismatch for what is really
  // a stylesheet that never arrived.
  if (!loaded) {
    throw new Error(`the probe document loaded ${doc.styleSheets.length} of its ${wanted} stylesheets — ${await whyGivingUp()}`);
  }
  return { doc, frame };
}

/**
 * Create a test session.
 * Loads an existing session created by UnitTestExecutor.
 * @returns {Promise<Session>} Session instance
 */
export async function createTestSession() {
  const apiServiceModule = await import('../../js/services/api.js');
  const apiService = apiServiceModule.default;
  const SessionModule = await import('../../js/model/session.js');
  const Session = SessionModule.default;

  const session = trackTestSession(new Session(/** @type {any} */ (apiService)));

  // Set up mock services (no UI for tests)
  const services = await createMockServices();
  session.setServices(services);

  // Load session data from backend
  await session.load();

  // Record the size of the shared project this load saw, so a failure later in
  // the lane can report the trajectory as well as the size at the failure.
  noteProjectSize(session.conversations.size);

  // The failure trace reports which conversation this lane had visible. It reads
  // the session from here, so a lane that never publishes one reports "none"
  // whatever it was actually looking at.
  /** @type {any} */ (window).__sessionForTests = session;

  return session;
}

/**
 * Create a test conversation in the session.
 * Sets up permissions for headless execution (auto-approve actions).
 * Spawns a worker and waits for it to be ready.
 * @param {Session} session - Session instance
 * @returns {Promise<Conversation>} Conversation instance (worker operations synced via Yjs)
 */
export async function createTestConversation(session) {
  const convId = await session.createConversation('');
  const conversation = session.conversations.get(convId);

  if (!conversation) {
    throw new Error('Failed to create conversation');
  }

  // Set a default model configuration for worker validation
  // Worker requires a model to be configured before processing messages
  await conversation.setModelConfig({ provider: 'test-provider', model: 'test-model' });

  // Set visible conversation for the session
  session._setSelection({ kind: 'conversation', id: convId });

  // Enable write permission for write-file operations
  conversation.rootMessageThread.addRule('write-file', { kind: 'boolean', value: true });

  // Auto-approve all tools (approval-flow tests use createApprovalTestConversation instead)
  conversation.setAutoApprove(true);
  // Conversation-scoped: a session-scoped blanket grant would leak into every
  // other lane's shared session metadata and auto-approve their pending tools.
  conversation.rootMessageThread.addRule('execute', { kind: 'glob', value: '*', scope: 'conversation' });

  // Wait for worker to be ready (session.createConversation spawns a worker)
  await waitForWorkerReady(convId);

  return conversation;
}

/**
 * Release a conversation a test created: tear it down in this lane, then
 * delete it from the shared project.
 *
 * A conversation kept until the suite-end sweep is not free company. Every lane
 * in the pool loads the SAME project, and Session.load() builds a stub — and in
 * time a hydrated Yjs doc — for every conversation in it. A suite that creates
 * one per case and holds them all therefore raises what every sibling lane's
 * load costs, for as long as it runs. A case that is finished with its
 * conversation says so here.
 *
 * Local teardown first (releaseConversation cancels the load, destroys the
 * worker and drops the map entry) so the folder is free before the backend
 * removes it — the order Session.deleteConversation uses. The delete is
 * permanent: binning would fill the bin over a run and nothing restores it.
 * @param {Session} session - Session that owns the conversation
 * @param {string} conversationId - Conversation to release
 * @param {string} reason - Attribution tag the server logs with the delete
 * @returns {Promise<void>}
 */
export async function releaseTestConversation(session, conversationId, reason) {
  const apiService = (await import('../../js/services/api.js')).default;
  await session.releaseConversation(conversationId);
  try {
    await apiService.deleteConversation(conversationId, { permanent: true, reason });
  } catch (err) {
    console.error(`[test-helpers] Couldn't delete ${conversationId}:`, err);
  }
  forgetOwnConversation(conversationId);
}

/**
 * Wait for a worker to be ready
 * @param {string} conversationId - Conversation ID
 * @param {number} [timeout=2000] - Timeout in ms
 * @returns {Promise<void>}
 */
// Worker startup is an async settle that takes variable time under the
// multi-iframe pool's load — not a race that a short timeout would expose. Wait
// up to the per-test budget (the runner's per-test hard timeout is the real
// fail-fast and aborts the whole test if the worker never comes up) so a
// slow-but-starting worker isn't declared dead at 2s under load. Kept at/under
// that budget so this poll loop can't outlive an aborted test and pile load
// onto the next one.
export async function waitForWorkerReady(conversationId, timeout = 10000) {
  const ready = await pollPatiently(() => workerManager.isWorkerReady(conversationId),
    { nominalMs: timeout, intervalMs: 50 });
  if (ready) return;
  throw new Error(`Worker not ready after ${timeout}ms for ${conversationId} — ${await whyGivingUp()}`);
}

// getProxy() removed - tests use conversation directly

/**
 * Get the ResponseHandler for a conversation
 * @param {Conversation} conversation - Conversation instance
 * @returns {ResponseHandler} Response handler
 */
export function getResponseHandler(conversation) {
  // @ts-ignore - Access private member for testing
  return conversation._responseHandler;
}

/**
 * Build LLM context from an message thread
 * Returns the messages that would be sent to the LLM on the next turn.
 * Uses production ContextBuilder - context item content syncing is handled by worker's syncContextItemContent().
 * @param {import('../../model/message-thread.js').default} messageThread - Message thread
 * @param {Session} session - Session instance
 * @returns {Promise<{systemPrompt: string|null, messages: Message[]}>} Prepared context
 */
export async function buildContext(messageThread, session) {
  const contextWindow = messageThread.conversation.contextWindow || 200000;
  const builder = new ContextBuilder({ messageThread, session, contextWindow });
  return await builder.prepare();
}

/**
 * Find a tool-result message in context by tool use ID
 * @param {Message[]} messages - Context messages
 * @param {string} toolUseId - Tool use ID to find
 * @returns {import('../../model/message.js').ToolResultMessage|undefined} The tool-result message or undefined
 */
export function findToolResult(messages, toolUseId) {
  return /** @type {import('../../model/message.js').ToolResultMessage|undefined} */ (
    messages.find(m => isToolResultMessage(m) && m.toolUseId === toolUseId)
  );
}

/**
 * Find a tool-use message in context by tool use ID
 * @param {Message[]} messages - Context messages
 * @param {string} toolUseId - Tool use ID to find
 * @returns {import('../../model/message.js').ToolUseMessage|undefined} The tool-use message or undefined
 */
export function findToolUse(messages, toolUseId) {
  return /** @type {import('../../model/message.js').ToolUseMessage|undefined} */ (
    messages.find(m => isToolUseMessage(m) && m.toolUseId === toolUseId)
  );
}

/**
 * Find a context item message by item ID (UI marker only - no content)
 * @param {Message[]} messages - Context messages
 * @param {string} itemId - Context item ID to find
 * @returns {import('../../model/message.js').ContextItemMessage|undefined} The context item message or undefined
 */
export function findContextItemMessage(messages, itemId) {
  return /** @type {import('../../model/message.js').ContextItemMessage|undefined} */ (
    messages.find(m => /** @type {any} */ (m).itemId === itemId)
  );
}

/**
 * Find a tool-result message that contains context item content (by contextItemId)
 * With the new architecture, context item content is rendered in tool-results.
 * @param {Message[]} messages - Context messages
 * @param {string} itemId - Context item ID to find
 * @returns {import('../../model/message.js').ToolResultMessage|undefined} The tool-result or undefined
 */
export function findContextItemToolResult(messages, itemId) {
  return /** @type {import('../../model/message.js').ToolResultMessage|undefined} */ (
    messages.find(m => isToolResultMessage(m) && m.contextItemId === itemId)
  );
}

/**
 * Create a mock tool call (simulating what LLM would send)
 * @param {string} toolName - Tool name (e.g., 'write_file', 'read_file')
 * @param {Record<string, unknown>} input - Tool input parameters
 * @param {string} [id] - Optional tool use ID (auto-generated if not provided)
 * @returns {{id: string, name: string, input: Record<string, unknown>}} Tool call object
 */
export function createToolCall(toolName, input, id) {
  return {
    id: id || `call_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    name: toolName,
    input
  };
}

/**
 * Execute tool calls directly via ToolExecutor and get context.
 * Bypasses LLM round-trips - Go worker handles LLM calls via LLMCallFunc.
 * Flow: toolExecutor.executeToolCall() → items updated → ContextBuilder → messages
 * @param {Conversation} conversation - Conversation instance
 * @param {Session} session - Session instance
 * @param {Array<{id: string, name: string, input: Record<string, unknown>}>} toolCalls - Tool calls to execute
 * @returns {Promise<{outcomes: Array<{toolName: string, success: boolean, result?: any, error?: string, resultStatus: string}>, context: {systemPrompt: string|null, messages: Message[]}}>} Tool outcomes and context
 */
export async function executeToolsAndGetContext(conversation, session, toolCalls) {
  // Add user message (normally added by conversation when user sends message)
  conversation.rootMessageThread.addEvent(createUserMessage('Execute the tools'));

  // Create tool-action messages pre-set to COMPLETED — a terminal state that
  // every reducer rests on — so nothing else in the system executes them;
  // toolExecutor.executeToolCall below is the single executor and overwrites
  // the state with the real outcome. RUNNING is NOT safe here even though it
  // also suppresses the insert observer: this conversation syncs to the
  // shared engine, whose auto-load ends with recoverStalledTools(), and a
  // RUNNING tool with no result is — by production's engine-is-sole-executor
  // invariant — definitionally stalled, so the engine resets it to APPROVED
  // and executes it itself. That double execution raced this helper's direct
  // execution for years as the intermittent write/edit "Created file" vs
  // "Updated file" flake (whichever exec ran second found the file existing).
  for (const tc of toolCalls) {
    const toolActionMsg = createToolActionMessage({
      toolUseId: tc.id,
      toolName: tc.name,
      toolInput: tc.input,
      state: TOOL_STATES.COMPLETED
    });
    conversation.rootMessageThread.addEvent(toolActionMsg);
  }

  // Execute tools directly via ToolExecutor
  for (const tc of toolCalls) {
    const toolCall = { id: tc.id, name: tc.name, input: tc.input };
    const execPromise = toolExecutor.executeToolCall(toolCall, conversation._responseHandler, conversation.rootMessageThread);
    if (!await racePatiently(execPromise, 10000)) {
      throw new Error(`[${tc.name}] tool execution timeout (10s) — ${await whyGivingUp()}`);
    }
  }

  // Add assistant done message (normally added by strategy)
  conversation.rootMessageThread.addEvent({ type: 'assistant', content: 'Done.' });

  // Small delay for Yjs sync
  await new Promise(resolve => setTimeout(resolve, 100));

  // Build context from conversation state
  const rootThread = conversation.rootMessageThread;
  const context = await buildContext(rootThread, session);
  const outcomes = extractToolOutcomes([...conversation.rootItems], toolCalls);

  return { outcomes, context };
}

// buildContextFromProxy() removed - use buildContext() directly

/**
 * @typedef {object} ToolResultItem
 * @property {string} type - Item type
 * @property {string} toolUseId - Tool use ID
 * @property {string} content - Result content
 * @property {boolean} [isError] - Whether result is an error
 * @property {boolean} [cancelled] - Whether tool was cancelled
 */

/**
 * Extract tool outcomes from items.
 * Items contain tool-action messages (internal format), not tool-result messages (LLM context format).
 * @param {Array<object>} items - Proxy items
 * @param {Array<{id: string, name: string}>} toolCalls - Original tool calls
 * @returns {Array<{toolName: string, success: boolean, result?: string, error?: string, resultStatus: string}>} Outcomes
 */
function extractToolOutcomes(items, toolCalls) {
  return toolCalls.map(tc => {
    // Items contain tool-action messages with a nested result property
    const toolAction = /** @type {Message|undefined} */ (
      items.find(
        item => isToolActionMessage(/** @type {Message} */ (item)) &&
        /** @type {any} */ (item).get('toolUseId') === tc.id
      )
    );
    if (toolAction && toolAction.get('result')) {
      const result = toolAction.get('result');
      return {
        toolName: tc.name,
        success: !result.get('isError'),
        result: result.get('content'),
        error: result.get('isError') ? result.get('content') : undefined,
        resultStatus: result.get('cancelled') ? 'cancelled' : result.get('isError') ? 'error' : 'success'
      };
    }
    return {
      toolName: tc.name,
      success: false,
      error: 'No result found',
      resultStatus: 'error'
    };
  });
}

/**
 * Simple assertion helper
 * @param {boolean} condition - Condition to check
 * @param {string} message - Error message if condition is false
 */
export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}



/**
 * Extract essential fields from context messages for golden comparison.
 * Strips internal fields (id, timestamp, etc.) but keeps all LLM-visible content.
 * Normalizes dynamic IDs: toolUseId → $1, $2; contextItemId → $CI_1, $CI_2, etc.
 * Also normalizes context item IDs that appear within content strings (e.g., "=== PLAN_xxx ===").
 * @param {Message[]} messages - Raw context messages
 * @param {Array<{id: string, name: string, input: Record<string, unknown>}>} toolCalls - Tool calls for ID mapping
 * @returns {Array<Record<string, unknown>>} Normalized messages for comparison
 */
export function extractGoldenMessages(messages, toolCalls) {
  // Build ID map: original ID → $1, $2, etc. based on order in toolCalls
  /** @type {Map<string, string>} */
  const idMap = new Map();
  toolCalls.forEach((tc, i) => {
    idMap.set(tc.id, `$${i + 1}`);
  });

  // Build contextItemId map: original contextItemId → $CI_1, $CI_2, etc. based on order seen
  /** @type {Map<string, string>} */
  const contextItemIdMap = new Map();
  let contextItemCounter = 0;

  /**
   * Get normalized contextItemId, creating new mapping if needed
   * @param {string} contextItemId - Original contextItemId
   * @returns {string} Normalized contextItemId like $CI_1
   */
  const getNormalizedContextItemId = (contextItemId) => {
    if (!contextItemIdMap.has(contextItemId)) {
      contextItemCounter++;
      contextItemIdMap.set(contextItemId, `$CI_${contextItemCounter}`);
    }
    return /** @type {string} */ (contextItemIdMap.get(contextItemId));
  };

  /**
   * Normalize toolUseId, handling both regular tool IDs and synthetic UI-added context item IDs
   * @param {string} toolUseId - Original toolUseId
   * @param {string|undefined} contextItemId - Associated contextItemId if any
   * @returns {string} Normalized toolUseId
   */
  const getNormalizedToolUseId = (toolUseId, contextItemId) => {
    // Check regular tool ID map first
    if (idMap.has(toolUseId)) {
      return /** @type {string} */ (idMap.get(toolUseId));
    }

    // Handle synthetic UI-added context item IDs (format: "ui-ci-{contextItemId}")
    // Extract contextItemId from toolUseId if not provided (context-builder doesn't include contextItemId)
    if (toolUseId.startsWith('ui-ci-')) {
      const extractedContextItemId = contextItemId || toolUseId.replace('ui-ci-', '');
      return `ui-ci-${getNormalizedContextItemId(extractedContextItemId)}`;
    }

    return toolUseId;
  };

  /**
   * Normalize context item IDs within content strings.
   * Replaces patterns like "=== PLAN_xxx ===" with normalized IDs.
   * Must be called AFTER contextItemIdMap is fully populated.
   * @param {string} content - Content string to normalize
   * @returns {string} Content with context item IDs normalized
   */
  const normalizeContentContextItemIds = (content) => {
    if (!content) return content;
    let result = content;
    for (const [original, normalized] of contextItemIdMap.entries()) {
      // Escape special regex characters in the original ID
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), normalized);
    }
    return result;
  };

  // First pass: build the contextItemIdMap by processing all messages
  for (const msg of messages) {
    if (isToolUseMessage(msg)) {
      if (msg.toolUseId.startsWith('ui-ci-')) {
        const contextItemId = msg.toolUseId.replace('ui-ci-', '');
        getNormalizedContextItemId(contextItemId);
      }
    } else if (isToolResultMessage(msg)) {
      if (msg.contextItemId) {
        getNormalizedContextItemId(msg.contextItemId);
      }
    }
  }

  // Second pass: extract and normalize messages
  return messages.map(msg => {
    switch (msg.type) {
      case 'tool-use': {
        const m = /** @type {import('../../model/message.js').ToolUseMessage} */ (msg);
        // Handle synthetic UI-added context item IDs (format: "ui-ci-{contextItemId}")
        let normalizedToolUseId = idMap.get(m.toolUseId) || m.toolUseId;
        if (m.toolUseId.startsWith('ui-ci-')) {
          const contextItemId = m.toolUseId.replace('ui-ci-', '');
          normalizedToolUseId = `ui-ci-${getNormalizedContextItemId(contextItemId)}`;
        }
        return {
          type: 'tool-use',
          toolUseId: normalizedToolUseId,
          toolName: m.toolName,
          toolInput: m.toolInput
        };
      }
      case 'tool-result': {
        const m = /** @type {import('../../model/message.js').ToolResultMessage} */ (msg);
        const normalizedContextItemId = m.contextItemId ? getNormalizedContextItemId(m.contextItemId) : undefined;
        /** @type {Record<string, unknown>} */
        const result = {
          type: 'tool-result',
          toolUseId: getNormalizedToolUseId(m.toolUseId, m.contextItemId),
          content: normalizeContentContextItemIds(m.content || ''),
          isError: m.isError || false
        };
        if (normalizedContextItemId) {
          result.contextItemId = normalizedContextItemId;
        }
        return result;
      }
      case 'user':
      case 'assistant': {
        const m = /** @type {{type: string, content: string}} */ (msg);
        return {
          type: m.type,
          content: normalizeContentContextItemIds(m.content)
        };
      }
      case 'system-reminder': {
        const m = /** @type {{type: string, content: string}} */ (msg);
        return {
          type: 'system-reminder',
          content: normalizeContentContextItemIds(m.content)
        };
      }
      default:
        return { type: msg.type, _raw: msg };
    }
  });
}

/**
 * Assert context messages match expected golden array.
 * Compares full structure, not substrings. Shows clear diff on failure.
 * @param {{systemPrompt: string|null, messages: Message[]}} context - Actual context
 * @param {Array<Record<string, unknown>>} expectedMessages - Expected message array
 * @param {Array<{id: string, name: string, input: Record<string, unknown>}>} toolCalls - Tool calls for ID normalization
 * @param {string} testName - Test name for error reporting
 */
export function assertContextGolden(context, expectedMessages, toolCalls, testName) {
  const actual = extractGoldenMessages(context.messages, toolCalls);
  const actualJson = JSON.stringify(actual, null, 2);
  const expectedJson = JSON.stringify(expectedMessages, null, 2);

  if (actualJson !== expectedJson) {
    throw new Error(
      `[${testName}] Context mismatch!\n\n` +
			`=== EXPECTED ===\n${expectedJson}\n\n` +
			`=== ACTUAL ===\n${actualJson}\n\n` +
			`=== END ===`
    );
  }
}

// =============================================================================
// APPROVAL FLOW TEST HELPERS
// =============================================================================

/**
 * Create a test conversation WITHOUT auto-approve.
 * Use this for testing approval flows where we want to programmatically
 * resolve approvals rather than auto-approving everything.
 * @param {Session} session - Session instance
 * @returns {Promise<Conversation>} Conversation instance without auto-approve
 */
export async function createApprovalTestConversation(session) {
  const convId = await session.createConversation('');
  const conversation = session.conversations.get(convId);

  if (!conversation) {
    throw new Error('Failed to create conversation');
  }

  // Enable headless execution visibility
  session._setSelection({ kind: 'conversation', id: convId });

  // Set a default model configuration (required for worker validation)
  await conversation.setModelConfig({ provider: 'test-provider', model: 'test-model' });

  // DO NOT set auto-approve - we want to test the approval flow
  // But do set file write permission to avoid that layer of approval
  conversation.rootMessageThread.addRule('write-file', { kind: 'boolean', value: true });
  conversation.rootMessageThread.clearRules('execute');

  // Note: we intentionally do NOT call:
  // - conversation.rootMessageThread.addRule('execute', { kind: 'glob', value: '*' })
  // - conversation.setAutoApprove(true)
  // So that execute actions will require approval

  // Wait for worker to be ready (session.createConversation spawns a worker)
  await waitForWorkerReady(convId);

  return conversation;
}

/**
 * Execute a tool and wait for it to reach the approval-pending state.
 * Returns the execution promise and toolUseId for programmatic resolution.
 *
 * Usage:
 * ```
 * const { toolUseId, executionPromise } = await executeToolUntilApproval(conv, sess, toolCall);
 * // ... verify pending state ...
 * conversation.resolveApproval(toolUseId, 'yes');
 * await executionPromise;
 * // ... verify final state ...
 * ```
 * @param {Conversation} conversation - Conversation instance
 * @param {Session} _session - Session instance (unused but kept for API consistency)
 * @param {{id: string, name: string, input: Record<string, unknown>}} toolCall - Tool call to execute
 * @param {number} [timeoutMs=2000] - Timeout for waiting for pending state
 * @returns {Promise<{toolUseId: string, executionPromise: Promise<import('juggler/strategy-type').ToolOutcome[]>}>} The tool use ID and execution promise
 */
export async function executeToolUntilApproval(conversation, _session, toolCall, timeoutMs = 2000) {
  // The Yjs observer only processes REMOTE (non-local) transactions.
  // Locally inserted tool-actions are not auto-processed by handleNewToolAction.
  // So we must manually set state=PENDING and approvalOptions when inserting.

  // Build approval options via the action's prepare() path
  const ActionClass = /** @type {any} */ (contextItemRegistry.getByToolName(toolCall.name));
  let approvalOptions = null;
  if (ActionClass) {
    const action = new ActionClass({
      id: ActionClass.MANIFEST?.id || 'unknown',
      session: conversation._session,
      conversation,
      messageThread: conversation.rootMessageThread
    });
    try {
      const prepared = await action.prepare(toolCall.input);
      if (prepared.valid) {
        approvalOptions = getResponseHandler(conversation).buildApprovalOptions(action, prepared);
      }
    } catch {
      // fallback to minimal options
    }
  }
  if (!approvalOptions) {
    approvalOptions = {
      title: 'Approve action',
      message: '',
      options: [
        { label: 'Yes', value: 'yes', style: 'primary' },
        { label: 'No', value: 'no', style: 'secondary' }
      ]
    };
  }

  // Insert tool-action directly with state=PENDING and approvalOptions
  conversation.rootMessageThread.addEvent(createToolActionMessage({
    toolUseId: toolCall.id,
    toolName: toolCall.name,
    toolInput: toolCall.input,
    state: TOOL_STATES.PENDING,
    approvalOptions
  }));

  // State is already PENDING — verify (should be immediate)
  await waitForPendingApproval(conversation, toolCall.id, timeoutMs);

  // Call executeToolCalls — finds the PENDING item and waits for resolveApproval
  const responseHandler = getResponseHandler(conversation);
  const executionPromise = responseHandler.executeToolCalls([toolCall], conversation.rootMessageThread);

  return { toolUseId: toolCall.id, executionPromise };
}

/**
 * Wait for a tool-use or tool-action message to reach the pending approval state.
 * Polls conversation.rootItems until the message appears with state: 'pending'.
 * Handles both legacy tool-use format and new unified tool-action format.
 * @param {Conversation} conversation - Conversation instance
 * @param {string} toolUseId - Tool use ID to wait for
 * @param {number} [timeoutMs=2000] - Timeout in milliseconds
 * @returns {Promise<import('../../model/message.js').ToolActionMessage>} The pending message
 */
export async function waitForPendingApproval(conversation, toolUseId, timeoutMs = 2000) {
  const pending = await pollPatiently(() => {
    // Iterate items to find matching tool-action
    for (const item of conversation.rootItems) {
      // Check for tool-action with pending approval
      // Check for null OR undefined (Yjs sync may lose explicit null from Go)
      if (isToolActionMessage(/** @type {Message} */ (item))) {
        if (item.get('toolUseId') === toolUseId &&
					item.get('state') === TOOL_STATES.PENDING &&
					(item.get('result') === null || item.get('result') === undefined)) {
          return item;
        }
      }
    }
    return null;
  }, { nominalMs: timeoutMs });
  if (pending) return pending;
  throw new Error(`Timeout waiting for pending approval: ${toolUseId} — ${await whyGivingUp()}`);
}

/**
 * Poll `predicate` until it returns truthy, or throw once `timeoutMs` elapses.
 *
 * The deterministic replacement for fixed `setTimeout` sleeps used as sync
 * barriers. A hard-coded `await sleep(100)` gambles that 100ms is enough for
 * some async work to land — true on a fast dev machine, false on a slow or
 * contended CI runner, where the assertion then reads not-yet-settled state and
 * fails intermittently. Polling a real condition instead returns the instant the
 * work is actually visible (near-zero on fast machines) and stays patient up to
 * `timeoutMs` on slow ones, so the wait scales with the machine rather than a
 * guessed constant. Prefer this (or a domain-specific waiter like
 * {@link waitForPendingApproval}) over any load-bearing sleep.
 * `timeoutMs` deliberately does NOT ride the per-test deadline, though the
 * harness's own waits do. Making it ride the deadline was measured and reverted:
 * the browser suite went from 3 clean `test-all` runs in 3 to 1 in 3, losing a
 * different unit suite each time (`unit:pinboard`, `unit:popup-back-button`),
 * neither reproducible alone. No call site treats a timeout as an expected
 * outcome, so the cost was not extra waiting on a passing run — the suspicion is
 * that stretching the most-used wait in the suite reshuffles how a lane's work
 * interleaves with its two siblings'. Read the 2026-09-05 entry in
 * scratch/flaky-tests.md before giving this wait a bigger number again.
 *
 * What it does do is refuse to fail for a reason that isn't the code's fault:
 * reaching `timeoutMs` is not the end but a question, and a machine that was not
 * serving this lane buys another slice (`./test-patience.js`). On a quiet machine
 * that question is answered "no" and this behaves exactly as it always did,
 * failing on the nominal — which is what keeps the 2026-09-05 measurement from
 * applying to it.
 * @param {() => boolean} predicate - Condition to wait for; polled until truthy.
 * @param {{timeoutMs?: number, intervalMs?: number, description?: string}} [opts]
 * @returns {Promise<void>} Resolves when predicate is truthy; rejects on timeout.
 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10, description = 'condition' } = {}) {
  if (await pollPatiently(predicate, { nominalMs: timeoutMs, intervalMs })) return;
  throw new Error(`Timeout after ${timeoutMs}ms waiting for ${description} — ${await whyGivingUp()}`);
}

/**
 * Create an orphaned approval message for testing.
 * This simulates what happens after a page reload: a tool-use message with
 * state: 'pending' but no entry in _pendingApprovals Map.
 * @param {Conversation} conversation - Conversation to add the orphaned message to
 * @param {string} toolUseId - Tool use ID
 * @param {string} toolName - Tool name (e.g., 'execute')
 * @param {Record<string, unknown>} toolInput - Tool input parameters
 * @param {import('../../components/action-confirmation.js').ActionConfirmationOptions} approvalOptions - Approval options for UI
 * @returns {import('../../model/message.js').ToolActionMessage} The created orphaned message
 */
export function createOrphanedApproval(conversation, toolUseId, toolName, toolInput, approvalOptions) {
  const orphanedMsg = createToolActionMessage({
    toolUseId,
    toolName,
    toolInput,
    state: TOOL_STATES.PENDING,
    approvalOptions,
    result: null
  });

  const rootThread = conversation.rootMessageThread;
  rootThread.insertAt(rootThread.length, plainToYMap(orphanedMsg));

  // Note: we intentionally do NOT add to _pendingApprovals Map
  // This simulates the orphaned state after page reload

  return orphanedMsg;
}

/**
 * Helper to execute with timeout protection.
 * Wraps a promise with a timeout to prevent tests from hanging forever.
 * @template T
 * @param {Promise<T>} promise - Promise to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} description - Description for error message
 * @returns {Promise<T>} The promise result or throws on timeout
 */
export async function withTimeout(promise, timeoutMs, description) {
  const settled = await racePatiently(promise, timeoutMs);
  if (settled) return settled.value;
  throw new Error(`Timeout: ${description} (${timeoutMs}ms) — ${await whyGivingUp()}`);
}

// Re-export message factories for convenience in tests
export { createToolActionMessage };

