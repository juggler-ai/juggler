//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Miller Column Selection State
 *
 * Pure state and logic for Miller column navigation. No DOM dependencies.
 * Tracks which item is selected in each column, which column is active,
 * and handles auto-following of LLM processing threads.
 */

import { buildDisplayItems, findGroup, isGroupId } from './item-grouping.js';
import { canonicalThread } from '../model/thread-alias.js';
import { isYMap } from '../model/item-accessor.js';

/**
 * @typedef {object} ColumnChainEntry
 * @property {'conversation'|'properties'|'transaction'} type - What kind of column to render
 * @property {import('yjs').Map<unknown>} [container] - Y.Map container (root or thread Y.Map) that holds 'items'
 * @property {string|undefined} [threadItemId] - Thread item ID (for thread conversation columns)
 * @property {import('yjs').Map<unknown>} [threadYMap] - The thread Y.Map (for thread conversation columns)
 * @property {string} [viewItemId] - The parent item this column was opened through,
 *   which for a thread called more than once is one of several views of the same
 *   transcript. It is the tile the user is acting on, so it — not the canonical
 *   the column resolves to — is what the column's Delete removes.
 * @property {string} [selectedItemId] - Selected item ID (for properties columns)
 * @property {string} [transactionId] - Round-trip id: the one the selected item
 *   belongs to (properties columns), or the one being shown (transaction columns)
 * @property {string} [groupId] - Display id of the folded tool run this column shows
 * @property {unknown[]} [groupItems] - The run's items (for group conversation columns)
 */

/** @typedef {(item: unknown) => boolean} ThreadPredicate */

/**
 * One field of a column item, read through its `get`.
 * @param {unknown} item - A Y.Map, a group entry, or anything else.
 * @param {string} key - Field name.
 * @returns {unknown} The field value, or undefined for anything with no `get`.
 */
function field(item, key) {
  if (!item || typeof item !== 'object' || !('get' in item) || typeof item.get !== 'function') return undefined;
  return /** @type {unknown} */ (item.get(key));
}

/**
 * A stored list's items: a Y.Array's, or nothing.
 * @param {unknown} list - A Y.Array, or anything else.
 * @returns {unknown[]} Its items, or an empty array.
 */
function listItems(list) {
  if (!list || typeof list !== 'object' || !('toArray' in list) || typeof list.toArray !== 'function') return [];
  /** @type {unknown} */
  const items = list.toArray();
  return Array.isArray(items) ? items : [];
}

const AUTO_SELECT_COOLDOWN_MS = 5000;

class ColumnSelectionState {
  constructor() {
    /** @type {(string|null)[]} - Selected itemId per column index */
    this.selections = [];

    /** @type {number} - Which column has focus */
    this.activeColumnIndex = 0;

    /** @type {number} - Timestamp of last manual interaction */
    this.lastManualInteractionTime = 0;

    /** @type {string|null|undefined} - Last observed statusThreadId for change detection */
    this._lastStatusThreadId = undefined;

    /**
     * Threads the status path has already opened. A thread's ongoing life —
     * streaming, tool events, token progress — rewrites nothing here once its
     * column has been revealed from status; the only moves left to it are the
     * user's. Without this, a turn running several threads sees its chain
     * rewritten on every frame the projection sends (a reader whose pin has
     * lifted loses the row they selected to whichever sibling wrote last).
     * @type {Set<string>}
     */
    this._autoOpenedThreadIds = new Set();

    /**
     * Whether the transaction-detail panel is open. It is a lens on the
     * properties column beside it rather than a pinned view of one round-trip:
     * it re-targets to whatever that column is showing, so browsing items
     * leaves it up. Its own index is never stored — a properties column is
     * always the tail of the chain, so the transaction column is always the
     * one appended after it.
     * @type {boolean}
     */
    this.txnOpen = false;
  }

  /** Reset selections (e.g. when switching conversations) */
  resetSelections() {
    this.selections = [];
    this.txnOpen = false;
    this._autoOpenedThreadIds = new Set();
  }

  /** Record that the user manually interacted (click, keyboard) */
  markManualInteraction() {
    this.lastManualInteractionTime = Date.now();
  }

