//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * UI Driver - DOM interaction and query utilities for UI-level integration tests.
 * Knows how to interact with Juggler UI components:
 * type text and send messages, click approve/deny, wait for DOM state changes.
 * @module test/utilities/ui-driver
 */

import { getMessageSelector } from './test-assertions.js';
import { budgetFor } from './test-deadline.js';

/**
 * @typedef {object} RenderedMessage
 * @property {string} type - Element tag name (e.g., 'user-message', 'assistant-message')
 * @property {string} itemId - The message-id attribute
 * @property {HTMLElement} element - The DOM element
 */

/**
 * UI Driver for headless browser tests.
 * Waiting methods use MutationObserver with polling fallback.
 */
class UIDriver {
  /**
   * @param {HTMLElement} container - DOM element containing the conversation-tab
   * @param {{deadlineMs?: number}} [opts] - Per-test deadline the waits ride
   */
  constructor(container, { deadlineMs = 0 } = {}) {
    /** @type {HTMLElement} @private */
    this._container = container;

    /**
     * Absolute time the runner will fail this test at, or 0 when unknown.
     * @type {number}
     * @private
     */
    this._perTestDeadlineMs = deadlineMs;
  }

  /**
   * How long a wait may run for.
   *
   * The per-test deadline is the one real bound (the same rule turn-sync.js
   * applies to the model-level waits): stay patient right up to it, so a lane
   * competing with eight others for one machine isn't cut off by a nominal
   * sub-timeout chosen when a lane had the pool to itself, and never past it, so
   * a wait started late can't overrun the budget. The +1s lets the runner's own
   * hard timeout fire first, which reports the operation trace rather than the
   * bare wait. `fallbackMs` applies only when no deadline was supplied.
   * @param {number} fallbackMs - Nominal timeout to use with no deadline set
   * @returns {number} Milliseconds this wait may take
   * @private
   */
  _budget(fallbackMs) {
    // A driver built without an explicit deadline — every unit suite builds
    // its own — falls back to the one armed for the test in progress, so those
    // waits ride the budget too instead of reverting to a nominal chosen when
    // a lane had the pool to itself.
    return budgetFor(fallbackMs, this._perTestDeadlineMs);
  }

  // =========================================================================
  // Interaction
  // =========================================================================

  /**
   * Type a message into the composer-box and send it.
   * Sets the textarea value then calls composer.sendMessage(),
   * which dispatches the real 'send-message' CustomEvent.
   * @param {string} message - Message text to send
   */
  async typeAndSend(message) {
    const composer = this.getComposer();
    if (!composer) {
      throw new Error('UIDriver: composer-box not found in container');
    }

    const textarea = composer.querySelector('textarea');
    if (!textarea) {
      throw new Error('UIDriver: textarea not found inside composer-box');
    }

    // Set value and dispatch input event (mirrors real typing)
    textarea.value = message;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // Call the component's sendMessage method (dispatches send-message CustomEvent).
    // sendMessage is async — it awaits any @-mention context-item creation
    // before dispatching — so we await the full flow here. After this resolves,
    // the document already has the file-content items and the user message has
    // been kicked off via the harness's listener.
    //
    // A blocked send must FAIL the test here, not later: the composer's
    // guards (visible conversation processing, busy thread items) decline
    // silently by design for humans, but a test that proceeds after an
    // unsent message rides its turn fence to the per-test timeout with a
    // misleading "turn complete" error.
    const blocked = await /** @type {any} */ (composer).sendMessage();
    if (blocked) {
      throw new Error(`UIDriver: composer-box refused to send "${message}" (${blocked})`);
    }
  }

  /**
   * Click the approve button on an action-confirmation dialog for a tool.
   * @param {string} toolUseId - The tool use ID to approve
   * @param {string} [_response] - Custom response value (for AskUserQuestion answers)
   */
  async clickApprove(toolUseId, _response) {
    const confirmation = await this._findActionConfirmation(toolUseId);
    if (!confirmation) {
      throw new Error(`UIDriver: action-confirmation not found for toolUseId=${toolUseId}`);
    }

    // Find the approve button (primary style, first button typically)
    const buttons = Array.from(confirmation.querySelectorAll('.action-confirmation-button'));
    let approveButton = null;

    for (const btn of buttons) {
      const value = btn.getAttribute('data-value');
      // 'yes' or 'yes-always' are approve actions
      if (value === 'yes' || value === 'yes-always' || value === 'approved') {
        approveButton = btn;
        break;
      }
    }

    // Fallback: first button with primary style
    if (!approveButton) {
      approveButton = confirmation.querySelector('.action-confirmation-button.primary');
    }

    // Last fallback: first button
    if (!approveButton) {
      approveButton = buttons[0];
    }

    if (!approveButton) {
      throw new Error(`UIDriver: no approve button found in action-confirmation for toolUseId=${toolUseId}`);
    }

    /** @type {HTMLElement} */ (approveButton).click();
  }

