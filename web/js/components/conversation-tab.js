//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @typedef {import('../model/conversation.js').default} Conversation
 * @typedef {import('../utils/column-selection.js').ColumnChainEntry} ColumnChainEntry
 * @typedef {import('./conversation-area.js').default} ConversationArea
 */

import { isThreadMessage } from '../../sdk/lib/message.js';
import { findFirstPendingApprovalId } from '../model/thread-navigation.js';
import { ColumnSelectionState } from '../utils/column-selection.js';
import { rootFontSizePx, columnScrollDelta } from '../utils/column-resize.js';
import { isToolGroupingEnabled, TOOL_GROUPING_EVENT } from '../utils/tool-grouping-pref.js';
import { buildDisplayItems, isGroupId, groupMemberIndices } from '../utils/item-grouping.js';
import { isItemSelectable } from '../services/context-item-utilities.js';
import { recordTape } from '../utils/event-tape.js';
import { SHEET_QUERY } from '../utils/popup-surface.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import JugglerElement from './juggler-element.js';
import { handleEscapeKey } from '../services/escape-behaviour.js';
import { ColumnBuilder, asArea, asPanel } from './column-builder.js';

/**
 * Fired on `document` when the thread the user is reading changes, carrying
 * `{threadItemId}` (null for a root column). Column selection lives in the tab
 * and not in session state, so this is the only notice a surface outside the
 * conversation gets that the focused thread has moved.
 */
export const THREAD_FOCUS_CHANGED = 'juggler:thread-focus-changed';

/**
 * How much of the column it moved past a column-level scroll leaves showing, in
 * rem (so it tracks zoom, as every other column measurement does).
 *
 * A scroll that parks a column boundary exactly on the container's edge produces
 * the one arrangement that cannot be read: a chain that continues looks
 * identical to a chain that ends. Leaving a sliver behind costs nothing and
 * removes the ambiguity — it is the reason Finder's columns never sit flush.
 * Small on purpose: enough to read as the edge of something, too narrow to be
 * mistaken for a column you were meant to be looking at.
 */
const COLUMN_PEEK_REM = 1.5;

/**
 * ConversationTab - Isolated DOM container for a single conversation
 *
 * Supports Miller columns: selecting any item in column N opens column N+1.
 * - Selected thread → column N+1 is a conversation-area with the thread's nested items
 * - Selected tool group → column N+1 is a conversation-area listing the folded
 *   rows, bound to the SAME thread as column N (the rows never moved)
 * - Selected non-thread → column N+1 is a properties-panel showing item details
 * - No selection → no columns after N
 *
 * Each conversation tab owns its own:
 * - column-container with dynamically created columns
 * - All UI state (busy indicators, iteration counters, etc.)
 *
 * CRITICAL: No shared state between tabs. Each tab is completely independent.
 */
class ConversationTab extends JugglerElement {
  constructor() {
    super();

    /** @type {Conversation|null} @private */
    this._conversation = null;

    /** @type {HTMLElement|null} @private - The non-scrolling box around _columnContainer that draws its edge fades */
    this._columnViewport = null;

    /** @type {HTMLElement|null} @private */
    this._columnContainer = null;

    /** @type {HTMLElement[]} @private - Array of column elements (conversation-area or properties-panel) */
    this._columns = [];

    /** @type {ResizeObserver|null} @private - Watches the container for the edge-fade classes */
    this._columnOverflowObserver = null;

    /** @type {boolean} @private - Whether the edge-fade teardown is registered */
    this._columnOverflowWired = false;

    /** @type {ColumnSelectionState} @private */
    this._selection = new ColumnSelectionState();

    /** @type {(() => void)|null} @private - Session event unsubscribe function */
    this._unsubscribe = null;

    /** @type {(() => void)|null} @private - Conversation status feed unsubscribe function */
    this._statusUnsubscribe = null;

    /** @type {boolean} @private - Whether item-selected listener is attached */
    this._itemSelectedListenerAttached = false;

    /** @type {boolean} @private - Tripwire: detects re-entrant _rebuildColumns (Yjs mutation during render) */
    this._isRebuilding = false;

    /**
     * The thread id last announced as focused, so THREAD_FOCUS_CHANGED fires on
     * a real move rather than on every rebuild. `undefined` until the first
     * announcement, which is how a genuine null (the root column) is told apart
     * from having said nothing yet.
     * @type {string|null|undefined} @private
     */
    this._announcedThreadItemId = undefined;

    // Hidden tabs defer the heavy rendering path (_rebuildColumns →
    // renderFromItems → markdown parsing per assistant message) until they
    // become visible. _isHidden gates session-event work; _needsResync
    // records that a deferred sync is pending and is consumed by setActive.
    /** @type {boolean} @private */
    this._isHidden = true;
    /** @type {boolean} @private - Whether hidden transcript DOM has been discarded */
    this._isParked = false;
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

    /** @type {boolean} @private - Whether the document keydown listener is live (see _setupKeyboardNavigation) */
    this._keyboardNavWired = false;

    /** @type {ColumnBuilder} @private - Builds the columns, and remembers what it last rendered into each */
    this._builder = new ColumnBuilder();
  }

  connectedCallback() {
    this.render();
    this.onWindow(TOOL_GROUPING_EVENT, () => this._onToolGroupingChanged());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Re-assignable (setConversation disposes and re-subscribes mid-life), so
    // they stay fields rather than addCleanup registrations.
    this._dropSubscriptions();
  }

