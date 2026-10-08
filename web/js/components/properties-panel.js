//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * PropertiesPanel - Right-side panel showing details of selected item
 *
 * Displays expanded content and controls for:
 * - Selected messages (user, assistant)
 * - Selected context items (full content view, controls)
 * - Selected tool-actions (full result, retry controls)
 *
 * Part of the conversation-tab flex layout (not fixed position).
 * Auto-fills remaining horizontal space via flex: 1.
 */

import { createIconBadge, createTypeBadge } from '../utils/icon-message-renderer.js';
import { FORK_SVG, INFO_SVG, RETRY_SVG, UNDO_SVG } from '../utils/icons.js';
import { appendDeleteControls } from '../utils/panel-delete-controls.js';
import { createPinControl } from '../utils/properties-panel-helpers.js';
import { TOOL_STATES } from '../../sdk/lib/message.js';
import { findNeighborItemId } from '../services/context-item-utilities.js';
import { renderTransactionDetail } from './transaction-detail-renderer.js';
import { dispatchItemRenderer, renderContextItem } from '../services/renderers/item-renderers.js';
import workerManager from '../services/worker-manager.js';
import { openSettings } from '../services/settings-launcher.js';
import { setupColumnResize } from '../utils/column-resize.js';
import { formatDuration, formatRelativeDateTime, formatTokens } from '../utils/format.js';
import { plain } from '../model/item-accessor.js';
import { estimateTokens, llmTextForItem } from '../utils/token-estimate.js';
import { FormattingHelpers } from '../../sdk/lib/formatting-helpers.js';

/**
 * @typedef {import('../model/conversation.js').default} Conversation
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 * @typedef {import('juggler/context-item').default} ContextItemType
 */

// Magnifying-glass + sigil glyph used on the inline View-Transaction button
// AND as the header icon of the transaction-mode panel itself, so the user
// recognises the same affordance opening the same view.
const TRANSACTION_ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor"><path d="M824-120 636-308q-41 32-90.5 50T440-240q-90 0-162.5-44T163-400h98q34 37 79.5 58.5T440-320q100 0 170-70t70-170q0-100-70-170t-170-70q-94 0-162.5 63.5T201-580h-80q8-127 99.5-213.5T440-880q134 0 227 93t93 227q0 56-18 105.5T692-364l188 188-56 56ZM397-400l-63-208-52 148H80v-60h160l66-190h60l61 204 43-134h60l60 120h30v60h-67l-47-94-50 154h-59Z"/></svg>';

// Colour preset for the transaction panel's own header. A round-trip is not an
// item type, so it takes the neutral default rather than borrowing a family's
// hue — but it must be a real preset: the `.color-*` blocks are what define
// --preset-bg / --preset-badge-bg, and a name with no block leaves the icon box
// and the lozenge with no background at all while the light theme still forces
// their glyph and label white.
const TRANSACTION_HEADER_COLOR = 'slate';

// An item big enough to be worth noticing, and one big enough to be worth
// worrying about, in estimated tokens. Below the first the chip stays neutral:
// a colour on every row would be decoration, not information.
const TOKEN_CHIP_HIGH = 10_000;
const TOKEN_CHIP_CRITICAL = 25_000;

// The item types a round-trip's reported output tokens can describe. The
// provider reports one output total covering every block it emitted, so that
// total belongs to a single item only when the turn produced exactly one of
// these. The originating user message carries the same transactionId but sits
// on the input side, so it never counts here.
const OUTPUT_ITEM_TYPES = new Set(['assistant', 'thinking', 'tool-action']);

// Of those, the ones whose entire LLM contribution IS that output: an assistant
// message is its text, a thinking block is its reasoning. A tool-action is not
// — most of what it costs the context is the result that comes back on the NEXT
// turn's input, which no provider reports separately, so swapping the round-trip
// figure in for a lone tool-action would understate it.
const REPORTED_OUTPUT_TYPES = new Set(['assistant', 'thinking']);

/**
 * Paint a token count onto a header chip, colouring it by magnitude.
 * @param {HTMLElement} chip - The chip element.
 * @param {number} tokens - The count the colour is chosen from.
 * @param {string} label - Chip text.
 * @param {string} title - Tooltip text.
 */
function paintChip(chip, tokens, label, title) {
  chip.hidden = false;
  chip.textContent = label;
  chip.title = title;
  chip.classList.toggle('token-critical', tokens >= TOKEN_CHIP_CRITICAL);
  chip.classList.toggle('token-high', tokens >= TOKEN_CHIP_HIGH && tokens < TOKEN_CHIP_CRITICAL);
}

/**
 * Paint an estimated token count onto a header chip, leaving it hidden when
 * the item contributes no text at all.
 * @param {HTMLElement} chip - The chip element.
 * @param {string} text - The item's LLM-facing text.
 */
function paintTokenChip(chip, text) {
  const tokens = estimateTokens(text);
  if (tokens <= 0) {
    chip.hidden = true;
    return;
  }
  paintChip(chip, tokens, `~${formatTokens(tokens)}`,
    `Estimated ${tokens.toLocaleString()} tokens from ${text.length.toLocaleString()} characters `
    + '(~4 characters per token). Provider-reported counts cover a whole round-trip \u2014 open the '
    + 'transaction to see those.');
}

/**
 * Paint a provider-reported output count. Shown without a `~`, because it is
 * the number the provider billed rather than one we worked out.
 * @param {HTMLElement} chip - The chip element.
 * @param {number} tokens - Reported output tokens for the round-trip.
 */
