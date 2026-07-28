//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import contextItemRegistry from '../registries/context-item-registry.js';
import { renderResultStatusMessage } from '../../sdk/lib/html.js';
import {
  TOOL_STATES,
  ACTION_STATES
} from '../../sdk/lib/message.js';
import { wrapWithIcon, createErrorArticle } from '../utils/icon-message-renderer.js';
import { iconOptionsForItem } from '../utils/item-badge.js';

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 * @typedef {import('../model/conversation.js').default} Conversation
 */

/**
 * Tool action item from Yjs - using import type for proper resolution
 * @typedef {import('../../sdk/lib/message.js').ToolActionMessage} ToolActionItem
 */

/**
 * ActionType class constructor type (from registry lookup).
 * Note: We use 'new (...args: any[]) => any' because this code instantiates
 * action classes with just an id string for UI rendering, not full ActionContext.
 * @typedef {{ new (...args: any[]): any, MANIFEST?: { id?: string, name?: string, icon?: string }, prototype: { getStatusUI?: Function }, getToolDefinitions?: () => Array<{name: string}> }} ActionTypeClass
 */

/**
 * ContextItemType class constructor type (from registry lookup)
 * @typedef {{ MANIFEST?: { id?: string, name?: string }, getToolDefinitions?: () => Array<{name: string}> }} ContextItemTypeClass
 */

/**
 * conversation-area element with conversation property
 * @typedef {HTMLElement & { conversation: Conversation }} ConversationAreaElement
 */

/**
 * action-confirmation element with setOptions method
 * @typedef {import('./action-confirmation.js').ActionConfirmationOptions} ActionConfirmationOptions
 * @typedef {HTMLElement & { setOptions: (options: ActionConfirmationOptions, resolve: (value: string) => void, extra?: {onRevise?: Function}) => void }} ActionConfirmationElement
 */

/**
 * Action result from fullResult - loosely typed as it comes from various action plugins
 * @typedef {Record<string, any>} ActionResult
 */

/**
 * Self-contained component for rendering tool-action messages.
 * Handles all states internally:
 * - Pending approval (state='pending')
 * - Running (state='running')
 * - Completed (state='completed' or 'cancelled')
 *
 * Observes Yjs for changes to its own item and re-renders automatically.
 */
class ToolActionMessage extends HTMLElement {
  /** @type {Function|null} @private */
  _yjsObserver = null;

  /** @type {{state: string|undefined, hasResult: boolean, resultIsError: boolean, hasApprovalOptions: boolean, displayDataJson: string, reviewStatusJson: string}|null} @private */
  _lastSnapshot = null;

  connectedCallback() {
    this.classList.add('conversation-item');
    this._setupYjsObserver();
    this.render();
  }

  disconnectedCallback() {
    this._cleanupObserver();
  }

  /**
   * Get the message ID from the attribute
   * @returns {string|null} The message ID or null
   */
  get itemId() {
    return this.getAttribute('message-id');
  }

  /**
   * Set up Yjs observer to watch for changes to this element's item
   * @private
   */
  _setupYjsObserver() {
    const conversation = this._getConversation();
    if (!conversation) return;
    const messageThread = this._getMessageThread();
    if (!messageThread) return;

    const itemId = this.itemId;
    if (!itemId) return;

    // Capture initial state
    this._lastSnapshot = this._snapshot(this._getItem());

    // Observe Yjs items array
    this._yjsObserver = () => {
      const item = this._getItem();
      const newSnapshot = this._snapshot(item);
      if (this._hasChanged(newSnapshot)) {
        const prevSnapshot = this._lastSnapshot;
        this._lastSnapshot = newSnapshot;
        // While a live approval widget is mounted, a displayData-only churn
        // must not tear it down and rebuild: render() does innerHTML='' which
        // recreates the buttons under the user's cursor. A button moving (or
        // being replaced) mid-click reassigns the native click target to a
        // neighbouring item — the source of the "approve clicked, neighbour
        // selected" bug. The command/diff being approved is fixed at request
        // time, so suppressing the rebuild loses nothing visible.
        // A reviewStatus-only change (a strategy's onToolPending reviewer
        // starting/finishing) must likewise avoid the destructive re-render:
        // update the indicator in place so the live buttons stay put.
        if (this._isReviewStatusChurn(prevSnapshot, newSnapshot)) {
          this._applyReviewStatus(this._getItem());
          return;
        }
        if (this._isPendingApprovalChurn(prevSnapshot, newSnapshot)) return;
        this.render();
        // Tool state changes (e.g. RUNNING→COMPLETED) affect isProcessing;
        // field-level Yjs changes don't fire conversation:changed, so we
        // must push a footer refresh here.
        const conversationArea = /** @type {any} */ (this.closest('conversation-area'));
        conversationArea?.updateFooter?.();
      }
    };

    messageThread.yarray.observeDeep(this._yjsObserver);
  }

