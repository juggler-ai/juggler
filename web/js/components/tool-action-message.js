//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import contextItemRegistry from '../registries/context-item-registry.js';
import strategyRegistry from '../registries/strategy-registry.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import { userApprovalsThisTurn, hintStrategyIds, HINT_AFTER_APPROVALS } from '../services/approval-hint.js';
import { renderResultStatusMessage, escapeHtml } from '../../sdk/lib/html.js';
import {
  TOOL_STATES,
  ACTION_STATES,
  itemField
} from '../../sdk/lib/message.js';
import { wrapWithIcon, createErrorArticle } from '../utils/icon-message-renderer.js';
import { iconOptionsForItem } from '../utils/item-badge.js';
import { plain, yGet, yGetRecord } from '../model/item-accessor.js';
import JugglerElement from './juggler-element.js';
import { capabilityLabel } from '../utils/capability-label.js';
import { decorateTextFileRefs, fileRefContext } from '../utils/file-refs.js';
import { t, htmlSlots, withHtml, formatList } from '../../sdk/lib/i18n.js';

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 * @typedef {import('../model/conversation.js').default} Conversation
 */

/**
 * Tool action item from Yjs - using import type for proper resolution
 * @typedef {import('../../sdk/lib/message.js').ToolActionMessage} ToolActionItem
 */

/**
 * A tool action's review indicator, read from its `reviewStatus` (a Y.Map, or
 * a plain object set before conversion).
 * @param {ToolActionItem} item - The tool action
 * @returns {{busy: boolean, label: string|undefined}} Whether a review is in flight, and its label or closing note
 */
function reviewStatusOf(item) {
  const reviewStatus = item.get('reviewStatus');
  const label = itemField(reviewStatus, 'label');
  return { busy: !!itemField(reviewStatus, 'busy'), label: typeof label === 'string' ? label : undefined };
}

/**
 * The content text of a tool action's result (a Y.Map, a plain object, or
 * nothing yet).
 * @param {unknown} result - The tool action's `result` field
 * @returns {string} The content, or '' when there is none
 */
function resultContentText(result) {
  const content = itemField(result, 'content');
  return typeof content === 'string' ? content : '';
}

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
 * The observer is registered through JugglerElement, whose disposer holds the
 * array it was attached to: a tile removed from its column on its own can no
 * longer find the column, so teardown must not have to.
 */
class ToolActionMessage extends JugglerElement {
  /** @type {{state: string|undefined, hasResult: boolean, resultIsError: boolean, hasApprovalOptions: boolean, displayDataJson: string, reviewStatusJson: string}|null} @private */
  _lastSnapshot = null;