function paintReportedChip(chip, tokens) {
  paintChip(chip, tokens, formatTokens(tokens),
    `${tokens.toLocaleString()} output tokens, reported by the provider. This round-trip `
    + "produced nothing else, so the count is this item's alone.");
}

class PropertiesPanel extends HTMLElement {
  constructor() {
    super();

    /** @type {Conversation|null} @private */
    this._conversation = null;

    /** @type {string|null} @private */
    this._selectedItemId = null;

    /** @type {string|null} @private - ID of the item currently rendered in the DOM */
    this._renderedItemId = null;

    /** @type {(() => boolean)|null} @private - Closure that patches DOM for same-item updates; returns false when full re-render needed */
    this._liveUpdater = null;

    /** @type {import('../model/message-thread.js').default|null} @private - MessageThread for finding/mutating items */
    this._messageThread = null;

    /** @type {((event: any, transaction: any) => void)|null} @private */
    this._itemsObserver = null;

    /** @type {((event: any, transaction: any) => void)|null} @private */
    this._contextItemsObserver = null;

    /** @type {(() => void)|null} @private - Session feed unsubscribe, for strategy changes */
    this._strategyUnsubscribe = null;

    /** @type {{state: string|undefined, hasResult: boolean, contentSnippet: string, type: string|undefined}|null} @private */
    this._lastSnapshot = null;

    /**
     * When set, the panel renders an LLM round-trip blob instead of a
     * conversation item. Cleared by selectItem(), set by setTransaction().
     * @type {{transactionId: string, conversationId: string}|null}
     * @private
     */
    this._transactionMode = null;

    /**
     * Provider-reported output tokens per round-trip, keyed by transactionId.
     * Arrow-keying through a turn's items asks about the same round-trip for
     * each of them, and every fetch is a disk read in the worker. Only positive
     * results land here: the worker stamps the id onto the streaming item
     * before it saves the blob, so an early fetch can legitimately find nothing
     * and has to stay free to retry.
     * @type {Map<string, number>}
     * @private
     */
    this._blobOutputTokens = new Map();

    /**
     * 1Hz ticker that refreshes elements bearing `data-elapsed-since`
     * (currently the "Running…" status text on in-flight tool actions).
     * Started by _refreshElapsedTicker() when any such element is present
     * after a render; stopped when none remain or the panel disconnects.
     * @type {ReturnType<typeof setInterval>|null}
     * @private
     */
    this._elapsedTicker = null;
  }

  connectedCallback() {
    this.render();
  }

  disconnectedCallback() {
    this._cleanupObservers();
    this._stopElapsedTicker();
  }

  /**
   * Set the conversation for this panel
   * @param {Conversation} conversation
   */
  setConversation(conversation) {
    if (this._conversation === conversation) return;

    // Clean up old observers
    this._cleanupObservers();

    this._conversation = conversation;
    this._selectedItemId = null;
    this._renderedItemId = null;
    this._liveUpdater = null;
    this._lastSnapshot = null;
    // Transaction ids are per conversation; nothing cached for the old one can
    // answer a question about the new one.
    this._blobOutputTokens.clear();

    if (conversation) {
      this._setupObservers();
    }

    this._renderContent();
  }

  /**
   * Set the message thread for finding and mutating items.
   * @param {import('../model/message-thread.js').default} messageThread
   */
  setMessageThread(messageThread) {
    this._messageThread = messageThread;

    // Set up observers if conversation is set but observers weren't
    // created yet (conversation was set before messageThread was available)
    if (this._conversation && !this._itemsObserver) {
      this._setupObservers();
    }
  }

  /**
   * Select an item by ID
   * @param {string|null} itemId - Message ID, context item ID, or null to clear selection
   */
  selectItem(itemId) {
    this._transactionMode = null;
    this._selectedItemId = itemId;
    this._renderContent();
  }

  /**
   * Switch into transaction-detail mode: render the input/output blob for
   * one LLM round-trip. The blob is fetched lazily from disk via the
   * worker. Conversation-tab uses this for nested transaction panels.
   * @param {string} conversationId
   * @param {string} transactionId
   */
  setTransaction(conversationId, transactionId) {
    const m = this._transactionMode;
    if (m && m.conversationId === conversationId && m.transactionId === transactionId) return;
    this._transactionMode = { conversationId, transactionId };
    this._selectedItemId = null;
    this._renderedItemId = null;
    this._liveUpdater = null;
    this._lastSnapshot = null;
    this._renderTransactionContent();
  }

  /**
   * Clear the current selection
   */
  clearSelection() {
    this.selectItem(null);
  }

  /**
   * Get the currently selected item ID
   * @returns {string|null} The selected item ID or null if nothing selected
   */
  getSelectedItemId() {
    return this._selectedItemId;
  }

  /**
   * Resolve the selected item from EITHER the committed `items` array or the
   * `pendingItems` queue, so a queued (not-yet-sent) message gets the same
   * properties panel as any other item.
   * @param {string|null} [id] - Item id (defaults to the current selection)
   * @returns {{ msg: any, isPending: boolean }} The Y.Map and whether it is queued
   * @private
   */
  _resolveItem(id = this._selectedItemId) {
    if (!id || !this._messageThread) return { msg: null, isPending: false };
    const inItems = this._messageThread.items.find((/** @type {any} */ i) => i.get('itemId') === id);
    if (inItems) return { msg: inItems, isPending: false };
    const pending = ('pendingItems' in this._messageThread) ? this._messageThread.pendingItems : [];
    const inPending = pending.find((/** @type {any} */ i) => i.get('itemId') === id);
    if (inPending) return { msg: inPending, isPending: true };
    return { msg: null, isPending: false };
  }