  /**
   * Create a snapshot of item fields we care about for change detection
   * @param {ToolActionItem|null} item - The item to snapshot
   * @returns {{state: string|undefined, hasResult: boolean, resultIsError: boolean, hasApprovalOptions: boolean, displayDataJson: string, reviewStatusJson: string}|null} Snapshot object or null
   * @private
   */
  _snapshot(item) {
    if (!item) return null;
    const displayData = item.get('displayData');
    const resultMap = item.get('result');
    const isError = resultMap?.get ? resultMap.get('isError') : resultMap?.isError;
    const reviewStatus = item.get('reviewStatus');
    return {
      state: item.get('state'),
      hasResult: resultMap !== null && resultMap !== undefined,
      resultIsError: !!isError,
      hasApprovalOptions: !!item.get('approvalOptions'),
      displayDataJson: displayData ? JSON.stringify(displayData.toJSON ? displayData.toJSON() : displayData) : '',
      reviewStatusJson: reviewStatus ? JSON.stringify(reviewStatus.toJSON ? reviewStatus.toJSON() : reviewStatus) : ''
    };
  }

  /**
   * Check if item has changed from last snapshot
   * @param {{state: string|undefined, hasResult: boolean, resultIsError: boolean, hasApprovalOptions: boolean, displayDataJson: string, reviewStatusJson: string}|null} newSnapshot - New snapshot to compare
   * @returns {boolean} True if the item has changed
   * @private
   */
  _hasChanged(newSnapshot) {
    if (!this._lastSnapshot || !newSnapshot) return true;
    return this._lastSnapshot.state !== newSnapshot.state ||
               this._lastSnapshot.hasResult !== newSnapshot.hasResult ||
               this._lastSnapshot.resultIsError !== newSnapshot.resultIsError ||
               this._lastSnapshot.hasApprovalOptions !== newSnapshot.hasApprovalOptions ||
               this._lastSnapshot.displayDataJson !== newSnapshot.displayDataJson ||
               this._lastSnapshot.reviewStatusJson !== newSnapshot.reviewStatusJson;
  }

  /**
   * Whether a snapshot change is pure displayData churn on a tool-action that
   * is still PENDING with a live approval widget already mounted. In that case
   * the destructive re-render is suppressed so the approval buttons stay put
   * under the user's cursor. Requires the previous displayData to be non-empty
   * (this is churn, not the first paint of the command/diff) and an
   * action-confirmation to be present (the buttons are showing).
   * @param {ReturnType<ToolActionMessage['_snapshot']>} prev - Previous snapshot
   * @param {ReturnType<ToolActionMessage['_snapshot']>} next - New snapshot
   * @returns {boolean} True if the re-render should be suppressed
   * @private
   */
  _isPendingApprovalChurn(prev, next) {
    if (!prev || !next) return false;
    return prev.state === TOOL_STATES.PENDING &&
      next.state === TOOL_STATES.PENDING &&
      prev.hasApprovalOptions && next.hasApprovalOptions &&
      prev.hasResult === next.hasResult &&
      prev.resultIsError === next.resultIsError &&
      prev.displayDataJson !== '' &&
      !!this.querySelector('action-confirmation');
  }

