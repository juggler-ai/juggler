//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * UI Test Harness - wraps IntegrationTestHarness with real UI rendering.
 * Mounts a conversation-tab in the DOM, wires events, and provides
 * a UIDriver for DOM-based interaction and querying.
 * @module test/utilities/ui-test-harness
 */

import { IntegrationTestHarness } from './test-harness.js';
import { waitForTurnComplete } from './turn-sync.js';
import UIDriver from './ui-driver.js';
import { deadlineFor } from './test-deadline.js';

/**
 * @typedef {import('./test-harness.js').TestHarnessOptions} TestHarnessOptions
 */

/**
 * UI-aware test harness that renders real UI components
 * and interacts through the DOM.
 */
export class UITestHarness {
  /**
   * @param {TestHarnessOptions} options - Same options as IntegrationTestHarness
   */
  constructor(options) {
    /** @type {TestHarnessOptions} @private */
    this._options = options;

    /** @type {IntegrationTestHarness|null} @private */
    this._innerHarness = null;

    /** @type {HTMLElement|null} @private */
    this._container = null;

    /** @type {HTMLElement|null} @private */
    this._conversationTab = null;

    /** @type {UIDriver|null} @private */
    this._driver = null;

    /** @type {((event: Event) => void)|null} @private */
    this._sendMessageHandler = null;

    /** @type {Promise<void>|null} @private - Tracks the most recent sendMessage() call */
    this._pendingSend = null;

    /** @type {{[key: string]: any}} - Named result captures for capture-tool-result / assert-tool-result-changed operations */
    this._capturedResults = {};
  }

  /**
   * The UIDriver for DOM interaction.
   * @returns {UIDriver} The UI driver instance
   */
  get driver() {
    if (!this._driver) throw new Error('UITestHarness not set up');
    return this._driver;
  }

  /**
   * Access the inner IntegrationTestHarness for Yjs-level operations.
   * @returns {IntegrationTestHarness} The inner harness
   */
  get innerHarness() {
    if (!this._innerHarness) throw new Error('UITestHarness not set up');
    return this._innerHarness;
  }

  /**
   * Proxy to inner harness conversation.
   * @returns {import('../../model/conversation.js').default} The conversation
   */
  get conversation() {
    return this.innerHarness.conversation;
  }

  /**
   * Proxy to inner harness root thread.
   * @returns {import('../../model/message-thread.js').default} The root message thread
   */
  get rootThread() {
    return this.innerHarness.rootThread;
  }

  /**
   * Proxy to inner harness — IDs of conversations this test created.
   * @returns {string[]} Conversation IDs created by this test.
   */
  conversationIds() {
    return this.innerHarness.conversationIds();
  }

  /**
   * Set up the test environment:
   * 1. Create and set up inner IntegrationTestHarness
   * 2. Mount conversation-tab in the DOM
   * 3. Wire send-message events
   * 4. Create UIDriver
   * @returns {Promise<void>}
   */
  async setup() {
    // 1. Create and set up inner harness (session, conversation, mock LLM)
    this._innerHarness = new IntegrationTestHarness(this._options);
    // The runner sets the per-test deadline + abort on THIS wrapper, but the
    // condition waits (cancelExecution, rerunTool, waitForExecution, …) run on
    // the inner harness — forward them so those waits actually stay patient up
    // to the deadline and tear down on abort instead of firing on their short
    // caller sub-timeouts.
    this._innerHarness._perTestDeadlineMs = this._perTestDeadlineMs || 0;
    this._innerHarness._abortSignal = this._abortSignal || null;
    await this._innerHarness.setup();

    // 2. Create DOM container
    this._container = document.createElement('div');
    this._container.id = 'ui-test-mount';
    this._container.style.cssText = 'position:absolute;top:0;left:0;width:100vw;height:100vh;';
    document.body.appendChild(this._container);

    // 3. Create and mount conversation-tab
    this._conversationTab = document.createElement('conversation-tab');
    this._container.appendChild(this._conversationTab);

    // 4. Wire the conversation to the tab, then activate it. setActive()
    //    flips _isHidden=false and triggers _syncWithConversation() →
    //    _rebuildColumns() which creates conversation-area, composer-box,
    //    conversation-controls. Without setActive() the tab stays hidden
    //    and columns never get built.
    const conversation = this._innerHarness.conversation;
    /** @type {any} */ (this._conversationTab).setConversation(conversation);
    /** @type {any} */ (this._conversationTab).setActive();

    // 5. Wire send-message event at document level (mirrors UIEventManager._setupInputHandler)
    this._sendMessageHandler = (event) => {
      const detail = /** @type {any} */ (event).detail;
      // Forward image-only sends too (empty message + staged attachments) —
      // mirrors UIEventManager, which forwards unconditionally.
      if (detail && (detail.message || (detail.attachments && detail.attachments.length))) {
        // Always use the current conversation — multi-conv tests switch it
        const conv = /** @type {any} */ (this._innerHarness).conversation;
        // Track the async sendMessage so tests can await delivery.
        // Forward staged image attachments (mirrors UIEventManager, which
        // passes detail.attachments through to conversation.sendMessage).
        this._pendingSend = conv.sendMessage(
          detail.message,
          detail.threadItemId || null,
          detail.messageThread || null,
          { attachments: detail.attachments || [] }
        );
      }
    };
    document.addEventListener('send-message', this._sendMessageHandler);

    // 6. Create UIDriver. It gets the per-test deadline for the same reason the
    // inner harness does: its DOM waits are bounded by the budget the runner
    // will actually fail on, not by their own nominal sub-timeouts.
    this._driver = new UIDriver(this._container, { deadlineMs: this._perTestDeadlineMs || 0 });

    // 7. Wait for initial DOM to settle.
    // setTimeout (a macrotask) — not requestAnimationFrame, because hidden
    // WKWebViews throttle rAF to near-zero, hanging the test.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 50));
  }

