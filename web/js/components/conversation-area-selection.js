//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * conversation-area-selection — the selection engine for conversation-area.js:
 * which row is selected, what gets auto-selected as items arrive, and the
 * item-selected event the tab navigates on.
 *
 * One {@link ColumnSelection} per column, owning the column's selection state.
 * It reaches the column only through the column's public surface (its DOM,
 * `conversation`, `getMessageThread()`, `displayIdFor()`) and scrolls through
 * the column's ColumnScroll (conversation-area-scroll.js).
 *
 * UX rules 1-5b (scroll rules 6-11 live in conversation-area-scroll.js, which
 * this module drives):
 *   1. User arrow-keys / clicks → select that item.
 *   2. LLM inserts items → auto-select the best candidate
 *      (error > pending-approval > latest non-text item).
 *      Never auto-select user messages, transaction markers,
 *      assistant messages, or thinking messages.
 *   2b. After the selected pending-approval item transitions out
 *      of PENDING (approved / cancelled), auto-select the first
 *      remaining pending-approval item in the thread — so the
 *      user lands on the next thing to act on without scrolling
 *      or clicking. Driven from conversation-tab, which observes
 *      conversation:changed (including empty-insertedItemIds state
 *      transitions) and calls `getNextPendingApprovalToSelect()`
 *      on each conversation-area column. Suppressed by rule 4
 *      (origin === 'user').
 *   3. A new user message resets auto-follow (ready to track the response)
 *      AND scrolls to the end of the conversation, from wherever the reader
 *      was — the user just acted, so their message and the spinner working
 *      on it are what they're waiting to see. No gate may veto this: not the
 *      rule-11 near-bottom band, not rule 4's pin, not rule 4b. It is the one
 *      move in this file the user asked for directly, so it runs last and
 *      overrides whatever the automatic rules decided (see onItemsInserted).
 *      (Combined with the tail-only rule in ColumnScroll's follow target, this
 *      lands cleanly on the footer rather than on a busy sub-thread
 *      tile higher up.)
 *   4. Once the user manually selects, auto-follow is suppressed
 *      until the next user message resets it. Suppressed means the SCROLL as
 *      well as the selection: a pinned row is the reader's place in this
 *      column, and a column that kept chasing its own end would carry that row
 *      out of the viewport, where rule C reads it as the reader having moved on
 *      and retires the pin. Every automatic move therefore asks
 *      isFollowingEnd (conversation-area-scroll.js) rather than the bare
 *      near-bottom test — including the reader anchors, whose job only starts
 *      once there is a place worth keeping.
 *   4c. Items arriving in a SUB-THREAD never move this column's selection.
 *      Parallel runs make this stronger than rule 4 alone: a sub-thread's
 *      items belong to its own column, and the status path may reveal a
 *      thread's column only once (see maybeAutoSelectThread), so a thread's
 *      ongoing life cannot re-target the parent — not even after a pin has
 *      lifted (rule A, rule C).
 *   4b. While the reader is scrolled away from the end of the
 *      conversation, auto-follow is off entirely: no auto-selection
 *      (rules 2 and 2b) and no auto-scroll. Scrolling away is itself the
 *      instruction to leave the view alone, and it needs no click to say
 *      so — this is the rule-11 near-bottom gate the other follow paths
 *      already honour, applied to selection, which is the one path that
 *      moved the viewport without asking. Suppressing the selection too,
 *      not merely its scroll, is deliberate: selecting in a column
 *      truncates the chain to its right (ColumnSelectionState.selectItem),
 *      so an auto-selection made "quietly" behind a reader's back would
 *      close the sub-thread column they are reading. A new user message
 *      (rule 3) overrides the gate — submitting is a request to watch the
 *      answer — and because this rule can withhold a selection's scroll
 *      without withholding the selection, rule 3 never delegates its scroll
 *      to one.
 *   5. Never select an item that isn't visible in the DOM.
 *   5b. When a selected item is deleted, auto-select the nearest visible
 *       neighbor (next preferred, previous if last). Driven by the
 *       deletion site (properties-panel), not the render path.
 *       See: request-item-selection event in conversation-tab.
 *
 * State (read through the column's getSelectedItemId() and selectionOrigin):
 *   selectedId  – which item is selected (string | null)
 *   origin      – 'user' | 'auto' | null
 *
 * Entry points:
 *   onItemsInserted     → rules 2-4, 8
 *   select              → rules 1, 5-7
 *   streaming observer  → rules 9, 11
 *
 * Note: _rebuildColumns (conversation-tab) applies selections via
 *   presetSelectedItemId + applySelectedClass, bypassing select
 *   to avoid re-entrant events and data-driven scroll hijacking.
 *   When the selection is genuinely new (openThread, maybeAutoSelectThread)
 *   the caller invokes _scrollSelectionsIntoView to honour rules 6-7.
 *
 * See also: Focus rules in conversation-tab.js (rules 12-19).
 * @module components/conversation-area-selection
 */

import {
  isUserMessage,
  isAssistantMessage,
  isToolActionMessage,
  isErrorMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import { recordTape } from '../utils/event-tape.js';

/** @typedef {import('../../sdk/lib/message.js').Message} Message */
/** @typedef {import('./conversation-area-scroll.js').ColumnScroll} ColumnScroll */

/**
 * How long a pinned row may sit offscreen before its pin is retired (rule C,
 * see _watchVisibility).
 */
const OFFSCREEN_RESUME_MS = 3000;

/** Every tag that renders a selectable row. */
const SELECTABLE_SELECTOR =
  'user-message[message-id], assistant-message[message-id], thinking-message[message-id], ' +
  'context-item-message[message-id], error-message[message-id], notice-message[message-id], ' +
  'tool-action-message[message-id], thread-message[message-id], tool-group-message[message-id]';

/**
 * The selection engine for one conversation column.
 */
export class ColumnSelection {
  /**
   * @param {any} area - The ConversationArea whose selection this is.
   * @param {ColumnScroll} scroll - The column's scroll controller, which every
   *   selection scroll goes through.
   */
  constructor(area, scroll) {
    /** @type {any} @private */
    this._area = area;
    /** @type {ColumnScroll} @private */
    this._scroll = scroll;
    /** @type {string|null} - Which item is selected, in the ids the column renders */
    this.selectedId = null;
    /** @type {'user'|'auto'|null} - Who made the selection; 'user' pins it (rule 4) */
    this.origin = null;
    /** @type {IntersectionObserver|null} @private - Watches the pinned row while origin is 'user' (rule C) */
    this._visibilityObserver = null;
    /** @type {number|null} @private - Pending demotion of a pin that has sat offscreen */
    this._offscreenTimer = null;
  }

  /**
   * Whether the selection is a tool action still awaiting approval, resolved
   * against the column's live items.
   * @returns {boolean} True for a selected PENDING tool action.
   * @private
   */
  _selectedIsPending() {
    const thread = this._area.getMessageThread();
    if (!this.selectedId || !thread) return false;
    const sel = thread.items.find(
      (/** @type {any} */ i) => i?.get?.('itemId') === this.selectedId
    );
    return !!sel && isToolActionMessage(/** @type {Message} */ (sel)) &&
      sel.get('state') === TOOL_STATES.PENDING;
  }

  /**
   * Handle newly inserted items — auto-select the best candidate.
   * Called by conversation-tab when conversation:changed carries insertedItemIds.
   * @param {string[]} insertedItemIds
   * @param {Array<any>} items - Current full items array
   */
  onItemsInserted(insertedItemIds, items) {
    if (!insertedItemIds.length) return;

    const itemMap = new Map();
    for (const item of items) {
      const id = item?.get?.('itemId');
      if (id) itemMap.set(id, item);
    }

    // Rule 3: new user message → reset auto-follow
    let sawUserMessage = false;
    for (const id of insertedItemIds) {
      const item = itemMap.get(id);
      if (item && isUserMessage(item)) {
        this.origin = null;
        sawUserMessage = true;
        break;
      }
    }

    // Rule 4b: a reader scrolled away from the end is inspecting, so nothing
    // below may move the view or the chain. A new user message overrides it:
    // the reader just asked for this turn, and rule 3 has already re-armed.
    const following = sawUserMessage || this._scroll.isNearBottom();

    // Rule 2: find best auto-select candidate (suppressed by rules 4 and 4b)
    let autoSelected = false;
    if (following && this.origin !== 'user') {
      const candidate = this._pickAutoSelectCandidate(insertedItemIds, itemMap);
      if (candidate) {
        const candidateId = candidate.get('itemId');
        if (candidateId && candidateId !== this.selectedId) {
          this.select(candidateId, 'auto');
          autoSelected = true;
        }
      }
    }

    // Rule 3/8b: the user's own message just landed in the DOM — show it, from
    // wherever they were reading. This is the right moment for the "show me the
    // spinner working on my message" scroll: the user-msg element is now real,
    // and the follow target (footer / spinner) sits just below it. Doing this
    // here (rather than at submitMessage time) means we never scroll into a
    // phantom position before the user msg is rendered, which would push the new
    // user message offscreen.
    //
    // It runs last and unconditionally, AFTER any auto-selection above, because
    // it is the only move here that is not the system's own idea. The selection
    // scroll can't stand in for it: rule 4b silently withholds that scroll from
    // a reader who is scrolled away — which is exactly the reader this rule
    // exists for — so treating "an item was auto-selected" as "the view has been
    // taken care of" loses the user's message off the top of a long conversation.
    if (sawUserMessage) {
      this._scroll.userSendIntoView();
      return;
    }

    if (autoSelected) return; // select has already scrolled, rule 4b permitting

    // No candidate selected — scroll follow target into view if this column is
    // still following its end (rule 8). A pinned row is a reader's place even at
    // the end, and following would carry it away (isFollowingEnd).
    if (this._scroll.isFollowingEnd()) {
      this._scroll.followIfNeeded();
    }
  }

  /**
   * Pick the best auto-select candidate from a set of inserted item IDs.
   * Priority: error > pending approval / shouldAutoSelect > last non-user item.
   * Skips user messages and transaction markers (rule 2).
   * @param {string[]} ids
   * @param {Map<string, any>} itemMap
   * @returns {any|null} The best candidate item, or null if none found
   * @private
   */
  _pickAutoSelectCandidate(ids, itemMap) {
    // If the user is already looking at a PENDING tool-action, a *new* PENDING
    // tool-action arriving in a later insertion batch must NOT preempt it —
    // otherwise multiple sequentially-streamed approvals yank the user to the
    // last one, when they need to act on the first. (Errors still preempt;
    // resolved against the live items array — the current selection won't
    // be in the insertedItemIds batch.)
    const currentIsPending = this._selectedIsPending();

    let fallback = null;
    for (const id of ids) {
      const item = itemMap.get(id);
      if (!item) continue;
      // Neutral plugin opt-out: items inserted "in the background" (e.g.
      // /compact's summary thread) set noAutoSelect so the user's column
      // isn't yanked into them.
      if (item.get?.('noAutoSelect')) continue;
      if (isUserMessage(item)) continue;

      if (isErrorMessage(item)) return item;

      if (isToolActionMessage(item)) {
        const toolName = item.get('toolName');
        const ActionClass = toolName
          ? contextItemRegistry.getByToolName(toolName)
          : null;
        const isPending = item.get('state') === TOOL_STATES.PENDING;
        if (ActionClass?.shouldAutoSelect?.() || isPending) {
          if (isPending && currentIsPending) continue; // earliest pending wins
          return item;
        }
      }
      // Text-only messages — selecting just duplicates content in a properties panel.
      // Thinking messages are included (not skipped) so users can watch them stream in.
      if (isAssistantMessage(item)) continue;

      // Only items that render a selectable row are valid fallbacks. Internal
      // payload items (e.g. the meta-tool-result a sync meta tool such as
      // drop_context_items leaves behind) have no selectable element, so picking one would
      // silently fail select's visibility check and leave the column with
      // no selection. When a whole turn arrives in one coalesced sync, such an
      // item can be the last in the batch and would otherwise shadow the real
      // tool-action that precedes it.
      if (this.isVisible(id)) fallback = item;
    }
    return fallback;
  }

  /**
   * Rule 2b: pure decision function — does this column have a pending-approval
   * item that should become the next auto-selection? Returns the itemId of the
   * first pending-approval item iff one exists AND the current selection isn't
   * already a pending-approval item AND origin isn't 'user'. Otherwise null.
   *
   * Caller (conversation-tab) is responsible for routing the result through
   * the standard selection path so the visual update and rebuild happen.
   * @returns {string|null} itemId of the first pending-approval item to auto-select, or null
   */
  nextPendingApproval() {
    // Diagnostic: record the Rule 2b decision + the reason it bailed, so a
    // "selection didn't advance" flake shows WHY in the tape (the leading
    // suspect being origin==='user' not cleared on approve).
    const trace = (/** @type {string} */ reason, /** @type {string|null} */ picked) => {
      recordTape('autoselect-2b', this._area.conversation?.id ?? null, {
        reason,
        picked,
        origin: this.origin,
        selected: this.selectedId ?? null
      });
    };
    if (this.origin === 'user') { trace('origin-user', null); return null; }
    // Rule 4b: a parked approval doesn't get to haul a reader back to the end.
    // The footer spinner and the scroll-to-bottom control both still advertise
    // that something is waiting.
    if (!this._scroll.isNearBottom()) { trace('scrolled-away', null); return null; }
    const thread = this._area.getMessageThread();
    if (!thread) { trace('no-thread', null); return null; }
    const pending = thread.getPendingApprovalMessages();
    if (pending.length === 0) { trace('none-pending', null); return null; }

    // If the current selection is already a pending tool-action, leave it
    // alone — the user hasn't acted on it yet.
    if (this._selectedIsPending()) {
      trace('selected-still-pending', null);
      return null;
    }

    // The caller applies this id as the column's selection, so hand back the id
    // this column actually renders: a folded approval is reached by selecting
    // its group, which opens the run (and the approval) in the next column.
    const nextId = this._area.displayIdFor(pending[0]?.get?.('itemId'));
    if (!nextId || nextId === this.selectedId) { trace('no-change', nextId ?? null); return null; }
    if (!this.isVisible(nextId)) { trace('not-visible', nextId); return null; }
    trace('pick', nextId);
    return nextId;
  }

  /**
   * Select an item by ID.
   * @param {string} itemId
   * @param {'user'|'auto'} [origin='user']
   * @param {{allowReveal?: boolean, scroll?: boolean}} [opts] - allowReveal
   *   false when the click that caused this selection landed on a control inside
   *   the tile: the item still becomes selected, but its child column is not
   *   revealed. scroll false when the selection is a click: the row is already
   *   under the pointer, so the viewport stays exactly where it is.
   */
  select(itemId, origin = 'user', { allowReveal = true, scroll = true } = {}) {
    const conversation = this._area.conversation;
    if (!conversation) return;
    // A folded tool row has no row of its own — selecting it means selecting the
    // group standing in for it, which opens the run in the next column.
    itemId = this._area.displayIdFor(itemId);
    // Rule 5: never select a hidden item
    if (!this.isVisible(itemId)) return;

    recordTape('selection', conversation.id, {
      itemId,
      origin,
      threadItemId: this._area.getMessageThread()?.threadItemId ?? null
    });

    this.selectedId = itemId;
    this.origin = origin;

    const ids = this.selectableIds();
    const isTail = ids.length > 0 && ids[ids.length - 1] === itemId;

    // Rule A: selecting the last item re-arms auto-follow. The user's mental
    // model is "I want to see whatever shows up next"; only items further up
    // the list represent inspection that should pin the selection.
    //
    // A sub-thread tile is exempt. It opens its transcript in the next column, so
    // selecting one is a request to read that run — and while the sub-thread is
    // working its tile is necessarily the last row here, because nothing is
    // appended to this column until the thread returns. Re-arming on it would
    // hand the column back to auto-follow at the exact moment the user asked to
    // watch the child, and the parent's next item would select the child column
    // shut. The pin still lifts by the ordinary routes: a new user message
    // (rule 3), drifting offscreen (rule C), or focusing a composer (rule B).
    if (origin === 'user' && isTail && this._rowTag(itemId) !== 'THREAD-MESSAGE') {
      this.origin = null;
    }

    this.applyClass(itemId);

    // Auto-selection ('auto') is the system following incoming content to the end
    // of the conversation — glide there, like the streaming-content follow. A
    // 'user' selection (arrow keys, click) is navigation the user drives directly,
    // where a glide reads as lag, so it stays instant.
    const smooth = origin === 'auto';

    // Rule 4b: an automatic selection may only move the viewport while the reader
    // is already at the end. A selection the user made by keyboard always
    // scrolls — the row it lands on may be offscreen. (Rules 2/2b are gated at
    // their own call sites too; this is the invariant every future auto-selecting
    // caller inherits for free.)
    //
    // A click never scrolls: the reader pointed at a row they can see, and
    // framing it — its top for a row taller than the viewport, the end of the
    // conversation for the tail — slides the text out from under the pointer,
    // so the copy or the answer they were starting lands on something else.
    const mayScroll = scroll && (origin === 'user' || this._scroll.isNearBottom());

    // Rules 6-7: scroll selected item into view. This is a no-op when the item
    // is already fully visible (see ColumnScroll._elementIntoView), except for
    // the tail, which always goes to the end.
    if (mayScroll) this._scroll.itemIntoView(itemId, { smooth, automatic: origin === 'auto' });

    this.dispatchItemSelected(itemId, origin, false, allowReveal);

    // Tail-only safety net: re-pin the end on the next frame. The hidden→visible
    // composer-box transition re-measures the textarea, which can clamp a
    // bottom-pinned scroll; for the tail we re-assert the end so it can never end
    // up behind the composer (Safari has no scroll-anchoring to recover the
    // clamp). We must NOT re-assert for non-tail items: there the initial
    // itemIntoView already no-opped (the item was fully visible), and re-pinning
    // would needlessly scroll an on-screen item.
    if (isTail && mayScroll) {
      const scrolledId = itemId;
      requestAnimationFrame(() => {
        // Match the initial scroll's mode: an instant re-assert would snap and
        // kill an in-flight auto-follow glide.
        if (this.selectedId === scrolledId) {
          this._scroll.itemIntoView(scrolledId, { smooth, automatic: origin === 'auto' });
        }
      });
    }

    // Rule C: if origin remained 'user', start watching the element so we can
    // re-arm auto-follow when it drifts offscreen for a few seconds.
    this._watchVisibility();
  }

  /**
   * Record which item is selected without applying it: no event, no highlight,
   * no scroll (see the column's presetSelectedItemId).
   * @param {string|null} itemId
   */
  preset(itemId) {
    this.selectedId = itemId;
  }

  /**
   * Lift a user pin and leave the selection where it is, so auto-follow may move
   * it again: the reader approved or denied an item (rule 2b's hand-off), or
   * focused the composer to write the next turn (rule B).
   */
  releasePin() {
    this.origin = null;
    this.stopWatching();
  }

  /**
   * Clear the current selection.
   */
  clear() {
    if (!this._area.conversation) return;
    this.selectedId = null;
    this.origin = null;
    this.stopWatching();
    this.applyClass(null);
    this.dispatchItemSelected(null);
  }

  /**
   * Re-apply the highlight after a render, or — when the selected row is gone —
   * forget the selection silently. The tab owns selection state, so this never
   * dispatches item-selected (it would loop back via conversation-tab).
   */
  reconcileAfterRender() {
    if (!this.selectedId) return;
    if (this.isVisible(this.selectedId)) {
      this.applyClass(this.selectedId);
      return;
    }
    this.selectedId = null;
    this.origin = null;
    this.stopWatching();
    this.applyClass(null);
  }

  /**
   * Watch the currently selected element's viewport visibility. If it stays
   * offscreen for OFFSCREEN_RESUME_MS while origin is still 'user', demote to
   * null so the next inserted item can auto-select.
   *
   * This reads "offscreen" as "the user has moved on", which is only honest
   * because nothing else can push the element out: the reader anchor in
   * conversation-area-scroll.js holds its place against both streaming growth
   * and inserted items, and a pinned row is exactly what tells it there is a
   * place to hold — at the end of the conversation as much as away from it
   * (isFollowingEnd). Without that second half the column went on following its
   * own end while pinned, walked the pinned row off the top, and this timer then
   * retired a pin the reader had never let go of. So the element leaves the
   * viewport when — and only when — the user scrolls it away.
   *
   * The demotion is not itself a scroll: rule 4b keeps the view still until the
   * reader comes back to the end. What it buys is that they need no click to
   * resume following when they do, and that a pin left behind up the list cannot
   * block the tab-level chain move (_hasUserPinnedSelection) for the rest of the
   * session.
   * @private
   */
  _watchVisibility() {
    this.stopWatching();
    if (this.origin !== 'user' || !this.selectedId) return;

    const messageList = /** @type {HTMLElement|null} */ (this._area.querySelector('#message-list'));
    if (!messageList) return;
    const el = this._area.querySelector(`[message-id="${this.selectedId}"]`);
    if (!el) return;

    const watchedId = this.selectedId;

    this._visibilityObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (entry.isIntersecting) {
        if (this._offscreenTimer !== null) {
          clearTimeout(this._offscreenTimer);
          this._offscreenTimer = null;
        }
        return;
      }
      if (this._offscreenTimer !== null) return;
      this._offscreenTimer = window.setTimeout(() => {
        this._offscreenTimer = null;
        if (this.origin === 'user' && this.selectedId === watchedId) this.releasePin();
      }, OFFSCREEN_RESUME_MS);
    }, { root: messageList, threshold: 0 });
    this._visibilityObserver.observe(el);
  }

  /**
   * Stop watching the selected element and cancel any pending offscreen
   * demotion — the one piece of selection state that outlives the column on its
   * own, so the column also calls this when it leaves the document.
   */
  stopWatching() {
    if (this._visibilityObserver) {
      this._visibilityObserver.disconnect();
      this._visibilityObserver = null;
    }
    if (this._offscreenTimer !== null) {
      clearTimeout(this._offscreenTimer);
      this._offscreenTimer = null;
    }
  }

  /**
   * @param {string|null} itemId
   * @param {'user'|'auto'} [origin='auto']
   * @param {boolean} [reveal=false] - Repeat-click "show me more" gesture: the
   *   selection is unchanged; the tab should just reveal this item's details
   *   column if it has drifted off-screen.
   * @param {boolean} [allowReveal=true] - False suppresses the reveal for this
   *   selection regardless of item type (a click on a control inside the tile).
   */
  dispatchItemSelected(itemId, origin = 'auto', reveal = false, allowReveal = true) {
    const revealable = allowReveal && !!itemId && this._isRevealable(itemId);
    this._area.dispatchEvent(new CustomEvent('item-selected', {
      detail: { itemId, origin, reveal, revealable },
      bubbles: true,
      composed: true
    }));
  }

  /**
   * Whether tapping this item should auto-scroll to reveal its child column.
   * Prose messages (user/assistant) are exempt: a fresh tap is reading, not a
   * request to scroll away, and a repeat tap is the start of a text selection.
   * Context items, tool actions, thinking, errors, and threads all reveal — for
   * a thread the child column is its conversation column, which is exactly where
   * the reveal is most useful. Mirrors the repeat-click prose check in the
   * column click handler. This judges the item alone; a click that landed on a
   * control inside the tile suppresses the reveal separately (see allowReveal).
   * @param {string} itemId
   * @returns {boolean} True when a reveal scroll is appropriate for this item
   * @private
   */
  _isRevealable(itemId) {
    const tag = this._rowTag(itemId);
    return !!tag && tag !== 'USER-MESSAGE' && tag !== 'ASSISTANT-MESSAGE';
  }

  /**
   * The tag of the row rendered for `itemId`.
   * @param {string} itemId
   * @returns {string|null} The row's upper-case tag name, or null for no row.
   * @private
   */
  _rowTag(itemId) {
    return this._area.querySelector(`[message-id="${itemId}"]`)?.tagName ?? null;
  }

  /**
   * Select the next item in the list
   */
  selectNext() {
    const items = this.selectableIds();
    if (items.length === 0) return;

    const currentIndex = this.selectedId ? items.indexOf(this.selectedId) : -1;

    if (currentIndex < items.length - 1) {
      this.select(/** @type {string} */ (items[currentIndex + 1])); // bounded by currentIndex < items.length - 1
    } else if (currentIndex === -1 && items.length > 0) {
      this.select(/** @type {string} */ (items[0])); // bounded by items.length > 0
    }
  }

  /**
   * Select the previous item in the list
   */
  selectPrevious() {
    const items = this.selectableIds();
    if (items.length === 0) return;

    const currentIndex = this.selectedId ? items.indexOf(this.selectedId) : -1;

    if (currentIndex > 0) {
      this.select(/** @type {string} */ (items[currentIndex - 1])); // bounded by currentIndex > 0
    } else if (currentIndex === -1 && items.length > 0) {
      this.select(/** @type {string} */ (items[items.length - 1])); // bounded by items.length > 0
    }
  }

  /**
   * Get list of selectable item IDs
   * @returns {string[]} Array of message IDs
   */
  selectableIds() {
    const messageList = this._area.querySelector('#message-list');
    if (!messageList) return [];

    /** @type {string[]} */
    const ids = [];
    for (const el of Array.from(messageList.querySelectorAll(SELECTABLE_SELECTOR))) {
      const id = /** @type {Element} */ (el).getAttribute('message-id');
      if (id && this.isVisible(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * Check if an item is currently visible
   * @param {string} itemId - Item ID to check
   * @returns {boolean} True if the item is visible
   */
  isVisible(itemId) {
    return this._area.querySelector(`[message-id="${this._area.displayIdFor(itemId)}"]`) !== null;
  }

  /**
   * Toggle the .selected class on the correct DOM element.
   * Pure visual update — no scrolling, no events.
   * @param {string|null} selectedId
   */
  applyClass(selectedId) {
    const messageList = /** @type {HTMLElement|null} */ (this._area.querySelector('#message-list'));
    if (!messageList) return;
    selectedId = selectedId ? this._area.displayIdFor(selectedId) : selectedId;

    const currentlySelected = messageList.querySelectorAll('.selected');
    if (selectedId && currentlySelected.length === 1 &&
        currentlySelected[0]?.getAttribute('message-id') === selectedId) {
      return; // already correct
    }
    currentlySelected.forEach(el => el.classList.remove('selected'));
    if (selectedId) {
      const el = messageList.querySelector(`[message-id="${selectedId}"]`);
      if (el) el.classList.add('selected');
    }
  }
}
