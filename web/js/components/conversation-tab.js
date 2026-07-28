//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @typedef {import('../model/conversation.js').default} Conversation
 * @typedef {import('../utils/column-selection.js').ColumnChainEntry} ColumnChainEntry
 */

import { isThreadMessage } from '../../sdk/lib/message.js';
import { createMessageThread } from '../model/message-thread.js';
import { isThreadClosed } from '../model/thread-navigation.js';
import { ColumnSelectionState } from '../utils/column-selection.js';
import { recordTape } from '../utils/event-tape.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
// Columns are created via createElement('conversation-area' | 'properties-panel')
// in _buildConversationColumn. Import the defining modules so the custom elements
// are registered before this component ever instantiates one (otherwise an
// un-upgraded element has no setMessageThread/etc. method).
import './conversation-area.js';
import './properties-panel.js';

/**
 * ConversationTab - Isolated DOM container for a single conversation
 *
 * Supports Miller columns: selecting any item in column N opens column N+1.
 * - Selected thread → column N+1 is a conversation-area with the thread's nested items
 * - Selected non-thread → column N+1 is a properties-panel showing item details
 * - No selection → no columns after N
 *
 * Each conversation tab owns its own:
 * - column-container with dynamically created columns
 * - All UI state (busy indicators, iteration counters, etc.)
 *
 * CRITICAL: No shared state between tabs. Each tab is completely independent.
 */
class ConversationTab extends HTMLElement {
  constructor() {
    super();

    /** @type {Conversation|null} @private */
    this._conversation = null;

    /** @type {HTMLElement|null} @private */
    this._columnContainer = null;

    /** @type {HTMLElement[]} @private - Array of column elements (conversation-area or properties-panel) */
    this._columns = [];

    /** @type {ColumnSelectionState} @private */
    this._selection = new ColumnSelectionState();

    /** @type {(() => void)|null} @private - Session event unsubscribe function */
    this._unsubscribe = null;

    /** @type {boolean} @private - Whether item-selected listener is attached */
    this._itemSelectedListenerAttached = false;

    /** @type {boolean} @private - Tripwire: detects re-entrant _rebuildColumns (Yjs mutation during render) */
    this._isRebuilding = false;

    // Hidden tabs defer the heavy rendering path (_rebuildColumns →
    // renderFromItems → markdown parsing per assistant message) until they
    // become visible. _isHidden gates session-event work; _needsResync
    // records that a deferred sync is pending and is consumed by setActive.
    /** @type {boolean} @private */
    this._isHidden = true;
    /** @type {boolean} @private */
    this._needsResync = false;
    /**
     * Inserted item IDs accumulated while hidden, replayed through
     * onItemsInserted on setActive so the standard auto-selection policy
     * evaluates them.
     * @type {Set<string>|null} @private
     */
    this._deferredInsertedItemIds = null;

    /** @type {boolean} @private - Scroll selections into view after next rebuild (Rule 5b) */
    this._pendingNeighborScroll = false;

    /** @type {boolean} @private - Suppresses Rule 15 autofocus during keyboard navigation */
    this._isKeyboardNavigating = false;

    /** @type {((e: KeyboardEvent) => void)|null} @private - Bound keydown handler for cleanup */
    this._keydownHandler = null;
  }

  connectedCallback() {
    this.render();
  }