  /**
   * Select an item in a column. Truncates all selections after this column (Finder behavior).
   *
   * `focus` decides whether the keyboard target moves to this column too. A
   * selection the user drives (click, arrow key) belongs in the column they are
   * working in, so it takes focus. A selection the system makes for them — a
   * child column auto-selecting a tool action as it arrives, while the user
   * reads further up — must not, or the next arrow key navigates a column they
   * never asked for. Truncation happens either way: the chain past this column
   * is stale whoever selected it, and clampActiveIndex pulls a focus left
   * dangling past the shortened chain back into range.
   * @param {number} columnIndex
   * @param {string} itemId
   * @param {{focus?: boolean}} [opts] - `focus` (default true): make this the active column.
   */
  selectItem(columnIndex, itemId, opts = {}) {
    const { focus = true } = opts;
    if (focus) this.activeColumnIndex = columnIndex;
    this.selections[columnIndex] = itemId;
    this.selections.length = columnIndex + 1;
  }

  /**
   * Clear selection at a column, removing all columns after it.
   * @param {number} columnIndex
   */
  clearSelection(columnIndex) {
    this.selections.length = columnIndex;
  }

  /**
   * Apply a column's `item-selected` event: select the item, or clear the column
   * when there is none. Only the user's own selection counts as manual
   * interaction or moves the keyboard target onto this column. An
   * auto-selection landing in a column the user isn't in (a child column
   * picking up an arriving tool action) leaves the arrow keys where they were.
   * @param {number} columnIndex - The column the event came from.
   * @param {string|null} itemId - The selected item, or null to clear.
   * @param {SelectionOrigin} origin - Who made the selection.
   * @returns {boolean} Whether the keyboard target moved to another column.
   */
  applySelection(columnIndex, itemId, origin) {
    const prevActiveColumn = this.activeColumnIndex;
    if (!itemId) {
      this.clearSelection(columnIndex);
    } else {
      if (origin === 'user') this.markManualInteraction();
      this.selectItem(columnIndex, itemId, { focus: origin === 'user' });
    }
    return this.activeColumnIndex !== prevActiveColumn;
  }

  /**
   * Open the transaction-detail panel beside the properties column at
   * `columnIndex`, and move focus onto it so the existing
   * scroll-to-active-column rule (clampActiveIndex + _scrollToActiveColumn)
   * brings it into view — the same path that handles arrow-right navigation.
   * @param {number} columnIndex - Index of the properties column it opens beside.
   */
  openTransaction(columnIndex) {
    this.txnOpen = true;
    // Transaction column is appended right after the originating properties
    // panel, so its index is columnIndex + 1.
    this.activeColumnIndex = columnIndex + 1;
  }

  /**
   * Close the transaction-detail panel. Focus returns to the properties panel
   * that owns the toggle button so the just-closed column doesn't leave the
   * active index dangling past the shortened chain.
   * @param {number} columnIndex - Index of the properties column that owns the toggle.
   */
  closeTransaction(columnIndex) {
    this.txnOpen = false;
    this.activeColumnIndex = columnIndex;
  }

  /**
   * Remove a thread from selections (e.g. when deleted).
   * @param {string} threadItemId
   * @returns {number} The column index where truncation happened, or -1 if not found
   */
  deleteThread(threadItemId) {
    for (let i = 0; i < this.selections.length; i++) {
      if (this.selections[i] === threadItemId) {
        this.selections.length = i;
        return i;
      }
    }
    return -1;
  }

  /**
   * Navigate left (toward root).
   * @returns {boolean} True if the index changed
   */
  navigateLeft() {
    if (this.activeColumnIndex <= 0) return false;
    this.activeColumnIndex--;
    return true;
  }

  /**
   * Navigate right (into a thread column).
   * Caller must verify the selected item is a thread and the next column exists.
   * @param {number} nextColumnIndex - The column to navigate into
   * @returns {boolean} True if the index changed
   */
  navigateRight(nextColumnIndex) {
    this.activeColumnIndex = nextColumnIndex;
    return true;
  }