  /**
   * Clean up: remove DOM elements and tear down inner harness.
   * @returns {Promise<void>}
   */
  async teardown() {
    // Remove event listener
    if (this._sendMessageHandler) {
      document.removeEventListener('send-message', this._sendMessageHandler);
      this._sendMessageHandler = null;
    }

    // Remove DOM
    if (this._container && this._container.parentNode) {
      this._container.remove();
    }
    this._container = null;
    this._conversationTab = null;
    this._driver = null;

    // Tear down inner harness
    if (this._innerHarness) {
      await this._innerHarness.teardown();
      this._innerHarness = null;
    }
  }

  // =========================================================================
  // Turn synchronization (observer-based, reacts to every Yjs change)
  // =========================================================================

  /**
   * Wait for the current LLM turn to complete (idle or blocked on approval).
   * Delegates to the shared turn-completion fence (turn-sync.js), capturing the
   * turn epoch at entry: the UI executor calls this right after triggering an
   * action, so the worker's increment hasn't reached this view yet. Fencing on
   * the monotonic `completedTurns` is immune to Yjs sync-batch coalescing.
   * @param {number} [timeoutMs=6000] - Timeout in milliseconds
   * @param {number} [sinceTurn] - Turn epoch to fence on, captured BEFORE the
   *   action that started the turn. Omitting it falls back to the epoch at
   *   wait start — only correct when no turn can already be in flight.
   * @returns {Promise<void>} Resolves when idle (new turn done) or approval-blocked
   */
  async waitForTurnComplete(timeoutMs = 6000, sinceTurn = undefined) {
    await waitForTurnComplete(this.conversation, {
      sinceTurn: sinceTurn ?? this.conversation.completedTurns,
      deadlineMs: deadlineFor(timeoutMs, this._perTestDeadlineMs),
      signal: this._abortSignal,
      timeoutMs
    });
  }

  // =========================================================================
  // Delegate methods (pass through to inner harness for model-level ops)
  // =========================================================================

  /**
   * Read a file from the fixture.
   * @param {string} path - File path relative to fixture
   * @returns {Promise<string>} File content
   */
  async readFile(path) {
    return this.innerHarness.readFile(path);
  }

  /**
   * Wait for items array to reach a minimum count.
   * @param {number} minCount - Minimum items count
   * @param {number} [timeoutMs=5000] - Timeout
   * @returns {Promise<void>} Resolves when count reached
   */
  async waitForItemsSync(minCount, timeoutMs = 5000) {
    return this.innerHarness.waitForItemsSync(minCount, timeoutMs);
  }

  /**
   * Wait until the document snapshot matches the expected shape (see
   * {@link import('./test-harness.js').default#waitForDocumentMatch}).
   * @param {(snapshot: import('./golden-comparator.js').DocumentSnapshot) => boolean} matches
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<void>}
   */
  async waitForDocumentMatch(matches, timeoutMs = 5000) {
    return this.innerHarness.waitForDocumentMatch(matches, timeoutMs);
  }

  /**
   * Create a new conversation.
   * @param {string} [name] - Conversation name
   * @param {import('./test-harness.js').MockResponse[]} [llmResponses] - Explicit
   *   mock script for this conversation (see TestHarness.createConversation)
   * @returns {Promise<string>} Conversation ID
   */
  async createConversation(name, llmResponses) {
    const id = await this.innerHarness.createConversation(name, llmResponses);
    // Re-wire the conversation-tab to the new conversation so UI reflects it
    if (this._conversationTab && this._innerHarness) {
      /** @type {any} */ (this._conversationTab).setConversation(this._innerHarness.conversation);
    }
    return id;
  }