  /**
   * Set up Yjs observers for real-time updates
   * @private
   */
  _setupObservers() {
    if (!this._conversation || !this._messageThread) return;

    // Selection comes via selectItem() from conversation-tab — no Yjs observer for selectedItemId.

    // Observe items for content changes to selected item (delta-aware)
    // observeDeep passes an array of Y.Event objects; find the array-level event
    this._itemsObserver = (/** @type {any[]} */ events) => {
      if (!this._selectedItemId) return;

      const arrayEvent = Array.isArray(events) ? events.find(e => e.changes?.delta?.length) : events;
      const delta = arrayEvent?.changes?.delta;
      if (!delta) {
        // No array-level changes, but nested Y.Map content may have changed.
        // Re-render if the selected item's content was modified.
        if (this._selectedItemId) {
          this._renderContent();
        }
        return;
      }

      const selectedId = this._selectedItemId;
      let insertedSelected = false;
      let hasDeletes = false;

      for (const change of delta) {
        if (change.delete) {
          hasDeletes = true;
        }
        if (change.insert) {
          const inserted = Array.isArray(change.insert) ? change.insert : [change.insert];
          for (const item of inserted) {
            if (item && (item.get ? item.get('itemId') : item.itemId) === selectedId) {
              insertedSelected = true;
              break;
            }
          }
        }
        if (insertedSelected) break;
      }

      // Selected item was re-inserted (modified via delete+insert) → re-render
      if (insertedSelected) {
        this._renderContent();
        return;
      }

      // Deletions occurred but selected item wasn't re-inserted → check if it
      // was removed. A queued message lives in pendingItems, not items, so a
      // still-pending selection must NOT be cleared by an unrelated delete.
      if (hasDeletes) {
        const { msg } = this._resolveItem(selectedId);
        if (!msg) {
          this.clearSelection();
        }
      }
    };
    const container = /** @type {import('../model/message-thread.js').MessageThread} */ (this._messageThread).container;
    this._observedContainer = container;
    container.observeDeep(this._itemsObserver);
    // Unified storage: context items are in items array, so items observer handles changes too

    // Re-render when this conversation's strategy changes (system prompt panel
    // shows strategy content).
    const conversation = this._messageThread?.conversation;
    const session = conversation?.session;
    if (session) {
      this._strategyUnsubscribe = /** @type {() => void} */ (session.subscribe((/** @type {{type: string, data?: any}} */ event) => {
        if (event.type !== 'conversation:strategy-changed' || event.data?.conversation !== conversation) return;
        if (this._selectedItemId) {
          // Force full re-render by clearing snapshot
          this._lastSnapshot = null;
          this._renderedItemId = null;
          this._renderContent();
        }
      }));
    }
  }

  /**
   * Clean up Yjs observers
   * @private
   */
  _cleanupObservers() {
    if (this._observedContainer && this._itemsObserver) {
      this._observedContainer.unobserveDeep(this._itemsObserver);
    }
    this._observedContainer = null;
    this._itemsObserver = null;

    if (this._strategyUnsubscribe) {
      this._strategyUnsubscribe();
      this._strategyUnsubscribe = null;
    }
  }

  /**
   * Render the panel structure
   * @private
   */
  render() {
    this.innerHTML = `
            <properties-panel-content>
                <properties-panel-empty>
                    <span class="properties-panel-empty-icon">
                        ${INFO_SVG}
                    </span>
                    <span class="properties-panel-empty-text">Select an item to view details</span>
                </properties-panel-empty>
            </properties-panel-content>
            <col-resize-handle></col-resize-handle>
        `;
    setupColumnResize(this, 'juggler-properties-panel-width');
  }

  /**
   * Where ⌘F searches in the properties panel: the section, which is the
   * panel's one scroller, with the bar floating in the panel itself (already a
   * positioned box).
   *
   * The section is rebuilt from scratch every time the panel renders — a new
   * selection, a transaction view, a live update that the patcher can't absorb —
   * so this resolves it afresh on every call and names the enclosing content
   * area, which survives all of that, as the thing to watch for mutations. Null
   * while the panel is empty, so ⌘F falls through to the browser's own find
   * rather than opening a bar over "Select an item to view details".
   * @returns {import('./find-bar.js').FindTarget|null} The find descriptor, or null when there is nothing to search.
   */
  getFindTarget() {
    const root = this.querySelector('properties-panel-section');
    const watch = this.querySelector('properties-panel-content');
    if (!root || !watch) return null;
    return { root, watch, mount: this, label: 'Find in properties' };
  }