  /**
   * Clamp activeColumnIndex to a valid conversation-area column.
   *
   * Exception: when the leaf column is an open transaction-detail panel,
   * keep focus on it. The user opened it deliberately, so the existing
   * scroll-to-active rule should reveal it. Keyboard navigation early-returns
   * gracefully on non-conversation-area columns, so leaving focus there is
   * harmless.
   * @param {{tagName: string}[]} columns - The current column elements
   */
  clampActiveIndex(columns) {
    if (this.activeColumnIndex >= columns.length) {
      this.activeColumnIndex = columns.length - 1;
    }
    const lastIdx = columns.length - 1;
    if (this.txnOpen &&
        this.activeColumnIndex === lastIdx &&
        columns[lastIdx]?.tagName === 'PROPERTIES-PANEL') {
      return;
    }
    while (this.activeColumnIndex > 0 &&
           columns[this.activeColumnIndex] &&
           columns[this.activeColumnIndex]?.tagName !== 'CONVERSATION-AREA') {
      this.activeColumnIndex--;
    }
  }

  /**
   * Resolve the column chain from root through current selections.
   * Walks the Yjs tree to determine what type each column should be.
   * @param {{container: import('yjs').Map<unknown>, items: unknown[]}} rootThread - The root message thread
   * @param {ThreadPredicate} isThread - Predicate to check if an item is a thread
   * @param {{groupingEnabled?: boolean}} [opts] - Display options; `groupingEnabled`
   *   lets a selection name a folded tool run rather than a single item.
   * @returns {ColumnChainEntry[]} Column chain entries
   */
  resolveColumnChain(rootThread, isThread, opts = {}) {
    /** @type {ColumnChainEntry[]} */
    const chain = [{ type: /** @type {const} */ ('conversation'), container: rootThread.container, threadItemId: undefined }];

    let currentItems = rootThread.items;
    for (let i = 0; i < this.selections.length; i++) {
      let selectedId = this.selections[i];
      if (!selectedId) break;

      // A selection is a DISPLAY id, and folding decides which ids a column
      // has: an item that folds into a run stops being a row of its own, so a
      // selection naming it points at nothing the column lists (no highlight,
      // no index for the next arrow key). Callers that name an item can't
      // resolve this themselves — the pre-delete neighbour hand-off picks a row
      // that only folds once the delete lands — so it is settled here, the one
      // place that walks each level's items. A group column is exempt: it
      // exists to list its members individually, so its rows never re-fold.
      if (opts.groupingEnabled && !isGroupId(selectedId) && !chain[i]?.groupId) {
        const { memberToGroup } = buildDisplayItems(currentItems, { enabled: true });
        const groupId = memberToGroup.get(selectedId);
        if (groupId) {
          selectedId = groupId;
          this.selections[i] = groupId;
        }
      }

      // A folded tool run is a display construct, not an item: it opens a
      // column showing the rows it stands for. That column belongs to the SAME
      // thread as this one — the rows are still that thread's items — so it
      // inherits the container/thread identity and only narrows what's listed.
      if (isGroupId(selectedId)) {
        const group = opts.groupingEnabled ? findGroup(currentItems, selectedId) : null;
        if (!group) break;
        const parent = chain[i];
        chain.push({
          type: /** @type {const} */ ('conversation'),
          container: parent?.container,
          threadItemId: parent?.threadItemId,
          threadYMap: parent?.threadYMap,
          groupId: selectedId,
          groupItems: group.members
        });
        currentItems = group.members;
        continue;
      }

      /** @type {unknown} */
      let selectedItem = null;
      for (const item of currentItems) {
        if (field(item, 'itemId') === selectedId) {
          selectedItem = item;
          break;
        }
      }

      if (!selectedItem) {
        // A queued (pending) message lives in this level's `pendingItems` array,
        // not `items`. It's always a leaf (never a thread), so it gets a plain
        // properties column — same as any selected non-thread item.
        const container = chain[i]?.container;
        const pending = listItems(container?.get('pendingItems'));
        const isPending = pending.some((it) => field(it, 'itemId') === selectedId);
        if (isPending) {
          chain.push({
            type: /** @type {const} */ ('properties'),
            selectedItemId: selectedId,
            container: chain[i]?.container
          });
        }
        break;
      }

      if (isThread(selectedItem)) {
        // The one place an alias is resolved. A thread called more than once has
        // one tile per call, each carrying its own result; every one of them
        // opens the SAME column, because they are views of one transcript. The
        // selection keeps naming the tile the user clicked — so that tile stays
        // highlighted — and only the column it opens is the canonical's.
        const thread = canonicalThread(selectedItem, currentItems);
        if (!isYMap(thread)) break;
        const nestedItems = thread.get('items');
        if (!nestedItems) break;
        const threadItemId = thread.get('itemId');

        chain.push({
          type: /** @type {const} */ ('conversation'),
          container: thread,
          threadItemId: typeof threadItemId === 'string' && threadItemId ? threadItemId : selectedId,
          threadYMap: thread,
          viewItemId: selectedId
        });

        currentItems = listItems(nestedItems);
      } else {
        chain.push({
          type: /** @type {const} */ ('properties'),
          selectedItemId: selectedId,
          container: chain[i]?.container,
          transactionId: String(field(selectedItem, 'transactionId') || '')
        });
        break;
      }
    }

    // Append the open transaction-detail panel, if any. It shows the round-trip
    // of whatever the properties column is showing, so it follows the selection
    // rather than pinning one blob — an item belonging to no round-trip simply
    // leaves it empty. A properties column is always the tail of the chain, so
    // the chain no longer ending in one is the single condition that closes the
    // panel.
    if (this.txnOpen) {
      const anchor = chain[chain.length - 1];
      if (anchor?.type === 'properties') {
        chain.push({
          type: /** @type {const} */ ('transaction'),
          transactionId: anchor.transactionId || ''
        });
      } else {
        this.txnOpen = false;
      }
    }

    return chain;
  }