  /**
   * Whether a snapshot change is a pure `reviewStatus` change on a tool-action
   * that is still PENDING with a live approval widget mounted — i.e. a
   * strategy's onToolPending reviewer starting or finishing. In that case the
   * indicator is toggled in place (see `_applyReviewStatus`) so the approval
   * buttons are never rebuilt under the user's cursor. Requires everything else
   * (state, result, displayData, approval options) unchanged and an
   * action-confirmation present.
   * @param {ReturnType<ToolActionMessage['_snapshot']>} prev - Previous snapshot
   * @param {ReturnType<ToolActionMessage['_snapshot']>} next - New snapshot
   * @returns {boolean} True if only reviewStatus changed on a mounted approval widget
   * @private
   */
  _isReviewStatusChurn(prev, next) {
    if (!prev || !next) return false;
    return prev.state === TOOL_STATES.PENDING &&
      next.state === TOOL_STATES.PENDING &&
      prev.hasApprovalOptions && next.hasApprovalOptions &&
      prev.hasResult === next.hasResult &&
      prev.resultIsError === next.resultIsError &&
      prev.displayDataJson === next.displayDataJson &&
      prev.reviewStatusJson !== next.reviewStatusJson &&
      !!this.querySelector('action-confirmation');
  }

  /**
   * Show/hide the transient "reviewing…" indicator in place, without a
   * destructive re-render. Adds a `.approval-review-status` row directly above
   * the approval buttons when `reviewStatus.busy`, updates its label, or removes
   * it otherwise. Never touches the buttons themselves.
   * @param {ToolActionItem|null} item - The tool action item
   * @private
   */
  _applyReviewStatus(item) {
    const container = /** @type {HTMLElement|null} */ (this.querySelector('.action-approval-container'));
    if (!item || !container) return;
    const reviewStatus = item.get('reviewStatus');
    const busy = reviewStatus?.get ? reviewStatus.get('busy') : reviewStatus?.busy;
    const label = reviewStatus?.get ? reviewStatus.get('label') : reviewStatus?.label;
    let row = /** @type {HTMLElement|null} */ (container.querySelector('.approval-review-status'));
    if (busy) {
      if (!row) {
        row = this._buildReviewStatusRow(label);
        const buttons = container.querySelector('action-confirmation');
        container.insertBefore(row, buttons);
      } else {
        const labelEl = row.querySelector('.approval-review-status-label');
        if (labelEl) labelEl.textContent = label || 'Reviewing…';
      }
    } else if (row) {
      row.remove();
    }
  }

  /**
   * Build the "reviewing…" indicator row (spinner + label). Purely additive —
   * rendered above the approval buttons; the buttons stay live.
   * @param {string} [label] - The review label to show
   * @returns {HTMLElement} The indicator row
   * @private
   */
  _buildReviewStatusRow(label) {
    const row = document.createElement('div');
    row.className = 'approval-review-status';
    const spinner = document.createElement('juggler-spinner');
    spinner.setAttribute('style', '--size: 1.5rem');
    spinner.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'approval-review-status-label';
    text.textContent = label || 'Reviewing…';
    row.appendChild(spinner);
    row.appendChild(text);
    return row;
  }

  /**
   * Find this element's item in the Yjs items array
   * @returns {ToolActionItem|null} The item or null if not found
   * @private
   */
  _getItem() {
    const conversation = this._getConversation();
    if (!conversation) return null;

    const itemId = this.itemId;
    const messageThread = this._getMessageThread();
    const items = messageThread ? messageThread.items : [];
    const item = items.find(
      (/** @type {any} */ item) =>
        item.get && item.get('itemId') === itemId
    );
    return /** @type {ToolActionItem|null} */ (item ?? null);
  }

  /**
   * Get conversation reference from parent conversation-area
   * @returns {Conversation|null} The conversation instance or null
   * @private
   */
  _getConversation() {
    const conversationArea = /** @type {ConversationAreaElement|null} */ (
      this.closest('conversation-area')
    );
    if (!conversationArea) return null;
    return conversationArea.conversation || null;
  }

  /**
   * Get message thread from parent conversation-area
   * @returns {import('../model/message-thread.js').default|null} Message thread or null
   * @private
   */
  _getMessageThread() {
    const conversationArea = /** @type {any} */ (this.closest('conversation-area'));
    return conversationArea?.getMessageThread?.() || null;
  }

  /**
   * Clean up the Yjs observer
   * @private
   */
  _cleanupObserver() {
    if (this._yjsObserver) {
      const messageThread = this._getMessageThread();
      if (messageThread?.yarray) {
        messageThread.yarray.unobserveDeep(this._yjsObserver);
      }
      this._yjsObserver = null;
      this._lastSnapshot = null;
    }
  }