  /**
   * Render the transaction-mode panel (LLM round-trip detail view).
   * Fetched lazily from disk via worker; small blobs and rare access mean
   * no caching — we just re-fetch on every entry.
   * @private
   */
  async _renderTransactionContent() {
    const contentArea = this.querySelector('properties-panel-content');
    if (!contentArea) return;
    contentArea.innerHTML = '';

    const mode = this._transactionMode;
    if (!mode) return;

    // Wrap header + body in a properties-panel-section so the panel
    // scrolls vertically (flex:1 + overflow-y:auto on the section).
    const section = document.createElement('properties-panel-section');
    contentArea.appendChild(section);

    const header = this._createHeader('LLM Transaction', {
      color: TRANSACTION_HEADER_COLOR,
      iconSvg: TRANSACTION_ICON_SVG
    });
    section.appendChild(header);

    const body = document.createElement('properties-panel-body');
    section.appendChild(body);

    // The panel follows the selected item, and plenty of items — context items,
    // queued messages — were never part of a round-trip. That is a fact about
    // the item, not a missing blob, so say so and skip the fetch.
    if (!mode.transactionId) {
      renderTransactionDetail(body, null, 'Not part of a round-trip.');
      return;
    }

    let blob = null;
    try {
      blob = await workerManager.getTransaction(mode.conversationId, mode.transactionId);
    } catch (err) {
      console.error('[PropertiesPanel] Failed to load transaction blob:', err);
    }

    // Bail if the user navigated away while the fetch was in flight.
    if (this._transactionMode !== mode) return;

    // The thread comes along so the recorded tool list can say how the live one
    // differs — the panel is where "was my tool even offered" gets answered.
    renderTransactionDetail(
      body,
      /** @type {import('./transaction-detail-renderer.js').TransactionBlob|null} */ (blob),
      undefined,
      { messageThread: this._messageThread }
    );
  }

  /**
   * Render content based on selected item.
   * Same-item updates use _liveUpdater for non-destructive DOM patching.
   * Different-item or no updater → full rebuild.
   * @private
   */
  _renderContent() {
    // Transaction mode short-circuits item rendering entirely.
    if (this._transactionMode) {
      this._renderTransactionContent();
      return;
    }

    const contentArea = this.querySelector('properties-panel-content');
    if (!contentArea) return;

    // Same item — try live updater first, then snapshot comparison
    if (this._selectedItemId === this._renderedItemId) {
      if (this._liveUpdater) {
        if (this._liveUpdater()) return;
        // liveUpdater returned false (e.g. running → completed) → fall through
      } else {
        const snapshot = this._snapshotItem();
        if (this._lastSnapshot && snapshot &&
                    this._lastSnapshot.state === snapshot.state &&
                    this._lastSnapshot.hasResult === snapshot.hasResult &&
                    this._lastSnapshot.contentSnippet === snapshot.contentSnippet &&
                    this._lastSnapshot.type === snapshot.type) {
          return;
        }
      }
    }

    // Full render
    this._liveUpdater = null;
    this._lastSnapshot = null;
    contentArea.innerHTML = '';
    this._renderedItemId = this._selectedItemId;
    this._lastSnapshot = this._snapshotItem();

    if (!this._selectedItemId || !this._conversation) {
      this._renderEmptyState(contentArea);
      return;
    }

    // Route to renderer: registry item, tool-action, or plain message
    const registered = this._messageThread?.getContextItem(this._selectedItemId);
    if (registered) {
      renderContextItem(/** @type {any} */ (this), contentArea, registered);
      return;
    }

    const { msg } = this._resolveItem();
    if (!msg) {
      this._renderEmptyState(contentArea);
      return;
    }

    dispatchItemRenderer(/** @type {any} */ (this), contentArea, msg);
    this._refreshElapsedTicker();
  }

  /**
   * Start/stop the 1Hz ticker based on whether the current render contains
   * any [data-elapsed-since] elements. Called after every full render and
   * after every successful live update. Idempotent — calling with the
   * ticker already in the right state is a no-op.
   * @private
   */
  _refreshElapsedTicker() {
    const targets = this.querySelectorAll('[data-elapsed-since]');
    if (targets.length === 0) {
      this._stopElapsedTicker();
      return;
    }
    // Update immediately so the digit doesn't lag by up to 1s on first
    // paint (e.g. when transitioning PENDING → RUNNING).
    this._tickElapsedLabels();
    if (this._elapsedTicker === null) {
      this._elapsedTicker = setInterval(() => this._tickElapsedLabels(), 1000);
    }
  }

  /** @private */
  _stopElapsedTicker() {
    if (this._elapsedTicker !== null) {
      clearInterval(this._elapsedTicker);
      this._elapsedTicker = null;
    }
  }

  /**
   * One-shot update of every [data-elapsed-since] element's textContent.
   * If the set becomes empty mid-tick (e.g. the tool action just finished
   * and the renderer hasn't replaced the node yet), stops the ticker.
   * @private
   */
  _tickElapsedLabels() {
    const targets = this.querySelectorAll('[data-elapsed-since]');
    if (targets.length === 0) {
      this._stopElapsedTicker();
      return;
    }
    const now = Date.now();
    targets.forEach((el) => {
      const startMs = Number(/** @type {HTMLElement} */ (el).dataset.elapsedSince);
      if (!Number.isFinite(startMs)) return;
      const seconds = Math.max(0, Math.round((now - startMs) / 1000));
      el.textContent = `Running… ${formatDuration(seconds)}`;
    });
  }