  /**
   * Click the deny/cancel button on an action-confirmation dialog for a tool.
   * @param {string} toolUseId - The tool use ID to deny
   */
  async clickDeny(toolUseId) {
    const confirmation = await this._findActionConfirmation(toolUseId);
    if (!confirmation) {
      throw new Error(`UIDriver: action-confirmation not found for toolUseId=${toolUseId}`);
    }

    const buttons = Array.from(confirmation.querySelectorAll('.action-confirmation-button'));
    let denyButton = null;

    for (const btn of buttons) {
      const value = btn.getAttribute('data-value');
      if (value === 'no' || value === 'cancel' || value === 'denied') {
        denyButton = btn;
        break;
      }
    }

    // Fallback: button with danger style
    if (!denyButton) {
      denyButton = confirmation.querySelector('.action-confirmation-button.danger');
    }

    if (!denyButton) {
      throw new Error(`UIDriver: no deny button found in action-confirmation for toolUseId=${toolUseId}`);
    }

    /** @type {HTMLElement} */ (denyButton).click();
  }

  // =========================================================================
  // Waiting (MutationObserver-based)
  // =========================================================================

  /**
   * Wait for a message element matching a predicate to appear in the DOM.
   * @param {(el: HTMLElement) => boolean} predicate - Function to test each message element
   * @param {number} [timeoutMs=10000] - Timeout in milliseconds
   * @returns {Promise<HTMLElement>} The matching element
   */
  async waitForMessage(predicate, timeoutMs = 10000) {
    // Check immediately
    const existing = this._findMessage(predicate);
    if (existing) return existing;

    return this._observeUntil(() => this._findMessage(predicate), timeoutMs,
      'waitForMessage: no matching message appeared');
  }

  /**
   * Wait for an action-confirmation dialog to appear for a tool.
   * @param {string} toolUseId - Tool use ID
   * @param {number} [timeoutMs=10000] - Timeout
   * @returns {Promise<HTMLElement>} The action-confirmation element
   */
  async waitForApprovalDialog(toolUseId, timeoutMs = 10000) {
    return this._observeUntil(() => this._findActionConfirmation(toolUseId), timeoutMs,
      `waitForApprovalDialog: no dialog appeared for toolUseId=${toolUseId}`);
  }

  /**
   * Wait for an element matching a CSS selector to appear.
   * @param {string} selector - CSS selector
   * @param {number} [timeoutMs=10000] - Timeout
   * @returns {Promise<HTMLElement>} The matching element
   */
  async waitForElement(selector, timeoutMs = 10000) {
    const existing = /** @type {HTMLElement|null} */ (this._container.querySelector(selector));
    if (existing) return existing;

    return this._observeUntil(
      () => /** @type {HTMLElement|null} */ (this._container.querySelector(selector)),
      timeoutMs,
      `waitForElement: selector "${selector}" not found`
    );
  }