  /**
   * Get busy state for this tool action.
   * Running (no result, not pending approval) shows tool name with spinner.
   * @returns {null|{message: string, spinner: boolean}} Busy state or null
   */
  getBusyState() {
    const item = this._getItem();
    if (!item) return null;
    const state = item.get('state');
    if (state !== TOOL_STATES.RUNNING && state !== TOOL_STATES.APPROVED) return null;
    // Convergence guard: a settled `result` means terminal, whatever `state` says.
    // A late APPROVED→RUNNING claim (claimRunning) can win the Yjs LWW on `state`
    // against the worker's concurrent `state='cancelled'`, leaving
    // state=running + result=interrupted. The worker is the sole writer of
    // results, so a present result is authoritative — without this the spinner
    // sticks on "Running …" forever. Regression: cancel in the approved→running window.
    const result = item.get('result');
    if (result !== null && result !== undefined) return null;
    const toolName = item.get('toolName') || 'tool';
    return { message: `Running ${toolName}...`, spinner: true };
  }

  /**
   * Main render method - determines state and renders appropriate UI
   */
  render() {
    // Clear any existing content
    this.innerHTML = '';

    const item = this._getItem();
    if (!item) return;

    // Expose toolUseId as a DOM attribute for test selectors
    const toolUseId = item.get('toolUseId');
    if (toolUseId) this.setAttribute('data-tool-use-id', toolUseId);

    // Route to appropriate renderer based on state
    const state = item.get('state');
    const result = item.get('result');
    if (state === TOOL_STATES.PENDING) {
      this._renderPendingApproval(item);
    } else if (state === TOOL_STATES.CANCELLED) {
      this._renderCancelled(item);
    } else if (result !== null && result !== undefined && (state === TOOL_STATES.RUNNING || state === TOOL_STATES.APPROVED || state === undefined)) {
      // Same race as getBusyState: a running/approved item that already carries a
      // settled result is terminal. Result wins — cancelled result → cancelled row.
      (result.get ? result.get('cancelled') : result.cancelled)
        ? this._renderCancelled(item)
        : this._renderResult(item);
    } else if (state === TOOL_STATES.RUNNING || state === TOOL_STATES.APPROVED || state === undefined) {
      this._renderRunning(item);
    } else {
      this._renderResult(item);
    }
  }

  /**
   * Render pending approval state with approval buttons
   * @param {ToolActionItem} item
   * @private
   */
  _renderPendingApproval(item) {
    const actionId = item.get('toolName');
    /** @type {ActionTypeClass|undefined} */
    const ActionClass = contextItemRegistry.getByToolName(actionId);
    const conversation = this._getConversation();

    // Create article wrapper for styling consistency
    const article = document.createElement('article');
    article.className = 'action';

    // Try to get custom UI from action plugin
    if (ActionClass && typeof ActionClass.prototype.getStatusUI === 'function') {
      try {
        const actionInstance = this._createActionForUI(ActionClass, actionId, conversation);
        if (!actionInstance) throw new Error('missing context');
        const displayData = item.get('displayData');
        const displayDataPlain = displayData?.toJSON ? displayData.toJSON() : displayData;
        const toolInput = item.get('toolInput');
        const toolInputPlain = toolInput?.toJSON ? toolInput.toJSON() : toolInput;
        const actionResult = {
          pending: true,
          actionId,
          displayData: displayDataPlain,
          state: item.get('state')
        };
        const statusConfig = actionInstance.getStatusUI(actionResult, toolInputPlain, {
          conversation,
          messageThread: this._getMessageThread(),
          session: conversation?.session,
          toolUseId: item.get('toolUseId')
        });

        if (statusConfig) {
          const customElement = renderResultStatusMessage(statusConfig);
          if (statusConfig.customFormElement) {
            // Multi-question: append form after status message, skip action-confirmation buttons
            const wrapper = document.createElement('div');
            wrapper.className = 'action-approval-container';
            wrapper.appendChild(customElement);
            wrapper.appendChild(statusConfig.customFormElement);
            article.appendChild(this._wrapWithIcon(wrapper));
          } else {
            const container = this._createApprovalContainer(customElement, item);
            article.appendChild(this._wrapWithIcon(container));
          }
          this.appendChild(article);
          return;
        }
      } catch (error) {
        console.error(`[ToolActionMessage] Error creating pending approval UI for ${actionId}:`, error);
      }
    }

    // Default fallback
    const container = document.createElement('div');
    container.className = 'action-approval-container';

    const label = document.createElement('div');
    label.className = 'pending-approval-label';
    label.textContent = `${actionId}: Waiting for approval...`;
    container.appendChild(label);

    // Add approval buttons
    this._appendApprovalButtons(container, item);

    article.appendChild(this._wrapWithIcon(container));
    this.appendChild(article);
  }