  /**
   * Duplicate a conversation.
   * @param {string} sourceId - Source conversation ID
   * @returns {Promise<string>} New conversation ID
   */
  async duplicateConversation(sourceId) {
    const id = await this.innerHarness.duplicateConversation(sourceId);
    if (this._conversationTab && this._innerHarness) {
      /** @type {any} */ (this._conversationTab).setConversation(this._innerHarness.conversation);
    }
    return id;
  }

  /**
   * Switch to a different conversation.
   * @param {string} conversationId - Target conversation ID
   */
  switchConversation(conversationId) {
    this.innerHarness.switchConversation(conversationId);
    // Re-wire the conversation-tab to the new conversation
    if (this._conversationTab && this._innerHarness) {
      /** @type {any} */ (this._conversationTab).setConversation(this._innerHarness.conversation);
    }
  }

  /**
   * Delete a conversation.
   * @param {string} conversationId - Conversation ID to delete
   * @returns {Promise<void>}
   */
  async deleteConversation(conversationId) {
    return this.innerHarness.deleteConversation(conversationId);
  }

  /**
   * Attempt to bin a conversation through the conversation-bar busy-guard
   * (the real action site every bin affordance routes through). Whether it
   * succeeds is the behaviour under test; assert on session state.
   * @param {string} conversationId - Conversation ID or $CONV_N placeholder
   * @returns {Promise<void>}
   */
  async binConversationViaBar(conversationId) {
    return this.innerHarness.binConversationViaBar(conversationId);
  }

  /**
   * Perform undo.
   * @returns {Promise<boolean>} True if undo was successful
   */
  async undo() {
    return this.innerHarness.undo();
  }

  /**
   * Perform redo.
   * @returns {Promise<boolean>} True if redo was successful
   */
  async redo() {
    return this.innerHarness.redo();
  }

  /**
   * Run a command.
   * @param {string} command - Command name
   * @param {string} [args] - Command arguments
   * @returns {Promise<void>}
   */
  async runCommand(command, args) {
    return this.innerHarness.runCommand(command, args);
  }

  /**
   * Run a command without fencing on anything it might start.
   * @param {string} command - Command name
   * @param {string} [args] - Command arguments
   * @returns {Promise<void>}
   */
  async runCommandNoWait(command, args) {
    return this.innerHarness.runCommandNoWait(command, args);
  }

  /**
   * Compact items up to an index.
   * @param {number} index - Index to compact up to
   * @returns {Promise<void>}
   */
  async compactUpTo(index) {
    return this.innerHarness.compactUpTo(index);
  }

  /**
   * Cancel execution.
   * @returns {Promise<void>}
   */
  async cancelExecution() {
    return this.innerHarness.cancelExecution();
  }

  /**
   * Stop from the root/parent vantage: stop the turn and close open sub-threads.
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async cancelFromRoot(timeoutMs) {
    return this.innerHarness.cancelFromRoot(timeoutMs);
  }

  /**
   * Wait for a paused mock response (MockResponse.PauseBeforeReturn).
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async waitForMockPaused(timeoutMs) {
    return this.innerHarness.waitForMockPaused(timeoutMs);
  }

  /**
   * Release a paused mock response.
   * @returns {void}
   */
  releaseMock() {
    this.innerHarness.releaseMock();
  }

  /**
   * Start capturing progress events.
   * @param {string} toolUseId
   */
  startCapturingProgress(toolUseId) {
    this.innerHarness.startCapturingProgress(toolUseId);
  }

  /**
   * Wait for progress events.
   * @param {string} toolUseId
   * @param {number} minEvents
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async waitForProgress(toolUseId, minEvents, timeoutMs) {
    return this.innerHarness.waitForProgress(toolUseId, minEvents, timeoutMs);
  }

  /**
   * Wait for a running action's accumulated output to contain a substring.
   * @param {string} toolUseId
   * @param {string} substring
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async waitForActionOutput(toolUseId, substring, timeoutMs) {
    return this.innerHarness.waitForActionOutput(toolUseId, substring, timeoutMs);
  }

  /**
   * Assert streaming chunks.
   * @param {string} toolUseId
   * @param {number} minChunks
   */
  assertStreamingChunks(toolUseId, minChunks) {
    this.innerHarness.assertStreamingChunks(toolUseId, minChunks);
  }

  /**
   * Register a Yjs observer that captures spinner visibility during non-idle processing.
   * @param {'main'|'sub'} threadType - Which column to check
   */
  startSpinnerCapture(threadType) {
    this.innerHarness.startSpinnerCapture(threadType);
  }

  /**
   * Assert that the spinner was visible when processingState last went non-idle.
   * @returns {Promise<void>}
   */
  async assertSpinnerWasVisible() {
    return this.innerHarness.assertSpinnerWasVisible();
  }