  /**
   * Resolve the chain of thread item IDs from root to a target thread.
   * Recursively walks the Yjs tree to find the path.
   * @param {unknown[]} rootItems - Root-level items to search
   * @param {string} targetThreadItemId - The thread item ID to find
   * @param {ThreadPredicate} isThread - Predicate to check if an item is a thread
   * @returns {string[]} Chain of item IDs from root to target
   */
  resolveThreadChain(rootItems, targetThreadItemId, isThread) {
    /**
     * @param {unknown[]} items
     * @returns {string[]|null} Chain if found, null otherwise
     */
    const search = (items) => {
      for (const item of items) {
        const itemId = field(item, 'itemId');
        if (typeof itemId !== 'string' || !itemId) continue;

        if (itemId === targetThreadItemId) {
          return [itemId];
        }

        if (isThread(item)) {
          const nestedItems = field(item, 'items');
          if (nestedItems) {
            const result = search(listItems(nestedItems));
            if (result) {
              return [itemId, ...result];
            }
          }
        }
      }
      return null;
    };

    return search(rootItems) || [];
  }

  /**
   * Reveal the column chain for a running thread — the one automatic path
   * that rewrites the whole chain, and therefore the one that can pull a
   * column out from under a reader. Two properties keep it in its place:
   *
   * A thread is opened from status AT MOST ONCE. Its first frame that finds
   * the chain free opens it; from then on every later frame is ignored, so a
   * thread's ongoing life (streaming, tool events, sibling projections
   * re-naming it) can never rewrite the chain again. The moves left to a
   * thread that has been revealed are the user's.
   *
   * A reader defers even that first open. `userReading` is how the columns
   * say "someone is looking at this", whether by selecting an item or just by
   * scrolling away from the end. Reading is not consumed: neither
   * `_lastStatusThreadId` nor `_autoOpenedThreadIds` records a deferred open,
   * so when it ends (a new user message, the offscreen demotion, focusing a
   * composer, scrolling back to the end) the thread that is running by then
   * opens — the deferral postpones the reveal rather than cancelling it.
   * @param {string|null} statusThreadId - Current LLM status thread ID
   * @param {unknown[]} rootItems - Root-level items for chain resolution
   * @param {ThreadPredicate} isThread - Predicate to check if an item is a thread
   * @param {{userReading?: boolean, nowMs?: number}} [opts] - `userReading`: the
   *   user is reading a column of this tab — a selection of their own, or a
   *   viewport scrolled away from the end. `nowMs`: current timestamp (for
   *   testability).
   * @returns {boolean} True if auto-selection was applied
   */
  maybeAutoSelectThread(statusThreadId, rootItems, isThread, opts = {}) {
    const { userReading = false, nowMs = Date.now() } = opts;
    if (statusThreadId === this._lastStatusThreadId) return false;

    if (userReading) return false;

    // An already-revealed thread never rewrites the chain from status again.
    if (statusThreadId && this._autoOpenedThreadIds.has(statusThreadId)) {
      this._lastStatusThreadId = statusThreadId;
      return false;
    }

    if (nowMs - this.lastManualInteractionTime < AUTO_SELECT_COOLDOWN_MS) {
      // Only apply cooldown for threads the user is already viewing.
      // A new thread (not in current selections) should always auto-open —
      // the user hasn't seen it yet, so there's nothing to protect.
      if (!statusThreadId || this.selections.includes(statusThreadId)) {
        this._lastStatusThreadId = statusThreadId;
        return false;
      }
    }
    if (!statusThreadId) {
      this._lastStatusThreadId = statusThreadId;
      return false;
    }

    const chain = this.resolveThreadChain(rootItems, statusThreadId, isThread);
    if (chain.length === 0) return false;

    // Only mark as handled once the chain actually resolved — the thread item
    // may not be in rootItems yet on the first sync after creation.
    this._lastStatusThreadId = statusThreadId;
    this._autoOpenedThreadIds.add(statusThreadId);
    this.selections = chain;
    this.activeColumnIndex = chain.length;
    return true;
  }
}