  /**
   * Render running state with streaming output
   * @param {ToolActionItem} item
   * @private
   */
  _renderRunning(item) {
    const actionId = item.get('toolName');
    /** @type {ActionTypeClass|undefined} */
    const ActionClass = contextItemRegistry.getByToolName(actionId);
    const conversation = this._getConversation();

    // Create article wrapper with processing indicator
    const article = document.createElement('article');
    article.className = 'action';
    article.setAttribute('data-processing', 'true');

    // Try to get custom UI from action plugin
    if (ActionClass && typeof ActionClass.prototype.getStatusUI === 'function') {
      try {
        const actionInstance = this._createActionForUI(ActionClass, actionId, conversation);
        if (!actionInstance) throw new Error('missing context');
        const displayData = item.get('displayData');
        const displayDataPlain = displayData?.toJSON ? displayData.toJSON() : displayData;
        const toolInput = item.get('toolInput');
        const toolInputPlain = toolInput?.toJSON ? toolInput.toJSON() : toolInput;
        const actionResult = {
          pending: true,  // Signals to getStatusUI to show streaming UI
          actionId,
          displayData: displayDataPlain,
          state: item.get('state')
        };
        const statusConfig = actionInstance.getStatusUI(actionResult, toolInputPlain, {
          conversation,
          messageThread: this._getMessageThread(),
          session: conversation?.session,
          toolUseId: item.get('toolUseId')
        });

        if (statusConfig) {
          const customElement = renderResultStatusMessage(statusConfig);
          article.appendChild(this._wrapWithIcon(customElement));
          this.appendChild(article);
          return;
        }
      } catch (error) {
        console.error(`[ToolActionMessage] Error creating running UI for ${actionId}:`, error);
      }
    }

    // Default fallback - simple running indicator
    const container = document.createElement('div');
    container.className = 'action-running-container';

    const label = document.createElement('div');
    label.className = 'running-label';
    label.textContent = `${actionId}: Running...`;
    container.appendChild(label);

    article.appendChild(this._wrapWithIcon(container));
    this.appendChild(article);
  }

  /**
   * Render cancelled state with optional retry button
   * @param {ToolActionItem} item
   * @private
   */
  _renderCancelled(item) {
    const toolName = item.get('toolName') || 'Action';
    const resultMap = item.get('result');
    const result = resultMap?.toJSON ? resultMap.toJSON() : resultMap;
    const conversation = this._getConversation();

    // Create article wrapper
    const article = document.createElement('article');
    article.className = 'action';

    // Try to use action's getStatusUI for custom rendering
    let statusElement;
    /** @type {ActionTypeClass|undefined} */
    const ActionClass = contextItemRegistry.getByToolName(toolName);
    if (ActionClass && typeof ActionClass.prototype.getStatusUI === 'function') {
      try {
        const actionInstance = this._createActionForUI(ActionClass, toolName, conversation);
        if (!actionInstance) throw new Error('missing context');
        const displayData = item.get('displayData');
        const displayDataPlain = displayData?.toJSON ? displayData.toJSON() : displayData;
        const toolInput = item.get('toolInput');
        const toolInputPlain = toolInput?.toJSON ? toolInput.toJSON() : toolInput;
        const actionStatus = {
          cancelled: result?.cancelled,
          actionId: toolName,
          displayData: displayDataPlain
        };
        const customConfig = actionInstance.getStatusUI(actionStatus, toolInputPlain, {
          conversation,
          messageThread: this._getMessageThread(),
          session: conversation?.session,
          toolUseId: item.get('toolUseId')
        });
        if (customConfig) {
          statusElement = renderResultStatusMessage(customConfig);
        }
      } catch (error) {
        console.error(`[ToolActionMessage] Error creating cancelled UI for ${toolName}:`, error);
      }
    }

    // Fallback
    if (!statusElement) {
      statusElement = renderResultStatusMessage({
        summary: `${toolName}: Cancelled`,
        status: 'cancelled'
      });
    }

    const container = document.createElement('div');
    container.className = 'cancelled-container';
    container.appendChild(statusElement);

    article.appendChild(this._wrapWithIcon(container));
    this.appendChild(article);
  }