  /**
   * Start counting executeToolCall invocations for a toolUseId.
   * @param {string} toolUseId
   */
  startToolExecCounter(toolUseId) {
    this.innerHarness.startToolExecCounter(toolUseId);
  }

  /**
   * Assert the number of executeToolCall invocations since
   * startToolExecCounter was called.
   * @param {string} toolUseId
   * @param {number} expected
   */
  assertToolExecCount(toolUseId, expected) {
    this.innerHarness.assertToolExecCount(toolUseId, expected);
  }

  /**
   * Wait for tool execution to complete.
   * @param {string} toolUseId
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async waitForExecution(toolUseId, timeoutMs) {
    return this.innerHarness.waitForExecution(toolUseId, timeoutMs);
  }

  /**
   * Rerun a tool and wait for the rerun's turn to complete (durable fence;
   * patience comes from the per-test deadline).
   * @param {string} toolUseId
   * @returns {Promise<void>}
   */
  async rerunTool(toolUseId) {
    return this.innerHarness.rerunTool(toolUseId);
  }

  /**
   * Rerun a tool without waiting for it to complete.
   * @param {string} toolUseId
   * @returns {Promise<void>}
   */
  async rerunToolNoWait(toolUseId) {
    return this.innerHarness.rerunToolNoWait(toolUseId);
  }

  /**
   * Trigger the JS-side cancel flow that Escape would invoke when an LLM
   * turn is active. Used to test cancellation while a rerun is stuck.
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async cancelViaUIFlow(timeoutMs) {
    return this.innerHarness.cancelViaUIFlow(timeoutMs);
  }

  /**
   * Send a thread message (delegates to inner harness).
   * @param {string} message
   * @returns {Promise<void>}
   */
  async sendThreadMessage(message) {
    return this.innerHarness.sendThreadMessage(message);
  }

  /**
   * Send a thread message without waiting for the turn (delegates to inner harness).
   * @param {string} message
   * @returns {Promise<void>}
   */
  async sendThreadMessageNoWait(message) {
    return this.innerHarness.sendThreadMessageNoWait(message);
  }

  /**
   * Simulate disconnect.
   * @param {number} [reconnectMs]
   * @returns {Promise<void>}
   */
  async simulateDisconnect(reconnectMs) {
    return this.innerHarness.simulateDisconnect(reconnectMs);
  }

  /**
   * Wait for state condition.
   * @param {object} condition
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async waitForState(condition, timeoutMs) {
    return this.innerHarness.waitForState(condition, timeoutMs);
  }

  /**
   * Wait for approval (model-level).
   * @param {string} toolUseId
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async waitForApproval(toolUseId, timeoutMs) {
    return this.innerHarness.waitForApproval(toolUseId, timeoutMs);
  }

  /**
   * Wait for thread approval (model-level).
   * @param {string} toolUseId
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async waitForThreadApproval(toolUseId, timeoutMs) {
    return this.innerHarness.waitForThreadApproval(toolUseId, timeoutMs);
  }

  /**
   * Resolve thread approval (model-level).
   * @param {string} toolUseId
   * @param {string} response
   * @returns {Promise<void>}
   */
  async resolveThreadApproval(toolUseId, response) {
    return this.innerHarness.resolveThreadApproval(toolUseId, response);
  }

  /**
   * Resolve thread approval without waiting (model-level).
   * @param {string} toolUseId
   * @param {string} response
   */
  resolveThreadApprovalNoWait(toolUseId, response) {
    this.innerHarness.resolveThreadApprovalNoWait(toolUseId, response);
  }

  // =========================================================================
  // Public methods for operation executor (avoids private API access)
  // =========================================================================

  /**
   * Await and clear the pending sendMessage promise from the UI event handler.
   * @returns {Promise<void>}
   */
  async awaitPendingSend() {
    if (this._pendingSend) {
      const dropped = await this._pendingSend;
      this._pendingSend = null;
      // conversation.sendMessage resolves with a reason string when one of
      // its guards dropped the message (processing, no strategy). A test
      // that proceeds past a dropped send rides its turn fence to the
      // per-test timeout with a misleading error — fail here instead.
      if (dropped) {
        throw new Error(`send-message was dropped by conversation.sendMessage (${dropped})`);
      }
    }
  }

  /**
   * Mark that a mock response has been consumed by a send-message operation.
   */
  consumeResponse() {
    this.innerHarness.consumeResponse();
  }

  /**
   * Resolve a tool approval without waiting for idle.
   * @param {string} toolUseId
   * @param {string} response
   */
  resolveApprovalNoWait(toolUseId, response) {
    this.innerHarness.resolveApprovalNoWait(toolUseId, response);
  }
}

export default UITestHarness;
