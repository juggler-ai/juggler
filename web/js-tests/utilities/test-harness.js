//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Test Harness
 *
 * Forces tests through real code paths by injecting mock LLM responses
 * into the Go worker and calling real conversation methods.
 *
 * This harness ensures:
 * - All code paths are exercised (sendMessage → worker → tools → Yjs)
 * - Only the LLM provider is mocked (everything else runs real code)
 * - Document state can be compared with golden data
 * @module integration/test-harness
 */

import workerManager from '../../js/services/worker-manager.js';
import wsService from '../../js/services/websocket.js';
import { TOOL_STATES } from '../../sdk/lib/message.js';
import { threadRunSettled } from '../../js/model/run-records.js';
import { waitForTurnComplete, observeUntil, findItemRecursive, hasIncompleteApprovedTools } from './turn-sync.js';
// Multi-iframe pool support: the integration-test-executor's BroadcastChannel
// receiver filters action-progress events by `conversationId` so sibling
// tests' tool runs don't pollute this iframe's exec counters, and destructive
// cross-lane operations treat claimed conversations as untouchable. Harnesses
// register every conversation they create so both hold.
import { registerOwnConversation as _registerOwnConversation } from './conversation-claims.js';
import { deadlineFor } from './test-deadline.js';


/**
 * @typedef {object} MockResponseBlock
 * @property {string} type - Block type: 'text', 'thinking', 'tool_use'
 * @property {string} [content] - Text content
 * @property {string} [text] - Text content (API format)
 * @property {string} [thinking] - Thinking content
 * @property {string} [toolUseId] - Tool use ID (for tool_use blocks)
 * @property {string} [toolName] - Tool name (for tool_use blocks)
 * @property {object} [toolInput] - Tool input parameters (for tool_use blocks)
 */

/**
 * @typedef {object} MockResponse
 * @property {MockResponseBlock[]} blocks - Response content blocks
 * @property {string} stopReason - Stop reason: 'end_turn', 'tool_use'
 * @property {number} [inputTokens] - Simulated input tokens
 * @property {boolean} [inputTokensApproximate] - Whether simulated input tokens are estimated
 * @property {number} [outputTokens] - Simulated output tokens
 * @property {number} [cachedTokens] - Simulated cached tokens
 * @property {boolean} [pauseBeforeReturn] - If true, the worker pauses after streaming chunks; tests must call releaseMock() to resume
 */

/**
/**
 * @typedef {object} TestHarnessOptions
 * @property {MockResponse[]} llmResponses - Scripted LLM responses
 * @property {string} fixture - Fixture name to use
 * @property {string} fixtureDir - Fixture directory path from test context
 * @property {boolean} [approvalFlow] - If true, use createApprovalTestConversation (no autoApprove)
 */

/**
 * Raw item from conversation (Y.Map)
 * @typedef {import('../../model/message.js').YMapItem & {type: string, toolUseId?: string, state?: string, result?: object}} RawItem
 */

/**
 * Integration test harness that exercises real code paths with mock LLM responses.
 */
export class IntegrationTestHarness {
  /**
   * @param {TestHarnessOptions} options - Test configuration
   */
  constructor(options) {
    /** @type {MockResponse[]} @private */
    this._llmResponses = options.llmResponses;

    /** @type {string} @private */
    this._fixture = options.fixture;

    /** @type {boolean} @private */
    this._approvalFlow = options.approvalFlow ?? false;

    /**
     * Absolute timestamp (Date.now()-based) of the per-test hard deadline,
     * set by the runner. In-test condition waits stay patient up to this
     * deadline instead of pre-empting it with their own shorter sub-timeout —
     * a slow-but-progressing op under machine load then completes, while the
     * per-test hard timeout remains the single fail-fast for a genuine hang.
     * 0 means "not set" (e.g. unit tests that drive the harness directly),
     * in which case the passed per-wait timeout is used unchanged.
     * @type {number} @private
     */
    this._perTestDeadlineMs = 0;

    /**
     * The deadline a wait should be bounded by: this test's own when the
     * runner set one, otherwise one derived from the deadline armed for the
     * suite in progress (see test-deadline.js). A unit suite drives this
     * harness directly and the runner sets nothing on it, which is how these
     * waits came to run on their nominal timeouts alone.
     * @param {number} fallbackMs - The wait's nominal timeout
     * @returns {number} A deadline, or 0 when the wait should use its nominal
     * @private
     */
    this._deadline = (fallbackMs) => deadlineFor(fallbackMs, this._perTestDeadlineMs);

    /**
     * Per-test AbortController signal, set by the runner. When the per-test
     * hard timeout fires it aborts; condition waits tear down their Yjs
     * observers immediately rather than lingering until their own (now
     * deadline-length) timeout, so a failing test can't leak observers past
     * the deadline and pile contention onto sibling lanes.
     * @type {AbortSignal|null} @private
     */
    this._abortSignal = null;

    /** @type {import('../../model/session.js').default|null} @private */
    this._session = null;

    /** @type {import('../../model/conversation.js').default|null} @private */
    this._conversation = null;

    /** @type {string} @private */
    this._fixtureDir = options.fixtureDir;

    /**
     * Map of all conversations (id -> conversation) for multi-conversation tests
     * @type {Map<string, import('../../model/conversation.js').default>}
     * @private
     */
    this._conversations = new Map();

    /**
     * Ordered list of conversation IDs for consistent $CONV_N mapping
     * @type {string[]}
     * @private
     */
    this._conversationOrder = [];

    /**
     * Tracks the next response index to inject into new conversations.
     * Each 'send-message' operation consumes one response from the current conversation's queue.
     * When creating a new conversation, we inject only the remaining responses.
     * @type {number}
     * @private
     */
    this._nextResponseIndex = 0;

    /**
     * Map of active progress captures (toolUseId -> {events, handler})
     * Used for streaming action tests.
     * @type {Map<string, {events: object[], handler: Function}>}
     * @private
     */
    this._progressCaptures = new Map();

    /**
     * Counter of toolExecutor.executeToolCall invocations keyed by toolUseId.
     * Installed on-demand via installToolExecCounter() and used to detect
     * observer re-entrancy bugs (the "rerun restart cascade").
     * @type {Map<string, number>}
     * @private
     */
    this._toolExecCounts = new Map();

    /**
     * BroadcastChannel subscription that increments _toolExecCounts when
     * the engine WebviewWindow posts a toolExecutor.executeToolCall start.
     * `null` when no subscription is installed.
     * @type {BroadcastChannel | null}
     * @private
     */
    this._toolExecChannel = null;

    /**
     * Spinner capture state: set by _startSpinnerCapture, read by _assertSpinnerWasVisible.
     * @type {{observed: boolean, visible: boolean, status: string|null, threadItemId: string|null}|null}
     * @private
     */
    this._spinnerCapture = null;
  }

  /**
   * Mark that a mock response has been consumed (e.g. by a send-message operation).
   * Used by the UI operation executor to track response index without accessing private state.
   */
  consumeResponse() {
    this._nextResponseIndex++;
  }

  /**
   * Get the root MessageThread for the current conversation.
   * @returns {import('../../model/message-thread.js').default} The root message thread
   */
  get rootThread() {
    if (!this._conversation) throw new Error('Conversation not initialized');
    return this._conversation.rootMessageThread;
  }

  /**
   * Set up the test environment.
   * Creates fixture, session, conversation, and injects mock responses.
   * @returns {Promise<void>}
   */
  async setup() {
    // Initialize registries if needed (contextItemRegistry = actionRegistry in unified registry)
    const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;
    const strategyRegistry = (await import('../../js/registries/strategy-registry.js')).default;

    if (!contextItemRegistry.isInitialized()) {
      await contextItemRegistry.init();
    }
    if (!strategyRegistry.isInitialized()) {
      await strategyRegistry.init();
    }

    // Create session using test helpers pattern (skip if pre-created)
    const { createTestSession, createTestConversation, createApprovalTestConversation } = await import('./test-helpers.js');

    this._session = await createTestSession();
    this._conversation = this._approvalFlow
      ? await createApprovalTestConversation(this._session)
      : await createTestConversation(this._session);

    // Track the initial conversation
    this._conversations.set(this._conversation.id, this._conversation);
    this._conversationOrder.push(this._conversation.id);
    _registerOwnConversation(this._conversation.id);

    // Inject mock responses into worker
    await this._injectMockResponses(this._llmResponses);
  }