  /**
   * Render completed result state (success or error)
   * @param {ToolActionItem} item
   * @private
   */
  _renderResult(item) {
    const resultMap = item.get('result');
    const fullResultMap = resultMap?.get ? resultMap.get('fullResult') : resultMap?.fullResult;
    const result = /** @type {ActionResult|undefined} */ (fullResultMap?.toJSON ? fullResultMap.toJSON() : fullResultMap);
    const conversation = this._getConversation();
    const itemToolName = item.get('toolName');

    // Get actionId from result, or look up by toolName
    let actionId = result?.actionId;
    /** @type {ActionTypeClass|undefined} */
    let ActionClass = actionId ? contextItemRegistry.get(actionId) : undefined;

    // If no result yet, try to find action by tool name
    if (!ActionClass && itemToolName) {
      ActionClass = contextItemRegistry.getByToolName(itemToolName);
      if (ActionClass) {
        actionId = ActionClass.MANIFEST?.id;
      }
    }

    // Check contextItemRegistry for context item plugin tools
    /** @type {ContextItemTypeClass|undefined} */
    let ContextItemClass;
    if (!actionId && itemToolName) {
      const allContextItems = contextItemRegistry.getAll();
      for (const { class: candidateClass } of allContextItems) {
        if (candidateClass.getToolDefinitions) {
          const tools = candidateClass.getToolDefinitions();
          if (tools.some((/** @type {{name: string}} */ t) => t.name === itemToolName)) {
            ContextItemClass = candidateClass;
            actionId = candidateClass.MANIFEST?.id;
            break;
          }
        }
      }
    }

    if (!actionId) {
      const resultContent = resultMap?.get ? resultMap.get('content') : resultMap?.content;
      const errorMessage = resultContent || result?.error || `Unknown tool: ${itemToolName}`;
      this.appendChild(createErrorArticle(errorMessage));
      return;
    }

    // Create article wrapper
    const article = document.createElement('article');

    // Determine state from result
    const state = result?.state || (result?.success !== undefined ? ACTION_STATES.COMPLETED : ACTION_STATES.RUNNING);
    const isApproval = state === ACTION_STATES.WAITING_FOR_APPROVAL;
    const isErrorState = state === ACTION_STATES.ERROR || (!result?.success && result?.error);

    // Set article class based on state
    if (isErrorState) {
      article.className = 'error';
    } else if (state === ACTION_STATES.CANCELLED) {
      article.className = 'status';
    } else {
      article.className = 'action';
    }

    // Try to get custom UI from action plugin
    if (ActionClass && typeof ActionClass.prototype.getStatusUI === 'function') {
      try {
        // Build actionResult based on state
        const resultContent = resultMap?.get ? resultMap.get('content') : resultMap?.content;
        const content = resultContent || '';
        let actionResult;
        if (isApproval) {
          actionResult = {
            pending: true,
            actionId,
            content,
            displayData: result?.approvalOptions
          };
        } else if (state === ACTION_STATES.RUNNING) {
          actionResult = { pending: true, actionId, content, ...result };
        } else {
          actionResult = { content, ...(result || { pending: true, actionId }) };
        }

        const toolInput = item.get('toolInput');
        const toolInputPlain = toolInput?.toJSON ? toolInput.toJSON() : toolInput;
        const actionInstance = this._createActionForUI(ActionClass, actionId, conversation);
        if (!actionInstance) throw new Error('missing context');
        const statusConfig = actionInstance.getStatusUI(actionResult, toolInputPlain || {}, {
          conversation,
          messageThread: this._getMessageThread(),
          session: conversation?.session,
          toolUseId: item.get('toolUseId')
        });

        if (statusConfig) {
          // Ensure error states have a typeName (tool name) even if the plugin didn't set one
          if (!statusConfig.typeName && isErrorState && result?.error) {
            statusConfig.typeName = ActionClass?.MANIFEST?.name || itemToolName || actionId;
          }

          const customElement = renderResultStatusMessage(statusConfig);
          const statusColor = statusConfig.status === 'error' ? 'red' : undefined;

          // For approval state: wrap content and add approval buttons
          if (isApproval) {
            if (statusConfig.customFormElement) {
              const wrapper = document.createElement('div');
              wrapper.className = 'action-approval-container';
              wrapper.appendChild(customElement);
              wrapper.appendChild(statusConfig.customFormElement);
              article.appendChild(this._wrapWithIcon(wrapper, statusColor));
            } else {
              const container = this._createApprovalContainer(customElement, item, result?.approvalOptions);
              article.appendChild(this._wrapWithIcon(container, statusColor));
            }
          } else {
            article.appendChild(this._wrapWithIcon(customElement, statusColor));
          }

          this.appendChild(article);
          return;
        }
      } catch (error) {
        console.error(`[ToolActionMessage] Error creating result status message for ${actionId}:`, error);
      }
    }

    // Default rendering (fallback if plugin doesn't provide custom UI)
    if (result?.success) {
      const displayName = ActionClass?.MANIFEST?.name || ContextItemClass?.MANIFEST?.name || itemToolName || actionId;
      const content = result.formatted?.summary || `${displayName}: Completed`;
      const statusElement = renderResultStatusMessage({
        summary: content,
        status: 'success'
      });
      article.appendChild(this._wrapWithIcon(statusElement));
    } else if (result?.error) {
      const toolName = result.toolName || itemToolName || ActionClass?.MANIFEST?.name || ContextItemClass?.MANIFEST?.name || actionId;
      const errorElement = renderResultStatusMessage({
        typeName: toolName,
        summary: result.error,
        status: 'error'
      });
      article.appendChild(this._wrapWithIcon(errorElement, 'red'));
    } else if (result?.cancelled) {
      const content = result.formatted?.summary || 'Action cancelled';
      const statusElement = renderResultStatusMessage({
        summary: content,
        status: 'cancelled'
      });
      article.appendChild(this._wrapWithIcon(statusElement));
    } else if (result?.blocked) {
      const content = result.formatted?.summary || 'Action blocked (plan mode active)';
      const statusElement = renderResultStatusMessage({
        summary: content,
        status: 'cancelled'
      });
      article.appendChild(this._wrapWithIcon(statusElement));
    }

    if (article.children.length > 0) {
      this.appendChild(article);
    }
  }