  /**
   * Create a lightweight snapshot of the selected item for change detection.
   * @returns {{state: string|undefined, hasResult: boolean, contentSnippet: string, type: string|undefined}|null} Snapshot or null if no item
   * @private
   */
  _snapshotItem() {
    if (!this._selectedItemId || !this._messageThread) return null;

    const registered = this._messageThread.getContextItem(this._selectedItemId);
    if (registered) {
      // Snapshot uses the item's title as a change-detection scalar
      // (it changes when the underlying data changes).
      const snippet = typeof registered.getTitle === 'function' ? String(registered.getTitle() || '') : '';
      return { state: undefined, hasResult: false, contentSnippet: snippet, type: 'context' };
    }

    const { msg } = this._resolveItem();
    if (!msg) return null;

    const msgType = msg.get('type');
    if (msgType === 'tool-action') {
      const result = msg.get('result');
      const displayData = msg.get('displayData');
      const ddJson = displayData ? JSON.stringify(plain(displayData)) : '';
      return {
        state: msg.get('state'),
        hasResult: result !== null && result !== undefined,
        contentSnippet: ddJson.slice(0, 200),
        type: msgType
      };
    }

    const content = msg.get('content') || msg.get('message') || '';
    return {
      state: undefined,
      hasResult: false,
      contentSnippet: typeof content === 'string' ? content.slice(0, 200) : '',
      type: msgType
    };
  }

  /**
   * Create a header element with the circular icon + type-name lozenge badge.
   * This reuses the same `.message-icon-badge` group the conversation list
   * renders for each item, so the panel header and the row it describes show
   * an identical badge — the `title` becomes the lozenge label.
   * @param {string} title - Type-name label shown in the lozenge
   * @param {object} iconOptions - Options for createIconBadge
   * @param {string} iconOptions.color - Color preset
   * @param {string} [iconOptions.iconClass] - CSS class for icon
   * @param {string} [iconOptions.iconSvg] - SVG markup for icon
   * @param {string|null} [iconOptions.pluginId] - Owning capability id; makes the badge a link into the Extensions catalog
   * @param {HTMLElement} [chipEl] - Token chip element (gets margin-left:auto via CSS)
   * @param {string|HTMLElement} [statusText] - Optional status text (string or element) shown beside the badge
   * @param {HTMLElement} [trailingEl] - Element to append after the chip (e.g. View Transaction icon)
   * @param {number} [timestampMs] - Optional Unix ms timestamp to display as a subtle time label
   * @returns {HTMLElement} Header element
   * @private
   */
  _createHeader(title, iconOptions, chipEl = undefined, statusText = undefined, trailingEl = undefined, timestampMs = undefined) {
    const header = document.createElement('header');
    header.className = 'properties-panel-header';

    const badgeGroup = createIconBadge(iconOptions, createTypeBadge(title));
    if (iconOptions.pluginId) this._linkBadgeToCatalog(badgeGroup, iconOptions.pluginId, title);
    header.appendChild(badgeGroup);

    if (statusText instanceof HTMLElement) {
      header.appendChild(statusText);
    } else if (statusText) {
      const statusSpan = document.createElement('span');
      statusSpan.className = 'properties-panel-title-status';
      statusSpan.textContent = statusText;
      header.appendChild(statusSpan);
    }

    if (timestampMs) {
      const date = new Date(timestampMs);
      const { short, full } = formatRelativeDateTime(date);
      const timeEl = document.createElement('time');
      timeEl.className = 'properties-panel-timestamp';
      timeEl.dateTime = date.toISOString();
      timeEl.textContent = short;
      timeEl.title = full;
      header.appendChild(timeEl);
    }

    if (chipEl) header.appendChild(chipEl);
    if (trailingEl) header.appendChild(trailingEl);

    return header;
  }

  /**
   * Make the header's icon + lozenge badge open the item's entry in the
   * Extensions catalog (Settings → Extensions, that capability selected), so
   * "what is this thing, and can I turn it off?" is one click from the item
   * itself. The badge is a link only here: the conversation list paints the
   * same badge from the same resolver and stays inert, since a click there
   * belongs to selecting the row.
   * @param {HTMLElement} badgeGroup - The `.message-icon-badge` group
   * @param {string} pluginId - Registry id of the capability that owns the item
   * @param {string} title - Lozenge label, used in the tooltip
   * @private
   */
  _linkBadgeToCatalog(badgeGroup, pluginId, title) {
    badgeGroup.classList.add('badge-catalog-link');
    badgeGroup.tabIndex = 0;
    badgeGroup.setAttribute('role', 'button');
    const label = `Show "${title}" in the Extensions settings`;
    badgeGroup.title = label;
    badgeGroup.setAttribute('aria-label', label);

    const open = () => {
      openSettings('extensions', { capability: { itemType: 'context-item', id: pluginId } });
    };

    badgeGroup.addEventListener('click', (e) => {
      e.stopPropagation();
      open();
    });
    badgeGroup.addEventListener('keydown', (e) => {
      const key = /** @type {KeyboardEvent} */ (e).key;
      if (key !== 'Enter' && key !== ' ') return;
      e.preventDefault();
      open();
    });
  }

  /**
   * Create a section wrapper with header and controls in standard layout
   * @param {string} title - Type-name label shown in the header lozenge
   * @param {{color: string, iconClass?: string, iconSvg?: string, pluginId?: string|null}} iconOptions - Options for createIconBadge
   * @param {HTMLElement|null} [controls] - Controls element to place after header (null = no controls)
   * @param {string} [statusText] - Optional status text shown beside the badge
   * @param {string} [transactionId] - Round-trip id; renders a small icon button right of the chip
   * @param {number} [timestamp] - Unix ms timestamp to show as subtle time label in the header
   * @returns {HTMLElement} Section wrapper with header + controls
   * @private
   */
  _createSectionWithControls(title, iconOptions, controls = null, statusText = undefined, transactionId = undefined, timestamp = undefined) {
    const wrapper = document.createElement('properties-panel-section');

    const txnBtn = transactionId ? this._buildViewTransactionButton() : undefined;
    wrapper.appendChild(this._createHeader(title, iconOptions, this._buildTokenChip(), statusText, txnBtn, timestamp));
    if (controls) {
      wrapper.appendChild(controls);
    }
    return wrapper;
  }