  /**
   * Inject mock LLM responses into the Go worker.
   * @param {MockResponse[]} responses - Mock responses to inject
   * @param {number} [startIndex=0] - Index to start from (for skipping already-consumed responses)
   * @private
   */
  async _injectMockResponses(responses, startIndex = 0) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    // Inject only responses from startIndex onwards
    const remainingResponses = responses.slice(startIndex);
    console.error(`[ESSENTIAL] [MOCK] Injecting ${remainingResponses.length} responses (total=${responses.length}, startIndex=${startIndex}) for ${this._conversation.id}`);
    await workerManager.setMockResponses(this._conversation.id, remainingResponses);
  }

  /**
   * Send a message to the conversation and wait for completion.
   * @param {string} message - Message to send
   * @returns {Promise<void>}
   */
  async sendMessage(message) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }

    // Track that we're consuming a response
    this._nextResponseIndex++;

    // Capture the turn epoch BEFORE sending so we wait for a genuinely new
    // turn to complete, not a stale idle from before (and immune to the
    // worker's busy→idle window coalescing into one sync batch).
    const sinceTurn = this._conversation.completedTurns;

    // Send message through real code path
    const dropped = await this._conversation.sendMessage(message, null, this.rootThread);
    if (dropped) {
      throw new Error(`send-message was dropped by conversation.sendMessage (${dropped})`);
    }

    await this._waitForTurnComplete(sinceTurn);

    // Even after the turn completes, there can be a brief window where
    // the worker has flushed status=idle but a few trailing Yjs updates
    // (e.g. system-prompt placeholder insertion, last assistant message
    // chunks) have not yet been applied to the browser doc. Wait for the
    // items array to be stable: no mutations across one full sync round.
    await this._waitForItemsStable();
  }

  /**
   * Wait for the items array to be stable: no mutations for one full
   * "settling" round (microtask + animation frame). Driven by the items
   * observer, not a clock — but the bound is "one settle round" rather
   * than "the predicate became true" because there's no concrete predicate.
   * @param {number} [timeoutMs=2000] - Fail-fast safety net
   * @private
   */
  async _waitForItemsStable(timeoutMs = 2000) {
    if (!this._conversation) return;
    const rootThread = this._conversation.rootMessageThread;
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      let dirty = true;
      const onChange = () => { dirty = true; };
      const overall = setTimeout(() => {
        rootThread.unobserveItemsDeep?.(onChange);
        reject(new Error('Timeout waiting for items to be stable'));
      }, timeoutMs);
      rootThread.observeItemsDeep?.(onChange);
      // Use setTimeout(0) rather than requestAnimationFrame: hidden
      // WKWebViews throttle rAF to near-zero, which would hang the test.
      // A macrotask is the smallest deterministic checkpoint that always
      // fires regardless of webview visibility.
      const tick = () => {
        if (!dirty) {
          rootThread.unobserveItemsDeep?.(onChange);
          clearTimeout(overall);
          resolve();
          return;
        }
        dirty = false;
        setTimeout(tick, 0);
      };
      setTimeout(tick, 0);
    }));
  }

  /**
   * Send a message targeting a thread's sub-conversation and wait for completion.
   * Finds the first thread item in root and sends the message to it.
   * @param {string} message - Message to send
   * @returns {Promise<void>}
   */
  async sendThreadMessage(message) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }

    // Find the first thread item in root items
    const items = this.rootThread.items || [];
    let threadItemId = null;
    for (const item of items) {
      if (item.get('type') === 'thread') {
        threadItemId = item.get('itemId');
        break;
      }
    }
    if (!threadItemId) {
      throw new Error('No thread item found in root items');
    }

    // Track that we're consuming a response
    this._nextResponseIndex++;

    const sinceTurn = this._conversation.completedTurns;

    // Send message targeting the thread
    const droppedThread = await this._conversation.sendMessage(message, threadItemId);
    if (droppedThread) {
      throw new Error(`thread send-message was dropped by conversation.sendMessage (${droppedThread})`);
    }

    // Wait for the worker to complete the new turn (fence on the turn epoch).
    await this._waitForTurnComplete(sinceTurn);
  }

  /**
   * Send a message into a thread's sub-conversation WITHOUT waiting for the
   * turn to complete. Used by tests that pin the thread turn at a mock barrier
   * and then act while it is still in flight.
   * @param {string} message - Message to send
   * @returns {Promise<void>}
   */
  async sendThreadMessageNoWait(message) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }

    // A thread whose run is still going is the one a mid-turn test means. With
    // none running, fall back to the first thread: a stopped thread takes a
    // message and runs again, which is exactly how a resumed run is started.
    const items = this.rootThread.items || [];
    let threadItemId = null;
    let firstThreadItemId = null;
    for (const item of items) {
      if (item.get('type') !== 'thread') continue;
      if (firstThreadItemId === null) firstThreadItemId = item.get('itemId');
      if (!threadRunSettled(item)) {
        threadItemId = item.get('itemId');
        break;
      }
    }
    threadItemId = threadItemId || firstThreadItemId;
    if (!threadItemId) {
      throw new Error('No thread item found in root items');
    }

    // Track that we're consuming a response.
    this._nextResponseIndex++;

    // Deliberately do NOT wait for turn completion — the caller acts while the
    // turn is still in flight.
    const droppedNoWait = await this._conversation.sendMessage(message, threadItemId);
    if (droppedNoWait) {
      throw new Error(`thread send-message (no-wait) was dropped by conversation.sendMessage (${droppedNoWait})`);
    }
  }

  /**
   * Wait for items array to reach a minimum count.
   * @param {number} minCount - Minimum items count
   * @param {number} [timeoutMs=5000] - Timeout
   */
  async waitForItemsSync(minCount, timeoutMs = 5000) {
    if (!this._conversation) return;
    try {
      await this._waitForCondition(items => (items?.length ?? 0) >= minCount,
        { timeoutMs, label: `items >= ${minCount}` });
    } catch (_) {
      // Log but don't throw — items might have synced by a different path
      console.warn(`[TestHarness] Items sync timeout: expected ${minCount}, got ${this.rootThread.items?.length ?? 0}`);
    }
  }

  /**
   * Wait until the normalized document snapshot satisfies `matches`, riding the
   * per-test deadline. Unlike {@link waitForItemsSync} (count-only), this fences
   * on the EXACT shape the final assertion checks, so the assertion never races
   * a mid-sync document that happens to have the right item COUNT but the wrong
   * items — e.g. in-flight items have pushed the count past the threshold while
   * a seeded context item (system-prompt) is still syncing. Non-throwing: on the
   * deadline it returns and lets the real assertion surface the precise mismatch.
   * @param {(snapshot: import('./golden-comparator.js').DocumentSnapshot) => boolean} matches
   * @param {number} [timeoutMs=5000]
   */
  async waitForDocumentMatch(matches, timeoutMs = 5000) {
    if (!this._conversation) return;
    try {
      await this._waitForCondition(() => matches(this.getDocumentSnapshot()),
        { timeoutMs, label: 'document matches expected shape' });
    } catch (_) {
      // Deadline reached — fall through so the real assertion reports the
      // precise field/index mismatch on the final snapshot.
    }
  }

  /**
   * Wait for a NEW worker turn to complete, fencing on the monotonic turn
   * epoch (Conversation.completedTurns) captured before the action that starts
   * it. This replaces the old observe-the-busy-edge approach, which could miss
   * a fast turn whose busy→idle window coalesced into a single sync batch and
   * then hang the whole test budget. Rides the per-test deadline for patience.
   * @param {number} sinceTurn - completedTurns captured before the action
   * @returns {Promise<void>}
   * @private
   */
  async _waitForTurnComplete(sinceTurn) {
    if (!this._conversation) {
      return; // No conversation means no worker, skip
    }
    await waitForTurnComplete(this._conversation, {
      sinceTurn,
      deadlineMs: this._deadline(6000),
      signal: this._abortSignal,
      label: 'turn complete'
    });
  }

  /**
   * Resolve an approval for a tool action (root or thread).
   * Searches recursively through threads to find the tool.
   * @param {string} toolUseId - Tool use ID to resolve
   * @param {string} response - Approval response ('approved', 'denied', or a custom value)
   * @returns {Promise<void>}
   */
  async resolveApproval(toolUseId, response) {
    this._doResolveApproval(toolUseId, response);
    await this._waitForIdle();
  }

  /**
   * Resolve an approval without waiting for idle.
   * Used for long-running commands that will be cancelled mid-execution.
   * @param {string} toolUseId - Tool use ID to resolve
   * @param {string} response - Approval response ('approved', 'denied', or a custom value)
   */
  resolveApprovalNoWait(toolUseId, response) {
    this._doResolveApproval(toolUseId, response);
  }

  /**
   * Trigger a re-run of a completed tool-action WITHOUT waiting for it to
   * complete. Useful for tests that want to cancel the rerun while it's
   * still in flight.
   * @param {string} toolUseId - Tool use ID to re-run
   * @returns {Promise<void>}
   */
  async rerunToolNoWait(toolUseId) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    this._conversation.retryToolApproval(toolUseId);
    // Wait only for the worker's state=approved write to land (result
    // cleared); do NOT wait for execution to finish.
    const findItem = (/** @type {Array<*>} */ items) => {
      /** @type {*} */
      let found = null;
      findItemRecursive(items, item => {
        if (item.get('toolUseId') === toolUseId) { found = item; return true; }
        return false;
      });
      return found;
    };
    await this._waitForCondition(items => {
      const item = findItem(items);
      return !!item && (item.get('result') === null || item.get('result') === undefined);
    }, { timeoutMs: 3000, label: `rerun cleared (no-wait) ${toolUseId}` });
  }

  /**
   * Trigger the JS-side cancel flow — same calls Escape makes via
   * `cancelLLMOperation`, but bypasses the DOM keydown gate so tests can
   * exercise the cancellation semantics in isolation. Waits for full
   * quiescence (processingState=idle, no in-flight approved/running tools
   * without a result).
   * @param {number} [timeoutMs=4000] - Timeout for quiescence
   * @returns {Promise<void>}
   */
  async cancelViaUIFlow(timeoutMs = 4000) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }

    // Mirror the body of app.js cancelLLMOperation. Pre-fix this only
    // cancels in-page actions but leaves the worker in
    // `activity='awaiting_llm'`, so the idle-wait below times out and
    // the test surfaces the bug. Post-fix the worker-cancel branch fires
    // when actions are running or the worker is awaiting an LLM, the
    // worker writes `state='cancelled'`, and the test goes green.
    // Sub-thread active column → settle it (same first-class branch app.js takes).
    if (await this._conversation.cancelActiveTurn()) {
      await this._waitForCondition((items, ps) => {
        if (ps?.status !== 'idle') return false;
        const isUnsettled = (/** @type {*} */ item) =>
          item.get('type') === 'tool-action' &&
					item.get('state') !== TOOL_STATES.CANCELLED &&
					item.get('state') !== TOOL_STATES.COMPLETED;
        return !findItemRecursive(items, isUnsettled);
      }, { timeoutMs, label: 'idle after sub-thread cancel (UI flow)' });
      return;
    }

    const { default: actionExecutor } = await import('../../js/services/action-executor.js');

    // Which branch the flow takes is decided from two things that arrive here
    // independently: the action executor's own view, and the worker's activity
    // as it syncs into the doc. A caller that has seen the tool produce output
    // knows it is running — it does not know either of those has reached this
    // page yet, and sampling them a moment early sends the worker nothing at
    // all, leaving a cancel the quiescence wait below can never observe at any
    // budget. So wait for something cancellable to be visible first.
    await this._waitForCondition(
      (_items, ps) => actionExecutor.hasRunningActions() || ps?.activity === 'awaiting_llm',
      { timeoutMs, label: 'cancellable work visible to the UI cancel flow' });

    const wasRunningActions = actionExecutor.hasRunningActions();
    const isAwaitingLLM = this._conversation.processingState?.activity === 'awaiting_llm';
    this._conversation.cancelAllPendingApprovals();
    actionExecutor.cancelAllActions();
    if (wasRunningActions || isAwaitingLLM) {
      this._conversation.stopProcessing();
    }

    await this._waitForCondition((items, ps) => {
      if (ps?.status !== 'idle') return false;
      // Require every tool-action to be in a terminal state (CANCELLED
      // or COMPLETED). A "state=RUNNING with result set" is a transient
      // race window: the worker's CancelInFlightToolActions transaction
      // (state=cancelled+result=interrupted) is in flight while the
      // frontend's prior _claimRunning write is also racing through
      // Y.js merge. Accepting RUNNING+result here lets the test assert
      // the doc before the cancelled write wins; wait for the terminal
      // state instead.
      const isUnsettled = (/** @type {*} */ item) =>
        item.get('type') === 'tool-action' &&
				item.get('state') !== TOOL_STATES.CANCELLED &&
				item.get('state') !== TOOL_STATES.COMPLETED;
      return !findItemRecursive(items, isUnsettled);
    }, { timeoutMs, label: 'idle after UI cancel flow' });
  }

  /**
   * Trigger a re-run of a completed tool-action and wait for the rerun's
   * turn to finish (reset → execution → result → LLM continuation → idle).
   *
   * Waits ONLY on the durable turn fence. The previous implementation first
   * waited for the transient "result cleared" window the worker's reset
   * opens — but for a fast tool (grep, read) the reset and the new result
   * coalesce into one sync batch, the viewer never observes result==nil,
   * and the wait hung until the per-test timeout. Never wait on a state the
   * worker passes through; wait on the monotonic counter it lands on.
   * Patience comes from the per-test deadline (see _waitForTurnComplete) —
   * the single place that deadline policy lives.
   * @param {string} toolUseId - Tool use ID to re-run
   * @returns {Promise<void>}
   */
  async rerunTool(toolUseId) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    const sinceTurn = this._conversation.completedTurns;
    this._conversation.retryToolApproval(toolUseId);
    await this._waitForTurnComplete(sinceTurn);
  }

  /**
   * Wait for a specific tool to reach pending approval state.
   * Searches recursively through threads.
   * @param {string} toolUseId - Tool use ID to wait for
   * @param {number} [timeoutMs=2000] - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  async waitForApproval(toolUseId, timeoutMs = 5000) {
    await this._waitForCondition(items => findItemRecursive(items,
      item => item.get('toolUseId') === toolUseId && item.get('state') === TOOL_STATES.PENDING),
    { timeoutMs, label: `approval ${toolUseId}` });
  }

  // Thread-specific aliases (kept for test readability — delegate to the same recursive methods)

  /**
   * Alias for waitForApproval (searches threads recursively).
   * @param {string} toolUseId - Tool use ID to wait for
   * @param {number} [timeoutMs] - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  async waitForThreadApproval(toolUseId, timeoutMs) { return this.waitForApproval(toolUseId, timeoutMs); }

  /**
   * Alias for resolveApproval (searches threads recursively).
   * @param {string} toolUseId - Tool use ID to resolve
   * @param {string} response - Approval response
   * @returns {Promise<void>}
   */
  async resolveThreadApproval(toolUseId, response) { return this.resolveApproval(toolUseId, response); }

  /**
   * Alias for resolveApprovalNoWait (searches threads recursively).
   * @param {string} toolUseId - Tool use ID to resolve
   * @param {string} response - Approval response
   */
  resolveThreadApprovalNoWait(toolUseId, response) { this.resolveApprovalNoWait(toolUseId, response); }

  /**
   * Find and resolve a tool approval, searching recursively through threads.
   * @param {string} toolUseId - Tool use ID to resolve
   * @param {string} response - Test-friendly response ('approved', 'denied', or custom value)
   * @private
   */
  _doResolveApproval(toolUseId, response) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }

    // Map test-friendly names to conversation API values
    let apiResponse = response;
    if (response === 'approved') apiResponse = 'yes';
    else if (response === 'denied') apiResponse = 'cancel';

    // UI policy: denying any tool cancels all pending tools in the batch
    if (apiResponse === 'cancel' || apiResponse === 'no') {
      const thread = this._findThreadForTool(this.rootThread, toolUseId);
      if (!thread) {
        throw new Error(`Could not find pending tool ${toolUseId} in root or any thread`);
      }
      thread.cancelPendingApprovals();
      return;
    }

    // Walk recursively to find the tool in root or any nested thread
    const resolved = this._resolveInThread(this.rootThread, toolUseId, apiResponse);
    if (!resolved) {
      throw new Error(`Could not find pending tool ${toolUseId} in root or any thread`);
    }
  }

  /**
   * Find the MessageThread containing a tool by toolUseId.
   * @param {*} thread - MessageThread to search
   * @param {string} toolUseId - Tool use ID to find
   * @returns {*} The MessageThread containing the tool, or null
   * @private
   */
  _findThreadForTool(thread, toolUseId) {
    if (!this._conversation) return null;
    return this._conversation.findMessageThreadForToolUse(toolUseId);
  }

  /**
   * Recursively find and resolve a tool approval in the correct MessageThread.
   * @param {*} thread - MessageThread to search
   * @param {string} toolUseId - Tool use ID to find
   * @param {string} apiResponse - API response value
   * @returns {boolean} True if found and resolved
   * @private
   */
  _resolveInThread(thread, toolUseId, apiResponse) {
    if (!this._conversation) return false;
    const targetThread = this._conversation.findMessageThreadForToolUse(toolUseId);
    if (!targetThread) return false;
    // Verify the tool is actually pending before resolving
    const items = targetThread.items || [];
    for (const item of items) {
      if (item.get('toolUseId') === toolUseId && item.get('state') === TOOL_STATES.PENDING) {
        targetThread.resolveApproval(toolUseId, apiResponse);
        return true;
      }
    }
    return false;
  }

  /**
   * Wait for the conversation to settle to idle (settle mode of the shared
   * turn fence): resolves once the worker is idle with all approved tools
   * complete, or a tool is pending approval. Use this for resume/rerun paths
   * where the current turn just needs to quiesce; for a freshly-started turn
   * fence on the turn epoch via _waitForTurnComplete instead. Rides the
   * per-test deadline for patience.
   * @param {number} [timeoutMs=3000] - Fallback timeout when no deadline is set
   * @returns {Promise<void>}
   * @private
   */
  async _waitForIdle(timeoutMs = 3000) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    await waitForTurnComplete(this._conversation, {
      deadlineMs: this._deadline(timeoutMs),
      signal: this._abortSignal,
      timeoutMs,
      label: 'idle'
    });
  }

  /**
   * Wait for predicate(items, processingState) to return truthy.
   * Re-evaluates on every Yjs metadata/items mutation and on every
   * action-executor idle/busy transition. Timeout is a fail-fast safety net,
   * never a flow-control wait.
   * @param {(items: Array<*>, processingState: *) => boolean} predicate
   * @param {{timeoutMs?: number, label?: string}} [opts]
   * @returns {Promise<void>}
   * @private
   */
  async _waitForCondition(predicate, { timeoutMs = 5000, label = '' } = {}) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    // Delegates to the single shared observe-until engine (turn-sync.js). The
    // per-test deadline is THE bound for every wait: stay patient up to it (so
    // a progressing op under load isn't cut off by a shorter nominal
    // sub-timeout) but never past it (so a wait started late can't overrun the
    // budget). The caller's timeoutMs is the fallback when no deadline is set.
    await observeUntil(this._conversation, predicate, {
      deadlineMs: this._deadline(timeoutMs),
      signal: this._abortSignal,
      timeoutMs,
      label
    });
  }

  /**
   * Get the conversation instance.
   * @returns {import('../../model/conversation.js').default} The conversation instance
   */
  get conversation() {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    return this._conversation;
  }

  /**
   * Conversation IDs THIS harness created. Used by the integration test
   * runner's `finally{}` cleanup to delete only this test's conversations
   * — not sibling tests' conversations in the multi-iframe pool topology.
   * @returns {string[]} IDs of conversations created by this harness.
   */
  conversationIds() {
    return [...this._conversationOrder];
  }

  /**
   * Get the session instance.
   * @returns {import('../../model/session.js').default} The session instance
   */
  get session() {
    if (!this._session) {
      throw new Error('Session not initialized');
    }
    return this._session;
  }

  // =========================================================================
  // Multi-Conversation Support
  // =========================================================================

  /**
   * Create a new conversation and make it active.
   * @param {string} [name] - Optional conversation name
   * @param {import('./test-harness.js').MockResponse[]} [llmResponses] - Explicit
   *   mock script for this conversation; omitted = remaining shared responses
   * @returns {Promise<string>} New conversation ID
   */
  async createConversation(name, llmResponses) {
    if (!this._session) {
      throw new Error('Session not initialized');
    }

    const convId = await this._session.createConversation(name || 'Test Conversation');
    const conv = this._session.getConversation(convId);
    if (!conv) {
      throw new Error(`Failed to create conversation: ${convId}`);
    }

    // Set model config (required for worker to process messages)
    await conv.setModelConfig({ provider: 'test-provider', model: 'test-model' });

    // Enable write permission for write-file operations
    conv.rootMessageThread.addRule('write-file', { kind: 'boolean', value: true });

    // Track the conversation
    this._conversations.set(convId, conv);
    this._conversationOrder.push(convId);
    _registerOwnConversation(convId);

    // Switch to it
    this._conversation = conv;

    // Wait for worker to be fully ready
    await this._waitForWorkerReady(convId);

    // Inject mock responses into the new conversation's worker. An explicit
    // per-conversation list takes priority — required when two conversations
    // need independent scripts (e.g. both issuing tools with the same
    // toolUseId), which the shared remaining-tail heuristic cannot express
    // because every worker pops sequentially from its own copy of the tail.
    if (llmResponses) {
      await this._injectMockResponses(llmResponses, 0);
    } else {
      // Default: remaining responses only (responses before
      // _nextResponseIndex were consumed by previous conversations).
      await this._injectMockResponses(this._llmResponses, this._nextResponseIndex);
    }

    return convId;
  }

  /**
   * Duplicate an existing conversation.
   * @param {string} sourceId - Source conversation ID or $CONV_N placeholder
   * @returns {Promise<string>} New conversation ID
   */
  async duplicateConversation(sourceId) {
    if (!this._session) {
      throw new Error('Session not initialized');
    }

    // Resolve placeholder
    const resolvedSourceId = this._resolveConversationId(sourceId);

    // Get source conversation's item count BEFORE duplication
    // We'll wait for this many items to sync to the new conversation
    const sourceConv = this._conversations.get(resolvedSourceId);
    const expectedItemCount = sourceConv ? sourceConv.rootItems.length : 0;

    // Call the REAL duplicateConversation method (don't duplicate logic)
    const newConvId = await this._session.duplicateConversation(resolvedSourceId);
    if (!newConvId) {
      throw new Error(`Failed to duplicate conversation: ${sourceId}`);
    }

    const newConv = this._session.getConversation(newConvId);
    if (!newConv) {
      throw new Error(`Failed to get duplicated conversation: ${newConvId}`);
    }

    // Track for test cleanup
    this._conversations.set(newConvId, newConv);
    this._conversationOrder.push(newConvId);
    _registerOwnConversation(newConvId);
    this._conversation = newConv;

    // CRITICAL: Wait for Yjs sync to complete
    // The worker sends yjs-sync message before ready, but the frontend may not
    // have processed it yet. Wait for items to appear in the duplicated conversation.
    if (expectedItemCount > 0) {
      await this._waitForItemCount(newConvId, expectedItemCount, 5000);
    }

    // Inject mock responses
    await this._injectMockResponses(this._llmResponses, this._nextResponseIndex);

    return newConvId;
  }

  /**
   * Wait for conversation to have at least N items (Yjs sync completion).
   * @param {string} conversationId - Conversation ID
   * @param {number} expectedCount - Minimum number of items expected
   * @param {number} [timeout=5000] - Timeout in ms
   * @returns {Promise<void>}
   * @private
   */
  async _waitForItemCount(conversationId, expectedCount, timeout = 5000) {
    const conv = this._conversations.get(conversationId);
    if (!conv) {
      throw new Error(`Conversation ${conversationId} not found`);
    }
    // observeUntil deep-observes the root map rather than the items array: a
    // just-duplicated conversation loads with an empty doc, so its items array
    // does not exist until the worker's first yjs-sync creates it. Observing
    // the array directly would silently register nothing and miss that sync.
    await observeUntil(conv, (items) => items.length >= expectedCount, {
      deadlineMs: this._deadline(timeout),
      signal: this._abortSignal,
      timeoutMs: timeout,
      label: `${expectedCount} items to sync in ${conversationId}`
    });
  }

  /**
   * Wait for a worker to be ready.
   * @param {string} conversationId - Conversation ID
   * @param {number} [timeout=5000] - Timeout in ms
   * @returns {Promise<void>}
   * @private
   */
  async _waitForWorkerReady(conversationId, timeout = 5000) {
    await Promise.race([
      workerManager.whenReady(conversationId),
      new Promise((_resolve, reject) => setTimeout(
        () => reject(new Error(`Timeout waiting for worker to be ready: ${conversationId}`)),
        timeout
      ))
    ]);
  }

  /**
   * Switch to a different conversation.
   * @param {string} conversationId - Conversation ID (can be $CONV_N placeholder)
   */
  switchConversation(conversationId) {
    // Resolve $CONV_N placeholder
    const resolvedId = this._resolveConversationId(conversationId);

    const conv = this._conversations.get(resolvedId);
    if (!conv) {
      throw new Error(`Unknown conversation: ${conversationId} (resolved: ${resolvedId})`);
    }

    this._conversation = conv;

    // Also update session's visible conversation
    if (this._session) {
      this._session.switchConversation(resolvedId);
    }
  }

  /**
   * Delete a conversation.
   * @param {string} conversationId - Conversation ID (can be $CONV_N placeholder)
   * @returns {Promise<void>}
   */
  async deleteConversation(conversationId) {
    if (!this._session) {
      throw new Error('Session not initialized');
    }

    // Resolve $CONV_N placeholder
    const resolvedId = this._resolveConversationId(conversationId);

    const success = await this._session.deleteConversation(resolvedId, 'test-op:delete-conversation');
    if (!success) {
      throw new Error(`Failed to delete conversation: ${conversationId} (resolved: ${resolvedId})`);
    }

    // Update tracking
    this._conversations.delete(resolvedId);
    const orderIndex = this._conversationOrder.indexOf(resolvedId);
    if (orderIndex !== -1) {
      this._conversationOrder.splice(orderIndex, 1);
    }

    // If we deleted the active conversation, switch to another
    if (this._conversation?.id === resolvedId) {
      const remaining = [...this._conversations.values()];
      if (remaining.length > 0) {
        this._conversation = remaining[0];
      } else {
        this._conversation = null;
      }
    }
  }

  /**
   * Attempt to bin a conversation through the REAL conversation-bar action
   * site (`_binConversation`), so the production busy-guard runs exactly as it
   * does behind the per-tab trash icon, the context-menu, and the bottom-bar
   * "Move to Bin". WHETHER the bin happens is the behaviour under test — an
   * awaiting-approval conversation is binnable, a genuinely running one is
   * refused — so this method never asserts; it just drives the real path and
   * lets the production `session.conversations` map be the oracle.
   *
   * Local harness tracking is deliberately left untouched so `conversationIds()`
   * still resolves the (possibly binned) id for assertions. A detached
   * conversation-bar is used: it's never connected, so its `_cachedElements`
   * map is empty and `_flyTabToBin` no-ops — only the guard + `binConversation`
   * run.
   * @param {string} conversationId - Conversation ID or $CONV_N placeholder
   * @returns {Promise<void>}
   */
  async binConversationViaBar(conversationId) {
    if (!this._session) {
      throw new Error('Session not initialized');
    }
    const resolvedId = this._resolveConversationId(conversationId);
    await import('../../js/components/conversation-bar.js');
    const bar = document.createElement('conversation-bar');
    /** @type {any} */ (bar)._session = this._session;
    await /** @type {any} */ (bar)._binConversation(resolvedId);
    bar.remove();
  }

  /**
   * Get the index of a conversation for $CONV_N placeholder resolution.
   * @param {string} conversationId - Conversation ID
   * @returns {number} Index in _conversationOrder, or -1 if not found
   */
  getConversationIndex(conversationId) {
    return this._conversationOrder.indexOf(conversationId);
  }

  /**
   * Get all conversation IDs in order.
   * @returns {string[]} Conversation IDs
   */
  getConversationIds() {
    return [...this._conversationOrder];
  }

  /**
   * Resolve $CONV_N placeholder to actual conversation ID.
   * @param {string} conversationId - ID or $CONV_N placeholder
   * @returns {string} Resolved conversation ID
   * @private
   */
  _resolveConversationId(conversationId) {
    const match = conversationId.match(/^\$CONV_(\d+)$/);
    if (match) {
      const index = parseInt(match[1], 10);
      if (index >= 0 && index < this._conversationOrder.length) {
        return this._conversationOrder[index];
      }
      throw new Error(`Invalid conversation placeholder: ${conversationId} (only ${this._conversationOrder.length} conversations exist)`);
    }
    return conversationId;
  }

  // =========================================================================
  // Undo/Redo Support
  // =========================================================================

  /**
   * Undo the last operation in the active conversation.
   * @returns {Promise<boolean>} True if undo was successful
   */
  async undo() {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    return await this._conversation.undo();
  }

  /**
   * Redo the last undone operation in the active conversation.
   * @returns {Promise<boolean>} True if redo was successful
   */
  async redo() {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    return await this._conversation.redo();
  }

  /**
   * Get a snapshot of the document state for golden comparison.
   * @returns {import('./golden-comparator.js').DocumentSnapshot} Normalized document snapshot
   */
  getDocumentSnapshot() {
    // Import at runtime to avoid circular dependency
    const helpers = /** @type {{normalizeDocumentSnapshot?: Function}|undefined} */ (
    /** @type {any} */ (window).__integrationTestHelpers
    );
    if (helpers?.normalizeDocumentSnapshot) {
      return helpers.normalizeDocumentSnapshot(this._conversation);
    }
    // Fallback: return normalized raw state
    const items = /** @type {RawItem[]} */ (this.rootThread.items || []);
    return {
      items: items.map(item => ({ type: item.get('type') }))
    };
  }

  /**
   * Get context items as a plain object map with normalized structure.
   * Unified storage: context items are items with type="context-item" in items array.
   * @returns {Record<string, {type: string}>} Context items map
   * @private
   */
  _getContextItemsMap() {
    /** @type {Record<string, {type: string}>} */
    const contextItems = {};
    if (this.rootThread) {
      const items = this.rootThread.yarray.toArray() || [];
      for (const item of items) {
        if (item.get('itemId')) {
          contextItems[item.get('itemId')] = { type: item.get('type') || 'unknown' };
        }
      }
    }
    return contextItems;
  }

  /**
   * Get metadata as a plain object map.
   * @returns {Record<string, any>} Metadata map
   * @private
   */
  _getMetadataMap() {
    /** @type {Record<string, any>} */
    const metadata = {};
    if (this._conversation) {
      for (const [key, value] of this._conversation.getMetadataEntries()) {
        metadata[key] = value;
      }
    }
    return metadata;
  }

  /**
   * Read a file from the fixture directory.
   * @param {string} relativePath - Relative path to the file
   * @returns {Promise<string>} File content
   */
  async readFile(relativePath) {
    const { readFileLoad } = await import('../../js/services/ops-api.js');
    const fullPath = this._fixtureDir ? `${this._fixtureDir}/${relativePath}` : relativePath;
    const result = await readFileLoad({ path: fullPath });
    return result?.content || '';
  }

  /**
   * Run a slash command.
   * Commands are executed by sending /commandName as a message.
   * Commands that trigger LLM calls (like compaction) consume mock responses.
   * @param {string} command - Command name (without leading slash)
   * @param {string} [args] - Optional command arguments
   * @returns {Promise<void>}
   */
  async runCommand(command, args) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }

    const message = args ? `/${command} ${args}` : `/${command}`;
    const sourceConvId = this._conversation.id;

    // Compact triggers the worker to process a doc-driven thread (one strategy
    // turn that consumes a mock response). Fence on the turn epoch captured
    // before the command — the slash command itself is a pure Yjs mutation and
    // does not bump the counter, so the increment marks the compaction turn.
    const llmCommands = ['compact'];
    if (llmCommands.includes(command)) {
      const sinceTurn = this._conversation.completedTurns;
      await this._conversation.sendMessage(message, null, this.rootThread);
      await this._waitForTurnComplete(sinceTurn);
      this._nextResponseIndex++;
      return;
    }

    // Non-LLM command: synchronous side effects only — settle, then re-track
    // if the command switched the active conversation to a newly-created one
    // (/new, /duplicate). These create+activate a tab without an LLM turn, so
    // there is nothing to fence on; we just adopt the new conversation as the
    // tracked one so subsequent assertions target it.
    await this._conversation.sendMessage(message, null, this.rootThread);
    await this._waitForIdle();

    const switchedConvId = this._session.visibleConversationId;
    if (switchedConvId && switchedConvId !== sourceConvId) {
      const switchedConv = this._session.getConversation(switchedConvId);
      if (switchedConv) {
        this._conversations.set(switchedConvId, switchedConv);
        this._conversationOrder.push(switchedConvId);
        _registerOwnConversation(switchedConvId);
        this._conversation = switchedConv;
      }
    }
  }

  /**
   * Fire a slash command without fencing on anything it might start.
   *
   * For when the command is expected NOT to run: a declined confirmation leaves
   * the original turn in flight, so both fences runCommand waits on (the turn
   * epoch for compact, idle for everything else) would sit out the whole test.
   * @param {string} command - Command name (without leading slash)
   * @param {string} [args] - Optional command arguments
   * @returns {Promise<void>}
   */
  async runCommandNoWait(command, args) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    const message = args ? `/${command} ${args}` : `/${command}`;
    await this._conversation.sendMessage(message, null, this.rootThread);
  }

  /**
   * Compact items up to a given index via pure yjs mutations.
   * Creates a thread with the items + summarization prompt.
   * The worker auto-detects the thread and processes it.
   * @param {number} index - Items before this index are compacted
   * @returns {Promise<void>}
   */
  async compactUpTo(index) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }

    const { createThreadMessage, createUserMessage } = await import('../../sdk/lib/message.js');
    const { plainToYMap } = await import('../../js/model/item-accessor.js');
    const Y = await import('../../js/vendor/yjs.mjs');

    const mt = this.rootThread;
    const items = mt.items;
    if (index <= 0 || items.length === 0) return;
    if (index > items.length) index = items.length;

    // Snapshot items before mutations
    /** @type {object[]} */
    const snapshots = [];
    for (let i = 0; i < index; i++) {
      if (items[i]?.toJSON) snapshots.push(items[i].toJSON());
    }
    if (snapshots.length === 0) return;

    const threadMsg = createThreadMessage({ goal: 'Compacted conversation history' });
    /** @type {any} */ (threadMsg).needsStrategyRun = true;
    const userMsg = createUserMessage(
      `Summarize the preceding ${snapshots.length} messages concisely. ` +
				'Focus on files modified, key decisions, and current state.'
    );

    const doc = this._conversation._doc.doc;
    const authorId = this._conversation._doc.authorId;
    const targetArray = mt.ensureYarray();

    // Capture the turn epoch before inserting the thread so we fence on the
    // worker's compaction turn, not a stale idle.
    const sinceTurn = this._conversation.completedTurns;

    doc.transact(() => {
      const threadYMap = plainToYMap(threadMsg);
      const nestedArray = new Y.Array();
      threadYMap.set('items', nestedArray);
      for (const snapshot of snapshots) {
        nestedArray.push([plainToYMap(snapshot)]);
      }
      nestedArray.push([plainToYMap(userMsg)]);
      for (let i = index - 1; i >= 0; i--) {
        targetArray.delete(i, 1);
      }
      targetArray.insert(0, [threadYMap]);
    }, authorId);

    // Worker auto-detects the new thread — fence on the turn completing.
    await this._waitForTurnComplete(sinceTurn);
    this._nextResponseIndex++;
  }

  /**
   * Simulate WebSocket disconnection for reconnection testing.
   * This closes the WebSocket and optionally waits before allowing reconnection.
   * @param {number} [reconnectMs=100] - Time to wait before allowing reconnection
   * @returns {Promise<void>}
   */
  async simulateDisconnect(reconnectMs = 100) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }

    // Access the worker manager to simulate disconnect
    await workerManager.simulateDisconnect(this._conversation.id);

    // Wait before allowing reconnection
    if (reconnectMs > 0) {
      await new Promise(resolve => setTimeout(resolve, reconnectMs));
    }

    // Trigger reconnection
    await workerManager.reconnect(this._conversation.id);
  }

  /**
   * Wait for a specific conversation state condition.
   * @param {object} condition - Condition to check
   * @param {number} [condition.itemCount] - Expected item count
   * @param {number} [condition.contextItemCount] - Expected context item count
   * @param {string} [condition.processingStatus] - Expected processing status
   * @param {boolean} [condition.politePending] - Expected synced pause-pending cue (processingState.politePending)
   * @param {boolean} [condition.hasThreadItem] - Whether any thread item exists
   * @param {boolean} [condition.hasCompactionBarrier] - Whether compaction barrier exists
   * @param {number} [condition.completedThreadCount] - Minimum count of threads whose run has settled
   * @param {number} [condition.atMostThreadCount] - Constraint: fail immediately if total thread count exceeds this
   * @param {number} [condition.maxCompletedThreadCount] - Constraint: fail immediately if settled thread count exceeds this
   * @param {boolean} [condition.mainThreadBusy] - Whether the main thread footer shows a spinner
   * @param {boolean} [condition.subThreadBusy] - Whether any sub-thread column footer shows a spinner
   * @param {number} [timeoutMs=5000] - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  async waitForState(condition, timeoutMs = 5000) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }

    // atMostThreadCount is a constraint: it must hold throughout the wait window.
    // If it's the only key, the call is purely a constraint check that succeeds
    // after timeoutMs elapses with no violation. If combined with goal conditions,
    // goals must be met AND the constraint must hold the whole time.
    const isConstraintKey = (/** @type {string} */ k) => k === 'atMostThreadCount' ||
			k === 'maxCompletedThreadCount';
    const hasConstraintOnly = Object.keys(condition).length > 0 &&
			Object.keys(condition).every(isConstraintKey);

    // Pure-function evaluator. Throws on constraint violation; returns true once goals met.
    const evaluate = (/** @type {Array<*>} */ items) => {
      let goalsMet = true;

      if (condition.itemCount !== undefined) {
        if ((items?.length ?? 0) !== condition.itemCount) goalsMet = false;
      }
      if (condition.contextItemCount !== undefined) {
        const c = this._conversation?.rootMessageThread.contextItems?.length ?? 0;
        if (c !== condition.contextItemCount) goalsMet = false;
      }
      if (condition.processingStatus !== undefined) {
        const ps = this._conversation?.getMetadata('processingState');
        if (ps?.status !== condition.processingStatus) goalsMet = false;
      }
      if (condition.politePending !== undefined) {
        // Server-authoritative pause-pending cue: the worker publishes
        // processingState.politePending while a Pause is still winding covered
        // work down, so this is what a reloaded client rehydrates from.
        const ps = this._conversation?.getMetadata('processingState');
        if ((ps?.politePending === true) !== condition.politePending) goalsMet = false;
      }
      if (condition.hasThreadItem !== undefined) {
        const has = items.some(item => item.get('type') === 'thread');
        if (has !== condition.hasThreadItem) goalsMet = false;
      }
      if (condition.completedThreadCount !== undefined) {
        const threadCount = items.filter(item =>
          item.get('type') === 'thread' && threadRunSettled(item)
        ).length;
        if (threadCount < condition.completedThreadCount) goalsMet = false;
      }
      if (condition.anyThreadResultIncludes !== undefined) {
        const needle = condition.anyThreadResultIncludes;
        const found = findItemRecursive(items, (/** @type {any} */ it) =>
          it.get('type') === 'thread' &&
					typeof it.get('result') === 'string' &&
					it.get('result').includes(needle));
        if (!found) goalsMet = false;
      }
      if (condition.atMostThreadCount !== undefined) {
        const threadCount = items.filter(item => item.get('type') === 'thread').length;
        if (threadCount > condition.atMostThreadCount) {
          throw new Error(
            `atMostThreadCount violated: expected ≤${condition.atMostThreadCount} but got ${threadCount}`
          );
        }
      }
      if (condition.maxCompletedThreadCount !== undefined) {
        const completedCount = items.filter(item =>
          item.get('type') === 'thread' && threadRunSettled(item)
        ).length;
        if (completedCount > condition.maxCompletedThreadCount) {
          throw new Error(
            `maxCompletedThreadCount violated: expected ≤${condition.maxCompletedThreadCount} but got ${completedCount}`
          );
        }
      }
      if (condition.hasCompactionBarrier !== undefined) {
        const hasBarrier = items.some(item =>
          item.get('type') === 'thread' && item.get('result')
        );
        if (hasBarrier !== condition.hasCompactionBarrier) goalsMet = false;
      }
      if (condition.mainThreadBusy !== undefined) {
        const rootCol = document.querySelector('conversation-area:not(.thread-column)');
        const processing = rootCol?.querySelector('footer-processing');
        const busy = processing !== null && processing !== undefined && !processing.classList.contains('hidden');
        if (busy !== condition.mainThreadBusy) goalsMet = false;
      }
      if (condition.subThreadBusy !== undefined) {
        const threadCols = document.querySelectorAll('conversation-area.thread-column');
        const anyBusy = Array.from(threadCols).some(col => {
          const fp = col.querySelector('footer-processing');
          return fp !== null && !fp.classList.contains('hidden');
        });
        if (anyBusy !== condition.subThreadBusy) goalsMet = false;
      }

      return goalsMet;
    };

    if (hasConstraintOnly) {
      // Constraint-only: observe for the full window, throw on any violation.
      // We listen on the doc root deeply (covers items mutations, and
      // survives a just-created conversation whose items array doesn't
      // exist yet — root.get('items') would be undefined there).
      // @ts-ignore - _doc access needed for low-level Yjs observers in test harness
      const root = this._conversation._doc.root;
      await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        const cleanup = () => root.unobserveDeep(check);
        const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
        const check = () => {
          try { evaluate(this.rootThread.items || []); }
          catch (err) { clearTimeout(timer); cleanup(); reject(err); }
        };
        root.observeDeep(check);
        try { check(); } catch (err) { clearTimeout(timer); reject(err); }
      }));
      return;
    }

    await this._waitForCondition(items => evaluate(items),
      { timeoutMs, label: `state ${JSON.stringify(condition)}` });
  }

  // =========================================================================
  // Progress Capture (for streaming action tests)
  // =========================================================================

  /**
   * Start capturing action-progress events for a tool.
   * @param {string} toolUseId - Tool use ID to capture events for
   */
  startCapturingProgress(toolUseId) {
    /** @type {object[]} */
    const events = [];
    /** @type {(e: CustomEvent) => void} */
    const handler = (e) => {
      if (e.detail?.toolUseId === toolUseId) {
        // accumulatedOutput is the executor's running total for the action,
        // not this chunk — it is what waitForActionOutput matches against, and
        // what the tool-action's displayData.output ends up holding.
        events.push({
          ...e.detail.event,
          accumulatedOutput: e.detail.accumulatedOutput ?? '',
          timestamp: Date.now()
        });
      }
    };
    document.addEventListener('action-progress', /** @type {EventListener} */ (handler));
    this._progressCaptures.set(toolUseId, { events, handler });
  }

  /**
   * Stop capturing and return captured events.
   * @param {string} toolUseId - Tool use ID
   * @returns {object[]} Captured progress events
   */
  stopCapturingProgress(toolUseId) {
    const capture = this._progressCaptures.get(toolUseId);
    if (!capture) return [];
    document.removeEventListener('action-progress', /** @type {EventListener} */ (capture.handler));
    this._progressCaptures.delete(toolUseId);
    return capture.events;
  }

  /**
   * Get current capture count without stopping.
   * @param {string} toolUseId - Tool use ID
   * @returns {number} Number of events captured so far
   */
  getProgressCount(toolUseId) {
    return this._progressCaptures.get(toolUseId)?.events.length ?? 0;
  }

  /**
   * Wait for at least N progress events to be captured.
   * @param {string} toolUseId - Tool use ID
   * @param {number} minEvents - Minimum events to wait for
   * @param {number} [timeoutMs=5000] - Timeout
   * @returns {Promise<void>}
   */
  async waitForProgress(toolUseId, minEvents, timeoutMs = 5000) {
    // action-progress events originate in the engine iframe but are
    // forwarded to window.parent via postMessage and re-dispatched on the
    // test document by integration-test-executor.js. Capture handlers see
    // them just like any other DOM event.
    if (this.getProgressCount(toolUseId) >= minEvents) return;
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        document.removeEventListener('action-progress', listener);
        reject(new Error(
          `Timeout waiting for ${minEvents} progress events, got ${this.getProgressCount(toolUseId)}`
        ));
      }, timeoutMs);
      const listener = (/** @type {Event} */ e) => {
        if (/** @type {CustomEvent} */ (e).detail?.toolUseId !== toolUseId) return;
        if (this.getProgressCount(toolUseId) >= minEvents) {
          clearTimeout(timeout);
          document.removeEventListener('action-progress', listener);
          resolve();
        }
      };
      document.addEventListener('action-progress', listener);
    }));
  }

  /**
   * Wait until a running action's accumulated output contains `substring`.
   *
   * Counting progress events is not a substitute for this. How many events a
   * tool emits before its first byte of output is the engine's business — a
   * start status, a claim, a heartbeat all count — so a test that waits for N
   * events and then acts on the output is asserting on something it never
   * established, and fails whenever the engine emits one status more than the
   * test's author happened to observe. Wait for the output itself.
   * @param {string} toolUseId - Tool use ID (must already be capturing)
   * @param {string} substring - Text the accumulated output must contain
   * @param {number} [timeoutMs=5000] - Timeout
   * @returns {Promise<void>}
   */
  async waitForActionOutput(toolUseId, substring, timeoutMs = 5000) {
    const capture = this._progressCaptures.get(toolUseId);
    if (!capture) {
      throw new Error(
        `waitForActionOutput(${toolUseId}): no progress capture — ` +
        'the test must run start-capture-progress before approving the tool'
      );
    }
    /** @returns {boolean} True once some captured event carries the substring */
    const seen = () => capture.events.some(
      (/** @type {any} */ ev) => String(ev.accumulatedOutput || '').includes(substring)
    );
    if (seen()) return;
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        document.removeEventListener('action-progress', listener);
        const last = capture.events[capture.events.length - 1];
        reject(new Error(
          `Timeout waiting for ${toolUseId} output to contain ${JSON.stringify(substring)} ` +
          `after ${capture.events.length} progress event(s); last accumulated output was ` +
          JSON.stringify(last ? String(last.accumulatedOutput || '') : '')
        ));
      }, timeoutMs);
      const listener = (/** @type {Event} */ e) => {
        if (/** @type {CustomEvent} */ (e).detail?.toolUseId !== toolUseId) return;
        if (seen()) {
          clearTimeout(timeout);
          document.removeEventListener('action-progress', listener);
          resolve();
        }
      };
      document.addEventListener('action-progress', listener);
    }));
  }

  // =========================================================================
  // Spinner Capture (for LLM generation spinner tests)
  // =========================================================================

  /**
   * Directly writes a non-idle processingState to the browser Yjs doc and captures
   * whether the DOM spinner is visible. Local Yjs writes fire observers synchronously,
   * so the DOM is fully updated before this method returns.
   * @param {'main'|'sub'} threadType - Which column to check
   */
  startSpinnerCapture(threadType) {
    const conv = /** @type {any} */ (this._conversation);
    const metadata = conv._doc.metadata;
    const currentTurn = Number(metadata.get('completedTurns')) || 0;

    // For sub-thread: find the last thread item ID so the spinner targets that column
    let threadItemId = null;
    if (threadType === 'sub') {
      const items = this._conversation?.rootMessageThread?.items || [];
      for (const item of items) {
        if (item.get && item.get('type') === 'thread') {
          threadItemId = item.get('itemId');
        }
      }
    }

    // Write non-idle processingState — local Yjs writes fire observers synchronously.
    // llmState's observer → _handleProcessingStateChange → syncWithStatus → updateAllFooters
    // all execute within this set() call.
    metadata.set('processingState', {
      status: 'preparing',
      message: '',
      threadItemId,
      activity: 'calling-llm',
      claimedAt: Date.now(),
    });

    // DOM is now updated — check spinner synchronously
    let visible = false;
    if (threadType === 'main') {
      const rootCol = document.querySelector('conversation-area:not(.thread-column)');
      const fp = rootCol?.querySelector('footer-processing');
      visible = fp !== null && fp !== undefined && !fp.classList.contains('hidden');
    } else {
      const threadCols = document.querySelectorAll('conversation-area.thread-column');
      visible = Array.from(threadCols).some(col => {
        const fp = col.querySelector('footer-processing');
        return fp !== null && !fp.classList.contains('hidden');
      });
    }

    this._spinnerCapture = { observed: true, visible, status: 'preparing', threadItemId };

    // Reset to idle (fires observers synchronously — cleans up llmState).
    // Mirror the real worker: bump the durable turn fence in its own
    // `completedTurns` metadata key, not inside the ephemeral processingState.
    metadata.set('processingState', { status: 'idle' });
    metadata.set('completedTurns', currentTurn + 1);
  }

  /**
   * Assert that the spinner was visible when startSpinnerCapture triggered it.
   * @returns {Promise<void>}
   */
  async assertSpinnerWasVisible() {
    if (!this._spinnerCapture) {
      throw new Error('assert-spinner-was-visible: start-spinner-capture was not called');
    }
    if (!this._spinnerCapture.visible) {
      const threadCols = document.querySelectorAll('conversation-area.thread-column');
      const diagParts = Array.from(threadCols).map((col, i) => {
        const fp = col.querySelector('footer-processing');
        return `col${i}[fp=${fp ? fp.className || '(no class)' : 'null'}]`;
      });
      const allCols = document.querySelectorAll('conversation-area');
      throw new Error(
        `Spinner not visible during processingState.status='${this._spinnerCapture.status}'. ` +
				`threadCols=${threadCols.length}/${allCols.length}: [${diagParts.join(', ')}]. ` +
				`threadItemId=${this._spinnerCapture.threadItemId ?? 'null'}`
      );
    }
    this._spinnerCapture = null;
  }

  /**
   * Assert streaming produced at least N chunks.
   * Stops capture and throws if fewer than minChunks.
   * @param {string} toolUseId - Tool use ID
   * @param {number} minChunks - Minimum chunks expected
   * @returns {object[]} Captured events
   */
  assertStreamingChunks(toolUseId, minChunks) {
    const events = this.stopCapturingProgress(toolUseId);
    if (events.length < minChunks) {
      throw new Error(`Expected at least ${minChunks} streaming chunks, got ${events.length}`);
    }
    return events;
  }

  // =========================================================================
  // Tool-execution counter (detects observer re-entrancy cascades)
  // =========================================================================

  /**
   * Start counting toolExecutor.executeToolCall invocations for a specific
   * toolUseId. Resets the counter for that id and installs a singleton
   * wrapper around toolExecutor.executeToolCall that increments the counter
   * every time the matching tool is invoked.
   *
   * Used to verify that a rerun triggers exactly one execution even while
   * the tool is streaming displayData updates (which previously re-fired
   * the conversation observer and spawned concurrent executions).
   * @param {string} toolUseId - Tool use ID to count
   */
  startToolExecCounter(toolUseId) {
    this._toolExecCounts.set(toolUseId, 0);

    if (this._toolExecChannel) return; // subscription already installed

    // Tool execution actually happens in the engine WebviewWindow
    // (executeToolAction short-circuits in viewers — see conversation.js).
    // The engine's toolExecutor.executeToolCall sends an engine-bridge WS
    // envelope on channel 'juggler-tool-exec'; subscribe to wsService
    // 'engine-bridge' (NOT the same-window BroadcastChannel) so each
    // iframe in the multi-iframe test pool counts the engine's emit
    // exactly once. The BC path multiplies events across sibling iframes.
    const counts = this._toolExecCounts;
    const handler = (/** @type {any} */ ev) => {
      if (!ev || ev.channel !== 'juggler-tool-exec') return;
      const { toolUseId: id, phase, conversationId } = ev.payload || {};
      if (phase !== 'start') return;
      // Reused toolUseIds across sibling tests (e.g. 'call_1' in multiple
      // fixtures) mean the engine emits 'start' for every conv that has
      // this id. Count only those belonging to a conversation THIS
      // harness owns.
      const ownIds = /** @type {any} */ (window).__ownConversationIds;
      if (conversationId && ownIds && !ownIds.has(conversationId)) return;
      if (id && counts.has(id)) {
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    };
    // Register synchronously — NOT via a lazy `import().then()`. The next
    // operation (e.g. rerun-tool) can fire the tool's single 'start' event
    // only ~100ms later; on a slow runner the dynamic import hadn't resolved
    // yet, so the listener missed that lone event and the count came back 0
    // (observed as a Windows CI flake in rerun-streaming-executes-once).
    wsService.on('engine-bridge', handler);
    // Sentinel so _uninstallToolExecCounter can find and unsubscribe.
    this._toolExecChannel = { close: () => {
      wsService.off('engine-bridge', handler);
    } };
  }

  /**
   * Assert the number of times executeToolCall has been invoked for a
   * specific toolUseId since startToolExecCounter was called.
   * @param {string} toolUseId - Tool use ID
   * @param {number} expected - Expected invocation count
   */
  assertToolExecCount(toolUseId, expected) {
    if (!this._toolExecCounts.has(toolUseId)) {
      throw new Error(`assertToolExecCount: counter not started for ${toolUseId}`);
    }
    const actual = this._toolExecCounts.get(toolUseId) || 0;
    if (actual !== expected) {
      throw new Error(
        `Expected ${expected} execution(s) of ${toolUseId}, got ${actual} ` +
				`(observer re-entrancy cascade — displayData updates are re-firing executeToolAction)`
      );
    }
  }

  /**
   * Close the tool-exec BroadcastChannel subscription if installed.
   * @private
   */
  _uninstallToolExecCounter() {
    if (this._toolExecChannel) {
      this._toolExecChannel.close();
      this._toolExecChannel = null;
    }
    this._toolExecCounts.clear();
  }

  /**
   * Cancel the current execution by calling addCancellationMessage.
   * Triggers mid-execution abort via the conversation's cancellation path.
   * Waits for the conversation to become idle after cancellation.
   * @param {number} [timeoutMs=10000] - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  /**
   * Wait for the worker to reach a paused mock response (MockResponse.PauseBeforeReturn).
   * Resolves the moment processingState.status flips to 'mock-paused'.
   * @param {number} [timeoutMs=5000] - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  async waitForMockPaused(timeoutMs = 5000) {
    await this._waitForCondition((_items, ps) => ps?.status === 'mock-paused',
      { timeoutMs, label: 'mock paused' });
  }

  /**
   * Release a paused mock response. The worker resumes the strategy loop and
   * delivers the response.
   * @returns {void}
   */
  releaseMock() {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    workerManager.releaseMock(this._conversation.id);
  }

  async cancelExecution(timeoutMs = 10000) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    // Mirror app.cancelLLMOperation with an unknown vantage (a bare Escape):
    // if a sub-thread is the live processing column, INTERRUPT it (worker-truth
    // cancel, thread left OPEN — no result stamp) instead of adding a root
    // cancellation message. Must run before any stop clears the status threadId.
    if (await this._conversation.cancelActiveTurn()) {
      await this._waitForCondition((items, ps) => {
        if (ps?.status !== 'idle') return false;
        return !hasIncompleteApprovedTools(items);
      }, { timeoutMs, label: 'idle after sub-thread interrupt' });
      return;
    }
    this._conversation.addCancellationMessage();

    // Wait for full quiescence: processingState=idle, no in-flight browser
    // actions (cancelled actions still need to unwind their finally blocks),
    // and no approved tools still missing results.
    await this._waitForCondition((items, ps) => {
      if (ps?.status !== 'idle') return false;
      return !hasIncompleteApprovedTools(items);
    }, { timeoutMs, label: 'idle after cancellation' });
  }

  /**
   * Stop from the ROOT/parent vantage — Escape while focused on the root, or
   * the root footer Stop. Stops the in-flight worker turn AND settles every
   * sub-thread's open run as cancelled, so the composer returns to the root
   * column. Mirrors the root-vantage branch of app.cancelLLMOperation(null).
   * @param {number} [timeoutMs=10000] - Timeout for quiescence
   * @returns {Promise<void>}
   */
  async cancelFromRoot(timeoutMs = 10000) {
    if (!this._conversation) {
      throw new Error('Conversation not initialized');
    }
    this._conversation.cancelAllPendingApprovals();
    this._conversation.addCancellationMessage();
    this._conversation.settleOpenSubThreads();
    await this._waitForCondition((items, ps) => {
      if (ps?.status !== 'idle') return false;
      if (hasIncompleteApprovedTools(items)) return false;
      // Every sub-thread's run must have settled.
      const runningThread = findItemRecursive(items, (/** @type {*} */ item) =>
        item.get('type') === 'thread' && !threadRunSettled(item));
      return !runningThread;
    }, { timeoutMs, label: 'idle after root-vantage cancel' });
  }

  /**
   * Wait until a tool-action has STARTED executing OR has already finished —
   * i.e. it has left the pending/approval phase. Use this only to SEQUENCE
   * after an approval (e.g. assert selection handoff once a tool is dispatched);
   * it deliberately also resolves on the terminal state because a fast tool's
   * RUNNING→completed edge can coalesce into one sync batch, so a strict
   * "is RUNNING right now" wait would hang. A test that must act WHILE a tool is
   * still running (cancel mid-execution) must pin it with a paused mock and use
   * waitForMockPaused — NOT this.
   * @param {string} toolUseId - Tool use ID to wait for
   * @param {number} [timeoutMs=5000] - Timeout in milliseconds
   * @returns {Promise<void>}
   */
  async waitForExecution(toolUseId, timeoutMs = 5000) {
    // Durable: resolve once the tool has STARTED executing (RUNNING) or has
    // already finished (terminal state / has a result). Waiting strictly for
    // the RUNNING edge is racy — a fast tool's RUNNING→completed transition
    // can coalesce into a single sync batch, so the viewer may never observe
    // RUNNING. "Has started or finished executing" is the durable condition;
    // paused/long-running tools (cancel tests) still resolve on RUNNING.
    await this._waitForCondition(items => findItemRecursive(items, item => {
      if (item.get('toolUseId') !== toolUseId) return false;
      const state = item.get('state');
      const result = item.get('result');
      return state === TOOL_STATES.RUNNING ||
				state === TOOL_STATES.COMPLETED ||
				state === TOOL_STATES.CANCELLED ||
				(result !== null && result !== undefined);
    }), { timeoutMs, label: `execution started ${toolUseId}` });
  }

  /**
   * Clean up test resources.
   * Just clears references - runIntegrationTest handles session deletion.
   * @returns {Promise<void>}
   */
  async teardown() {
    // Clean up any active progress captures
    for (const [_toolUseId, capture] of this._progressCaptures.entries()) {
      document.removeEventListener('action-progress', /** @type {EventListener} */ (capture.handler));
    }
    this._progressCaptures.clear();

    // Restore any installed toolExecutor wrapper
    this._uninstallToolExecCounter();


    // Destroy session: this calls conv.destroy() on each conversation
    // (which detaches Yjs observers and frees the doc) and calls
    // workerManager.terminateAll(). Without this, the 248-test
    // single-page suite leaks observers and DOM references across
    // every prior test's session.
    if (this._session && typeof this._session.destroy === 'function') {
      try { this._session.destroy(); } catch (_e) { /* ignore */ }
    }

    this._conversations.clear();
    this._conversationOrder = [];
    this._conversation = null;
    this._session = null;
  }
}

export default IntegrationTestHarness;