  /**
   * Drop the session and status subscriptions taken by {@link setConversation}.
   * @private
   */
  _dropSubscriptions() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._statusUnsubscribe) {
      this._statusUnsubscribe();
      this._statusUnsubscribe = null;
    }
  }

  /**
   * The tool-grouping preference flipped: re-render every column under the new
   * display rule, carrying each selection across the fold.
   *
   * Selections are ids, and folding changes which ids exist in a column: a
   * member id becomes its group's id when folding, and a group id becomes its
   * first row when unfolding. Translating them here means the user keeps
   * looking at the same thing, one level in or out. Nothing about the document
   * changes — only what each column lists.
   * @private
   */
  _onToolGroupingChanged() {
    if (!this._conversation) return;
    const enabled = isToolGroupingEnabled();

    for (let i = 0; i < this._columns.length; i++) {
      const col = asArea(this._columns[i]);
      if (!col) continue;

      const selectedId = this._selection.selections[i];
      if (selectedId) {
        const items = col.listedItems;
        let nextId = selectedId;
        if (enabled) {
          const { memberToGroup } = buildDisplayItems(items, { enabled: true });
          nextId = memberToGroup.get(selectedId) || selectedId;
        } else if (isGroupId(selectedId)) {
          nextId = selectedId.slice(selectedId.indexOf(':') + 1);
        }
        if (nextId !== selectedId) {
          this._selection.selections[i] = nextId;
          // Selecting into a group opened a column that no longer exists (or
          // now does); later selections belong to a chain that just changed
          // shape, so drop them rather than resolve them against the wrong list.
          this._selection.selections.length = i + 1;
        }
        col.presetSelectedItemId(this._selection.selections[i] ?? null);
      }

      // The rendered-item key is a function of what was listed, which is exactly
      // what changed — forget it so the column repaints.
      this._builder.invalidate(col);
    }

    this._rebuildColumns(false);
  }

  /**
   * Set the conversation this tab represents
   * @param {Conversation} conversation
   */
  setConversation(conversation) {
    this._dropSubscriptions();

    this._conversation = conversation;
    this._selection.resetSelections();

    // Reset the first column's scroll restore flag, and hand the root column
    // its conversation. The tab owns its columns: the conversation never
    // writes into one.
    const root = asArea(this._columns[0]);
    root?.resetScrollRestoreFlag();
    if (root) root.conversation = conversation;

    // Give conversation reference to this tab
    conversation.setTabElement(this);

    // Paint status changes. Rule B: syncWithStatus opens the running thread's
    // column before it updates the footers, so the spinner appears in the
    // right column.
    this._statusUnsubscribe = conversation.onStatusChange(() => {
      this.syncWithStatus(conversation.llmState?.getStatusThreadId(conversation.id) ?? null);
    });

    // Subscribe to session events
    const session = conversation.session;
    if (session) {
      this._unsubscribe = /** @type {() => void} */ (session.subscribe((/** @type {{type: string, data?: any}} */ event) => {
        if (!this._conversation) return;

        // A send or a continue: move to the end the moment it is asked for,
        // hidden or not, rather than waiting out the round-trip.
        if (event.type === 'conversation:turn-requested') {
          if (event.data?.conversationId === this._conversation.id) {
            asArea(this._columns[0])?.scrollToBottom(true);
          }
          return;
        }

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
          // Each column self-filters via pickAutoSelectCandidate so foreign
          // IDs are silently skipped.
          const insertedItemIds = event.data?.insertedItemIds;
          if (insertedItemIds?.length) {
            for (const col of this._columns) {
              const area = asArea(col);
              if (area) {
                const items = area.getMessageThread()?.items
                  ?? this._conversation.rootItems;
                area.onItemsInserted(insertedItemIds, items);
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
          // Rule 16: when this advances to a pending approval (e.g. the user
          // just approved the one that had keyboard focus, or one arrived on
          // its own), engage its widget so it gets real focus — not just
          // selection. This path calls ColumnSelectionState directly, bypassing
          // the _onItemSelected auto-engage, so without this the next item is
          // selected but unfocused and Enter merely engages it instead of
          // acting on it. _engageSelectedApproval applies Rule 16's draft
          // exception itself: this path sees arriving approvals too, so gating
          // only the _onItemSelected one leaves the keyboard stealable.
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
        } else if (event.type === 'session:loaded') {
          // The session finished loading: repaint the root column from the
          // document rather than trust what was rendered while it loaded.
          const rootColumn = this._columns[0];
          if (rootColumn) this._builder.invalidate(rootColumn);
          this._syncWithConversation();
        } else if (event.type === 'processing:stopped' ||
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
      this.addEventListener('show-transaction-requested', /** @type {EventListener} */ (this._onShowTransactionRequested.bind(this)));
      this.addEventListener('properties-panel:toggle-transaction', /** @type {EventListener} */ (this._onToggleTransaction.bind(this)));
      this.addEventListener('restore-input-focus', /** @type {EventListener} */ (this._onRestoreInputFocus.bind(this)));
      this._itemSelectedListenerAttached = true;
    }

    if (this._isHidden) {
      this._needsResync = true;
    } else {
      this._syncWithConversation();
    }
  }

  /**
   * Get the conversation for this conversation
   * @returns {Conversation|null} The conversation instance
   */
  getConversation() {
    return this._conversation;
  }

  /**
   * Get the root conversation area element (column 0)
   * @returns {ConversationArea|null} The root conversation area element
   */
  getConversationArea() {
    return asArea(this._columns[0]);
  }

  /**
   * Update footers on all conversation-area columns.
   */
  updateAllFooters() {
    for (const col of this._columns) {
      asArea(col)?.updateFooter();
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
        col => asArea(col)?.getMessageThread()?.threadItemId === activeThreadId
      );
      if (!alreadyOpen) {
        this._syncWithConversation();
      }
    }
    this.updateAllFooters();
  }

  /**
   * Get the MessageThread from the column whose composer-box is visible.
   * @returns {import('../model/message-thread.js').MessageThread|null} The input column's MessageThread
   */
  getActiveMessageThread() {
    return asArea(this._inputColumn())?.getMessageThread() || null;
  }

  /**
   * Whether the user has anything sendable typed or staged anywhere in this
   * tab. Every open column carries its own box, so a draft in a thread column
   * counts just as much as one in the root — this asks "is the user part-way
   * through a message here?", which gates whether another conversation may pull
   * them to a different tab.
   * @returns {boolean} True when any of this tab's composers is non-empty.
   */
  hasComposerText() {
    let hasText = false;
    this.querySelectorAll('composer-box').forEach((box) => {
      if (typeof box.isEmpty === 'function' && !box.isEmpty()) hasText = true;
    });
    return hasText;
  }

  /**
   * Get the visible composer.
   * @returns {HTMLElement|null} The composer element
   */
  getComposer() {
    const col = this._inputColumn();
    return col ? col.querySelector('composer-box') || null : null;
  }

  /**
   * Find the conversation-area column whose composer-box is visible
   * (deepest open thread, or root if no open thread column exists).
   * @returns {HTMLElement|null} The column element, or null
   * @private
   */
  _inputColumn() {
    // Global text-ops (rollback / branch / edit-message-into-box / warnings)
    // target the FOCUSED column when it shows a box; otherwise fall back to the
    // deepest open column, then root. With a box on every open thread, "the
    // composer" is whichever column the user is actually working in.
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
   * The column Find (⌘F) should search: the focused column when it has
   * something to search, else the leftmost column that has.
   *
   * Column TYPE is not the test — offering a find target is. A properties panel
   * opened from a message is the active column and its detail is worth
   * searching, while an empty one has nothing and steps aside for the
   * conversation beside it. Unlike {@link _inputColumn}, a column whose composer
   * is hidden still qualifies: Find searches a column's content, it doesn't type
   * into its composer.
   * @returns {HTMLElement|null} The column to search, or null when no column can be.
   */
  getFindColumn() {
    /**
     * @param {Element} col - A column.
     * @returns {boolean} Whether it currently offers somewhere to search.
     */
    const searchable = (col) => !!(asArea(col) ?? asPanel(col))?.getFindTarget();
    const active = /** @type {HTMLElement} */ (this._columns[this._selection.activeColumnIndex]);
    if (active && searchable(active)) return active;
    return /** @type {HTMLElement|null} */ (this._columns.find(searchable) || null);
  }

  /**
   * The thread the user is reading: the nearest conversation-area column at or
   * to the left of the active one. A root column has no thread item of its own,
   * which is what null means here.
   *
   * Scanning leftwards is what distinguishes this from {@link getFindColumn},
   * which answers with the active column itself whenever it has something to
   * search. That answers Find's question — which column's content to search —
   * but not this one: selecting an item inside a sub-thread opens a properties
   * panel to its right and makes that panel active, and Find is content to
   * search the panel. The column immediately left of it is the thread the item
   * actually belongs to.
   * @returns {string|null} The focused thread item's id, or null for the root.
   */
  getFocusedThreadItemId() {
    for (let i = Math.min(this._selection.activeColumnIndex, this._columns.length - 1); i >= 0; i--) {
      const col = asArea(this._columns[i]);
      if (col) {
        return col.getMessageThread()?.threadItemId ?? null;
      }
    }
    return null;
  }

  /**
   * Announce the focused thread, but only when it has actually moved. Surfaces
   * outside the conversation — the pinboard's Plan and Todo pins — follow the
   * thread the user is reading, and this is the only notice they get: column
   * selection is not session state, so nothing else reports it.
   * @private
   */
  _announceThreadFocus() {
    // A hidden tab still rebuilds columns; the thread it happens to have
    // selected is not the one anybody is reading.
    if (this._isHidden) return;
    const threadItemId = this.getFocusedThreadItemId();
    if (threadItemId === this._announcedThreadItemId) return;
    this._announcedThreadItemId = threadItemId;
    document.dispatchEvent(new CustomEvent(THREAD_FOCUS_CHANGED, { detail: { threadItemId } }));
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
  //  14b. Auto-selection in another column → the active column doesn't move.
  //      Which column the arrow keys drive is the user's choice; a column
  //      picking up an item that just arrived applies the selection to itself
  //      and leaves the keyboard alone (ColumnSelectionState.selectItem's
  //      `focus` option). Moving the selection also leaves the row's
  //      horizontal scroll alone — see _scrollToActiveColumn.
  //  15. Input column changes (not during keyboard navigation)
  //      → focus new input column's textarea.
  //      Covers a thread being created and a thread being deleted —
  //      the cases where the user's typing target moves.
  //      Suppressed when _isKeyboardNavigating is true, so arrow-key
  //      navigation through threads never steals focus to a message
  //      box.  The flag is set by _setupKeyboardNavigation around
  //      arrow/enter handling.
  //      Detected in _rebuildColumns by comparing _inputColumn()
  //      before and after the rebuild.
  //  16. Approval auto-selected   → engage approval widget (focus its
  //      buttons for up/down keyboard selection), UNLESS the message
  //      box holds a draft — an arriving approval must not take the
  //      keyboard off a prompt being written.  Same doctrine as rule
  //      20: take focus only where nothing has a better claim to it.
  //      The item is still selected either way, so Escape/arrows/Enter
  //      still reach it, as does the jump-to-attention shortcut, which
  //      engages on demand because the user asked for it.
  //  17. Escape while navigating  → focus textarea (enter typing mode).
  //      Escape always moves "up" one level:
  //      approval buttons → item list → textarea.
  //  18. All other events         → no focus change
  //      (LLM auto-select of non-approval, sync, remote data changes)
  //  19. Properties-panel content is debounced (150 ms) so rapid
  //      arrow-key navigation doesn't pay for markdown parsing /
  //      syntax highlighting on every item traversed.  The panel DOM
  //      element is placed immediately for layout; content waits for
  //      the selection to settle.  A change arriving after a second of
  //      stillness renders straight away, so a single click costs
  //      nothing.  Safe because the panel is display-only and doesn't
  //      participate in focus management.
  //  20. Inline prompt answered     → focus textarea (enter typing mode).
  //      An approval widget or question form holds the keyboard while
  //      it is up, then deletes itself on the answer — which would
  //      strand focus on <body>, and no rule above fires at the end of
  //      a turn to reclaim it.  The dismissing widget requests the
  //      hand-back with a bubbling `restore-input-focus`, keeping the
  //      decision here rather than in the widget.
  //
  // Focus is taken through _focusInput() below, except by
  // action-confirmation, which manages its own button focus.

  /**
   * Focus an input column's textarea (enter typing mode).
   *
   * `column` names the box to type into when the caller already knows it.
   * Rule 15's move is one of those: it fires because a column opened or closed,
   * and the box it means is that column's — whereas {@link _inputColumn}
   * answers "where is the user working", which during a reveal is still the
   * column they clicked in. Focusing that one instead lands the keyboard in the
   * PARENT's composer, and rule B reads a composer taking focus as the user
   * turning to compose, retiring the pin that opening the sub-thread just set.
   * @param {HTMLElement|null} [column] - Column whose box to focus; defaults to
   *   the column the user is working in.
   * @private
   */
  _focusInput(column = null) {
    const textarea = /** @type {HTMLTextAreaElement|null} */ (
      (column ?? this._inputColumn())?.querySelector('composer-box textarea')
    );
    if (!textarea) return;
    // Force a synchronous layout flush before focusing. When this runs during a
    // column rebuild (e.g. a freshly opened thread) the textarea can be newly
    // inserted and not yet laid out, and WebKit silently ignores focus() on an
    // unrendered element — so the new thread's box never actually took the
    // keyboard. Reading a layout property flushes pending layout so the element
    // is focusable right now, making the focus deterministic instead of racy.
    void textarea.offsetHeight;
    textarea.focus();
  }

  /**
   * Re-assert keyboard focus on the input column `target` across a short window.
   *
   * A column built during a rebuild isn't focusable in the same synchronous
   * tick, and a late async re-render of the new column can bounce focus to
   * <body> a beat later — so a single focus() (sync or deferred) is unreliable.
   * This retries over a few macrotasks (setTimeout, not requestAnimationFrame:
   * a backgrounded WKWebView throttles rAF to near-zero and would strand the
   * focus), re-focusing whenever focus has been lost to <body> or is still
   * sitting on the previously-focused input column (`staleCol`).
   *
   * Tightly bounded and guarded so it never fights a legitimate focus change:
   * it stops if the tab is hidden, keyboard-nav starts, or the input column
   * changes again, and it leaves focus alone when it has moved somewhere real
   * (a dialog, another column the user clicked).
   * @param {HTMLElement} target - The input column that should hold focus.
   * @param {HTMLElement|null} staleCol - The previously-focused input column.
   * @param {number} attempts - Remaining retry ticks.
   * @private
   */
  _reassertInputFocus(target, staleCol, attempts) {
    if (attempts <= 0) return;
    if (this._isHidden || this._isKeyboardNavigating) return;
    if (this._deepestInputColumn() !== target) return;
    const active = document.activeElement;
    const inTarget = !!(active && target.contains(active));
    if (!inTarget) {
      const lost = !active || active === document.body;
      const onStale = !!(staleCol && active && staleCol.contains(active));
      if (lost || onStale) this._focusInput(target);
    }
    // Keep watching even when focus currently looks right: a subsequent
    // re-render can still bounce it to <body> within this window.
    setTimeout(() => this._reassertInputFocus(target, staleCol, attempts - 1), 30);
  }

  /**
   * Whether a message box currently holds a prompt the user is writing, and so
   * has a better claim on the keyboard than an arriving approval (Rule 16).
   *
   * Both halves are load-bearing. Focus must be IN a message box: a draft the
   * user has clicked away from is not being typed, and nothing is interrupted
   * by taking a keyboard they already released. And the box must be NON-EMPTY:
   * sending with Enter leaves focus in the box, so the ordinary keyboard flow
   * (send a prompt, approval arrives) sits on an empty box whose focus is idle
   * and free to take — gating on focus alone would cost every keyboard user the
   * auto-engage they rely on.
   *
   * Deliberately a state test rather than a "seconds since the last keystroke"
   * one: a pause mid-sentence is exactly when the draft is most alive, and
   * Enter in an engaged widget answers an approval — so an idle timer would
   * turn a predictable annoyance into an intermittent, unread approval.
   * @returns {boolean} True when focus is inside a non-empty message box.
   * @private
   */
  _composerHoldsDraft() {
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    if (!active || active.tagName !== 'TEXTAREA') return false;
    if (!active.closest('composer-box')) return false;
    return /** @type {HTMLTextAreaElement} */ (active).value.trim().length > 0;
  }

  /**
   * Rule 20: an answered inline prompt is handing the keyboard back.
   *
   * An approval widget or question form holds focus on one of its own buttons
   * while it is up, then deletes itself the moment it is answered — which drops
   * focus to <body>, where it stays: no other rule fires at the end of a turn to
   * reclaim it. The dismissing widget dispatches `restore-input-focus` instead
   * of reaching into the composer itself, so the decision stays here.
   *
   * Deferred one macrotask because the answer typically rebuilds the column
   * around the now-resolved item — focusing synchronously would be undone by
   * that re-render. setTimeout, not requestAnimationFrame: rAF is throttled to
   * near-zero in a backgrounded WKWebView and never fires in a hidden frame, so
   * the hand-back would silently never happen (the same reason
   * {@link _reassertInputFocus} avoids it).
   *
   * One tick is not enough to land it, for the same reason a rebuild needs
   * {@link _reassertInputFocus}: the answer's re-render can bounce focus back to
   * <body> a beat after we place it, and while that rebuild is in flight the
   * column may have no composer-box at all — so a lone attempt either gets
   * undone or silently no-ops against a textarea that does not exist yet. Both
   * strand the keyboard for the rest of the turn, so the hand-back is retried
   * across a short window instead.
   * @private
   */
  _onRestoreInputFocus() {
    // ~240ms of ticks: long enough to outlast the answer's re-render even on a
    // loaded machine, short enough that it cannot fight a later deliberate
    // focus change (and it stops the moment anything else claims the keyboard).
    setTimeout(() => this._reclaimStrandedInputFocus(8), 0);
  }

  /**
   * Rule 20's retry window: reclaim focus for the message box while it is
   * stranded, until something with a better claim takes it.
   *
   * Reclaims STRANDED focus only. Focus on <body> is the signature of the
   * removed widget having dropped it with nothing else wanting it; anything
   * else holding the keyboard outranks us — chiefly the next pending approval,
   * which Rule 16 auto-engages when answering this one hands selection on — so
   * seeing focus somewhere real ends the window rather than skipping one tick.
   *
   * Keeps watching while focus sits in the input column, because placing it
   * there is not the end of the story: a later re-render can still bounce it to
   * <body> inside this window, which is the case a single attempt misses.
   *
   * Declined while the tab is hidden, during keyboard navigation (the user is
   * driving the item list, not composing), or while an overlay owns the
   * keyboard. Every condition is judged per tick, so a state change mid-window
   * ends it.
   * @param {number} attempts - Remaining retry ticks.
   * @private
   */
  _reclaimStrandedInputFocus(attempts) {
    if (attempts <= 0) return;
    if (this._isHidden || this._isKeyboardNavigating) return;
    if (keyShortcutManager.suppressedByOverlay()) return;
    const active = document.activeElement;
    if (!active || active === document.body) {
      this._focusInput();
    } else if (!this._inputColumn()?.contains(active)) {
      return;
    }
    setTimeout(() => this._reclaimStrandedInputFocus(attempts - 1), 30);
  }

  /** Mark this tab as active (visible). */
  setActive() {
    this.classList.add('active');
    this.classList.remove('hidden');
    this._isHidden = false;

    // Hidden tabs retain only their model-backed selection/draft state. Rebuild
    // the lightweight column shell before syncing the transcript back from Yjs.
    if (this._isParked) {
      this._isParked = false;
      this.render();
    }

    const root = asArea(this._columns[0]);
    if (root && this._conversation) {
      root.conversation = this._conversation;
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
      // A cheap activation need not have rebuilt anything, and the tab being
      // switched away from cleared what was last announced.
      this._announceThreadFocus();
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
      const col = asArea(this._columns[i]);
      if (!col) continue;
      const nextId = col.getNextPendingApprovalToSelect();
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
   * attention" switch. When `selectApproval` is true, the first pending approval
   * in the whole tree is revealed through {@link revealItem}: the column chain
   * is rebuilt to lead to it, whatever was open before (another sub-thread, an
   * item's properties), and its column is scrolled into view horizontally even
   * when it was already selected — an approval selected off screen is no use.
   * Keyboard focus then moves onto its buttons so the user can arrow up/down and
   * press Enter without clicking first. Otherwise the root column becomes active,
   * is brought into view, and scrolls to the end of the thread.
   *
   * First activation of a hidden tab defers its render, so retry across frames
   * until the columns exist.
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
    const approvalId = selectApproval && this._conversation
      ? findFirstPendingApprovalId([...this._conversation.rootItems])
      : null;
    if (approvalId) {
      this.revealItem(approvalId);
      this._engageSelectedApproval({ force: true });
      return;
    }
    this.revealThread(null);
    asArea(root)?.scrollToBottom(true);
  }

  /**
   * Move keyboard focus onto the first selected approval's buttons so ↑/↓/Enter
   * work immediately after a jump-to-attention, without a click. Deferred a
   * frame because {@link _maybeAutoSelectNextPendingInAllColumns} may rebuild the
   * column, recreating the action-confirmation element. Columns are scanned in
   * order (root first) and only the first pending approval is engaged.
   *
   * Rule 16 applies here as it does to the auto-select path: an approval that
   * arrives on its own must not take the keyboard off a prompt being written,
   * or the next Enter answers a question the user never read. Judged on the
   * deferred tick — the only moment that decides anything — so a draft typed
   * while the frame was pending still counts.
   * @param {{force?: boolean}} [opts] - `force` engages regardless of a draft,
   *   for the jump-to-attention shortcut: the user asked to be taken to the
   *   approval, so their own request outranks their own draft.
   * @private
   */
  _engageSelectedApproval({ force = false } = {}) {
    const run = () => {
      if (!force && this._composerHoldsDraft()) return;
      for (const col of this._columns) {
        const selected = asArea(col)?.getSelectedElement();
        if (!selected) continue;
        const confirmation = selected.querySelector('action-confirmation');
        if (confirmation) {
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
   * (pickAutoSelectCandidate: error > pending-approval > shouldAutoSelect >
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
      const area = asArea(col);
      if (!area) continue;
      const items = area.getMessageThread()?.items
        ?? this._conversation.rootItems;
      area.onItemsInserted(insertedItemIds, items);
    }
  }

  /** Mark this tab as hidden (not visible). */
  setHidden() {
    // Flush every column's live draft to the model before parking the tab. The
    // draft is otherwise only persisted by the keystroke DEBOUNCE, so leaving a
    // tab within that window would strand the last-typed characters in the live
    // textarea while the persisted draft lagged behind — any later restore would
    // then paint stale/empty text over what was typed. Flushing here keeps the
    // stored draft exactly current, so a re-activation restore (or reload, or a
    // second viewer) always sees the real text.
    this.querySelectorAll('composer-box').forEach((box) => box.flushDraft());

    // Relinquish focus while the tab is still rendered. WebKit keeps focus on
    // a textarea whose ancestor becomes display:none, so a hidden tab would
    // keep swallowing keystrokes into its now-invisible composer.
    if (
      document.activeElement instanceof HTMLElement &&
      this.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
    this.classList.remove('active');
    this.classList.add('hidden');
    this._isHidden = true;
    // Whatever this tab last announced is no longer what anyone is reading, so
    // its next activation must announce again even if the thread is the same.
    this._announcedThreadItemId = undefined;

    // A transcript can contain thousands of rich message nodes. Keeping one full
    // tree for every hidden tab makes renderer memory scale with the entire
    // project rather than the visible conversation. Drafts and scroll anchors
    // are persisted above/in the conversation model, so discard hidden columns
    // and recreate them from Yjs on next activation.
    if (this._columns.length > 0) {
      asArea(this._columns[0])?.saveScrollPositionImmediately();
      this._columnContainer?.replaceChildren();
      this._columns = [];
      this._isParked = true;
      this._needsResync = true;
    }
  }

  /**
   * Render the tab structure — no permanent properties-panel
   * @private
   */
  render() {
    this.innerHTML = `
      <column-viewport>
        <column-container>
        </column-container>
      </column-viewport>
    `;

    this._columnViewport = this.querySelector('column-viewport');
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

    this._setupColumnOverflow();
    this._setupKeyboardNavigation();
  }

  /**
   * Wire the container's edge fades to its actual scroll state.
   *
   * Unlike the keyboard listener this is re-wired on every render, because
   * render() builds a new column-container each time and the scroll listener
   * goes with the old one. The ResizeObserver does not, so the previous one is
   * disconnected here and the teardown registered once.
   *
   * The observer only catches the container changing shape — the window
   * resizing, a panel opening beside it. Columns arriving and leaving do not
   * change the container's own box at all, so _updateColumnLayout calls this
   * too, on the one path every rebuild goes through.
   * @private
   */
  _setupColumnOverflow() {
    const container = this._columnContainer;
    if (!container) return;
    container.addEventListener('scroll', () => this._updateColumnOverflow(), { passive: true });
    this._columnOverflowObserver?.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      this._columnOverflowObserver = new ResizeObserver(() => this._updateColumnOverflow());
      this._columnOverflowObserver.observe(container);
      if (!this._columnOverflowWired) {
        this._columnOverflowWired = true;
        this.addCleanup(() => {
          this._columnOverflowObserver?.disconnect();
          this._columnOverflowObserver = null;
          this._columnOverflowWired = false;
        });
      }
    }
    this._updateColumnOverflow();
  }

  /**
   * Mark which edges of the column container have columns hidden behind them,
   * so the CSS can fade exactly those. The classes go on the viewport around
   * the container, never on the container: a masked scroller is mis-composited
   * by WebKitGTK (see column-viewport in layout/app-shell.css). Neither class is set when the chain fits, which is
   * the point: a fade that is always there says nothing.
   *
   * The 1px slack absorbs the fractional scrollLeft a fractional column width or
   * a non-integer device pixel ratio produces, which would otherwise leave the
   * end fade permanently lit at the end of the chain.
   * @private
   */
  _updateColumnOverflow() {
    const el = this._columnContainer;
    const viewport = this._columnViewport;
    if (!el || !viewport) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    viewport.classList.toggle('overflow-start', el.scrollLeft > 1);
    viewport.classList.toggle('overflow-end', el.scrollLeft < maxScroll - 1);
  }

  /**
   * Set up centralized keyboard navigation (single document listener)
   * @private
   */
  _setupKeyboardNavigation() {
    // render() runs many times per connect, so the listener needs a guard the
    // base class's drain can clear — otherwise a re-connect would find the flag
    // still set and never re-register.
    if (this._keyboardNavWired) return;
    this._keyboardNavWired = true;
    this.addCleanup(() => { this._keyboardNavWired = false; });

    /** @param {KeyboardEvent} e */
    const onKeydown = (e) => {
      // Only handle if this is the active tab
      if (!this.classList.contains('active')) return;

      // This is a document-level handler that navigates/cancels the
      // conversation BEHIND focus, so it stands down for an open overlay (↑/↓
      // would move the selection under it), a field being typed into, or an
      // approval widget's own keys. Single rule, shared with the tab strip's nav.
      if (keyShortcutManager.backgroundNavStandsDown(e)) return;

      // Tab-list focus mode owns arrow keys until the user re-enters the tab.
      if (document.querySelector('conversation-bar.tab-list-focused')) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') return;
      }

      const activeCol = this._columns[this._selection.activeColumnIndex];
      if (!activeCol) return;
      const activeArea = asArea(activeCol);

      // Rule 15 suppression: flag that we're inside keyboard navigation
      // so _rebuildColumns won't steal focus to a sub-thread composer.
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
            // A folded run owns no properties panel — the column it opens just
            // lists its rows — so the delete-button hunt below would find
            // nothing. Backspace on a group tile means what it looks like:
            // delete the rows the tile stands for.
            if (activeArea) {
              const groupId = activeArea.getSelectedItemId();
              if (groupId && isGroupId(groupId)) {
                e.preventDefault();
                this._deleteGroup(activeArea, groupId);
                break;
              }
            }
            let propsPanel = null;
            if (activeCol.tagName === 'PROPERTIES-PANEL') {
              propsPanel = activeCol;
            } else if (activeCol.tagName === 'CONVERSATION-AREA') {
              const nextCol = this._columns[this._selection.activeColumnIndex + 1];
              if (nextCol?.tagName === 'PROPERTIES-PANEL' || nextCol?.tagName === 'CONVERSATION-AREA') {
                propsPanel = /** @type {HTMLElement} */ (nextCol);
              }
            }
            // The panel's content — the Delete button included — is rendered on
            // a debounce, so between moving the selection and pressing Delete
            // the button on screen can still be the previous item's. Acting on
            // it would delete a row the user is not pointing at. Bring the
            // panel up to the selection before reading anything off it.
            this._builder.flushPropertiesRender(propsPanel);
            const deleteBtn = /** @type {HTMLElement|null} */ (propsPanel?.querySelector('.properties-panel-btn.danger'));
            if (deleteBtn) {
              e.preventDefault();
              deleteBtn.click();
            }
            break;
          }
          case 'ArrowDown':
            if (!activeArea) break;
            e.preventDefault();
            this._selection.markManualInteraction();
            if (e.altKey) {
              activeArea.selectNextUserMessage();
            } else {
              activeArea.selectNextItem();
            }
            break;
          case 'ArrowUp':
            if (!activeArea) break;
            e.preventDefault();
            this._selection.markManualInteraction();
            if (e.altKey) {
              activeArea.selectPreviousUserMessage();
            } else {
              activeArea.selectPreviousItem();
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
            if (!activeArea) break;
            const selectedItem = activeArea.getSelectedElement();
            if (selectedItem) {
              const confirmation = selectedItem.querySelector('action-confirmation');
              if (confirmation) {
                e.preventDefault();
                confirmation.engage();
              }
            }
            break;
          }
          case 'Escape': {
            // A popup/modal open over the conversation owns Escape (popup-manager
            // dismisses it and stops the key at document); the overlay gate at the
            // top of this handler already returned before we got here, so by this
            // point no overlay is open and Escape means "back out one level".
            //
            // What that does — stop, pause, two-step, clear the prompt — is the
            // user's choice, so the decision lives in escape-behaviour.js and is
            // shared with the composer's own Escape. It fires regardless of which
            // column type is active (a "Re-run command" click lands in the
            // properties panel; gating on CONVERSATION-AREA left Escape a silent
            // no-op there).
            //
            // The vantage is the active column's thread: a sub-thread column
            // interrupts that thread (leaves it open); the root column (or a
            // non-thread column like properties) stops everything and closes
            // open sub-threads. Any prompt-clearing routes through the visible
            // composer's undoable clear — this handler only runs when focus
            // ISN'T in the textarea (the early TEXTAREA/INPUT return above), so
            // it covers Escape from an empty conversation where the box never
            // took focus.
            //
            // Moving focus into the box is itself a rung (below), so a press
            // that takes it must not also leave fullscreen — the next one, from
            // the box, can.
            const focusedThreadId = activeArea?.getMessageThread()?.threadItemId ?? null;
            handleEscapeKey(e, {
              focusedThreadId,
              getComposer: () => this.getComposer(),
              canLeaveFullscreen: !activeArea,
            });
            // Rule 17: escape while navigating the conversation-area → typing mode.
            if (activeArea) this._focusInput();
            break;
          }
        }
      } finally {
        this._isKeyboardNavigating = false;
      }
    };

    this.onDocument('keydown', /** @type {EventListener} */ (onKeydown));
  }

  /**
   * Navigate right into a thread's column (Finder-style)
   * @private
   */
  _navigateRight() {
    const activeCol = asArea(this._columns[this._selection.activeColumnIndex]);
    if (!activeCol) return;

    // Only enter if the selected item opens a column (sub-thread or tool group)
    if (!activeCol.isSelectedItemDrillable()) return;

    // The next column should already exist (created by item-selected event)
    const nextIndex = this._selection.activeColumnIndex + 1;
    const nextCol = asArea(this._columns[nextIndex]);
    if (!nextCol) return;

    this._selection.navigateRight(nextIndex);
    this._updateActiveColumnVisuals(true);

    // Select first item in the new column
    requestAnimationFrame(() => {
      const ids = nextCol.getSelectableItemIds();
      if (ids[0] !== undefined) {
        nextCol.selectItem(ids[0]);
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

    // Every path that moves the focus passes through here — a rebuild, the arrow
    // keys, opening a thread, following one the assistant started — which is why
    // the announcement belongs here rather than beside any one of them.
    this._announceThreadFocus();

    if (scroll) {
      this._scrollToActiveColumn();
    }
  }

  /**
   * Bring the active column fully into view with the smallest horizontal
   * movement that does it, plus COLUMN_PEEK_REM so the move never comes to rest
   * with a column boundary flush against an edge — and nothing at all when the
   * column is already fully visible, peek or no peek. The peek shapes the moves
   * this function was making anyway; it is not a reason to make a new one.
   *
   * One rule for every column, whatever the chain holds. Aligning the active
   * column to the left edge shows it, but it also re-anchors the whole row from
   * a position the user chose by dragging, and it did so only when a properties
   * panel happened to be in the chain — so the same keystroke moved the view or
   * left it alone depending on which kind of item the selection had landed on.
   * Minimal movement removes both the re-anchoring and the split.
   *
   * The delta is computed against the container's own scrollLeft and applied by
   * assignment, which clamps to [0, scrollWidth - clientWidth]: it can neither
   * overshoot nor scroll an ancestor, unlike Element.scrollIntoView's
   * ancestor-walking and nearest-edge guesswork. A column too wide to fit lands
   * a peek in from its left edge, where its content starts.
   *
   * Called only for explicit column-level navigation: arrow-left/right, clicking
   * a column, opening a thread, following a thread the LLM has started.
   * @private
   */
  _scrollToActiveColumn() {
    const col = this._columns[this._selection.activeColumnIndex];
    if (!col || !this._columnContainer) return;
    const containerRef = this._columnContainer;
    requestAnimationFrame(() => {
      const container = containerRef;
      // A rebuild between the frames can drop the column we measured for.
      if (!col.isConnected || !container.isConnected) return;
      const containerRect = container.getBoundingClientRect();
      const colRect = col.getBoundingClientRect();
      // A paged viewport holds exactly one column and snaps it: there is no
      // neighbour to leave showing, and a peek would only fight the snap.
      const paged = window.matchMedia?.(SHEET_QUERY).matches ?? false;
      const peek = paged ? 0 : COLUMN_PEEK_REM * rootFontSizePx();
      const delta = columnScrollDelta(colRect, containerRect, peek);
      if (delta === 0) return;
      container.scrollTo({ left: container.scrollLeft + delta, behavior: 'smooth' });
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
   * Bring a thread's column into view and make it the active one, for a surface
   * outside the conversation that wants to point at it.
   *
   * The root column is already on screen and already holds the chain the user
   * built, so revealing it moves the focus and scrolls, and deliberately does not
   * clear the selection: collapsing the columns would be a destructive answer to
   * "show me where this came from".
   * @param {string|null} threadItemId - The thread to reveal, or null for the root.
   */
  revealThread(threadItemId) {
    if (threadItemId) {
      this.openThread(threadItemId);
      return;
    }
    this._selection.activeColumnIndex = 0;
    this._selection.markManualInteraction();
    this._updateActiveColumnVisuals(true);
  }

  /**
   * Select one item wherever it lives, opening whatever columns it takes to get
   * there, for a surface outside the conversation pointing at something it found.
   *
   * This is {@link openThread} for an item that is not a thread: the chain
   * resolver matches an item id before it asks whether the item is a thread, so
   * the same walk finds a tool action several threads deep. The difference is
   * where it stops — a thread gets a column of its own and becomes active, while
   * an ordinary item is selected *in* the column that holds it. An item folded
   * into a tool group is reached the way a click reaches it: the group is
   * selected in the thread's column, and the item in the group's column.
   * @param {string} itemId - The item to select.
   */
  revealItem(itemId) {
    if (!this._conversation || !itemId) return;
    const rootItems = [...this._conversation.rootItems];
    const chain = this._selection.resolveThreadChain(rootItems, itemId, isThreadMessage);
    if (chain.length === 0) return;
    const groupId = this._foldingGroupOf(rootItems, chain);
    if (groupId) chain.splice(chain.length - 1, 0, groupId);
    this._selection.selections = chain;
    this._selection.activeColumnIndex = chain.length - 1;
    this._selection.markManualInteraction();
    this._rebuildColumns(true);
    this._scrollSelectionsIntoView();
  }

  /**
   * The tool group standing in for the last item of a resolved chain in the
   * column that lists it, or null when that column shows the item as itself.
   * @param {any[]} rootItems - Root-level items the chain was resolved against.
   * @param {string[]} chain - Item ids from the root to the target, threads first.
   * @returns {string|null} The group's display id, or null.
   * @private
   */
  _foldingGroupOf(rootItems, chain) {
    if (!isToolGroupingEnabled()) return null;
    let items = rootItems;
    for (const threadId of chain.slice(0, -1)) {
      const thread = items.find((i) => i?.get?.('itemId') === threadId);
      const nested = thread?.get?.('items');
      if (!nested) return null;
      items = nested.toArray();
    }
    const { memberToGroup } = buildDisplayItems(items, { enabled: true });
    return memberToGroup.get(/** @type {string} */ (chain[chain.length - 1])) ?? null;
  }

  /**
   * Scroll each column's selected item into view (nearest edge).
   * Complements _rebuildColumns which applies selection classes but
   * intentionally skips scrolling (to avoid hijacking scroll on
   * data-driven rebuilds).  Called by openThread and _syncWithConversation
   * after setting genuinely new selections — the same cases where
   * _selectItem's Rules 6-7 would fire if the selection went through
   * the normal entry point.
   *
   * Because it reaches the scroll module directly rather than through
   * selectItem, rule 4b's gate is applied here: an automatic move skips a
   * column whose reader has scrolled away, and every column it does move is
   * held to the end by the `automatic` flag. This loop visits EVERY column, not
   * just the one whose selection changed, so without the gate a thread this tab
   * revealed by itself would scroll a column the reveal has nothing to do with.
   * @param {{automatic?: boolean}} [opts] - `automatic`: the tab decided on this
   *   move; false when it follows an action of the reader's own.
   * @private
   */
  _scrollSelectionsIntoView({ automatic = false } = {}) {
    for (let i = 0; i < this._selection.selections.length; i++) {
      const col = asArea(this._columns[i]);
      const itemId = this._selection.selections[i];
      if (!col || !itemId) continue;
      if (automatic && !col.isScrolledNearBottom()) continue;
      col.scrollItemIntoView(itemId, { automatic });
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

    const prevActiveColumn = this._selection.activeColumnIndex;

    if (!itemId) {
      this._selection.clearSelection(columnIndex);
    } else {
      if (origin === 'user') {
        this._selection.markManualInteraction();
      }
      // Only the user's own selection moves the keyboard target onto this
      // column: an auto-selection landing in a column the user isn't in (a
      // child column picking up an arriving tool action) leaves the arrow keys
      // where they were.
      this._selection.selectItem(columnIndex, itemId, { focus: origin === 'user' });
    }

    // Moving the selection does not move the columns. The horizontal scroll is
    // the user's — they set it by dragging — and an arrow key walking this
    // column's items is asking for nothing to its left or right, so re-anchoring
    // the row on every keypress only throws that choice away. A selection that
    // lands the keyboard in a DIFFERENT column (clicking into one that is partly
    // off-screen) IS a request to see that column, so that case still scrolls.
    const enteredAnotherColumn = this._selection.activeColumnIndex !== prevActiveColumn;
    this._rebuildColumns(origin === 'user' && enteredAnotherColumn);

    // On a narrow viewport the columns are full-width and paged, so the child
    // column that just appeared for the tapped item sits off-screen to the
    // right. Reveal it so the user sees the detail they selected. Prose
    // (user/assistant messages) is exempt — a tap there is reading, not a
    // request to scroll away to a child column (see isItemRevealable) — as is
    // a tap on a control inside the tile, which is an action on the item.
    //
    // This is a pointer gesture. ↑/↓ walking this column's items is not asking
    // for the column beside it, and on a narrow viewport a reveal per keypress
    // would page the row away from the list being walked — so the keyboard
    // keeps the horizontal position, on every viewport, as it does above.
    if (origin === 'user' && !this._isKeyboardNavigating
      && itemId && revealable && window.matchMedia?.(SHEET_QUERY).matches) {
      this._revealDetailsColumn(columnIndex);
    }

    // Rule 16: auto-engage approval widget when LLM auto-selects an approval item —
    // unless the message box is holding a draft (see _composerHoldsDraft). Judged
    // on the deferred tick, the only moment that decides anything, so a draft
    // typed while the frame was pending still counts.
    if (origin === 'auto' && itemId && column) {
      requestAnimationFrame(() => {
        if (this._composerHoldsDraft()) return;
        const el = /** @type {import('./action-confirmation.js').default|null} */ (
          column.querySelector(`[message-id="${itemId}"] action-confirmation`));
        if (el) el.engage();
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
   * copy into a new conversation; the original thread stays in place because undo cannot
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
    const parentThread = target.closest('conversation-area')?.parentMessageThread;
    if (parentThread) {
      parentThread.deleteItemById(threadItemId);
    }

    this._rebuildColumns();  // Rule 15 handles focus
  }

  /**
   * Delete every row a folded group stands for.
   *
   * The group is a display construct, so there is nothing to delete called "the
   * group": the operation is a delete of its member items. They go in ONE Yjs
   * transaction, which is what makes the tile behave like the single object it
   * looks like — one update, so one undo step brings the whole run back, rather
   * than N steps that would each restore one row into a tile that no longer
   * matches what the user deleted.
   * @param {ConversationArea} col - The column the group tile is selected in.
   * @param {string} groupId - Display id of the group.
   * @private
   */
  _deleteGroup(col, groupId) {
    const messageThread = col.getMessageThread();
    if (!messageThread) return;
    const items = messageThread.items;
    const indices = groupMemberIndices(items, groupId);
    if (!indices.length) return;
    const columnIndex = this._columns.indexOf(col);
    if (columnIndex < 0) return;

    // Rule 5b, widened to a run: the neighbour to land on must come from
    // OUTSIDE it, so the next-then-previous search starts at the run's two
    // edges rather than at a single deleted index.
    const first = /** @type {number} */ (indices[0]);
    const last = /** @type {number} */ (indices[indices.length - 1]);
    let neighborId = null;
    for (let i = last + 1; i < items.length && !neighborId; i++) {
      if (isItemSelectable(items[i], messageThread)) neighborId = items[i].get('itemId');
    }
    for (let i = first - 1; i >= 0 && !neighborId; i--) {
      if (isItemSelectable(items[i], messageThread)) neighborId = items[i].get('itemId');
    }

    // A row awaiting approval has a caller parked on its promise; deleting the
    // item out from under it would strand that caller, so settle it first.
    // Scoped to this run — approvals elsewhere in the thread are untouched.
    const memberIds = new Set(indices.map((i) => items[i]?.get?.('itemId')));
    for (const pending of messageThread.getPendingApprovalMessages()) {
      if (memberIds.has(pending.get('itemId'))) {
        messageThread.resolveApproval(pending.get('toolUseId'), 'cancel');
      }
    }

    messageThread.transact(() => messageThread.removeItemsAt(indices));

    // With the run gone the rows that flanked it are adjacent, and so may fold
    // into a new group the neighbour is now hidden inside. Naming the item is
    // enough: resolveColumnChain settles a selection against the display before
    // the columns are built.
    if (neighborId) {
      this._selection.selectItem(columnIndex, neighborId);
    } else {
      this._selection.clearSelection(columnIndex);
    }
    this._selection.markManualInteraction();
    this._rebuildColumns();
  }

  /**
   * Handle a "View Transaction" click in any properties panel.
   *
   * A plain toggle: the transaction column is a lens on the properties column
   * beside it, so the panel this opens always shows the very item whose header
   * carries the button. The next rebuild appends or drops the column; later
   * selection changes re-target it rather than closing it.
   * @param {CustomEvent} e
   * @private
   */
  _onToggleTransaction(e) {
    const target = /** @type {HTMLElement} */ (e.target);
    const panel = target.closest('properties-panel');
    if (!panel) return;
    const columnIndex = this._columns.indexOf(/** @type {HTMLElement} */ (panel));
    if (columnIndex < 0) return;

    if (this._selection.txnOpen) {
      this._selection.closeTransaction(columnIndex);
    } else {
      this._selection.openTransaction(columnIndex);
    }
    this._selection.markManualInteraction();
    this._rebuildColumns(true);
  }

  /**
   * Show the transaction for a named item, selecting it on the way.
   *
   * The transaction column is a lens on the properties column beside it, so
   * getting there means selecting the item first and opening the lens on the
   * column that selection creates — one column to the right of the one the
   * request came from. Used by the footer's token pill, whose numbers come from
   * that round-trip and which otherwise had no way to show it.
   * @param {CustomEvent} e
   * @private
   */
  _onShowTransactionRequested(e) {
    const { itemId } = e.detail;
    if (!itemId || !this._conversation) return;
    const target = /** @type {HTMLElement} */ (e.target);
    const column = target.closest('conversation-area, properties-panel');
    const columnIndex = column ? this._columns.indexOf(/** @type {HTMLElement} */ (column)) : -1;
    if (columnIndex < 0) return;

    this._selection.selectItem(columnIndex, itemId);
    this._selection.openTransaction(columnIndex + 1);
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
      const chain = this._selection.resolveColumnChain(conversation.rootMessageThread, isThreadMessage,
        { groupingEnabled: isToolGroupingEnabled() });
      const session = conversation.session;

      // Build new columns array matching the chain
      /** @type {HTMLElement[]} */
      const newColumns = [];

      const container = this._columnContainer;
      for (const [i, entry] of chain.entries()) {
        const existing = this._columns[i];
        if (entry.type === 'conversation') {
          newColumns.push(this._builder.conversationColumn({
            container, existing, index: i, entry, conversation, session,
            previous: newColumns[i - 1],
            selectedItemId: this._selection.selections[i] || null,
          }));
        } else if (entry.type === 'properties') {
          newColumns.push(this._builder.propertiesColumn({
            container, existing, entry, parentEntry: chain[i - 1], conversation,
          }));
        } else if (entry.type === 'transaction') {
          newColumns.push(this._builder.transactionColumn({ container, existing, entry, conversation }));
        }
      }

      // Remove excess old columns
      for (let i = chain.length; i < this._columns.length; i++) {
        /** @type {HTMLElement} */ (this._columns[i]).remove();
      }

      this._columns = newColumns;

      // Tripwire: the column-sizing CSS and (until this was made explicit) the
      // resize-handle visibility assume the column-container's element children
      // appear in the SAME order as this._columns. New columns are appended to
      // the end and reused ones kept in place, so this should always hold — log
      // loudly with a stack if it ever doesn't, to capture the path that breaks
      // it. Resize-handle visibility is driven from the logical order
      // (_updateColumnLayout) so it survives a divergence, but a divergence is
      // still a real bug.
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
      // Covers a thread being created and a thread being deleted.
      // Suppressed during keyboard nav so arrow-keying onto a sub-thread
      // doesn't steal focus from item navigation.
      const newInputCol = this._deepestInputColumn();
      if (newInputCol && newInputCol !== prevInputCol && !this._isKeyboardNavigating) {
        this._focusInput(newInputCol);
        // A synchronous focus() during the rebuild silently no-ops for a
        // freshly-built column — the new thread's box is in the DOM but not yet
        // focusable at that instant, and late re-renders of the new column can
        // bounce focus back to <body> — so a newly opened thread (e.g. New
        // Thread) never actually took the keyboard. Re-assert across a short
        // window once rendering settles.
        this._reassertInputFocus(newInputCol, prevInputCol, 5);
      }

    } finally {
      this._isRebuilding = false;
    }
  }

  /**
   * Set data-hide-input on the columns that shouldn't show an composer-box.
   * @param {any[]} chain
   * @param {HTMLElement[]} newColumns
   * @private
   */
  _applyInputVisibility(chain, newColumns) {
    // Every thread column keeps its composer; only a group column hides one, so
    // data-hide-input and data-group-column always agree. A thread is running
    // or it is stopped, and a stopped thread — including one carrying a summary
    // from an earlier run — accepts a message and runs again, so there is no
    // thread state in which a column should refuse input.
    for (let i = chain.length - 1; i >= 0; i--) {
      const col = newColumns[i];
      if (!col || col.tagName !== 'CONVERSATION-AREA') continue;
      // A group column is a lens on the column to its left, not a place to
      // type: the parent keeps the one composer for that thread.
      if (chain[i].groupId) {
        col.setAttribute('data-group-column', '');
        col.setAttribute('data-hide-input', '');
        continue;
      }
      col.removeAttribute('data-group-column');
      // Re-measure the textarea ONLY on the hidden→visible transition: a
      // textarea inside a display:none box reads scrollHeight 0, so it must
      // be re-sized once revealed. Gated to the actual transition because a
      // visible box is already correctly sized, and re-running on every
      // rebuild (e.g. arrow-key item navigation) is wasted work.
      const wasHidden = col.hasAttribute('data-hide-input');
      col.removeAttribute('data-hide-input');
      if (wasHidden) {
        const composer = col.querySelector('composer-box');
        const textarea = composer?.querySelector('textarea');
        if (textarea) composer?.autoResize(textarea);
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
    // The builder preset each selection before rendering the column; this
    // loop applies the visual highlight now that the render is done.
    for (let i = 0; i < newColumns.length; i++) {
      const col = asArea(newColumns[i]);
      if (!col) continue;
      const selectedId = this._selection.selections[i] || null;
      col.applySelectedClass(selectedId);
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
      // Mark the rightmost column from the logical column order — `this._columns`
      // is the single source of truth. A structural `:last-child` in CSS silently
      // breaks if the DOM child order ever diverges from the logical order (the
      // wrong column is treated as rightmost). A lone column is never marked, so
      // it keeps its resize handle. Which rightmost columns drop their handle is
      // the CSS's call (only ones that flex-fill the space beside them).
      col.classList.toggle('column-rightmost', i === lastIndex && this._columns.length > 1);
    }

    // Columns arriving or leaving changes what is hidden past an edge without
    // changing the container's own box, so nothing else would notice.
    this._updateColumnOverflow();
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

    // Auto-select the thread chain for a running thread. ONE thread,
    // deliberately: revealing a column moves the viewport, and several threads
    // may be running. The status path reveals any given thread at most once
    // (see maybeAutoSelectThread), so parallel siblings streaming together
    // rewrite nothing here; llmState also holds its named thread while it
    // runs, which keeps the choice stable across the projection's churn.
    const llmState = conversation.llmState;
    let autoSelected = false;
    if (llmState) {
      const statusThreadId = llmState.getStatusThreadId(conversation.id);
      autoSelected = this._selection.maybeAutoSelectThread(
        statusThreadId, conversation.rootItems, isThreadMessage,
        { userReading: this._hasReaderInAnyColumn() });
    }

    // Rebuild all columns (root + any open threads/properties).
    // When a new thread was auto-selected, scroll horizontally to reveal it.
    this._rebuildColumns(autoSelected);

    this._ensureThreadColumnSelections();

    // Rules 6-7: new auto-selected thread or Rule 5b neighbor selection →
    // scroll the selected item into view in its parent column. Rule 5b follows
    // the reader's own delete, so it moves as a reader action; a thread this tab
    // revealed by itself is the system's own idea and answers to rule 11.
    const neighborScroll = this._pendingNeighborScroll;
    if (autoSelected || neighborScroll) {
      this._pendingNeighborScroll = false;
      this._scrollSelectionsIntoView({ automatic: !neighborScroll });
    }

  }

  /**
   * Whether the user is reading a column of this tab: one holds a selection of
   * their own (rule 4), or one is scrolled away from the end (rule 4b).
   *
   * Both rules are enforced per column, but a running sub-thread is a tab-level
   * move: it rewrites the whole chain, so either sign of a reader in ANY column
   * is a reason not to make it. Reading the columns rather than the selection
   * state is deliberate — the columns own both signals, including the ways they
   * expire.
   * @returns {boolean} True when some conversation column has a reader in it.
   * @private
   */
  _hasReaderInAnyColumn() {
    return this._columns.some((col) => {
      const area = asArea(col);
      return !!area && (area.selectionOrigin === 'user' || !area.isScrolledNearBottom());
    });
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
      const threadCol = asArea(col);
      if (threadCol && threadCol.classList.contains('thread-column')) {
        if (!threadCol.getSelectedItemId() && threadCol.selectionOrigin !== 'user') {
          // A group column lists only its folded rows; deriving from the whole
          // (shared) thread would nominate items it doesn't show.
          const items = threadCol.listedItems;
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