  /**
   * Build the header's token chip for the selected item: how much of the
   * context this one item costs, in the same standard slot for every item
   * type, so the answer doesn't require a trip to the transaction view.
   *
   * The number is an estimate, marked `~`, unless the provider's own figure can
   * only mean this item. A provider reports one output total per round-trip,
   * and a round-trip usually produces a thinking block, a reply and every tool
   * call it made — stamping that total onto each of them would say each one
   * cost the whole turn. So the reported count replaces the estimate only where
   * it is unambiguous: an assistant or thinking item that was its round-trip's
   * sole output.
   * @returns {HTMLElement|undefined} The chip, or undefined when the item contributes no text.
   * @private
   */
  _buildTokenChip() {
    const id = this._selectedItemId;
    if (!id) return undefined;

    const chip = document.createElement('span');
    chip.className = 'properties-panel-token-chip';
    chip.hidden = true;

    const { msg } = this._resolveItem(id);
    const text = msg ? llmTextForItem(msg) : '';
    if (text) {
      paintTokenChip(chip, text);
      if (chip.hidden) return undefined;
      const txnId = this._soleOutputTransactionId(msg);
      if (txnId) this._paintReportedOutput(chip, txnId, id);
      return chip;
    }

    // A standing context item holds no plain content field — it renders its
    // contribution on demand, and that render is async, so the chip fills in
    // when it lands.
    const contextItem = this._messageThread?.getContextItem(id);
    if (!contextItem || typeof contextItem.getContextText !== 'function') return undefined;
    this._paintContextItemChip(chip, contextItem, id);
    return chip;
  }

  /**
   * The round-trip whose reported output tokens describe `msg` and nothing
   * else, or '' when no such attribution is safe.
   *
   * The worker stamps one transactionId onto every item a round-trip produces,
   * so the reported output total is this item's own only when it is the single
   * output-producing item carrying that id.
   * @param {any} msg - The selected item's Y.Map.
   * @returns {string} The transactionId, or '' when the count would be shared.
   * @private
   */
  _soleOutputTransactionId(msg) {
    if (!REPORTED_OUTPUT_TYPES.has(msg.get('type'))) return '';
    const txnId = String(msg.get('transactionId') || '');
    if (!txnId) return '';

    let outputs = 0;
    for (const item of (this._messageThread?.items || [])) {
      if (String(item.get?.('transactionId') || '') !== txnId) continue;
      if (!OUTPUT_ITEM_TYPES.has(item.get('type'))) continue;
      if (++outputs > 1) return '';
    }
    return outputs === 1 ? txnId : '';
  }

  /**
   * Replace `chip`'s estimate with the round-trip's reported output tokens.
   * A cached count paints straight away, before the chip is even in the header;
   * a fetch has to check that the selection hasn't moved on underneath it.
   * @param {HTMLElement} chip - Chip element already carrying the estimate.
   * @param {string} txnId - Round-trip this item was the sole output of.
   * @param {string} itemId - Selection this chip was built for.
   * @private
   */
  async _paintReportedOutput(chip, txnId, itemId) {
    const cached = this._blobOutputTokens.get(txnId);
    if (cached !== undefined) {
      paintReportedChip(chip, cached);
      return;
    }

    const conversationId = this._conversation?.id;
    if (!conversationId) return;
    try {
      const blob = /** @type {any} */ (await workerManager.getTransaction(conversationId, txnId));
      const tokens = Number(blob?.outputTokens) || 0;
      if (tokens <= 0) return;
      this._blobOutputTokens.set(txnId, tokens);
      if (!chip.isConnected || this._selectedItemId !== itemId) return;
      paintReportedChip(chip, tokens);
    } catch {
      // No blob to read; the estimate already on the chip stands.
    }
  }

  /**
   * Render a context item's LLM text and paint its size onto `chip`. Bails if
   * the selection moved on while the render was in flight, or if the item
   * can't render outside a turn — a missing chip is the right outcome there,
   * not an error the user has to read.
   * @param {HTMLElement} chip - Chip element already in the header.
   * @param {any} contextItem - The registered context-item instance.
   * @param {string} itemId - Selection this chip was built for.
   * @private
   */
  async _paintContextItemChip(chip, contextItem, itemId) {
    try {
      const text = await contextItem.getContextText({
        contextWindowSize: this._conversation?.contextWindow || 0,
        modelConfig: this._conversation?.modelConfig || null,
        helpers: FormattingHelpers,
      });
      if (!chip.isConnected || this._selectedItemId !== itemId) return;
      paintTokenChip(chip, text || '');
    } catch {
      // Item couldn't render its context text here; it simply shows no size.
    }
  }