/** @typedef {'user'|'auto'} SelectionOrigin */

/**
 * @typedef {object} SelectionFollowUps
 * @property {boolean} scrollColumns - Scroll the column row to the active column.
 * @property {boolean} revealDetails - Page the row to the selected item's child column.
 * @property {boolean} engageApproval - Give the selected item's approval widget the keyboard.
 */

/**
 * What a selection asks of the columns beyond the selection itself. A pure
 * decision, so every rule is testable without a laid-out (or painting) tab.
 *
 * - **scrollColumns.** Moving the selection does not move the columns. The
 *   horizontal scroll is the user's (they set it by dragging), and an arrow key
 *   walking a column's items is asking for nothing to its left or right, so
 *   re-anchoring the row on every keypress only throws that choice away. A
 *   selection of the user's that lands the keyboard in a DIFFERENT column
 *   (clicking into one that is partly off-screen) IS a request to see that
 *   column.
 * - **revealDetails.** On a narrow viewport the columns are full-width and
 *   paged, so the child column that just appeared for a tapped item sits
 *   off-screen to the right. Revealing it shows the user the detail they
 *   selected. Prose (user/assistant messages) is exempt, since a tap there is
 *   reading rather than a request to scroll away (see isItemRevealable), and so
 *   is a tap on a control inside the tile, which is an action on the item: both
 *   arrive with `revealable` false. It is a pointer gesture: ↑/↓ walking a
 *   column is not asking for the column beside it, and a reveal per keypress
 *   would page the row away from the list being walked.
 * - **engageApproval.** Rule 16: an approval the model's progress auto-selected
 *   takes the keyboard, so Enter acts on it. Whether a draft in the message box
 *   holds it off is judged later, by the engage itself, on the tick it runs.
 * @param {object} s - The selection, after it was applied.
 * @param {SelectionOrigin} s.origin - Who made it.
 * @param {string|null} s.itemId - The selected item, or null for a clear.
 * @param {boolean} s.revealable - Whether the item asks for its child column when tapped.
 * @param {boolean} s.enteredAnotherColumn - Whether the keyboard target changed column.
 * @param {boolean} s.keyboard - Whether keyboard navigation made it.
 * @param {boolean} s.paged - Whether the columns are full-width pages (narrow viewport).
 * @returns {SelectionFollowUps} What the tab should do next.
 */
function selectionFollowUps({ origin, itemId, revealable, enteredAnotherColumn, keyboard, paged }) {
  const byUser = origin === 'user';
  return {
    scrollColumns: byUser && enteredAnotherColumn,
    revealDetails: byUser && !keyboard && !!itemId && revealable && paged,
    engageApproval: origin === 'auto' && !!itemId,
  };
}

export { ColumnSelectionState, selectionFollowUps };