  connectedCallback() {
    this.classList.add('conversation-item');
    this._setupYjsObserver();
    this.render();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._lastSnapshot = null;
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
    this.observeDeep(messageThread.yarray, () => {
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
    });
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
    const isError = itemField(resultMap, 'isError');
    const reviewStatus = item.get('reviewStatus');
    return {
      state: item.get('state'),
      hasResult: resultMap !== null && resultMap !== undefined,
      resultIsError: !!isError,
      hasApprovalOptions: !!item.get('approvalOptions'),
      displayDataJson: displayData ? JSON.stringify(plain(displayData)) : '',
      reviewStatusJson: reviewStatus ? JSON.stringify(plain(reviewStatus)) : ''
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
   * Update the review indicator in place, without a destructive re-render. The
   * row sits directly above the approval buttons and is shown whenever
   * `reviewStatus` carries anything: a spinner while `busy`, and the strategy's
   * closing note (no spinner) once its review has settled without approving —
   * so the card keeps explaining why it is still asking. An empty/absent status
   * removes the row. Never touches the buttons themselves.
   * @param {ToolActionItem|null} item - The tool action item
   * @private
   */
  _applyReviewStatus(item) {
    const container = /** @type {HTMLElement|null} */ (this.querySelector('.action-approval-container'));
    if (!item || !container) return;
    const { busy, label } = reviewStatusOf(item);
    const row = /** @type {HTMLElement|null} */ (container.querySelector('.approval-review-status'));
    if (!busy && !label) {
      row?.remove();
      return;
    }
    // Rebuild rather than patch: busy→settled swaps the spinner and the styling,
    // not just the text. The row carries no interactive controls, so replacing it
    // can't move anything under the user's cursor — the buttons are untouched.
    const next = this._buildReviewStatusRow(label, busy);
    if (row) row.replaceWith(next);
    else container.insertBefore(next, container.querySelector('action-confirmation'));
  }

  /**
   * Build the review indicator row. Purely additive — rendered above the
   * approval buttons; the buttons stay live. While busy it is a spinner plus
   * label; once settled the spinner gives way to a static icon and the muted
   * `--done` styling, marking it as a closing note rather than live work.
   * @param {string} [label] - The review label or closing note to show
   * @param {boolean} [busy] - Whether a review is still in flight
   * @returns {HTMLElement} The indicator row
   * @private
   */
  _buildReviewStatusRow(label, busy = true) {
    const row = document.createElement('div');
    row.className = busy ? 'approval-review-status' : 'approval-review-status approval-review-status--done';
    if (busy) {
      const spinner = document.createElement('juggler-spinner');
      spinner.setAttribute('style', '--size: 1.5rem');
      spinner.setAttribute('aria-hidden', 'true');
      row.appendChild(spinner);
    } else {
      const icon = document.createElement('span');
      icon.className = 'icon-auto-awesome';
      icon.setAttribute('aria-hidden', 'true');
      row.appendChild(icon);
    }
    const text = document.createElement('span');
    text.className = 'approval-review-status-label';
    // textContent, never innerHTML: the note is model-authored text.
    text.textContent = label || t('Reviewing…');
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
    const named = item.get('toolName');
    // An unnamed item has no capability to ask for its card's words.
    const label = named ? this._runningLabel(item, named) : '';
    if (label) return { message: label, spinner: true };
    return { message: named ? t('Running {tool}…', { tool: named }) : t('Running tool…'), spinner: true };
  }

  /**
   * The running card's own words — its type label and summary, as
   * `_renderRunning` draws them — so the footer names a tool as the user
   * sees it rather than by its wire name.
   * @param {ToolActionItem} item
   * @param {string} toolName - The item's tool name
   * @returns {string} `Type: summary`, or '' when the tool draws no status UI
   * @private
   */
  _runningLabel(item, toolName) {
    /** @type {ActionTypeClass|undefined} */
    const ActionClass = contextItemRegistry.getByToolName(toolName);
    if (!ActionClass || typeof ActionClass.prototype.getStatusUI !== 'function') return '';
    try {
      const conversation = this._getConversation();
      const actionInstance = this._createActionForUI(ActionClass, toolName, conversation);
      if (!actionInstance) return '';
      const config = actionInstance.getStatusUI(
        { pending: true, actionId: toolName, displayData: yGet(item, 'displayData'), state: item.get('state') },
        yGet(item, 'toolInput'),
        { conversation, messageThread: this._getMessageThread(), session: conversation?.session, toolUseId: item.get('toolUseId') }
      );
      if (!config) return '';
      const summary = (typeof config.summary === 'string' ? config.summary : config.summary?.textContent || '').trim();
      const name = ActionClass.MANIFEST?.name;
      const typeName = config.typeName || (name ? capabilityLabel(name, ActionClass.MANIFEST?.id) : toolName);
      return summary ? t('{type}: {summary}', { type: typeName, summary }) : typeName;
    } catch {
      return '';
    }
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
      itemField(result, 'cancelled')
        ? this._renderCancelled(item)
        : this._renderResult(item);
    } else if (state === TOOL_STATES.RUNNING || state === TOOL_STATES.APPROVED || state === undefined) {
      this._renderRunning(item);
    } else {
      this._renderResult(item);
    }

    // A plugin's status line can opt text into data-file-refs (the shell tool's
    // command line); the paths in it become links to the files.
    void decorateTextFileRefs(this, fileRefContext(this._getMessageThread(), this._getConversation()));
  }

  /**
   * Render pending approval state with approval buttons
   * @param {ToolActionItem} item
   * @private
   */
  _renderPendingApproval(item) {
    const actionId = item.get('toolName') ?? '';
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
        const displayDataPlain = yGet(item, 'displayData');
        const toolInputPlain = yGet(item, 'toolInput');
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
            // Multi-question: form below the status row, no action-confirmation buttons
            this._appendCustomForm(article, customElement, statusConfig.customFormElement);
          } else {
            this._appendApprovalRow(article, customElement, item);
          }
          this.appendChild(article);
          return;
        }
      } catch (error) {
        console.error(`[ToolActionMessage] Error creating pending approval UI for ${actionId}:`, error);
      }
    }

    // Default fallback
    const label = document.createElement('div');
    label.className = 'pending-approval-label';
    label.textContent = t('{action}: Waiting for approval…', { action: actionId });

    this._appendApprovalRow(article, label, item);
    this.appendChild(article);
  }

  /**
   * Render running state with streaming output
   * @param {ToolActionItem} item
   * @private
   */
  _renderRunning(item) {
    const actionId = item.get('toolName') ?? '';
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
        const displayDataPlain = yGet(item, 'displayData');
        const toolInputPlain = yGet(item, 'toolInput');
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
    label.textContent = t('{action}: Running…', { action: actionId });
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
    const toolName = item.get('toolName');
    const result = yGetRecord(item, 'result');
    const conversation = this._getConversation();

    // Create article wrapper
    const article = document.createElement('article');
    article.className = 'action';

    // Try to use action's getStatusUI for custom rendering. An unnamed item has
    // no capability to ask, so it takes the generic card below.
    let statusElement;
    /** @type {ActionTypeClass|undefined} */
    const ActionClass = toolName ? contextItemRegistry.getByToolName(toolName) : undefined;
    if (toolName && ActionClass && typeof ActionClass.prototype.getStatusUI === 'function') {
      try {
        const actionInstance = this._createActionForUI(ActionClass, toolName, conversation);
        if (!actionInstance) throw new Error('missing context');
        const displayDataPlain = yGet(item, 'displayData');
        const toolInputPlain = yGet(item, 'toolInput');
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
        summary: toolName ? t('{tool}: Cancelled', { tool: toolName }) : t('Action: Cancelled'),
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
    const fullResultMap = itemField(resultMap, 'fullResult');
    const result = /** @type {ActionResult|undefined} */ (plain(fullResultMap));
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
      const resultContent = resultContentText(resultMap);
      // The model's own text (content, error) is shown as it was; the fallback is ours.
      const errorMessage = resultContent || result?.error || (itemToolName ? t('Unknown tool: {name}', { name: String(itemToolName) }) : t('Unknown tool'));
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
        const content = resultContentText(resultMap);
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

        const toolInputPlain = yGet(item, 'toolInput');
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
            const name = ActionClass?.MANIFEST?.name;
            statusConfig.typeName = name ? capabilityLabel(name, ActionClass?.MANIFEST?.id) : itemToolName || actionId;
          }

          const customElement = renderResultStatusMessage(statusConfig);
          const statusColor = statusConfig.status === 'error' ? 'red' : undefined;

          // For approval state: wrap content and add approval buttons
          if (isApproval) {
            if (statusConfig.customFormElement) {
              this._appendCustomForm(article, customElement, statusConfig.customFormElement, statusColor);
            } else {
              this._appendApprovalRow(article, customElement, item, result?.approvalOptions, statusColor);
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

    // Default rendering (fallback if plugin doesn't provide custom UI). The
    // capability's manifest name is its English, translated in its extension's
    // catalogue; a tool name or action id is an identifier.
    const manifest = ActionClass?.MANIFEST?.name ? ActionClass.MANIFEST : ContextItemClass?.MANIFEST;
    const capabilityName = manifest?.name ? capabilityLabel(manifest.name, manifest.id) : '';
    if (result?.success) {
      const displayName = capabilityName || itemToolName || actionId;
      const content = result.formatted?.summary || t('{name}: Completed', { name: displayName });
      const statusElement = renderResultStatusMessage({
        summary: content,
        status: 'success'
      });
      article.appendChild(this._wrapWithIcon(statusElement));
    } else if (result?.error) {
      const toolName = result.toolName || itemToolName || capabilityName || actionId;
      const errorElement = renderResultStatusMessage({
        typeName: toolName,
        summary: result.error,
        status: 'error'
      });
      article.appendChild(this._wrapWithIcon(errorElement, 'red'));
    } else if (result?.cancelled) {
      const content = result.formatted?.summary || t('Action cancelled');
      const statusElement = renderResultStatusMessage({
        summary: content,
        status: 'cancelled'
      });
      article.appendChild(this._wrapWithIcon(statusElement));
    } else if (result?.blocked) {
      const content = result.formatted?.summary || t('Action blocked (plan mode active)');
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
   * Lay out a plugin-supplied form (an elicitation surface such as
   * AskUserQuestion's questions) under the item's status row. The status line
   * keeps the icon-row layout, but the form is appended as a sibling of that
   * row rather than inside its content box, so it hangs off the lozenge with
   * only the icon column as left gutter: the full badge gutter costs a third
   * of a phone screen, and the form's option text is the content that most
   * needs the room.
   * @param {HTMLElement} article - The item's article element
   * @param {HTMLElement} statusElement - The rendered status line
   * @param {HTMLElement} formElement - The plugin's form element
   * @param {string} [colorOverride] - Optional color override for the icon badge
   * @private
   */
  _appendCustomForm(article, statusElement, formElement, colorOverride = undefined) {
    article.appendChild(this._wrapWithIcon(statusElement, colorOverride));
    formElement.classList.add('action-custom-form', 'message-row-body');
    article.appendChild(formElement);
  }

  /**
   * Lay out an item's status row with its approval buttons beneath it, the same
   * shape a plugin form gets from `_appendCustomForm`. The buttons (and the
   * review indicator above them) go in an `.action-approval-container` appended
   * as a sibling of the icon row, so they hang off the lozenge rather than
   * starting past it. Emits no container at all when the item carries no
   * approval options, leaving a bare status row.
   * @param {HTMLElement} article - The item's article element
   * @param {HTMLElement} statusElement - The rendered status line
   * @param {ToolActionItem} item - The tool action item
   * @param {ActionConfirmationOptions|object} [overrideOptions] - Override approval options
   * @param {string} [colorOverride] - Optional color override for the icon badge
   * @private
   */
  _appendApprovalRow(article, statusElement, item, overrideOptions = undefined, colorOverride = undefined) {
    article.appendChild(this._wrapWithIcon(statusElement, colorOverride));
    const container = document.createElement('div');
    container.className = 'action-approval-container message-row-body';
    this._appendApprovalButtons(container, item, overrideOptions);
    if (container.children.length > 0) article.appendChild(container);
  }

  /**
   * Append approval buttons to a container
   * @param {HTMLElement} container - Container to append buttons to
   * @param {ToolActionItem} item - The tool action item
   * @param {ActionConfirmationOptions|object} [overrideOptions] - Override approval options (takes precedence over item.approvalOptions)
   * @private
   */
  _appendApprovalButtons(container, item, overrideOptions) {
    const approvalOptionsPlain = yGet(item, 'approvalOptions');
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
        return;
      }
      const toolUseId = item.get('toolUseId') ?? '';
      let resolved;
      if (chosen && (chosen.rules || chosen.allowedPaths)) {
        resolved = messageThread.resolveApproval(toolUseId, 'yes-always', {
          approvalRules: chosen.rules,
          approvalAllowedPaths: chosen.allowedPaths,
          approvalItemType: chosen.itemType,
          source: 'user'
        });
      } else {
        // A suggestion button that carries no rules/paths of its own still means
        // "don't ask again": normalise the indexed value to canonical
        // 'yes-always' so persistence recognises it and derives the grant from
        // the plugin's own suggestion pipeline. Passing 'yes-always:N' through
        // verbatim would approve the tool but never save the permission.
        const canonical = typeof response === 'string' && /^yes-always:\d+$/.test(response)
          ? 'yes-always'
          : response;
        resolved = messageThread.resolveApproval(toolUseId, canonical, { source: 'user' });
      }
      // A false return means the tool-action had already left PENDING, so the
      // click wrote nothing at all — including any "don't ask again" grant it
      // promised. Surface it rather than letting the permission silently not
      // stick.
      if (!resolved) {
        console.warn(
          '[ToolActionMessage] approval ignored — tool-action was no longer pending; ' +
          'any permission grant on this click was NOT saved',
          { toolUseId, response }
        );
      }
    }, onRevise ? { onRevise } : undefined);

    // First-paint of the review indicator: a strategy's onToolPending reviewer
    // may already be in flight (e.g. a reload mid-review) or may have left a
    // closing note on a call still parked. Either way the row belongs directly
    // above the buttons, so paint it here rather than waiting for a change.
    const { busy: reviewBusy, label: reviewLabel } = reviewStatusOf(item);
    if (reviewBusy || reviewLabel) {
      container.appendChild(this._buildReviewStatusRow(reviewLabel, reviewBusy));
    }

    container.appendChild(buttonsEl);

    const hint = this._buildStrategyHint(item, messageThread);
    if (hint) container.appendChild(hint);
  }

  /**
   * The registered, visible strategies the hint may offer. A seam for tests.
   * @returns {Array<{id: string, manifest: {name: string}}>} strategyRegistry.getAllManifests()
   * @private
   */
  _hintStrategies() {
    return /** @type {any} */ (strategyRegistry.getAllManifests());
  }

  /**
   * The strategy hint under the buttons (services/approval-hint.js). It appears
   * only once the user has approved enough calls by hand this turn, and offers
   * each strategy that would ask less as a link that switches to it. Switching
   * re-decides this parked call under the new strategy (the worker's strategy-
   * switch re-evaluation), so under YOLO the click is the approval.
   * @param {ToolActionItem} item - The parked tool action
   * @param {any} messageThread - Its thread
   * @returns {HTMLElement|null} The hint row, or null when there is none
   * @private
   */
  _buildStrategyHint(item, messageThread) {
    if (!messageThread?.items || typeof messageThread.setStrategy !== 'function') return null;
    if (userApprovalsThisTurn(messageThread.items, item.get('itemId') ?? '') < HINT_AFTER_APPROVALS) return null;
    const available = this._hintStrategies();
    const ids = hintStrategyIds(messageThread.getEffectiveStrategyId?.() || 'default', available);
    if (ids.length === 0) return null;

    /** @type {Record<string, string>} */
    const links = {};
    ids.forEach((id, i) => {
      const manifest = available.find((s) => s.id === id)?.manifest;
      const name = capabilityLabel(manifest?.name || id, id, strategyRegistry);
      links[`s${i}`] = `<a href="#" class="approval-strategy-hint-link" data-strategy-id="${escapeHtml(id)}">${escapeHtml(name)}</a>`;
    });
    // The list is formatted over slot stand-ins, so the language's own "or" is
    // escaped as text and the links go in as markup.
    const linkSlots = htmlSlots(links);
    const strategies = withHtml(formatList(Object.keys(links).map((k) => String(linkSlots[k])), { type: 'disjunction' }), links);
    const key = keyShortcutManager.formatBinding('strategy-switch');
    const parts = { strategies, shortcut: `<kbd>${escapeHtml(key)}</kbd>` };
    const text = key
      ? t('Approving a lot? Switch to {strategies} ({shortcut}).', htmlSlots(parts))
      : t('Approving a lot? Switch to {strategies}.', htmlSlots(parts));

    const row = document.createElement('div');
    row.className = 'approval-strategy-hint';
    row.innerHTML = withHtml(text, parts);
    row.addEventListener('click', (e) => {
      const link = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-strategy-id]'));
      if (!link) return;
      e.preventDefault();
      messageThread.setStrategy(link.dataset.strategyId);
    });
    return row;
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
    const params = yGet(item, 'toolInput') || {};
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