  /**
   * Create approval container with buttons
   * @param {HTMLElement} contentElement - The content to wrap
   * @param {ToolActionItem} item - The tool action item
   * @param {any} [overrideOptions] - Override approval options
   * @returns {HTMLElement} Container element with content and approval buttons
   * @private
   */
  _createApprovalContainer(contentElement, item, overrideOptions) {
    const container = document.createElement('div');
    container.className = 'action-approval-container';
    container.appendChild(contentElement);
    this._appendApprovalButtons(container, item, overrideOptions);
    return container;
  }

  /**
   * Append approval buttons to a container
   * @param {HTMLElement} container - Container to append buttons to
   * @param {ToolActionItem} item - The tool action item
   * @param {ActionConfirmationOptions|object} [overrideOptions] - Override approval options (takes precedence over item.approvalOptions)
   * @private
   */
  _appendApprovalButtons(container, item, overrideOptions) {
    const approvalOptionsRaw = item.get('approvalOptions');
    const approvalOptionsPlain = approvalOptionsRaw?.toJSON ? approvalOptionsRaw.toJSON() : approvalOptionsRaw;
    const approvalOptions = /** @type {ActionConfirmationOptions|undefined} */ (
      overrideOptions || approvalOptionsPlain
    );
    if (!approvalOptions) return;

    const messageThread = this._getMessageThread();

    // Snapshot the original suggestions before the edit UI mutates any option's
    // live grant in place, so each revise call sees the untouched suggestion.
    const originalOptions = (approvalOptions.options || []).map((o) => ({ ...o }));
    // Only wire the edit UI when the owning action implements the optional hook;
    // otherwise the component renders today's fixed buttons.
    const onRevise = this._buildReviseHook(item, originalOptions);

    const buttonsEl = /** @type {ActionConfirmationElement} */ (
      document.createElement('action-confirmation')
    );
    buttonsEl.setOptions(approvalOptions, (response) => {
      if (!messageThread) return;
      const isCancel = response === 'no' || response === 'cancel';
      // A "Don't ask again" button carries the exact permission rules it
      // would persist (escalating-breadth suggestions each have their own
      // set). Recover them from the chosen option, normalise the response
      // to canonical 'yes-always', and thread the rules to persistence.
      const chosen = (approvalOptions.options || []).find((o) => o.value === response);
      if (isCancel) {
        // UI policy: cancelling any tool cancels all pending tools
        messageThread.cancelPendingApprovals();
      } else if (chosen && (chosen.rules || chosen.allowedPaths)) {
        messageThread.resolveApproval(item.get('toolUseId'), 'yes-always', {
          approvalRules: chosen.rules,
          approvalAllowedPaths: chosen.allowedPaths,
          approvalItemType: chosen.itemType
        });
      } else {
        messageThread.resolveApproval(item.get('toolUseId'), response);
      }
    }, onRevise ? { onRevise } : undefined);

    // First-paint of the review indicator: if a strategy's onToolPending
    // reviewer is already in flight (e.g. a reload mid-review), render the
    // "reviewing…" row directly above the buttons so it paints correctly.
    const reviewStatus = item.get('reviewStatus');
    const reviewBusy = reviewStatus?.get ? reviewStatus.get('busy') : reviewStatus?.busy;
    if (reviewBusy) {
      const reviewLabel = reviewStatus?.get ? reviewStatus.get('label') : reviewStatus?.label;
      container.appendChild(this._buildReviewStatusRow(reviewLabel));
    }

    container.appendChild(buttonsEl);
  }