  disconnectedCallback() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._keydownHandler) {
      document.removeEventListener('keydown', this._keydownHandler);
      this._keydownHandler = null;
    }
  }

  /**
   * Set the conversation this tab represents
   * @param {Conversation} conversation
   */
  setConversation(conversation) {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }

    this._conversation = conversation;
    this._selection.resetSelections();

    // Reset the first column's scroll restore flag
    if (this._columns[0] && typeof /** @type {any} */ (this._columns[0]).resetScrollRestoreFlag === 'function') {
      /** @type {any} */ (this._columns[0]).resetScrollRestoreFlag();
    }

    // Give conversation reference to this tab
    conversation.setTabElement(this);

    // Subscribe to session events
    const session = conversation.session;
    if (session) {
      this._unsubscribe = /** @type {() => void} */ (session.subscribe((/** @type {{type: string, data?: any}} */ event) => {
        if (!this._conversation) return;

        // Hidden: defer all rendering work. setActive will flush.
        // 'conversation:switched' for our own conv is also a no-op here:
        // setActive() (called from conversation-bar) runs the sync, and
        // doing it again synchronously would defeat the deferred render.
        // Accumulate insertedItemIds so setActive can replay them through
        // the standard onItemsInserted path — keeps the auto-selection
        // rules in one place (rule 2 in conversation-area.js) rather than
        // adding a parallel "what to select on tab activation" policy.
        if (this._isHidden) {
          this._needsResync = true;
          if (event.type === 'conversation:changed' &&
              (!event.data?.conversationId || event.data.conversationId === this._conversation.id)) {
            const ids = event.data?.insertedItemIds;
            if (ids?.length) {
              if (!this._deferredInsertedItemIds) {
                this._deferredInsertedItemIds = new Set();
              }
              for (const id of ids) this._deferredInsertedItemIds.add(id);
            }
          }
          return;
        }

        if (event.type === 'conversation:changed') {
          if (event.data?.conversationId && event.data.conversationId !== this._conversation.id) return;
          recordTape('conv-changed', this._conversation.id, {
            insertedCount: event.data?.insertedItemIds?.length ?? 0
          });
          this._syncWithConversation();

          // Notify all open conversation-area columns about inserted items.
          // Each column self-filters via _pickAutoSelectCandidate so foreign
          // IDs are silently skipped.
          const insertedItemIds = event.data?.insertedItemIds;
          if (insertedItemIds?.length) {
            for (const col of this._columns) {
              if (col.tagName === 'CONVERSATION-AREA') {
                const items = /** @type {any} */ (col)._messageThread?.items
                  ?? this._conversation.rootItems;
                /** @type {any} */ (col).onItemsInserted(insertedItemIds, items);
              }
            }
          }

          // Rule 2b (see conversation-area.js): state-change events (typically
          // empty insertedItemIds — e.g. a tool-action's state going PENDING→
          // APPROVED after the user clicked Approve) hand selection to the
          // next remaining pending-approval item, if any. Each column decides
          // its own next ID; we route through ColumnSelectionState so the
          // rebuild updates the visual + properties panel consistently.
          //
          // Rule 16: when this advances to the next pending approval (e.g. the
          // user just approved the one that had keyboard focus), engage its
          // widget so it gets real focus — not just selection. This path calls
          // ColumnSelectionState directly, bypassing the _onItemSelected auto-
          // engage, so without this the next item is selected but unfocused and
          // Enter merely engages it instead of acting on it.
          if (this._maybeAutoSelectNextPendingInAllColumns()) {
            this._engageSelectedApproval();
          }

          // The onItemsInserted fan-out above can change the root selection
          // to a thread item, opening that thread column DURING this event —
          // after _syncWithConversation's pass already ran. Re-derive
          // selections for any column born selection-less, or a fully
          // coalesced batch (one event for a whole turn) leaves it that way
          // forever.
          this._ensureThreadColumnSelections();
        } else if (event.type === 'contextItems:changed' ||
            event.type === 'processing:stopped' ||
            (event.type === 'conversation:loadstate-changed' &&
             event.data?.conversationId === this._conversation.id)) {
          this._syncWithConversation();
        }
      }));
    }

    // Listen for unified item-selected events (attach once)
    if (!this._itemSelectedListenerAttached) {
      this.addEventListener('item-selected', /** @type {EventListener} */ (this._onItemSelected.bind(this)));
      this.addEventListener('thread-deleted', /** @type {EventListener} */ (this._onThreadDeleted.bind(this)));
      this.addEventListener('cancel-thread-requested', /** @type {EventListener} */ (this._onCancelThreadRequested.bind(this)));
      this.addEventListener('expand-thread-requested', /** @type {EventListener} */ (this._onExpandThreadRequested.bind(this)));
      this.addEventListener('promote-thread-requested', /** @type {EventListener} */ (this._onPromoteThreadRequested.bind(this)));
      this.addEventListener('request-item-selection', /** @type {EventListener} */ (this._onRequestItemSelection.bind(this)));
      this.addEventListener('properties-panel:open-transaction', /** @type {EventListener} */ (this._onOpenTransaction.bind(this)));
      this._itemSelectedListenerAttached = true;
    }

    if (this._isHidden) {
      this._needsResync = true;
    } else {
      this._syncWithConversation();
    }
  }

  /**
   * Get the conversation for this tab
   * @returns {Conversation|null} The conversation instance
   */
  getConversation() {
    return this._conversation;
  }

  /**
   * Get the root conversation area element (column 0)
   * @returns {HTMLElement|null} The root conversation area element
   */
  getConversationArea() {
    return this._columns[0] || null;
  }

  /**
   * Update footers on all conversation-area columns.
   */
  updateAllFooters() {
    for (const col of this._columns) {
      if (col.tagName === 'CONVERSATION-AREA' && 'updateFooter' in col) {
        (/** @type {any} */ (col)).updateFooter();
      }
    }
  }

  /**
   * Sync column layout if needed, then update all footers.
   * Called when LLM status changes. Only calls _syncWithConversation() (which
   * rebuilds all columns) when a sub-thread is active and doesn't have a column
   * yet — Rule B/Rule C: structural rebuild only when the column set actually changes.
   * @param {string|null} [activeThreadId] - Thread ID the LLM is currently processing
   */
  syncWithStatus(activeThreadId = null) {
    if (activeThreadId !== null && activeThreadId !== undefined) {
      const alreadyOpen = this._columns.some(
        col => col.tagName === 'CONVERSATION-AREA' &&
        /** @type {any} */ (col).getMessageThread?.()?.threadItemId === activeThreadId
      );
      if (!alreadyOpen) {
        this._syncWithConversation();
      }
    }
    this.updateAllFooters();
  }

  /**
   * Get the MessageThread from the column whose input-box is visible.
   * @returns {import('../model/message-thread.js').MessageThread|null} The input column's MessageThread
   */
  getActiveMessageThread() {
    const col = this._inputColumn();
    return col ? /** @type {any} */ (col).getMessageThread?.() || null : null;
  }

  /**
   * Get the visible input box.
   * @returns {HTMLElement|null} The input box element
   */
  getInputBox() {
    const col = this._inputColumn();
    return col ? col.querySelector('input-box') || null : null;
  }

  /**
   * Find the conversation-area column whose input-box is visible
   * (deepest open thread, or root if no open thread column exists).
   * @returns {HTMLElement|null} The column element, or null
   * @private
   */
  _inputColumn() {
    // Global text-ops (rollback / branch / edit-message-into-box / warnings)
    // target the FOCUSED column when it shows a box; otherwise fall back to the
    // deepest open column, then root. With a box on every open thread, "the
    // input box" is whichever column the user is actually working in.
    const active = /** @type {HTMLElement} */ (this._columns[this._selection.activeColumnIndex]);
    if (active && active.tagName === 'CONVERSATION-AREA' && !active.hasAttribute('data-hide-input')) {
      return active;
    }
    return this._deepestInputColumn();
  }

  /**
   * Deepest conversation-area column that shows a box (root if none show one).
   * Structural signal: Rule 15 keys focus-follows on this so focus moves only
   * when a thread opens/closes, not when the user shifts focus between existing
   * columns.
   * @returns {HTMLElement|null} The column element, or null
   * @private
   */
  _deepestInputColumn() {
    for (let i = this._columns.length - 1; i >= 0; i--) {
      const col = /** @type {HTMLElement} */ (this._columns[i]); // bounded by i < this._columns.length
      if (col.tagName === 'CONVERSATION-AREA' && !col.hasAttribute('data-hide-input')) {
        return col;
      }
    }
    return this._columns[0] || null;
  }

  /**
   * The conversation-area column that Find (⌘F) should search: the focused
   * column when it is a conversation-area, else the first conversation-area
   * column. Unlike {@link _inputColumn}, a column whose input box is hidden
   * still qualifies — Find searches a column's messages, it doesn't type into
   * its composer.
   * @returns {HTMLElement|null} The conversation-area element, or null.
   */
  getActiveConversationColumn() {
    const active = /** @type {HTMLElement} */ (this._columns[this._selection.activeColumnIndex]);
    if (active && active.tagName === 'CONVERSATION-AREA') return active;
    return /** @type {HTMLElement|null} */ (
      this._columns.find((c) => /** @type {HTMLElement} */ (c).tagName === 'CONVERSATION-AREA') || null
    );
  }

  // ── Focus management ──────────────────────────────────────────────
  //
  // Two focus modes: TYPING (textarea focused) and NAVIGATING (textarea
  // blurred, arrow keys move between items).
  //
  // Rules (numbered continuing from selection/scrolling rules 1-11
  // in conversation-area.js):
  //  12. Click item              → blur textarea (enter navigating mode)
  //  13. Click empty / textarea  → focus textarea (enter typing mode)
  //  14. Arrow keys (navigating) → stay navigating
  //  15. Input column changes (not during keyboard navigation)
  //      → focus new input column's textarea.
  //      Covers thread created, thread closed, and thread deleted —
  //      all cases where the user's typing target moves.
  //      Suppressed when _isKeyboardNavigating is true, so arrow-key
  //      navigation through threads never steals focus to a message
  //      box.  The flag is set by _setupKeyboardNavigation around
  //      arrow/enter handling.
  //      Detected in _rebuildColumns by comparing _inputColumn()
  //      before and after the rebuild.
  //  16. Approval auto-selected   → engage approval widget (focus its
  //      buttons for up/down keyboard selection).
  //  17. Escape while navigating  → focus textarea (enter typing mode).
  //      Escape always moves "up" one level:
  //      approval buttons → item list → textarea.
  //  18. All other events         → no focus change
  //      (LLM auto-select of non-approval, sync, remote data changes)
  //  19. Properties-panel content is debounced (150 ms) so rapid
  //      arrow-key navigation doesn't pay for markdown parsing /
  //      syntax highlighting on every item traversed.  The panel DOM
  //      element is placed immediately for layout; content waits for
  //      the selection to settle.  Safe because the panel is
  //      display-only and doesn't participate in focus management.
  //
  // All focus changes go through _focusInput() or _blurInput() below,
  // except action-confirmation which manages its own button focus.

  /**
   * Focus the visible input column's textarea (enter typing mode).
   * @private
   */
  _focusInput() {
    const textarea = this._inputColumn()?.querySelector('input-box textarea');
    if (textarea) /** @type {HTMLTextAreaElement} */ (textarea).focus();
  }

  /**
   * Blur the textarea if it's currently focused (enter navigating mode).
   * @private
   */
  _blurInput() {
    if (document.activeElement?.tagName === 'TEXTAREA') {
      /** @type {HTMLElement} */ (document.activeElement).blur();
    }
  }

  /** Mark this tab as active (visible). */
  setActive() {
    this.classList.add('active');
    this.classList.remove('hidden');
    this._isHidden = false;

    if (this._columns[0] && this._conversation) {
      /** @type {any} */ (this._columns[0]).conversation = this._conversation;
    }

    const suppressActivationFocus = !!document.querySelector('conversation-bar.tab-list-focused');
    const runWithoutAutofocus = (/** @type {() => void} */ fn) => {
      const wasKeyboardNavigating = this._isKeyboardNavigating;
      if (suppressActivationFocus) this._isKeyboardNavigating = true;
      try {
        fn();
      } finally {
        this._isKeyboardNavigating = wasKeyboardNavigating;
      }
    };

    // First activation of a previously-hidden tab is expensive (markdown
    // parse for every assistant message). Paint the loading overlay now
    // and defer the resync so the browser shows the active tab + spinner
    // before the render blocks. Subsequent activations are cheap and run
    // inline.
    if (!this._needsResync) {
      runWithoutAutofocus(() => {
        this._syncWithConversation();
        this._flushDeferredInsertions();
        this._ensureThreadColumnSelections();
      });
      return;
    }
    this._needsResync = false;
    this._renderLoadingOverlay('loading');
    setTimeout(() => {
      if (this._isHidden) return; // user clicked another tab first
      runWithoutAutofocus(() => {
        this._syncWithConversation();
        this._flushDeferredInsertions();
        this._ensureThreadColumnSelections();
      });
    }, 0);
  }

  /**
   * Rule 2b implementation: ask each conversation-area column for its next
   * pending-approval target (if any) and apply it via ColumnSelectionState
   * so the visual update and properties panel stay consistent. Idempotent:
   * `getNextPendingApprovalToSelect` returns null when there's nothing to do.
   * @returns {boolean} true iff a column's selection was advanced to a new
   *   pending approval (so the caller can engage its widget — Rule 16).
   * @private
   */
  _maybeAutoSelectNextPendingInAllColumns() {
    let didChange = false;
    for (let i = 0; i < this._columns.length; i++) {
      const col = /** @type {HTMLElement} */ (this._columns[i]); // bounded by i < this._columns.length
      if (col.tagName !== 'CONVERSATION-AREA') continue;
      const nextId = /** @type {any} */ (col).getNextPendingApprovalToSelect?.();
      if (!nextId) continue;
      this._selection.selectItem(i, nextId);
      didChange = true;
    }
    recordTape('autoselect-allcols', this._conversation?.id ?? null, { didChange });
    if (didChange) {
      this._rebuildColumns(false);
    }
    return didChange;
  }

  /**
   * Reveal whatever needs the user in this conversation, invoked after a "jump to
   * attention" switch. When `selectApproval` is true, select the first pending
   * approval (routing through {@link _maybeAutoSelectNextPendingInAllColumns} so
   * the visual + properties panel stay consistent); otherwise scroll the root
   * column to the end of the thread. First activation of a hidden tab defers its
   * render, so retry across frames until the columns exist. When an approval is
   * selected, keyboard focus is also moved onto its buttons so the user can
   * immediately arrow up/down and press Enter without clicking first.
   * @param {boolean} selectApproval - Prefer the first pending approval over scroll.
   * @param {number} [_attempt] - Internal retry counter.
   * @returns {void}
   */
  revealAttention(selectApproval, _attempt = 0) {
    if (!this.classList.contains('active')) return;
    const root = this._columns[0];
    if (!root) {
      if (_attempt < 30 && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => this.revealAttention(selectApproval, _attempt + 1));
      }
      return;
    }
    if (selectApproval) {
      this._maybeAutoSelectNextPendingInAllColumns();
      this._engageSelectedApproval();
    } else if (typeof /** @type {any} */ (root).scrollToBottom === 'function') {
      /** @type {any} */ (root).scrollToBottom(true);
    }
  }

  /**
   * Move keyboard focus onto the first selected approval's buttons so ↑/↓/Enter
   * work immediately after a jump-to-attention, without a click. Deferred a
   * frame because {@link _maybeAutoSelectNextPendingInAllColumns} may rebuild the
   * column, recreating the action-confirmation element. Columns are scanned in
   * order (root first) and only the first pending approval is engaged.
   * @private
   */
  _engageSelectedApproval() {
    const run = () => {
      for (const col of this._columns) {
        if (col.tagName !== 'CONVERSATION-AREA') continue;
        const selected = /** @type {any} */ (col).getSelectedElement?.();
        const confirmation = selected?.querySelector?.('action-confirmation');
        if (confirmation && typeof confirmation.engage === 'function') {
          confirmation.engage();
          return;
        }
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }

  /**
   * Fan accumulated-while-hidden insertedItemIds into each conversation-area
   * column's onItemsInserted, so the standard auto-selection policy
   * (_pickAutoSelectCandidate: error > pending-approval > shouldAutoSelect >
   * fallback) evaluates them exactly as it would have if the tab had been
   * visible. The user-override gate (_selectionOrigin === 'user') still
   * applies, so a manual selection made before switching away is preserved.
   * @private
   */
  _flushDeferredInsertions() {
    if (!this._deferredInsertedItemIds || this._deferredInsertedItemIds.size === 0) {
      this._deferredInsertedItemIds = null;
      return;
    }
    const insertedItemIds = Array.from(this._deferredInsertedItemIds);
    this._deferredInsertedItemIds = null;
    if (!this._conversation) return;
    for (const col of this._columns) {
      if (col.tagName !== 'CONVERSATION-AREA') continue;
      const items = /** @type {any} */ (col)._messageThread?.items
        ?? this._conversation.rootItems;
      /** @type {any} */ (col).onItemsInserted(insertedItemIds, items);
    }
  }

  /** Mark this tab as hidden (not visible). */
  setHidden() {
    // Relinquish focus while the tab is still rendered. WebKit keeps focus on
    // a textarea whose ancestor becomes display:none, so a hidden tab would
    // keep swallowing keystrokes into its now-invisible input box.
    if (
      document.activeElement instanceof HTMLElement &&
      this.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
    this.classList.remove('active');
    this.classList.add('hidden');
    this._isHidden = true;
  }

  /**
   * Render the tab structure — no permanent properties-panel
   * @private
   */
  render() {
    this.innerHTML = `
      <column-container>
      </column-container>
    `;

    this._columnContainer = this.querySelector('column-container');
    this._columns = [];

    // Focus management: clicking a column makes it active
    if (this._columnContainer) {
      this._columnContainer.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        const column = target.closest('conversation-area, properties-panel');
        if (column) {
          const idx = this._columns.indexOf(/** @type {HTMLElement} */ (column));
          if (idx >= 0) {
            // Footer action buttons are not manual navigation — don't suppress auto-selection
            if (!target.closest('conversation-footer')) {
              this._selection.markManualInteraction();
            }
            this._selection.activeColumnIndex = idx;
            this._updateActiveColumnVisuals(true);
          }
        }
      });
    }

    this._setupKeyboardNavigation();
  }

  /**
   * Set up centralized keyboard navigation (single document listener)
   * @private
   */
  _setupKeyboardNavigation() {
    if (this._keydownHandler) return; // already set up

    this._keydownHandler = (e) => {
      // Only handle if this is the active tab
      if (!this.classList.contains('active')) return;

      // An overlay (modal, settings panel, dropdown) owns the keyboard: this is
      // a document-level handler that navigates/cancels the conversation BEHIND
      // it, so it must stand down while a popup is open — otherwise ↑/↓ would
      // move the selection under the overlay. Single rule, shared with the
      // central command dispatcher (see KeyShortcutManager.suppressedByOverlay).
      if (keyShortcutManager.suppressedByOverlay()) return;

      // Don't handle if user is typing in an input
      const target = /** @type {Element|null} */ (e.target);
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;

      // If focus is inside an action-confirmation widget, let it handle arrow/Enter/Escape keys
      if (target && target.closest('action-confirmation')) return;

      // Tab-list focus mode owns arrow keys until the user re-enters the tab.
      if (document.querySelector('conversation-bar.tab-list-focused')) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') return;
      }

      const activeCol = this._columns[this._selection.activeColumnIndex];
      if (!activeCol) return;

      // Rule 15 suppression: flag that we're inside keyboard navigation
      // so _rebuildColumns won't steal focus to a sub-thread message box.
      this._isKeyboardNavigating = true;
      try {
        switch (e.key) {
          case 'Delete':
          case 'Backspace': {
            // ⌘/Ctrl+Backspace is the bin-conversation chord (KeyShortcutManager).
            // Both listeners sit on document, and stopPropagation() doesn't stop
            // same-target listeners, so this handler still sees the chord — but it
            // must not delete the selected item under it. When binning is refused
            // (a running turn), the chord should do nothing, not fall through here.
            if (e.metaKey || e.ctrlKey) break;
            let propsPanel = null;
            if (activeCol.tagName === 'PROPERTIES-PANEL') {
              propsPanel = activeCol;
            } else if (activeCol.tagName === 'CONVERSATION-AREA') {
              const nextCol = this._columns[this._selection.activeColumnIndex + 1];
              if (nextCol?.tagName === 'PROPERTIES-PANEL' || nextCol?.tagName === 'CONVERSATION-AREA') {
                propsPanel = /** @type {HTMLElement} */ (nextCol);
              }
            }
            const deleteBtn = /** @type {HTMLElement|null} */ (propsPanel?.querySelector('.properties-panel-btn.danger'));
            if (deleteBtn) {
              e.preventDefault();
              deleteBtn.click();
            }
            break;
          }
          case 'ArrowDown':
            if (activeCol.tagName !== 'CONVERSATION-AREA') break;
            e.preventDefault();
            this._selection.markManualInteraction();
            if (e.altKey) {
              /** @type {any} */ (activeCol).selectNextUserMessage();
            } else {
              /** @type {any} */ (activeCol).selectNextItem();
            }
            break;
          case 'ArrowUp':
            if (activeCol.tagName !== 'CONVERSATION-AREA') break;
            e.preventDefault();
            this._selection.markManualInteraction();
            if (e.altKey) {
              /** @type {any} */ (activeCol).selectPreviousUserMessage();
            } else {
              /** @type {any} */ (activeCol).selectPreviousItem();
            }
            break;
          case 'ArrowRight':
            if (activeCol.tagName !== 'CONVERSATION-AREA') break;
            e.preventDefault();
            this._selection.markManualInteraction();
            this._navigateRight();
            break;
          case 'ArrowLeft':
            if (activeCol.tagName !== 'CONVERSATION-AREA') break;
            e.preventDefault();
            this._selection.markManualInteraction();
            if (this._selection.activeColumnIndex === 0) {
              document.dispatchEvent(new CustomEvent('juggler:focus-tab-list'));
            } else {
              this._navigateLeft();
            }
            break;
          case 'Enter': {
            if (activeCol.tagName !== 'CONVERSATION-AREA') break;
            const selectedItem = /** @type {any} */ (activeCol).getSelectedElement?.();
            if (selectedItem) {
              const confirmation = selectedItem.querySelector('action-confirmation');
              if (confirmation) {
                e.preventDefault();
                confirmation.engage();
              }
            }
            break;
          }
          case 'Escape':
            // A popup/modal open over the conversation owns Escape (popup-manager
            // dismisses it and stops the key at document); the overlay gate at the
            // top of this handler already returned before we got here, so by this
            // point no overlay is open and Escape means "stop the turn behind me".
            // Cancel fires regardless of which column type is active (a
            // "Re-run command" click lands in the properties panel; gating
            // cancel on CONVERSATION-AREA left Escape a silent no-op there).
            // shouldHandleEscape() is the single decision for "is there
            // something to stop" (it catches the re-run's activity='awaiting_llm').
            // The vantage is the active column's thread: a sub-thread column
            // interrupts that thread (leaves it open); the root column (or a
            // non-thread column like properties) stops everything and closes
            // open sub-threads.
            // @ts-ignore - jugglerApp is added dynamically in app.js
            if (window.jugglerApp && window.jugglerApp.shouldHandleEscape()) {
              const focusedThreadId = (activeCol.tagName === 'CONVERSATION-AREA'
                && typeof (/** @type {any} */ (activeCol).getMessageThread) === 'function')
                ? (/** @type {any} */ (activeCol).getMessageThread()?.threadItemId ?? null)
                : null;
              // Shift+Escape = polite stop (Pause): finish the current step then
              // rest at idle, cancelling nothing. No `toggle` flag — unlike the
              // footer Pause button, pressing Shift+Escape again while a Pause is
              // pending re-affirms it rather than turning it off. Plain Escape =
              // hard cancel, and (per D7) escalates a pending Pause to a full cancel.
              // @ts-ignore
              window.jugglerApp.cancelLLMOperation(focusedThreadId, { polite: e.shiftKey });
            }
            // Rule 17: escape while navigating the conversation-area → typing mode.
            if (activeCol.tagName === 'CONVERSATION-AREA') this._focusInput();
            break;
        }
      } finally {
        this._isKeyboardNavigating = false;
      }
    };

    document.addEventListener('keydown', this._keydownHandler);
  }

  /**
   * Navigate right into a thread's column (Finder-style)
   * @private
   */
  _navigateRight() {
    const activeCol = this._columns[this._selection.activeColumnIndex];
    if (!activeCol || activeCol.tagName !== 'CONVERSATION-AREA') return;

    // Only enter if the selected item is a thread
    if (!/** @type {any} */ (activeCol).isSelectedItemThread()) return;

    // The next column should already exist (created by item-selected event)
    const nextIndex = this._selection.activeColumnIndex + 1;
    const nextCol = this._columns[nextIndex];
    if (!nextCol || nextCol.tagName !== 'CONVERSATION-AREA') return;

    this._selection.navigateRight(nextIndex);
    this._updateActiveColumnVisuals(true);

    // Select first item in the new column
    requestAnimationFrame(() => {
      const ids = /** @type {any} */ (nextCol).getSelectableItemIds();
      if (ids && ids.length > 0) {
        /** @type {any} */ (nextCol).selectItem(ids[0]);
      }
    });
  }

  /**
   * Navigate left to parent column (Finder-style)
   * @private
   */
  _navigateLeft() {
    if (this._selection.navigateLeft()) {
      this._updateActiveColumnVisuals(true);
    }
  }

  /**
   * Toggle active-column class on columns for visual distinction
   * @param {boolean} [scroll=false] - Whether to scroll the active column into view
   * @private
   */
  _updateActiveColumnVisuals(scroll = false) {
    const activeIndex = this._selection.activeColumnIndex;
    for (let i = 0; i < this._columns.length; i++) {
      /** @type {HTMLElement} */ (this._columns[i]).classList.toggle('active-column', i === activeIndex);
    }

    if (scroll) {
      this._scrollToActiveColumn();
    }
  }

  /**
   * Scroll the column container so the active column is fully visible.
   * Only explicit user navigation (arrow keys, clicking a column) triggers this.
   * @private
   */
  _scrollToActiveColumn() {
    const col = this._columns[this._selection.activeColumnIndex];
    if (!col || !this._columnContainer) return;
    const containerRef = this._columnContainer;
    requestAnimationFrame(() => {
      const container = containerRef;
      const panel = container.querySelector('properties-panel');
      if (!panel) {
        col.scrollIntoView({ inline: 'nearest', block: 'nearest' });
        return;
      }
      // Left-align the active column so the properties panel fills remaining space.
      // This shows the full column and maximises panel visibility.
      const targetScrollLeft = col.offsetLeft;
      if (Math.abs(container.scrollLeft - targetScrollLeft) > 1) {
        container.scrollTo({ left: targetScrollLeft, behavior: 'smooth' });
      }
    });
  }

  /**
   * Programmatically open a thread at any nesting depth.
   * Resolves the full selection chain from root to the target thread
   * via the Yjs tree (not DOM), then rebuilds columns with scroll and focus.
   * @param {string} threadItemId - The thread item ID to open
   */
  openThread(threadItemId) {
    if (!this._conversation) return;
    const chain = this._selection.resolveThreadChain(
      [...this._conversation.rootItems],
      threadItemId,
      isThreadMessage
    );
    if (chain.length === 0) return;
    this._selection.selections = chain;
    this._selection.activeColumnIndex = chain.length;
    this._selection.markManualInteraction();
    this._rebuildColumns(true);
    // Rules 6-7: _rebuildColumns applies the selection visually but
    // doesn't scroll items (most rebuilds are data-driven).  This is
    // a genuinely new selection, so scroll the thread item into view
    // in its parent column.
    this._scrollSelectionsIntoView();
  }

  /**
   * Scroll each column's selected item into view (nearest edge).
   * Complements _rebuildColumns which applies selection classes but
   * intentionally skips scrolling (to avoid hijacking scroll on
   * data-driven rebuilds).  Called by openThread and _syncWithConversation
   * after setting genuinely new selections — the same cases where
   * _selectItem's Rules 6-7 would fire if the selection went through
   * the normal entry point.
   * @private
   */
  _scrollSelectionsIntoView() {
    for (let i = 0; i < this._selection.selections.length; i++) {
      const col = /** @type {HTMLElement} */ (this._columns[i]); // bounded by i < this._columns.length
      const itemId = this._selection.selections[i];
      if (col?.tagName === 'CONVERSATION-AREA' && itemId) {
        /** @type {any} */ (col)._scrollItemIntoView(itemId);
      }
    }
  }

  /**
   * Handle unified item selection in any column
   * @param {CustomEvent} e
   * @private
   */
  _onItemSelected(e) {
    const { itemId, origin, reveal, revealable } = e.detail;
    if (!this._conversation) return;

    // Find which column the event came from
    const target = /** @type {HTMLElement} */ (e.target);
    const column = target.closest('conversation-area, properties-panel');
    const columnIndex = column ? this._columns.indexOf(/** @type {HTMLElement} */ (column)) : 0;
    if (columnIndex < 0) return;

    // Repeat-click on an already-selected item: the selection is unchanged, so
    // there's nothing to rebuild. It's a deliberate "show me more" gesture —
    // reveal the item's details column if it's drifted mostly off-screen (the
    // same intent the narrow-viewport tap below expresses for a fresh tap).
    if (reveal) {
      this._revealDetailsColumn(columnIndex);
      return;
    }

    if (!itemId) {
      this._selection.clearSelection(columnIndex);
    } else {
      if (origin === 'user') {
        this._selection.markManualInteraction();
      }
      this._selection.selectItem(columnIndex, itemId);
    }

    this._rebuildColumns(origin === 'user');

    // On a narrow viewport the columns are full-width and paged, so the child
    // column that just appeared for the tapped item sits off-screen to the
    // right. Reveal it so the user sees the detail they selected. Prose
    // (user/assistant messages) is exempt — a tap there is reading, not a
    // request to scroll away to a child column (see _isItemRevealable).
    if (origin === 'user' && itemId && revealable && window.matchMedia?.('(width <= 36rem)').matches) {
      this._revealDetailsColumn(columnIndex);
    }

    // Rule 16: auto-engage approval widget when LLM auto-selects an approval item
    if (origin === 'auto' && itemId && column) {
      requestAnimationFrame(() => {
        const el = column.querySelector(`[message-id="${itemId}"] action-confirmation`);
        if (el) /** @type {any} */ (el).engage();
      });
    }
  }

  /**
   * Reveal the child column immediately to the right of the given column by
   * horizontally scrolling the column container — but only when that column is
   * currently mostly off-screen. The child is either the selected item's
   * properties panel (for a leaf item) or its thread conversation column (for a
   * thread item); both are revealed. Shared by the two "show me more about this
   * item" gestures: tapping an item on a narrow/paged viewport (where the
   * just-opened child column is a full page to the right), and repeat-clicking
   * an already-selected item on desktop (where the child column may have drifted
   * mostly past the right edge). No-op when there's no child column to the right,
   * or it's already at least half visible.
   * @param {number} columnIndex - Index of the column whose child column to reveal
   * @private
   */
  _revealDetailsColumn(columnIndex) {
    const container = this._columnContainer;
    if (!container) return;
    const nextCol = /** @type {HTMLElement|undefined} */ (this._columns[columnIndex + 1]);
    if (nextCol?.tagName !== 'PROPERTIES-PANEL' && nextCol?.tagName !== 'CONVERSATION-AREA') return;
    // Measure after layout settles (the column may have just been (re)built),
    // then scroll only if the details column is more than half off-screen.
    requestAnimationFrame(() => {
      const containerRect = container.getBoundingClientRect();
      const colRect = nextCol.getBoundingClientRect();
      const visibleWidth = Math.max(0,
        Math.min(colRect.right, containerRect.right) - Math.max(colRect.left, containerRect.left));
      const mostlyVisible = colRect.width > 0 && visibleWidth / colRect.width >= 0.5;
      if (mostlyVisible) return;
      container.scrollTo({ left: nextCol.offsetLeft, behavior: 'smooth' });
    });
  }

  /**
   * Handle a stop request from a thread tile / properties panel. Resolves the
   * thread Y.Map and routes to the unified worker-truth cancel.
   * @param {CustomEvent} e
   * @private
   */
  _onCancelThreadRequested(e) {
    const { threadItemId } = e.detail || {};
    if (!threadItemId || !this._conversation) return;
    const threadYMap = this._conversation.findItemById(threadItemId);
    if (threadYMap && threadYMap.get?.('type') === 'thread') {
      void this._conversation.cancelThread(threadYMap);
    }
  }

  /**
   * Handle an expand request from a thread's Result block: splice the thread's
   * items back into the parent and drop the tile, then rebuild columns (the
   * open thread column collapses).
   * @param {CustomEvent} e
   * @private
   */
  _onExpandThreadRequested(e) {
    const { threadItemId } = e.detail || {};
    if (!threadItemId || !this._conversation) return;
    if (this._conversation.expandThread(threadItemId)) {
      this._selection.deleteThread?.(threadItemId);
      this._rebuildColumns(true);
    }
  }

  /**
   * Handle promote request from a thread's Result block. Cross-doc promote is a
   * copy into a new tab; the original thread stays in place because undo cannot
   * span two Yjs documents.
   * @param {CustomEvent} e
   * @private
   */
  _onPromoteThreadRequested(e) {
    const { threadItemId } = e.detail || {};
    if (!threadItemId || !this._conversation) return;
    void this._conversation.promoteThreadToNewTab(threadItemId, { activate: true });
  }

  /**
   * Handle thread deletion event
   * @param {CustomEvent} e
   * @private
   */
  _onThreadDeleted(e) {
    const { threadItemId } = e.detail;
    if (!threadItemId || !this._conversation) return;

    this._selection.deleteThread(threadItemId);

    // Delete the thread item using the parent message thread stored on the thread column
    const target = /** @type {HTMLElement} */ (e.target);
    const column = target.closest('conversation-area');
    const parentThread = column && /** @type {any} */ (column)._parentMessageThread;
    if (parentThread) {
      parentThread.deleteItemById(threadItemId);
    }

    this._rebuildColumns();  // Rule 15 handles focus
  }

  /**
   * Handle "View Transaction" click in any properties panel.
   * Records the open transaction tied to the originating column + selection;
   * the next rebuild appends a transaction-mode panel column at the right.
   * Clicking the same button again while that transaction is open toggles it
   * closed. Subsequent selection changes invalidate the anchor and the panel drops.
   * @param {CustomEvent} e
   * @private
   */
  _onOpenTransaction(e) {
    const { transactionId } = e.detail || {};
    if (!transactionId) return;

    const target = /** @type {HTMLElement} */ (e.target);
    const panel = target.closest('properties-panel');
    if (!panel) return;
    const columnIndex = this._columns.indexOf(/** @type {HTMLElement} */ (panel));
    if (columnIndex < 0) return;

    // The originating panel always corresponds to selections[columnIndex - 1]
    // — properties panels live one column to the right of the conversation-area
    // they describe.
    const itemId = this._selection.selections[columnIndex - 1];
    if (!itemId) return;

    // Toggle: clicking the button for the transaction that's already open
    // closes it, rather than reopening the same panel.
    const open = this._selection.openTxn;
    if (open && open.columnIndex === columnIndex &&
        open.itemId === itemId && open.transactionId === transactionId) {
      this._selection.closeTransaction();
    } else {
      this._selection.openTransaction(columnIndex, itemId, transactionId);
    }
    this._selection.markManualInteraction();
    this._rebuildColumns(true);
  }

  /**
   * Handle pre-deletion neighbor selection request (Rule 5b).
   * Updates selection state so the next _rebuildColumns picks up the neighbor.
   * @param {CustomEvent} e
   * @private
   */
  _onRequestItemSelection(e) {
    const { itemId } = e.detail;
    if (!itemId) return;
    const target = /** @type {HTMLElement} */ (e.target);
    const column = target.closest('properties-panel, conversation-area');
    if (!column) return;
    const columnIndex = this._columns.indexOf(/** @type {HTMLElement} */ (column));
    if (columnIndex < 1) return;
    // Select in parent conversation-area column (one to the left)
    this._selection.selectItem(columnIndex - 1, itemId);
    this._selection.markManualInteraction();
    this._pendingNeighborScroll = true;
  }

  /**
   * Rebuild column DOM to match the resolved chain.
   * @param {boolean} [scroll=false] - Whether to scroll the active column into view
   * @private
   */
  _rebuildColumns(scroll = false) {
    if (!this._columnContainer || !this._conversation) return;

    // Tripwire: a re-entrant call means something in the render path is
    // mutating Yjs data. Log loudly so the violation is caught during dev.
    if (this._isRebuilding) {
      console.error('[ConversationTab] _rebuildColumns called re-entrantly — ' +
          'a render path is likely mutating Yjs data.', new Error().stack);
      return;
    }
    this._isRebuilding = true;
    try {

      // Rule 15: capture input column BEFORE rebuild — setting data-hide-input
      // hides the textarea (display:none) which causes the browser to blur it,
      // so we must snapshot focus state here, not after. Keyed on the deepest
      // box column (structural) so focus follows a thread opening/closing, not
      // a focus shift between columns that both already show a box.
      const prevInputCol = this._deepestInputColumn();

      const conversation = this._conversation;
      const chain = this._selection.resolveColumnChain(conversation.rootMessageThread, isThreadMessage);
      const session = conversation.session;

      // Build new columns array matching the chain
      /** @type {HTMLElement[]} */
      const newColumns = [];

      for (const [i, entry] of chain.entries()) {
        if (entry.type === 'conversation') {
          newColumns.push(this._buildConversationColumn(i, entry, conversation, session, newColumns));
        } else if (entry.type === 'properties') {
          newColumns.push(this._buildPropertiesColumn(i, entry, conversation, chain));
        } else if (entry.type === 'transaction') {
          newColumns.push(this._buildTransactionColumn(i, entry, conversation));
        }
      }

      // Remove excess old columns
      for (let i = chain.length; i < this._columns.length; i++) {
        /** @type {HTMLElement} */ (this._columns[i]).remove();
      }

      this._columns = newColumns;

      // Tripwire: the column-sizing CSS, the active-column scroll, and (until
      // this was made explicit) the resize-handle visibility all assume the
      // column-container's element children appear in the SAME order as
      // this._columns. New columns are appended to the end and reused ones kept
      // in place, so this should always hold — log loudly with a stack if it
      // ever doesn't, to capture the path that breaks it. Resize-handle
      // visibility is now driven from the logical order (_updateColumnLayout)
      // so it survives a divergence, but a divergence is still a real bug.
      const domColumns = Array.from(this._columnContainer.children).filter(
        (el) => el.tagName === 'CONVERSATION-AREA' || el.tagName === 'PROPERTIES-PANEL'
      );
      if (domColumns.length !== newColumns.length ||
          newColumns.some((col, i) => domColumns[i] !== col)) {
        console.error('[ConversationTab] column-container DOM order diverged from ' +
          'logical column order — column visuals may be wrong.',
        { domCount: domColumns.length, logicalCount: newColumns.length },
        new Error().stack);
      }

      this._applyInputVisibility(chain, newColumns);
      this._applySelectionHighlights(newColumns);

      // Apply column width classes
      this._updateColumnLayout();

      // Clamp active column index to a conversation-area column
      this._selection.clampActiveIndex(this._columns);
      this._updateActiveColumnVisuals(scroll);

      // Rule 15: input column changed → focus new input column's textarea,
      // UNLESS we're inside keyboard navigation (arrow keys selecting items).
      // Covers thread created, closed (LLM exit / result set), and deleted.
      // Suppressed during keyboard nav so arrow-keying onto a sub-thread
      // doesn't steal focus from item navigation.
      const newInputCol = this._deepestInputColumn();
      if (newInputCol && newInputCol !== prevInputCol && !this._isKeyboardNavigating) {
        this._focusInput();
      }

    } finally {
      this._isRebuilding = false;
    }
  }

  /**
   * Build (or reuse) the conversation-area column for chain entry `i`.
   * @param {number} i
   * @param {any} entry
   * @param {any} conversation
   * @param {any} session
   * @param {HTMLElement[]} newColumns
   * @returns {HTMLElement} The conversation-area column element.
   * @private
   */
  _buildConversationColumn(i, entry, conversation, session, newColumns) {
    const existingCol = this._columns[i];
    // Need a conversation-area column
    let col;
    if (existingCol && existingCol.tagName === 'CONVERSATION-AREA') {
      col = existingCol;
    } else {
      if (existingCol) existingCol.remove();
      col = document.createElement('conversation-area');
      if (i > 0) col.classList.add('thread-column');
      /** @type {any} */ (this._columnContainer).appendChild(col);
    }

    const messageThread = (i === 0)
      ? conversation.rootMessageThread
      : createMessageThread(conversation, entry.container, entry.threadItemId);

    /** @type {any} */ (col).setMessageThread(messageThread);
    /** @type {any} */ (col).conversation = conversation;

    // Pre-sync selection BEFORE renderFromItems so a stale _localSelectedItemId
    // (from a thread this column previously displayed) doesn't trigger
    // _clearSelection and a re-entrant _rebuildColumns call.
    /** @type {any} */ (col)._localSelectedItemId = this._selection.selections[i] || null;

    if (i === 0) {
      // Root column
      /** @type {any} */ (col).setThreadContext?.(null);
      /** @type {any} */ (col).hideThreadHeader?.();
      const rootItems = conversation.rootItems;
      const rootPendingKey = (conversation.rootMessageThread.pendingItems || [])
        .map((/** @type {any} */ it) => it.get?.('itemId') ?? '').join(',');
      const rootItemKey = rootItems.map((/** @type {any} */ it) => it.get?.('itemId') ?? '').join(',') +
        '|pending:' + rootPendingKey;
      if (/** @type {any} */ (col)._renderedItemKey !== rootItemKey) {
        /** @type {any} */ (col)._renderedItemKey = rootItemKey;
        /** @type {any} */ (col).renderFromItems(rootItems);
      }
    } else {
      // Thread column
      /** @type {any} */ (col).setThreadContext?.(entry.threadYMap || null);

      const threadItems = entry.container.get('items');
      const items = threadItems && threadItems.toArray ? threadItems.toArray() : [];
      const threadPending = entry.container.get('pendingItems');
      const threadPendingArr = threadPending && threadPending.toArray ? threadPending.toArray() : [];
      const threadPendingKey = threadPendingArr.map((/** @type {any} */ it) => it?.get?.('itemId') ?? '').join(',');
      const threadItemKey = items.map((/** @type {any} */ it) => it?.get?.('itemId') ?? '').join(',') +
        '|pending:' + threadPendingKey;
      if (/** @type {any} */ (col)._renderedItemKey !== threadItemKey) {
        /** @type {any} */ (col)._renderedItemKey = threadItemKey;
        /** @type {any} */ (col).renderFromItems([...items]);
      }

      // Show thread header with parent message thread for delete operations
      if (entry.threadYMap) {
        const goal = entry.threadYMap.get('goal') || '';
        const parentMessageThread = (i === 1)
          ? conversation.rootMessageThread
          : newColumns[i - 1] && /** @type {any} */ (newColumns[i - 1]).getMessageThread?.();
        /** @type {any} */ (col).showThreadHeader?.(goal, entry.threadYMap, parentMessageThread);
      }
    }

    // Restore scroll after render
    window.requestAnimationFrame(() => {
      // @ts-ignore
      col.restoreScrollPosition?.();
    });

    // Set session/conversation on input-box
    const inputBox = col.querySelector('input-box');
    if (inputBox) {
      if (session) {
        // @ts-ignore
        inputBox.setSession(session);
      }
      // @ts-ignore
      inputBox.setConversation(conversation);
      // @ts-ignore
      inputBox.setMessageThread(messageThread);
    }

    return col;
  }

  /**
   * Build (or reuse) the properties-panel column for chain entry `i`.
   * @param {number} i
   * @param {any} entry
   * @param {any} conversation
   * @param {any[]} chain
   * @returns {HTMLElement} The properties-panel column element.
   * @private
   */
  _buildPropertiesColumn(i, entry, conversation, chain) {
    const existingCol = this._columns[i];
    // Need a properties-panel column
    let col;
    if (existingCol && existingCol.tagName === 'PROPERTIES-PANEL') {
      col = existingCol;
    } else {
      if (existingCol) existingCol.remove();
      col = document.createElement('properties-panel');
      /** @type {any} */ (this._columnContainer).appendChild(col);
    }

    // Debounce properties-panel content rendering so rapid arrow-key
    // navigation doesn't pay for markdown parsing / syntax highlighting
    // on every item traversed.  The panel DOM element exists immediately
    // for layout; expensive content waits for the selection to settle.
    // Skip entirely when the selection + conversation haven't changed.
    const selectedItemId = entry.selectedItemId;
    const parentEntry = chain[i - 1];
    const propInputKey = `${conversation.id}:${selectedItemId}`;
    if (/** @type {any} */ (col)._renderedInputKey !== propInputKey) {
      /** @type {any} */ (col)._renderedInputKey = propInputKey;
      clearTimeout(/** @type {any} */ (col)._juggler_renderTimer);
      /** @type {any} */ (col)._juggler_renderTimer = setTimeout(() => {
        /** @type {any} */ (col).setConversation(conversation);
        const parentMessageThread = parentEntry?.threadItemId
          ? createMessageThread(conversation, parentEntry.container, parentEntry.threadItemId)
          : conversation.rootMessageThread;
        /** @type {any} */ (col).setMessageThread(parentMessageThread);
        /** @type {any} */ (col).selectItem(selectedItemId);
        // Render settle: the properties panel paints ~150ms AFTER the
        // selection key changed. A flake that asserts the panel's content
        // before this fires shows the assert ts < props-render ts.
        recordTape('props-render', conversation.id, { selectedItemId });
      }, 150);
    }

    return col;
  }

  /**
   * Build (or reuse) the transaction-mode properties-panel column for chain entry `i`.
   * @param {number} i
   * @param {any} entry
   * @param {any} conversation
   * @returns {HTMLElement} The transaction-mode properties-panel column element.
   * @private
   */
  _buildTransactionColumn(i, entry, conversation) {
    const existingCol = this._columns[i];
    // Need a properties-panel column in transaction mode (renders the
    // input/output blob for one LLM round-trip — leaf, never nested
    // further).
    let col;
    if (existingCol && existingCol.tagName === 'PROPERTIES-PANEL') {
      col = existingCol;
    } else {
      if (existingCol) existingCol.remove();
      col = document.createElement('properties-panel');
      col.classList.add('properties-panel-transaction');
      /** @type {any} */ (this._columnContainer).appendChild(col);
    }
    const txInputKey = `${conversation.id}:${entry.transactionId}`;
    if (/** @type {any} */ (col)._renderedInputKey !== txInputKey) {
      /** @type {any} */ (col)._renderedInputKey = txInputKey;
      /** @type {any} */ (col).setTransaction(conversation.id, entry.transactionId);
    }
    return col;
  }

  /**
   * Set data-hide-input on the columns that shouldn't show an input-box.
   * @param {any[]} chain
   * @param {HTMLElement[]} newColumns
   * @private
   */
  _applyInputVisibility(chain, newColumns) {
    // Hide the input-box ONLY on closed sub-thread columns; every open thread
    // (root included) keeps its own box. A closed column shows a "reopen closed
    // thread" affordance in the box's slot instead — driven off this same
    // attribute (see the conversation-area[data-hide-input] reopen-box rule),
    // so data-hide-input now means exactly "this column's thread is closed".
    //
    // "Closed" is isThreadClosed (result set AND nothing awaiting approval),
    // NOT just "has a result" — a sub-thread parked on your approval is still
    // active even when a stale "interrupted" result sits on it from a reload,
    // so its column must keep the input box. Same rule the tile-status colour
    // uses; both go through the one predicate so the input box and the orange
    // highlight never disagree.
    for (let i = chain.length - 1; i >= 0; i--) {
      const col = newColumns[i];
      if (!col || col.tagName !== 'CONVERSATION-AREA') continue;
      const isClosed = i > 0 && isThreadClosed(chain[i].threadYMap);
      if (isClosed) {
        col.setAttribute('data-hide-input', '');
      } else {
        // Re-measure the textarea ONLY on the hidden→visible transition: a
        // textarea inside a display:none box reads scrollHeight 0, so it must
        // be re-sized once revealed. Gated to the actual transition because a
        // visible box is already correctly sized, and re-running on every
        // rebuild (e.g. arrow-key item navigation) is wasted work.
        const wasHidden = col.hasAttribute('data-hide-input');
        col.removeAttribute('data-hide-input');
        if (wasHidden) {
          const inputBox = col.querySelector('input-box');
          const textarea = inputBox?.querySelector('textarea');
          if (textarea) /** @type {any} */ (inputBox).autoResize(textarea);
        }
      }
    }
  }

  /**
   * Apply the selected-item CSS class on each conversation-area column.
   * @param {HTMLElement[]} newColumns
   * @private
   */
  _applySelectionHighlights(newColumns) {
    // Apply selected-item CSS class on each conversation-area column.
    // _localSelectedItemId was pre-synced before renderFromItems above;
    // this loop just ensures the visual highlight is applied after render.
    for (let i = 0; i < newColumns.length; i++) {
      const col = /** @type {HTMLElement} */ (newColumns[i]); // bounded by i < newColumns.length
      if (col.tagName !== 'CONVERSATION-AREA') continue;
      const selectedId = this._selection.selections[i] || null;
      /** @type {any} */ (col)._applySelectedClass(selectedId);
    }
  }

  /**
   * Update column layout CSS classes based on column count
   * @private
   */
  _updateColumnLayout() {
    if (!this._columnContainer) return;

    const lastIndex = this._columns.length - 1;
    for (let i = 0; i < this._columns.length; i++) {
      const col = /** @type {HTMLElement} */ (this._columns[i]); // bounded by i < this._columns.length
      col.classList.toggle('thread-column', i > 0 && col.tagName === 'CONVERSATION-AREA');
      // Hide the resize handle on the rightmost column (it has nothing to its
      // right to drag against) by marking it explicitly from the logical column
      // order — `this._columns` is the single source of truth. The CSS used to
      // key this off `:last-child`, which silently breaks if the DOM child order
      // ever diverges from the logical order (the wrong column's handle vanishes).
      // A lone column stays resizable, so the marker is only applied when there
      // is more than one column.
      col.classList.toggle('column-rightmost', i === lastIndex && this._columns.length > 1);
    }
  }

  /**
   * Show or hide the lazy-load overlay (spinner or error+retry) on this tab.
   * @param {'unloaded'|'loading'|'loaded'|'error'} loadState
   * @private
   */
  _renderLoadingOverlay(loadState) {
    let overlay = /** @type {HTMLElement|null} */ (this.querySelector(':scope > .conversation-tab-loading-overlay'));
    if (loadState === 'loaded') {
      if (overlay) overlay.remove();
      return;
    }
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'conversation-tab-loading-overlay';
      this.appendChild(overlay);
    }
    overlay.classList.remove('state-unloaded', 'state-loading', 'state-error');
    overlay.classList.add(`state-${loadState}`);
    if (loadState === 'error') {
      overlay.innerHTML = `
        <div class="conversation-tab-loading-content">
          <div class="conversation-tab-loading-message">
            Failed to load conversation
          </div>
          <button type="button" class="conversation-tab-loading-retry">Retry</button>
        </div>
      `;
      const retryBtn = overlay.querySelector('.conversation-tab-loading-retry');
      retryBtn?.addEventListener('click', () => {
        const conv = this._conversation;
        conv?.session?.retryConversationLoad?.(conv.id);
      }, { once: true });
    } else {
      overlay.innerHTML = `
        <div class="conversation-tab-loading-content">
          <juggler-spinner></juggler-spinner>
        </div>
      `;
    }
  }

  /**
   * Sync tab UI with conversation state
   * @private
   */
  _syncWithConversation() {
    const conversation = this._conversation;
    if (!conversation) return;

    // While the Yjs doc is still hydrating the columns would be empty —
    // show the spinner overlay instead so the panel doesn't look like an
    // empty conversation.
    const loadState = conversation.loadState;
    this._renderLoadingOverlay(loadState);
    if (loadState !== 'loaded') return;

    // Auto-select thread chain when processing state targets a new thread
    const llmState = conversation._llmState;
    let autoSelected = false;
    if (llmState) {
      const statusThreadId = llmState.getStatusThreadId(conversation.id);
      autoSelected = this._selection.maybeAutoSelectThread(statusThreadId, conversation.rootItems, isThreadMessage);
    }

    // Rebuild all columns (root + any open threads/properties).
    // When a new thread was auto-selected, scroll horizontally to reveal it.
    this._rebuildColumns(autoSelected);

    this._ensureThreadColumnSelections();

    // Rules 6-7: new auto-selected thread or Rule 5b neighbor selection →
    // scroll the selected item into view in its parent column.
    if (autoSelected || this._pendingNeighborScroll) {
      this._pendingNeighborScroll = false;
      this._scrollSelectionsIntoView();
    }

  }

  /**
   * Invariant: an open thread column that has no selection and no user lock
   * derives its selection from its current items (the standard rule-2 policy
   * via onItemsInserted). Thread items live in nested Y.Arrays, so their
   * insertedItemIds never propagate through the root-level observer; and a
   * thread column can be OPENED mid-event by the root column auto-selecting
   * its thread item — after the retro pass in _syncWithConversation already
   * ran. So this must be (re-)applied at the END of every path that can have
   * opened a column: data syncs, the conversation:changed batch handler, and
   * the deferred-insert flush on tab activation. When a whole turn arrives in
   * one coalesced batch (fast worker turn, or a late-joining viewer), no
   * later event will rescue a column missed here. Idempotent: skipped if
   * already selected or user-locked.
   * @private
   */
  _ensureThreadColumnSelections() {
    for (const col of this._columns) {
      if (col.tagName === 'CONVERSATION-AREA' && col.classList.contains('thread-column')) {
        const threadCol = /** @type {any} */ (col);
        if (!threadCol._localSelectedItemId && threadCol._selectionOrigin !== 'user') {
          const items = threadCol._messageThread?.items ?? [];
          if (items.length > 0) {
            const itemIds = items.map(/** @type {(i: any) => string|undefined} */ (i) => i?.get?.('itemId')).filter(Boolean);
            threadCol.onItemsInserted(/** @type {string[]} */ (itemIds), items);
          }
        }
      }
    }
  }
}

customElements.define('conversation-tab', ConversationTab);

export default ConversationTab;