  /**
   * Wait for the DOM subtree to stabilize (no mutations for stabilityMs).
   *
   * "The DOM is still moving" is never a fault on its own — a lane whose renders
   * are being interleaved with eight siblings' simply takes longer to go quiet —
   * so the overall bound is the per-test deadline rather than `timeoutMs`, which
   * stands in only when no deadline is set.
   * @param {number} [stabilityMs=50] - Required quiet period
   * @param {number} [timeoutMs=3000] - Overall timeout when no deadline is set
   * @returns {Promise<void>}
   */
  async waitForDOMStable(stabilityMs = 50, timeoutMs = 3000) {
    const budgetMs = this._budget(timeoutMs);
    const conversationArea = this.getConversationArea();
    const target = conversationArea || this._container;

    return new Promise((resolve, reject) => {
      let stableTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
      let overallTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);

      const observer = new MutationObserver(() => {
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
          observer.disconnect();
          if (overallTimer) clearTimeout(overallTimer);
          resolve();
        }, stabilityMs);
      });

      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });

      stableTimer = setTimeout(() => {
        observer.disconnect();
        if (overallTimer) clearTimeout(overallTimer);
        resolve();
      }, stabilityMs);

      overallTimer = setTimeout(() => {
        observer.disconnect();
        if (stableTimer) clearTimeout(stableTimer);
        reject(new Error(`waitForDOMStable: DOM did not stabilize within ${budgetMs}ms`));
      }, budgetMs);
    });
  }

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * Get all rendered message elements from the conversation area.
   * @returns {RenderedMessage[]} Array of rendered message descriptors
   */
  getRenderedMessages() {
    const conversationArea = this.getConversationArea();
    if (!conversationArea) return [];

    const selector = getMessageSelector();

    const elements = conversationArea.querySelectorAll(selector);
    return Array.from(elements).map(el => ({
      type: el.tagName.toLowerCase(),
      itemId: el.getAttribute('message-id') || '',
      element: /** @type {HTMLElement} */ (el)
    }));
  }

  /**
   * Get all tool-action-message elements.
   * @returns {HTMLElement[]} Tool action message elements
   */
  getToolActionElements() {
    const conversationArea = this.getConversationArea();
    if (!conversationArea) return [];
    return Array.from(conversationArea.querySelectorAll('tool-action-message[message-id]'));
  }

  /**
   * Get the composer-box element.
   * @returns {HTMLElement|null} The composer-box element or null
   */
  getComposer() {
    return this._container.querySelector('composer-box');
  }

  /**
   * Get the conversation-area element.
   * @returns {HTMLElement|null} The conversation-area element or null
   */
  getConversationArea() {
    return this._container.querySelector('conversation-area');
  }

  /**
   * Get the root container element.
   * @returns {HTMLElement} The container element
   */
  getContainer() {
    return this._container;
  }

  /**
   * Get the message-id of the currently selected item in the root conversation-area.
   * @returns {string|null} The selected item's message-id, or null if nothing selected
   */
  getSelectedItemId() {
    const conversationArea = this.getConversationArea();
    if (!conversationArea) return null;
    const selected = conversationArea.querySelector('.conversation-item.selected');
    return selected ? selected.getAttribute('message-id') : null;
  }

  /**
   * Get the number of open thread columns (conversation-area elements with thread-column class).
   * @returns {number} Count of thread columns
   */
  getThreadColumnCount() {
    return this._container.querySelectorAll('conversation-area.thread-column').length;
  }

  /**
   * Check if an approval dialog exists for a tool.
   * @param {string} toolUseId - Tool use ID
   * @returns {boolean} True if dialog exists
   */
  hasApprovalDialog(toolUseId) {
    return this._findActionConfirmation(toolUseId) !== null;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /**
   * Find a message element matching a predicate.
   * @param {(el: HTMLElement) => boolean} predicate - Test function
   * @returns {HTMLElement|null} Matching element or null
   * @private
   */
  _findMessage(predicate) {
    const messages = this.getRenderedMessages();
    for (const msg of messages) {
      if (predicate(msg.element)) return msg.element;
    }
    return null;
  }

  /**
   * Find the tool-action-message element for a given toolUseId.
   * @param {string} toolUseId - Tool use ID to find
   * @returns {HTMLElement|null} Matching tool-action-message or null
   * @private
   */
  _findToolActionByToolUseId(toolUseId) {
    const conversationArea = this.getConversationArea();
    if (!conversationArea) return null;
    return conversationArea.querySelector(`tool-action-message[data-tool-use-id="${toolUseId}"]`);
  }

  /**
   * Find the action-confirmation element inside the tool-action-message for a toolUseId.
   * @param {string} toolUseId - Tool use ID to find
   * @returns {HTMLElement|null} The action-confirmation element or null
   * @private
   */
  _findActionConfirmation(toolUseId) {
    const toolAction = this._findToolActionByToolUseId(toolUseId);
    if (!toolAction) return null;
    return toolAction.querySelector('action-confirmation');
  }

  /**
   * Observe the container's subtree for mutations and check a condition after each.
   * @template T
   * @param {() => T|null} check - Function that returns a truthy value when condition is met
   * @param {number} timeoutMs - Timeout to use when no per-test deadline is set
   * @param {string} errorMessage - Error message on timeout
   * @returns {Promise<T>} Resolved value from check function
   * @private
   */
  _observeUntil(check, timeoutMs, errorMessage) {
    const budgetMs = this._budget(timeoutMs);
    return new Promise((resolve, reject) => {
      // Check immediately before observing
      const immediate = check();
      if (immediate) {
        resolve(immediate);
        return;
      }

      const observer = new MutationObserver(() => {
        // A macrotask after each mutation lets Web Component renders
        // settle before evaluating; predicate is then re-checked.
        // setTimeout, not rAF — hidden WKWebViews throttle rAF.
        setTimeout(() => {
          const result = check();
          if (result) {
            observer.disconnect();
            clearTimeout(timer);
            resolve(result);
          }
        }, 0);
      });

      const target = this.getConversationArea() || this._container;
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(errorMessage));
      }, budgetMs);
    });
  }
}

export default UIDriver;