  /**
   * Build the optional revise bridge the edit UI calls when the user edits a
   * suggested pattern. Returns null unless the owning action implements
   * `reviseApprovalSuggestion` — in which case no pencil affordance is rendered
   * and the buttons stay fixed. The returned callback maps the component's
   * option index back to the untouched suggestion snapshot and forwards the edit
   * (with the validated tool input) to the plugin.
   * @param {ToolActionItem} item - The tool action item
   * @param {Array<Record<string, any>>} originalOptions - Untouched option snapshots
   * @returns {((index: number, editedText: string) => Promise<any>)|null} Revise callback, or null
   * @private
   */
  _buildReviseHook(item, originalOptions) {
    const toolName = item.get('toolName');
    if (!toolName) return null;
    const ActionClass = contextItemRegistry.getByToolName(toolName);
    if (!ActionClass) return null;
    const conversation = this._getConversation();
    const actionInstance = this._createActionForUI(ActionClass, toolName, conversation);
    if (!actionInstance || typeof actionInstance.reviseApprovalSuggestion !== 'function') {
      return null;
    }
    const toolInput = item.get('toolInput');
    const params = toolInput?.toJSON ? toolInput.toJSON() : (toolInput || {});
    return async (index, editedText) => {
      const original = originalOptions[index];
      if (!original) return null;
      const m = /^yes-always:(\d+)$/.exec(String(original.value));
      const suggestionIndex = m ? Number(m[1]) : index;
      try {
        return await actionInstance.reviseApprovalSuggestion({
          index: suggestionIndex,
          original,
          editedText,
          params
        });
      } catch (error) {
        console.error('[ToolActionMessage] reviseApprovalSuggestion failed:', error);
        return null;
      }
    };
  }

  /**
   * Create an action instance for UI rendering (getStatusUI calls).
   * @param {ActionTypeClass} ActionClass
   * @param {string} actionId - Action/tool name for id field
   * @param {Conversation|null} conversation
   * @returns {any} Action instance, or null if context unavailable
   * @private
   */
  _createActionForUI(ActionClass, actionId, conversation) {
    const messageThread = this._getMessageThread();
    if (!conversation || !messageThread) return null;
    return new ActionClass({
      id: actionId,
      session: conversation.session,
      conversation,
      messageThread
    });
  }

  /**
   * Wrap content with icon layout (consistent with other message components)
   * @param {HTMLElement} content - The content element to wrap
   * @param {string} [colorOverride] - Optional color override for the icon badge
   * @returns {HTMLElement} Wrapper element with icon and content
   * @private
   */
  _wrapWithIcon(content, colorOverride = undefined) {
    const opts = iconOptionsForItem(this._getItem(), {
      conversation: this._getConversation(),
      messageThread: this._getMessageThread(),
    });
    return wrapWithIcon(content, colorOverride ? { ...opts, color: colorOverride } : opts);
  }

}

customElements.define('tool-action-message', ToolActionMessage);

export default ToolActionMessage;