  /**
   * Build the small icon-only "View Transaction" button shown at the right
   * edge of an item's properties-panel header. Click dispatches a bubbling
   * event that conversation-tab handles by showing or hiding the
   * transaction-mode panel to the right of this column. The event carries no
   * round-trip id: that panel reads whichever item this column is showing.
   * @returns {HTMLButtonElement} The button element ready to insert into the header.
   * @private
   */
  _buildViewTransactionButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'properties-panel-header-icon-btn';
    btn.title = 'View the LLM input/output for this round-trip';
    btn.setAttribute('aria-label', 'View transaction');
    btn.innerHTML = TRANSACTION_ICON_SVG;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('properties-panel:toggle-transaction', {
        bubbles: true,
        composed: true
      }));
    });
    return btn;
  }

  /**
   * Render empty state
   * @param {Element} container
   * @private
   */
  _renderEmptyState(container) {
    container.innerHTML = `
            <properties-panel-empty>
                <span class="properties-panel-empty-icon">
                    ${INFO_SVG}
                </span>
                <span class="properties-panel-empty-text">Select an item to view details</span>
            </properties-panel-empty>
        `;
  }


  /**
   * Render message controls (delete, branch, rollback)
   * @param {Message} message - The message to render controls for
   * @returns {HTMLElement} The controls container element
   * @private
   */
  _renderMessageControls(message) {
    const controls = document.createElement('properties-panel-controls');

    // Only show editing controls for messages with an index
    const messageItemId = message.get('itemId');

    // Queued (pending) message: it isn't in history yet, so rewind/fork/delete-
    // range don't apply — the one action is to remove it from the queue.
    if (messageItemId && this._messageThread && this._resolveItem(messageItemId).isPending) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'properties-panel-btn danger';
      removeBtn.innerHTML = `<span class="icon-trashcan"></span> Remove from queue`;
      removeBtn.addEventListener('click', () => this._removePendingItem(messageItemId));
      controls.appendChild(removeBtn);
      return controls;
    }

    if (messageItemId && this._messageThread) {
      const itemIndex = this._messageThread.findIndexByItemId(messageItemId);

      if (itemIndex >= 0) {
        // Rewind/Fork buttons (for user messages)
        if (message.get('type') === 'user') {
          const rollbackBtn = document.createElement('button');
          rollbackBtn.className = 'properties-panel-btn';
          rollbackBtn.innerHTML = `
                        ${UNDO_SVG}
                        Rewind to this message
                    `;
          rollbackBtn.addEventListener('click', () => this._rollbackFromItem(messageItemId));
          controls.appendChild(rollbackBtn);

          const branchBtn = document.createElement('button');
          branchBtn.className = 'properties-panel-btn';
          branchBtn.innerHTML = `
                        ${FORK_SVG}
                        Fork a new conversation from here
                    `;
          branchBtn.addEventListener('click', () => this._branchFromItem(messageItemId));
          controls.appendChild(branchBtn);
        }

        appendDeleteControls(controls, this._messageThread, messageItemId,
          () => this._deleteItem(messageItemId));
      }
    }

    return controls;
  }

  /**
   * Render context item controls (remove, refresh)
   * @param {ContextItemType} contextItem - The context item to render controls for
   * @returns {HTMLElement} The controls container element
   * @private
   */
  _renderContextItemControls(contextItem) {
    const controls = document.createElement('properties-panel-controls');

    // Pin button (if the owning plugin names something the board can show).
    // First because it is the one control here that changes nothing.
    const pinBtn = createPinControl(/** @type {any} */ (contextItem.constructor)?.getPinSource?.());
    if (pinBtn) controls.appendChild(pinBtn);

    // Refresh button (if context item supports refresh)
    if (typeof /** @type {any} */ (contextItem).refresh === 'function') {
      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'properties-panel-btn';
      refreshBtn.innerHTML = `
                ${RETRY_SVG}
                Refresh
            `;
      refreshBtn.addEventListener('click', () => this._refreshContextItem(contextItem));
      controls.appendChild(refreshBtn);
    }

    // Delete buttons (if context item allows deletion)
    if (!contextItem.preventUserDeletion()) {
      const itemIndex = this._messageThread ? this._messageThread.findIndexByItemId(contextItem.id) : -1;
      if (itemIndex >= 0 && this._messageThread) {
        appendDeleteControls(controls, this._messageThread, contextItem.id,
          () => this._removeContextItem(contextItem));
      } else {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'properties-panel-btn danger';
        removeBtn.innerHTML = `<span class="icon-trashcan"></span> Remove`;
        removeBtn.addEventListener('click', () => this._removeContextItem(contextItem));
        controls.appendChild(removeBtn);
      }
    }

    return controls;
  }

  /**
   * Render tool action controls (re-run, delete, bulk delete)
   * @param {any} toolAction - The tool action to render controls for
   * @returns {HTMLElement} The controls container element
   * @private
   */
  _renderToolActionControls(toolAction) {
    const controls = document.createElement('properties-panel-controls');

    const taResult = toolAction.get('result');
    const ActionClass = this._conversation?.toolActionClass(toolAction.get('toolUseId'));

    // Pin button (if the owning plugin names something the board can show).
    // First because it is the one control here that changes nothing.
    const pinBtn = createPinControl(/** @type {any} */ (ActionClass)?.getPinSource?.());
    if (pinBtn) controls.appendChild(pinBtn);

    // Re-run button (for any completed action that can be re-run). Gate on the
    // owning plugin's declaration — items whose re-execution is a no-op (skill
    // load, memory write, static manual) opt out via isRerunnable()===false.
    const rerunnable = ActionClass?.isRerunnable?.() !== false;
    if (taResult && rerunnable && this._isRetryable(toolAction)) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'properties-panel-btn';
      retryBtn.innerHTML = `
                ${UNDO_SVG}
                Re-run command
            `;
      retryBtn.addEventListener('click', () => this._retryToolAction(toolAction));
      controls.appendChild(retryBtn);
    }

    // Find item index for delete operations
    const taItemId = toolAction.get('itemId');
    if (taItemId && this._messageThread) {
      const itemIndex = this._messageThread.findIndexByItemId(taItemId);

      if (itemIndex >= 0) {
        appendDeleteControls(controls, this._messageThread, taItemId,
          () => this._deleteItem(taItemId));
      }
    }

    return controls;
  }

  /**
   * Check if a tool action can be re-run.
   * Allowed unless a user message follows it or a subsequent tool-action is currently busy.
   * @param {any} toolAction - The tool action to check
   * @returns {boolean} True if action can be re-run
   * @private
   */
  _isRetryable(toolAction) {
    if (!this._conversation) return false;

    const items = this._messageThread ? this._messageThread.items : [];
    const taToolUseId = toolAction.get('toolUseId');
    const myIndex = items.findIndex((/** @type {any} */ m) => m.get('toolUseId') === taToolUseId);
    if (myIndex === -1) return false;

    for (let i = myIndex + 1; i < items.length; i++) {
      const item = items[i];
      if (item.get('type') === 'user') return false;
      // Block re-run if a later tool-action is still running or pending claim
      if (item.get('type') === 'tool-action') {
        const laterState = item.get('state');
        if (laterState === TOOL_STATES.RUNNING || laterState === TOOL_STATES.APPROVED) return false;
      }
    }
    return true;
  }

  // ========================================================================
  // ACTIONS
  // ========================================================================

  /**
   * Rollback from an item
   * @param {string} itemId
   * @private
   */
  _rollbackFromItem(itemId) {
    this.dispatchEvent(new CustomEvent('rollback-from-item', {
      bubbles: true,
      detail: { itemId }
    }));
  }

  /**
   * Branch from an item
   * @param {string} itemId
   * @private
   */
  _branchFromItem(itemId) {
    this.dispatchEvent(new CustomEvent('branch-from-item', {
      bubbles: true,
      detail: { itemId }
    }));
  }

  /**
   * Delete an item, named by id so that a list which has shifted since these
   * controls were built still loses the item they describe.
   * @param {string} itemId
   * @private
   */
  _deleteItem(itemId) {
    if (!this._messageThread) return;
    const items = this._messageThread.items;
    const itemIndex = this._messageThread.findIndexByItemId(itemId);
    if (itemIndex < 0) return;
    // Select a neighbour before deleting so the rebuild picks it up.
    if (itemId === this._selectedItemId) {
      const neighborId = findNeighborItemId(items, itemIndex, this._messageThread);
      if (neighborId) {
        this.dispatchEvent(new CustomEvent('request-item-selection', {
          bubbles: true, composed: true,
          detail: { itemId: neighborId }
        }));
      }
    }
    // deleteItemById re-resolves the id against the array it is about to
    // mutate, so the index resolved above is never what the delete acts on.
    // It also handles a thread item correctly (handing its transcript to
    // another of the thread's views); the column chain sends thread items to a
    // conversation-area rather than here, so that is insurance, not a case
    // this panel serves.
    this._messageThread.deleteItemById(itemId);
  }

  /**
   * Remove a queued (pending) message from the queue. Before removing, hand
   * selection to a neighbouring committed item (or clear) so the rebuild lands
   * somewhere sensible rather than on a now-gone id.
   * @param {string} itemId
   * @private
   */
  _removePendingItem(itemId) {
    if (!this._messageThread) return;
    if (itemId === this._selectedItemId) {
      const items = this._messageThread.items;
      const neighborId = items.length ? items[items.length - 1].get('itemId') : null;
      if (neighborId) {
        this.dispatchEvent(new CustomEvent('request-item-selection', {
          bubbles: true, composed: true,
          detail: { itemId: neighborId }
        }));
      } else {
        this.clearSelection();
      }
    }
    this._messageThread.removeItemById(itemId);
  }

  /**
   * Refresh a context item
   * @param {ContextItemType} contextItem
   * @private
   */
  async _refreshContextItem(contextItem) {
    if (typeof /** @type {any} */ (contextItem).refresh === 'function') {
      await /** @type {any} */ (contextItem).refresh();
    }
  }

  /**
   * Remove a context item
   * @param {ContextItemType} contextItem
   * @private
   */
  _removeContextItem(contextItem) {
    // Select a neighbour before removing so the rebuild picks it up.
    if (this._messageThread && contextItem.id === this._selectedItemId) {
      const items = this._messageThread.items;
      const idx = items.findIndex((/** @type {any} */ i) => i.get('itemId') === contextItem.id);
      if (idx !== -1) {
        const neighborId = findNeighborItemId(items, idx, this._messageThread);
        if (neighborId) {
          this.dispatchEvent(new CustomEvent('request-item-selection', {
            bubbles: true, composed: true,
            detail: { itemId: neighborId }
          }));
        }
      }
    }
    this.dispatchEvent(new CustomEvent('context-item-action', {
      bubbles: true,
      composed: true,
      detail: { action: 'remove', itemId: contextItem.id, threadItemId: this._messageThread?.threadItemId ?? null }
    }));
  }

  /**
   * Retry a tool action
   * @param {any} toolAction
   * @private
   */
  _retryToolAction(toolAction) {
    this._conversation?.retryToolApproval(toolAction.get('toolUseId'));
  }

}

customElements.define('properties-panel', PropertiesPanel);

export default PropertiesPanel;
