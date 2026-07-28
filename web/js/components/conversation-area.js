//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import { saveScrollState, getScrollState } from '../utils/scroll-persistence.js';
import {
  isUserMessage,
  isAssistantMessage,
  isToolActionMessage,
  isErrorMessage,
  isThreadMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import './conversation-footer.js';
import './tool-action-message.js';
import './user-message.js';
import './assistant-message.js';
import './thinking-message.js';
import './context-item-message.js';
import './error-message.js';
import './thread-message.js';
import { createIconBadge, createTypeBadge } from '../utils/icon-message-renderer.js';
import { badgeForItem } from '../utils/item-badge.js';
import { SCROLL_TOP_SVG, SCROLL_BOTTOM_SVG, REOPEN_THREAD_SVG } from '../utils/icons.js';
import { setupColumnResize } from '../utils/column-resize.js';
import { isThreadClosed } from '../model/thread-navigation.js';
import { appendDeleteControls } from '../utils/panel-delete-controls.js';
import { findNeighborItemId } from '../services/context-item-utilities.js';
import {
  MESSAGE_TAGS,
  ensureFooterExists,
  ensureResultSpec,
  ensureThreadResult,
  removeAllElements,
  buildElementMap,
  identifyElementsToKeep,
  removeDeletedElements,
  positionElements,
  ensurePendingMessages,
  getItemId,
} from './conversation-area-rendering.js';
import { recordTape } from '../utils/event-tape.js';
import { StatusMessageBuilder } from '../services/status-message-builder.js';

/**
 * Duration of the insert/relayout FLIP glide — the eased motion that replaces
 * the old smooth-scroll follow, without re-introducing any scroll bookkeeping.
 */
const INSERT_ANIM_MS = 220;

/**
 * Duration of the streaming-resize glide. When a tail bubble grows by a
 * streaming token we animate its height to the new size rather than letting it
 * snap, so the items above slide up smoothly while native column-reverse pinning
 * holds the footer perfectly still (no scroll position is ever touched). Kept
 * short so the bubble's height stays close to the live content during fast
 * streaming.
 */
const STREAM_RESIZE_MS = 140;

/** @returns {boolean} True when the OS asks for reduced motion. */
function prefersReducedMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 */

/**
 * ConversationArea - Fixed conversation panel at bottom of viewport
 */
class ConversationArea extends HTMLElement {
  constructor() {
    super();
    /** @type {import('../model/conversation.js').default|null} @private */
    this._conversation = null;
    /** @type {number|null} @private */
    this._scrollAnimationFrame = null;
    /** @type {boolean} @private - Track if initial scroll restore has happened */
    this._initialScrollRestored = false;
    /** @type {((event: any, transaction: any) => void)|null} @private - Metadata observer for nextSteps */
    this._metadataObserver = null;
    /** @type {((event: any, transaction: any) => void)|null} @private - Items observer for streaming scroll */
    this._streamingScrollObserver = null;
    /** @type {'user'|'auto'|null} @private - Origin of current selection */
    this._selectionOrigin = null;
    /** @type {boolean} @private - Whether the last pointer press began inside an action-confirmation widget */
    this._mousedownInApproval = false;
    /** @type {import('../model/message-thread.js').MessageThread|null} @private */
    this._messageThread = null;
    /** @type {string|null} @private - Locally tracked selected item ID (per-column) */
    this._localSelectedItemId = null;
    /** @type {*} @private - Thread Y.Map this column represents (null for root). FOR READS AND OBSERVATION ONLY — use messageThread methods for mutations. */
    this._threadYMap = null;
    /** @type {((event: any) => void)|null} @private - Yjs observer on thread Y.Map */
    this._threadStatusObserver = null;
    /** @type {IntersectionObserver|null} @private - Watches selected element visibility while origin='user' */
    this._selectedVisibilityObserver = null;
    /** @type {number|null} @private - Pending timer to demote origin after offscreen dwell */
    this._offscreenResumeTimer = null;
    /** @type {boolean} @private - True once this column has done its initial bulk render, so later structural inserts/removals animate (FLIP) while the first populate stays instant. */
    this._animationsPrimed = false;
    /** @type {ResizeObserver|null} @private - Recomputes scroll-control visibility on viewport/content resize */
    this._scrollControlsResizeObserver = null;
  }

  /**
   * Set conversation reference
   * @param {import('../model/conversation.js').default|null} conversation
   */
  set conversation(conversation) {
    // Skip if same conversation (avoids tearing down observers on every sync)
    if (conversation === this._conversation) return;

    // Clean up old observers
    if (this._conversation && this._metadataObserver) {
      this._conversation.unobserveMetadata(this._metadataObserver);
      this._metadataObserver = null;
    }
    if (this._streamingScrollObserver && this._observedContainer) {
      this._observedContainer.unobserveDeep(this._streamingScrollObserver);
      this._streamingScrollObserver = null;
      this._observedContainer = null;
    }
    this._teardownSelectionVisibilityWatcher();
    this._conversation = conversation;

    // Set up new observer for nextSteps metadata
    if (conversation) {
      this._metadataObserver = (/** @type {any} */ event) => {
        // Conversation metadata holds only the ROOT thread's plan; a sub-thread
        // column reads its own plan off its thread Y.Map (see the thread
        // observer in setThreadContext). Refreshing here is harmless for a
        // sub-thread column (it re-reads its own Y.Map, not this key).
        if (event.keysChanged.has('nextSteps')) {
          this._refreshNextStepsIndicator();
        }
        // Selection is local per-column, tracked in _localSelectedItemId.
      };
      conversation.observeMetadata(this._metadataObserver);

      // Check initial state
      this._refreshNextStepsIndicator();

      // Set up streaming scroll observer if message thread is already available.
      // Otherwise, it will be set up when setMessageThread() is called.
      if (this._messageThread) {
        this._setupStreamingScrollObserver(conversation);
      }
    }
  }

  /**
   * Set the message thread for this column.
   * @param {import('../model/message-thread.js').MessageThread} messageThread
   */
  setMessageThread(messageThread) {
    const containerChanged = this._observedContainer !== messageThread?.container;
    this._messageThread = messageThread;
    /** @type {any} */ (this._getFooter()).setMessageThread(messageThread);

    // Re-target the streaming observer whenever the thread's container changes.
    // Columns are reused across thread navigations (the same conversation-area
    // element is repurposed for a different sub-thread), and without this
    // retarget the observer would stay attached to the previous container and
    // miss streaming chunks on the new one.
    if (this._conversation && containerChanged) {
      if (this._streamingScrollObserver && this._observedContainer) {
        this._observedContainer.unobserveDeep(this._streamingScrollObserver);
        this._streamingScrollObserver = null;
        this._observedContainer = null;
      }
      if (messageThread) {
        this._setupStreamingScrollObserver(this._conversation);
      }
    }

    // The next-steps (`<plan>`) indicator is thread-scoped; columns are reused
    // across thread navigations, so re-evaluate it against this column's
    // (possibly new) thread.
    this._refreshNextStepsIndicator();
  }

  /**
   * Get the message thread for this column
   * @returns {import('../model/message-thread.js').MessageThread|null} The message thread or null
   */
  getMessageThread() {
    return this._messageThread;
  }

  /**
   * Set the thread context for this column.
   * @param {*} threadYMap - The thread Y.Map, or null for root column behavior
   */
  setThreadContext(threadYMap) {
    // A different thread context means a fresh bulk populate — don't FLIP it in.
    if (threadYMap !== this._threadYMap) this._animationsPrimed = false;

    // Clean up old observer
    if (this._threadStatusObserver && this._threadYMap) {
      this._threadYMap.unobserve(this._threadStatusObserver);
      this._threadStatusObserver = null;
    }

    this._threadYMap = threadYMap;

    if (threadYMap) {
      // Observe thread Y.Map for header button visibility AND this thread's own
      // `nextSteps` (<plan>) — both are per-thread state on this Y.Map.
      this._threadStatusObserver = () => {
        this._updateThreadHeaderStatus(threadYMap);
        this._refreshNextStepsIndicator();
      };
      threadYMap.observe(this._threadStatusObserver);
    }

    // Re-evaluate the plan indicator for this column's (possibly new) thread:
    // columns are reused across thread navigations, and root vs sub-thread read
    // the plan from different sources.
    this._refreshNextStepsIndicator();
  }

  /**
   * Set up observer for streaming content changes. This path handles ONLY
   * pure content growth of an existing bubble (a streaming token, which carries
   * no array-level delta): it refreshes the changed elements and, when pinned,
   * smooths their height change. It deliberately never moves the scroll position
   * — see the note at the end of the handler.
   * @param {import('../model/conversation.js').default} conversation
   * @private
   */
  _setupStreamingScrollObserver(conversation) {
    this._streamingScrollObserver = (/** @type {any} */ events) => {
      const scroller = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));

      // A structural change (item inserted/removed) carries an array-level delta
      // and is animated by the FLIP path in _renderFromItemsInner. Only PURE
      // growth of an existing item — a streaming token extending the tail bubble,
      // which has no array delta — is glided here. Letting both run for one change
      // would make the two animations fight, so this path bows out when structural.
      const structural = Array.isArray(events) && events.some(e => e?.changes?.delta?.length);
      // Only smooth growth while pinned to the very bottom: there, native
      // column-reverse pinning holds the footer steady on its own, so animating
      // the grown bubble's HEIGHT (never the scroll position) slides the items
      // above up without nudging the footer. When merely near — but not at — the
      // bottom, we leave the scroll position exactly where the user put it (no
      // catch-up scroll; see the note at the end of the handler).
      const pinned = !!scroller && Math.abs(scroller.scrollTop) <= 1;
      const animate = pinned && !structural && !prefersReducedMotion();

      const growEls = animate
        ? Array.from(scroller.querySelectorAll('assistant-message, thinking-message, thread-message'))
        : [];
      // Capture each streamable element's CURRENT visual height (which, mid-glide,
      // is its in-flight animated height) before the content update lands.
      const fromHeights = growEls.map((el) => /** @type {HTMLElement} */ (el).offsetHeight);

      // Reader anchor: when scrolled up to read (not pinned), record where the
      // top-visible message sits BEFORE the token lands, so we can hold it there
      // after. Column-reverse anchors the bottom edge, so a tail bubble growing
      // below the viewport otherwise shoves the read content up and off the top —
      // a drift the reader can't escape while text streams. Skipped when pinned
      // (native bottom-anchoring is what we want there) and on structural changes
      // (those are handled by the FLIP path + onItemsInserted).
      const anchorEl = (!pinned && !structural && scroller) ? this._topVisibleMessageElement() : null;
      const anchorTopBefore = anchorEl ? anchorEl.getBoundingClientRect().top : 0;

      this._notifyChangedElements(events, conversation);

      growEls.forEach((el, i) => {
        this._animateStreamingResize(/** @type {HTMLElement} */ (el), fromHeights[i] ?? 0);
      });

      // Re-anchor the reader: nudge scrollTop by however far the anchor drifted so
      // the lines under their eyes stay put. The nudge is relative, rect-derived,
      // and instant — sign-agnostic across the reversed scroller (matching
      // _scrollElementIntoView) and never glides. When pinned we take neither
      // branch: native column-reverse anchoring keeps the newest text in view (and
      // the height glide above smooths it). Auto-follow of new items / approvals /
      // busy-status still comes from onItemsInserted and showBusy, never here.
      if (anchorEl && scroller) {
        const shift = anchorEl.getBoundingClientRect().top - anchorTopBefore;
        if (Math.abs(shift) > 0.5) {
          scroller.scrollTo({ top: scroller.scrollTop + shift, behavior: 'instant' });
        }
      }
    };
    const container = /** @type {import('../model/message-thread.js').MessageThread} */ (this._messageThread).container;
    this._observedContainer = container;
    container.observeDeep(this._streamingScrollObserver);
  }

  /**
   * Notify message elements when their items change.
   * Builds a Map of items for O(1) lookup, then iterates streamable elements once.
   * Total complexity: O(N) where N = number of items.
   * @param {any[]} events - Array of Yjs events from observeDeep
   * @param {import('../model/conversation.js').default} _conversation
   * @private
   */
  _notifyChangedElements(events, _conversation) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;

    // observeDeep passes an array of Y.Event objects (one per nesting level).
    // Content updates within a Y.Map item won't have a top-level array delta,
    // so we just check that we received any events at all.
    if (!events || (Array.isArray(events) && events.length === 0)) return;

    // Build Map of itemId -> item for O(1) lookup
    const items = this._messageThread ? this._messageThread.items : [];
    /** @type {Map<string, any>} */
    const itemMap = new Map();
    for (const item of items) {
      const msg = /** @type {any} */ (item);
      if (msg && msg.get('itemId')) {
        itemMap.set(msg.get('itemId'), msg);
      }
    }

    // Notify all streamable message elements with their current item data
    // Elements that support streaming (assistant, thinking) implement updateFromItem()
    const streamableElements = Array.from(messageList.querySelectorAll('assistant-message, thinking-message, thread-message'));
    const live = this._snapshotLiveStatus();
    for (const element of streamableElements) {
      const itemId = element.getAttribute('message-id');
      if (!itemId) continue;

      const item = itemMap.get(itemId);
      if (item) {
        if (element.tagName === 'THREAD-MESSAGE') {
          /** @type {any} */ (element).updateFromItem?.(item, live);
        } else {
          /** @type {any} */ (element).updateFromItem?.(item);
        }
      }
    }

    // Pending queued messages live beside `items` on the same thread container;
    // a pendingItems-only change has no committed-item structural delta, so refresh
    // the queue zone from the deep observer too.
    const content = /** @type {HTMLElement} */ (this.querySelector('#message-list-inner'));
    if (content) {
      const footer = ensureFooterExists(this, content);
      ensureThreadResult(this, content, footer);
      ensurePendingMessages(this, content);
    }
  }

  /**
   * Height "FLIP" for a streaming bubble: the content update has already grown
   * the element to its natural new height. Pin it back to `fromHeight` and
   * transition to the new height, so the items above slide up smoothly. Because
   * this only ever animates the element's own height — never the scroller's
   * scrollTop — native column-reverse pinning keeps the footer perfectly still.
   *
   * Interruptible: a token arriving mid-glide re-baselines from the current
   * in-flight height (captured by the caller) to the fresh natural height, so
   * rapid streaming reads as one continuous resize rather than a stutter.
   * @param {HTMLElement} el - The streamable element that may have grown.
   * @param {number} fromHeight - Its visual height captured before the update.
   * @private
   */
  _animateStreamingResize(el, fromHeight) {
    // Drop any in-flight glide and its forced styles so the element reports its
    // true natural height for this token (otherwise the pinned height clips it).
    this._clearStreamingResize(el);
    const toHeight = el.offsetHeight;
    if (Math.abs(toHeight - fromHeight) < 0.5) return;

    el.style.height = `${fromHeight}px`;
    el.style.overflow = 'hidden';
    // Commit the from-height before transitioning to the target.
    void el.offsetHeight;
    el.style.transition = `height ${STREAM_RESIZE_MS}ms ease-out`;
    el.style.height = `${toHeight}px`;

    const done = (/** @type {TransitionEvent} */ e) => {
      if (e.target !== el || e.propertyName !== 'height') return;
      this._clearStreamingResize(el);
    };
    /** @type {any} */ (el)._streamResizeDone = done;
    el.addEventListener('transitionend', done);
  }

  /**
   * Tear down a streaming-resize glide: detach its listener and clear the forced
   * height/overflow/transition so the element returns to natural sizing.
   * @param {HTMLElement} el
   * @private
   */
  _clearStreamingResize(el) {
    const done = /** @type {any} */ (el)._streamResizeDone;
    if (done) {
      el.removeEventListener('transitionend', done);
      /** @type {any} */ (el)._streamResizeDone = null;
    }
    el.style.transition = '';
    el.style.height = '';
    el.style.overflow = '';
  }

  /**
   * Snapshot the conversation's live LLM status the same way the footer
   * reads it. Threads whose `itemId` matches `threadId` mirror this message.
   * @returns {import('../utils/thread-display.js').ThreadLiveStatus|null} Live status snapshot, or null if idle.
   * @private
   */
  _snapshotLiveStatus() {
    const conv = this._conversation;
    const llmState = conv?._llmState;
    if (!llmState || !conv?.id) return null;
    const message = llmState.getStatusMessage(conv.id) || '';
    if (!message) return null;
    const threadId = llmState.getStatusThreadId(conv.id);
    return { message, threadId };
  }

  /**
   * Push a live LLM status snapshot to every thread-message tile in this
   * column. Called from updateFooter so the tile face and the footer always
   * derive from the same snapshot in the same code path.
   * @param {import('../utils/thread-display.js').ThreadLiveStatus|null} live
   * @private
   */
  _broadcastLiveStatusToTiles(live) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;
    for (const el of Array.from(messageList.querySelectorAll('thread-message'))) {
      /** @type {any} */ (el).setLiveStatus?.(live);
    }
  }

  /**
   * Get conversation reference
   * @returns {import('../model/conversation.js').default|null} The conversation instance or null
   */
  get conversation() {
    return this._conversation;
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
  }

  disconnectedCallback() {
    // Tear down all observers attached via setters. The Yjs observers hold
    // strong references back to `this`, so leaving them attached prevents
    // the element (and its captured Conversation) from being collected.
    this.conversation = null;
    this.setThreadContext(null);
    this._teardownSelectionVisibilityWatcher();
    if (this._scrollAnimationFrame !== null) {
      cancelAnimationFrame(this._scrollAnimationFrame);
      this._scrollAnimationFrame = null;
    }
    if (this._scrollControlsResizeObserver) {
      this._scrollControlsResizeObserver.disconnect();
      this._scrollControlsResizeObserver = null;
    }
  }

  get inputBox() {
    return this.querySelector('input-box');
  }

  render() {
    this.innerHTML = `
      <header class="thread-column-header hidden">
        <properties-panel-section>
          <header class="properties-panel-header">
            <thread-column-icon-box></thread-column-icon-box>
            <h3 class="properties-panel-title thread-column-goal"></h3>
          </header>
          <thread-column-actions>
            <button class="properties-panel-btn thread-copy-tab-btn" title="Copy this thread (with inherited context) to a new tab">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M440-160v-326L336-382l-56-58 200-200 200 200-56 58-104-104v326h-80ZM160-600v-120q0-33 23.5-56.5T240-800h480q33 0 56.5 23.5T800-720v120h-80v-120H240v120h-80Z"/></svg>
              Copy thread to new tab
            </button>
          </thread-column-actions>
        </properties-panel-section>
      </header>
      <conversation-message-list-wrapper>
        <section class="conversation-message-list" id="message-list">
          <div class="conversation-message-list-inner" id="message-list-inner">
            <conversation-footer></conversation-footer>
          </div>
        </section>
        <div class="scroll-controls" id="scroll-controls">
          <button type="button" class="scroll-control-btn hidden" data-scroll="top" title="Scroll to top" aria-label="Scroll to top">${SCROLL_TOP_SVG}</button>
          <button type="button" class="scroll-control-btn hidden" data-scroll="bottom" title="Scroll to bottom" aria-label="Scroll to bottom">${SCROLL_BOTTOM_SVG}</button>
        </div>
      </conversation-message-list-wrapper>
      <input-box id="input-box"></input-box>
      <reopen-box id="reopen-box" role="button" tabindex="0" aria-label="Reopen closed thread">
        <reopen-box-bubble>
          <span class="reopen-box-icon">${REOPEN_THREAD_SVG}</span>
          <span class="reopen-box-label">Reopen closed thread</span>
        </reopen-box-bubble>
      </reopen-box>
      <col-resize-handle></col-resize-handle>
    `;

    // Give new users (no persisted width) a sensible fixed 50rem.
    setupColumnResize(this, 'juggler-column-width', undefined, 50);
  }

  /**
   * Show thread column header with goal, status badge, and action buttons
   * @param {string} goal - The thread's goal text
   * @param {*} threadYMap - The thread Y.Map for return operations
   * @param {import('../model/message-thread.js').default} [parentMessageThread] - The parent message thread where the thread item lives
   */
  showThreadHeader(goal, threadYMap, parentMessageThread) {
    this._parentMessageThread = parentMessageThread || null;

    const header = this.querySelector('.thread-column-header');
    if (!header) return;

    header.classList.remove('hidden');
    const goalEl = header.querySelector('.thread-column-goal');
    if (goalEl) goalEl.textContent = goal;

    // Circular icon + "Thread" lozenge from the one shared badge resolver and
    // component — the identical .message-icon-badge the conversation tile and
    // properties-panel header render, so every thread badge stays in lockstep.
    const iconPlaceholder = header.querySelector('thread-column-icon-box');
    if (iconPlaceholder) {
      const badge = badgeForItem(threadYMap, { fallbackType: 'thread' });
      iconPlaceholder.replaceWith(createIconBadge(badge, createTypeBadge(badge.typeName)));
    }

    // Update status badge
    this._updateThreadHeaderStatus(threadYMap);

    // Wire up Copy to new tab — reuses the same promote-thread-requested event
    // as the thread-result tile's Promote button (conversation-tab handles it
    // via promoteThreadToNewTab). Clone to clear listeners from a prior show.
    const copyTabBtn = header.querySelector('.thread-copy-tab-btn');
    if (copyTabBtn) {
      const newCopyTabBtn = copyTabBtn.cloneNode(true);
      copyTabBtn.parentNode?.replaceChild(newCopyTabBtn, copyTabBtn);
      const tid = threadYMap.get('itemId');
      newCopyTabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!tid) return;
        this.dispatchEvent(new CustomEvent('promote-thread-requested', {
          detail: { threadItemId: tid },
          bubbles: true,
          composed: true
        }));
      });
    }

    // Remove old dynamically-added delete controls and re-add via shared utility
    header.querySelectorAll('.properties-panel-btn.danger').forEach(b => b.remove());

    const threadItemId = threadYMap.get('itemId');
    const actionsEl = /** @type {HTMLElement|null} */ (header.querySelector('thread-column-actions'));
    const parentThread = this._parentMessageThread;
    if (actionsEl && parentThread && threadItemId) {
      const idx = parentThread.findIndexByItemId(threadItemId);
      if (idx >= 0) {
        appendDeleteControls(actionsEl, parentThread, idx, (e) => {
          e.stopPropagation();
          const neighborId = findNeighborItemId(parentThread.items, idx, parentThread);
          if (neighborId) {
            this.dispatchEvent(new CustomEvent('request-item-selection', {
              detail: { itemId: neighborId },
              bubbles: true,
              composed: true
            }));
          }
          this.dispatchEvent(new CustomEvent('thread-deleted', {
            detail: { threadItemId },
            bubbles: true,
            composed: true
          }));
        });
      }
    }
  }

  /**
   * Update the thread header input-box visibility based on whether the thread is
   * finished (derived state).
   *
   * "Finished" is isThreadClosed (result set AND nothing in the subtree awaiting
   * approval), NOT raw `result` — the same canonical predicate the tile colour
   * and the tab's input-box placement use. A sub-thread parked on your approval
   * is still active even when a stale "Thread was interrupted" result sits on it
   * from a reload, so it must keep its input box.
   *
   * For the input box we set display to '' (not a forced value) when active, so
   * we DEFER to the CSS `conversation-area[data-hide-input] input-box` rule that
   * the tab toggles per-column — the tab is the single authority on which
   * column shows the box (it alone knows the full column chain / open child to
   * the right). Forcing 'none' here on a non-empty raw result is precisely what
   * hid the waiting sub-thread's box while the tab wanted to show it.
   * @param {*} threadYMap
   * @private
   */
  _updateThreadHeaderStatus(threadYMap) {
    const header = this.querySelector('.thread-column-header');
    if (!header || !threadYMap) return;

    const isFinished = isThreadClosed(threadYMap);

    // Hide when finished; otherwise defer to CSS (data-hide-input) by clearing
    // the inline style rather than forcing visibility.
    const inputBox = this.inputBox;
    if (inputBox) /** @type {HTMLElement} */ (inputBox).style.display = isFinished ? 'none' : '';
    this.updateFooter();
  }

  /**
   * Hide thread column header
   */
  hideThreadHeader() {
    const header = this.querySelector('.thread-column-header');
    if (header) header.classList.add('hidden');
  }

  setupEventListeners() {
    const wrapper = this.querySelector('conversation-message-list-wrapper');
    const inputBox = this.querySelector('#input-box');

    if (wrapper && inputBox) {
      // Capture-phase pre-check: detect clicks that originate inside an
      // action-confirmation widget. The bubble-phase handler below can't do
      // this with closest() because the approve/deny resolve callback mutates
      // Yjs synchronously, which re-renders the tool-action-message and
      // orphans the clicked button before bubbling completes. By the time
      // closest('action-confirmation') runs at bubble, the ancestor is gone.
      // Capture runs before _resolve, so the DOM is still intact.
      //
      // Clicks inside an action-confirmation are *actions on* the item, not
      // navigation. We must NOT mark them as 'user'-origin selection — that
      // would suppress rule 2b's auto-handoff to the next pending approval.
      // Track where a pointer press BEGINS. A native `click` fires on the
      // nearest common ancestor of the mousedown and mouseup targets; if the
      // approval box shifts between press and release (autoscroll while
      // streaming, or a pending re-render), the click target can resolve onto
      // the selectable item ABOVE even though the user pressed an approval
      // button. Keying the approval-action decision off the press location
      // makes it immune to that shift, so a press that began on a button is
      // never mistaken for navigation onto a neighbour.
      wrapper.addEventListener('mousedown', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        this._mousedownInApproval = !!target?.closest?.('action-confirmation');
      }, true);

      wrapper.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        // The press location is authoritative: a click whose target shifted off
        // the button onto a neighbour after a layout move is still an approval
        // action, not navigation.
        const insideApproval = !!target.closest?.('action-confirmation') || this._mousedownInApproval;
        this._mousedownInApproval = false;
        this._clickIsApprovalAction = insideApproval;
        // Approving / denying is an act of "advance, I'm done with this
        // item", not navigation. Clear the user-origin pin so rule 2b can
        // hand selection to the next pending approval. Otherwise users
        // who clicked to select an item before approving would see
        // selection stay glued to the now-completed item.
        if (insideApproval && this._selectionOrigin === 'user') {
          this._selectionOrigin = null;
          this._teardownSelectionVisibilityWatcher();
        }
      }, true);

      // Click handling for item selection. Listener lives on the wrapper (not
      // the inner #message-list) so background clicks that miss the list —
      // e.g. the scrollbar-gap margin, list padding, footer whitespace — still
      // count as "click on the background of the column" and deselect.
      wrapper.addEventListener('click', (e) => {
        const wasApprovalAction = this._clickIsApprovalAction;
        this._clickIsApprovalAction = false;
        if (wasApprovalAction) return;

        const target = /** @type {HTMLElement} */ (e.target);

        // Check if user has selected any text
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
          // User is selecting text, don't steal focus or select
          return;
        }

        // Check if clicked on a selectable item (any message element)
        const selectableItem = target.closest(
          'user-message, assistant-message, thinking-message, context-item-message, ' +
          'error-message, tool-action-message, thread-message'
        );
        if (selectableItem) {
          const itemId = selectableItem.getAttribute('message-id');
          if (itemId) {
            if (this._localSelectedItemId === itemId) {
              // Already selected — interactive controls inside the tile still own
              // their clicks (let those pass through untouched). But a plain
              // repeat click is a deliberate "show me more about this" gesture:
              // ask the tab to reveal this item's details column if it's drifted
              // mostly off-screen. The reveal only scrolls, so even a click that
              // also hits some other handler is unaffected. User/assistant
              // messages are exempt: a repeat click on prose is almost always the
              // start of a text selection, not a request to see details.
              const tag = selectableItem.tagName;
              const isProse = tag === 'USER-MESSAGE' || tag === 'ASSISTANT-MESSAGE';
              if (!isProse &&
                  !target.closest('button, a, input, textarea, select, summary, [role="button"], [contenteditable="true"]')) {
                this._dispatchItemSelected(itemId, 'user', true);
              }
              return;
            }
            this._selectItem(itemId, 'user');
            // Move focus out of textarea so keyboard navigation works
            if (document.activeElement?.tagName === 'TEXTAREA') {
              /** @type {HTMLElement} */ (document.activeElement).blur();
            }
            e.stopPropagation();
            return;
          }
        }

        // Clicked on the background — deselect any current item in this column,
        // then focus the input so the next keystroke starts composing.
        this._clearSelection();
        const textarea = inputBox.querySelector('textarea');
        if (textarea) {
          textarea.focus();
        }
      });

      // Rule B: focusing the prompt textarea re-arms auto-follow. The user is
      // composing the next turn, not inspecting a pinned item. Use delegated
      // focusin so we survive any re-creation of the textarea inside input-box.
      inputBox.addEventListener('focusin', (e) => {
        const t = /** @type {HTMLElement} */ (e.target);
        if (t && t.tagName === 'TEXTAREA') {
          this._selectionOrigin = null;
          this._teardownSelectionVisibilityWatcher();
        }
      });
    }

    this.addEventListener('select-item-requested', (e) => {
      const { messageId } = /** @type {CustomEvent} */ (e).detail;
      if (messageId) this._selectItem(messageId, 'user');
    });

    // Reopen affordance — shown (via the data-hide-input CSS rule) in the
    // input-box's slot on a closed thread column. The whole box is clickable
    // (and Enter/Space-activatable, since it's role="button"); activating it
    // reopens the thread, after which the column shows its real input box again.
    const reopenBox = this.querySelector('#reopen-box');
    if (reopenBox) {
      const reopen = () => this._messageThread?.reopen();
      reopenBox.addEventListener('click', reopen);
      reopenBox.addEventListener('keydown', (e) => {
        const key = /** @type {KeyboardEvent} */ (e).key;
        if (key === 'Enter' || key === ' ') {
          e.preventDefault();
          reopen();
        }
      });
    }

    this._setupScrollControls();
  }

  /**
   * Wire the subtle scroll-to-top / scroll-to-bottom controls overlaid on the
   * top-right of the message list. Each button smooth-scrolls to its end and is
   * shown only when the list overflows AND there's further to travel in that
   * direction (so a short, fully-visible thread shows neither, and the end you're
   * already at hides its own button). Visibility is recomputed on scroll and on
   * any size change of the viewport or its content.
   * @private
   */
  _setupScrollControls() {
    const messageList = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));
    const controls = /** @type {HTMLElement|null} */ (this.querySelector('#scroll-controls'));
    if (!messageList || !controls) return;

    controls.querySelector('[data-scroll="top"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._scrollToConversationStart();
    });
    controls.querySelector('[data-scroll="bottom"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._scrollEndIntoView(true);
    });

    messageList.addEventListener('scroll', () => this._updateScrollControls(), { passive: true });

    // Recompute on content growth (streaming, inserts) and viewport resize, both
    // of which change whether — and how far — the list can scroll.
    this._scrollControlsResizeObserver = new ResizeObserver(() => this._updateScrollControls());
    this._scrollControlsResizeObserver.observe(messageList);
    const inner = this.querySelector('#message-list-inner');
    if (inner) this._scrollControlsResizeObserver.observe(inner);

    this._updateScrollControls();
  }

  /**
   * Toggle each scroll-control button's visibility from the live scroll metrics.
   * In the reversed scroller the bottom (newest) is scrollTop 0 and the magnitude
   * grows toward the top, so |scrollTop| is the distance from the bottom and the
   * max magnitude is scrollHeight − clientHeight — both sign-agnostic.
   * @private
   */
  _updateScrollControls() {
    const messageList = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));
    const controls = /** @type {HTMLElement|null} */ (this.querySelector('#scroll-controls'));
    if (!messageList || !controls) return;

    const topBtn = controls.querySelector('[data-scroll="top"]');
    const bottomBtn = controls.querySelector('[data-scroll="bottom"]');
    if (!topBtn || !bottomBtn) return;

    // Distance from the bottom (0) to the top, always >= 0.
    const range = messageList.scrollHeight - messageList.clientHeight;
    // "Long enough to be useful" — don't clutter a thread that barely overflows.
    const USEFUL_OVERFLOW_PX = 48;
    // Hide a direction's button once we're within a couple of rems of that end —
    // close enough that a flick finishes the trip.
    const EDGE_PX = 32;
    const fromBottom = Math.abs(messageList.scrollTop);

    if (range <= USEFUL_OVERFLOW_PX) {
      topBtn.classList.add('hidden');
      bottomBtn.classList.add('hidden');
      return;
    }

    // Hide the button for the end we're already resting near.
    topBtn.classList.toggle('hidden', fromBottom >= range - EDGE_PX);
    bottomBtn.classList.toggle('hidden', fromBottom <= EDGE_PX);
  }

  /**
   * Smooth-scroll to the very start (oldest message) of the conversation. Uses a
   * relative, viewport-rect-based nudge (like _scrollElementIntoView) so it's
   * agnostic to the reversed scroller's scrollTop sign, and clamped so it lands
   * exactly at the top rather than overshooting.
   * @private
   */
  _scrollToConversationStart() {
    const messageList = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));
    const content = /** @type {HTMLElement|null} */ (this.querySelector('#message-list-inner'));
    if (!messageList || !content) return;
    const first = content.firstElementChild;
    if (!first) return;
    const delta = first.getBoundingClientRect().top - messageList.getBoundingClientRect().top;
    messageList.scrollTo({ top: messageList.scrollTop + delta, behavior: 'smooth' });
  }

  // --- Public API for keyboard navigation (called by conversation-tab) ---

  /** Select the next item in the list */
  selectNextItem() {
    this._selectNextItem();
  }

  /** Select the previous item in the list */
  selectPreviousItem() {
    this._selectPreviousItem();
  }

  /** Skip forward to the next user message */
  selectNextUserMessage() {
    this._selectNextUserMessage();
  }

  /** Skip backward to the previous user message */
  selectPreviousUserMessage() {
    this._selectPreviousUserMessage();
  }

  /**
   * Select a specific item by ID
   * @param {string} itemId
   */
  selectItem(itemId) {
    this._selectItem(itemId);
  }

  /** Clear the current selection */
  clearSelection() {
    this._clearSelection();
  }

  /** @returns {string[]} List of selectable item IDs */
  getSelectableItemIds() {
    return this._getSelectableItemIds();
  }

  /** @returns {string|null} Currently selected item ID */
  getSelectedItemId() {
    return this._localSelectedItemId;
  }

  /** @returns {HTMLElement|null} The currently selected item's DOM element */
  getSelectedElement() {
    if (!this._localSelectedItemId) return null;
    return this.querySelector(`[message-id="${this._localSelectedItemId}"]`);
  }

  /**
   * Check if the currently selected item is a thread-message
   * @returns {boolean} True if selected item is a thread
   */
  isSelectedItemThread() {
    if (!this._localSelectedItemId) return false;
    const el = this.querySelector(`thread-message[message-id="${this._localSelectedItemId}"]`);
    return el !== null;
  }

  // ── Selection & Scrolling ────────────────────────────────────────
  //
  // UX rules:
  //
  //  SELECTION
  //   1. User arrow-keys / clicks → select that item.
  //   2. LLM inserts items → auto-select the best candidate
  //      (error > pending-approval > latest non-text item).
  //      Never auto-select user messages, transaction markers,
  //      assistant messages, or thinking messages.
  //   2b. After the selected pending-approval item transitions out
  //      of PENDING (approved / cancelled), auto-select the first
  //      remaining pending-approval item in the thread — so the
  //      user lands on the next thing to act on without scrolling
  //      or clicking. Driven from conversation-tab, which observes
  //      conversation:changed (including empty-insertedItemIds state
  //      transitions) and calls `getNextPendingApprovalToSelect()`
  //      on each conversation-area column. Suppressed by rule 4
  //      (origin === 'user').
  //   3. A new user message resets auto-follow (ready to track the response)
  //      AND forces the follow target into view, bypassing the rule-11
  //      near-bottom gate — the user just acted, so showing the footer
  //      spinner/status is what they're waiting for. The tall user message
  //      itself often pushes the footer below the viewport, so we can't
  //      rely on _isScrolledNearBottom() returning true at this point.
  //      (Combined with the tail-only rule in _getFollowTarget, this
  //      lands cleanly on the footer rather than on a busy sub-thread
  //      tile higher up.)
  //   4. Once the user manually selects, auto-follow is suppressed
  //      until the next user message resets it.
  //   5. Never select an item that isn't visible in the DOM.
  //   5b. When a selected item is deleted, auto-select the nearest visible
  //       neighbor (next preferred, previous if last). Driven by the
  //       deletion site (properties-panel), not the render path.
  //       See: request-item-selection event in conversation-tab.
  //
  //  SCROLLING
  //   All scrolling is direct, clamped scrollTop math against the
  //   #message-list (_scrollEndIntoView / _scrollElementIntoView), not
  //   Element.scrollIntoView: scrollTop is container-scoped and auto-clamped to
  //   [0, scrollHeight - clientHeight], so it can neither overshoot nor scroll a
  //   parent (e.g. the horizontal column container) as a side effect. The list
  //   wrapper never overlaps the input box, so the one correct "end of
  //   conversation" position is simply scrollTop = scrollHeight, which clamps to
  //   "end of content at the bottom edge, above the box". Selecting the tail
  //   item and every follow-target update share that path.
  //
  //   A selection scroll is re-asserted one frame later (see _selectItem): the
  //   selection triggers a column rebuild whose own rAF callbacks would
  //   otherwise perturb scrollTop right after our scroll. Chrome's scroll
  //   anchoring hid that; Safari (which has none) showed it as a just-selected
  //   tail item jumping down behind the input box. The re-assert makes our
  //   scroll the final word.
  //   6/7. Selection (user or auto) of an item → bring the item fully into
  //      view with minimal, clamped movement (_scrollElementIntoView). The
  //      tail item routes to _scrollEndIntoView (it IS the end).
  //   8. New items arrive but none auto-selected → scroll the follow
  //      target (status spinner or footer) into view, if near bottom.
  //   9. Streaming content grows → keep follow target visible,
  //      but only while user was already near bottom.
  //  10. LLM busy indicator appears → scroll follow target into view
  //      (same conditions as rule 9).
  //  11. User scrolls far from the bottom (>~20rem) → stop
  //      auto-scrolling. No fighting. Scrolling near the bottom
  //      (~20rem) allows auto-scrolling to continue.
  //
  // The follow target (see _getFollowTarget) always sits at the end of the
  // conversation, in priority order:
  //   selected busy thread > any busy thread > footer spinner > footer.
  //   Revealing any of them is the same _scrollEndIntoView call.
  //
  // State:
  //   _localSelectedItemId  – which item is selected (string | null)
  //   _selectionOrigin      – 'user' | 'auto' | null
  //
  // Entry points:
  //   onItemsInserted     → rules 2-4, 8
  //   _selectItem         → rules 1, 5-7
  //   streaming observer  → rules 9, 11
  //   showBusy            → rule 10
  //
  // Note: _rebuildColumns (conversation-tab) applies selections via
  //   _localSelectedItemId + _applySelectedClass, bypassing _selectItem
  //   to avoid re-entrant events and data-driven scroll hijacking.
  //   When the selection is genuinely new (openThread, maybeAutoSelectThread)
  //   the caller invokes _scrollSelectionsIntoView to honour rules 6-7.
  //
  // See also: Focus rules in conversation-tab.js (rules 12-19).
  // ────────────────────────────────────────────────────────────────

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
        this._selectionOrigin = null;
        sawUserMessage = true;
        break;
      }
    }

    // Rule 2: find best auto-select candidate (suppressed by rule 4)
    if (this._selectionOrigin !== 'user') {
      const candidate = this._pickAutoSelectCandidate(insertedItemIds, itemMap);
      if (candidate) {
        const candidateId = candidate.get('itemId');
        if (candidateId && candidateId !== this._localSelectedItemId) {
          this._selectItem(candidateId, 'auto');
          return; // _selectItem already scrolls
        }
      }
    }

    // A new user message just landed in the DOM — force-follow regardless
    // of the near-bottom check. This is the right moment for the
    // "show me the spinner working on my message" scroll: the user-msg
    // element is now real, and the follow target (footer / spinner) sits
    // just below it. Doing this here (rather than at submitMessage time)
    // means we never scroll into a phantom position before the user msg
    // is rendered, which would push the new user message offscreen.
    if (sawUserMessage) {
      this._scrollToFollowIfNeeded(true);
      return;
    }

    // No candidate selected — scroll follow target into view if near bottom (rule 8)
    if (this._isScrolledNearBottom()) {
      this._scrollToFollowIfNeeded();
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
    let currentIsPending = false;
    if (this._localSelectedItemId && this._messageThread) {
      const sel = this._messageThread.items.find(
        i => i?.get?.('itemId') === this._localSelectedItemId
      );
      if (sel && isToolActionMessage(/** @type {Message} */ (sel)) &&
          sel.get('state') === TOOL_STATES.PENDING) {
        currentIsPending = true;
      }
    }

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
        const ActionClass = item.get('toolName')
          ? contextItemRegistry.getByToolName(item.get('toolName'))
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
      // payload items (e.g. meta-tool-result, the closing-payload of a meta-tool
      // like return_result) have no selectable element, so picking one would
      // silently fail _selectItem's visibility check and leave the column with
      // no selection. When a whole turn arrives in one coalesced sync, such an
      // item can be the last in the batch and would otherwise shadow the real
      // tool-action that precedes it.
      if (this._isItemVisible(id)) fallback = item;
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
  getNextPendingApprovalToSelect() {
    // Diagnostic: record the Rule 2b decision + the reason it bailed, so a
    // "selection didn't advance" flake shows WHY in the tape (the leading
    // suspect being origin==='user' not cleared on approve).
    const trace = (/** @type {string} */ reason, /** @type {string|null} */ picked) => {
      recordTape('autoselect-2b', this._conversation?.id ?? null, {
        reason,
        picked,
        origin: this._selectionOrigin,
        selected: this._localSelectedItemId ?? null
      });
    };
    if (this._selectionOrigin === 'user') { trace('origin-user', null); return null; }
    if (!this._messageThread) { trace('no-thread', null); return null; }
    const pending = this._messageThread.getPendingApprovalMessages();
    if (pending.length === 0) { trace('none-pending', null); return null; }

    // If the current selection is already a pending tool-action, leave it
    // alone — the user hasn't acted on it yet.
    if (this._localSelectedItemId) {
      const sel = this._messageThread.items.find(
        i => i?.get?.('itemId') === this._localSelectedItemId
      );
      if (sel && isToolActionMessage(/** @type {Message} */ (sel)) &&
          sel.get('state') === TOOL_STATES.PENDING) {
        trace('selected-still-pending', null);
        return null;
      }
    }

    const nextId = pending[0]?.get?.('itemId');
    if (!nextId || nextId === this._localSelectedItemId) { trace('no-change', nextId ?? null); return null; }
    if (!this._isItemVisible(nextId)) { trace('not-visible', nextId); return null; }
    trace('pick', nextId);
    return nextId;
  }

  /**
   * Select an item by ID.
   * @param {string} itemId
   * @param {'user'|'auto'} [origin='user']
   * @private
   */
  _selectItem(itemId, origin = 'user') {
    if (!this._conversation) return;
    // Rule 5: never select a hidden item
    if (!this._isItemVisible(itemId)) return;

    recordTape('selection', this._conversation.id, {
      itemId,
      origin,
      threadItemId: this._messageThread?.threadItemId ?? null
    });

    this._localSelectedItemId = itemId;
    this._selectionOrigin = origin;

    const ids = this._getSelectableItemIds();
    const isTail = ids.length > 0 && ids[ids.length - 1] === itemId;

    // Rule A: selecting the last item re-arms auto-follow. The user's mental
    // model is "I want to see whatever shows up next"; only items further up
    // the list represent inspection that should pin the selection.
    if (origin === 'user' && isTail) {
      this._selectionOrigin = null;
    }

    this._applySelectedClass(itemId);

    // Auto-selection ('auto') is the system following incoming content to the end
    // of the conversation — glide there, like the streaming-content follow. A
    // 'user' selection (arrow keys, click) is navigation the user drives directly,
    // where a glide reads as lag, so it stays instant.
    const smooth = origin === 'auto';

    // Rules 6-7: scroll selected item into view. This is a no-op when the item
    // is already fully visible (see _scrollElementIntoView), so selecting an
    // on-screen item never moves the viewport.
    this._scrollItemIntoView(itemId, smooth);

    this._dispatchItemSelected(itemId, origin);

    // Tail-only safety net: re-pin the end on the next frame. The hidden→visible
    // input-box transition re-measures the textarea, which can clamp a
    // bottom-pinned scroll; for the tail we re-assert the end so it can never end
    // up behind the input box (Safari has no scroll-anchoring to recover the
    // clamp). We must NOT re-assert for non-tail items: there the initial
    // _scrollItemIntoView already no-opped (the item was fully visible), and
    // re-pinning would needlessly scroll an on-screen item.
    if (isTail) {
      const scrolledId = itemId;
      requestAnimationFrame(() => {
        // Match the initial scroll's mode: an instant re-assert would snap and
        // kill an in-flight auto-follow glide.
        if (this._localSelectedItemId === scrolledId) this._scrollItemIntoView(scrolledId, smooth);
      });
    }

    // Rule C: if origin remained 'user', start watching the element so we can
    // re-arm auto-follow when it drifts offscreen for a few seconds.
    this._watchSelectionVisibility();
  }

  /**
   * Clear the current selection.
   * @private
   */
  _clearSelection() {
    if (!this._conversation) return;
    this._localSelectedItemId = null;
    this._selectionOrigin = null;
    this._teardownSelectionVisibilityWatcher();
    this._applySelectedClass(null);
    this._dispatchItemSelected(null);
  }

  /**
   * Watch the currently selected element's viewport visibility. If it stays
   * offscreen for OFFSCREEN_RESUME_MS while origin is still 'user', demote to
   * null so the next inserted item can auto-select.
   * @private
   */
  _watchSelectionVisibility() {
    this._teardownSelectionVisibilityWatcher();
    if (this._selectionOrigin !== 'user' || !this._localSelectedItemId) return;

    const messageList = /** @type {HTMLElement|null} */ (this.querySelector('#message-list'));
    if (!messageList) return;
    const el = this.querySelector(`[message-id="${this._localSelectedItemId}"]`);
    if (!el) return;

    const watchedId = this._localSelectedItemId;
    const OFFSCREEN_RESUME_MS = 3000;

    this._selectedVisibilityObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (entry.isIntersecting) {
        if (this._offscreenResumeTimer !== null) {
          clearTimeout(this._offscreenResumeTimer);
          this._offscreenResumeTimer = null;
        }
        return;
      }
      if (this._offscreenResumeTimer !== null) return;
      this._offscreenResumeTimer = /** @type {number} */ (/** @type {unknown} */ (setTimeout(() => {
        this._offscreenResumeTimer = null;
        if (this._selectionOrigin === 'user' && this._localSelectedItemId === watchedId) {
          this._selectionOrigin = null;
          this._teardownSelectionVisibilityWatcher();
        }
      }, OFFSCREEN_RESUME_MS)));
    }, { root: messageList, threshold: 0 });
    this._selectedVisibilityObserver.observe(el);
  }

  /** @private */
  _teardownSelectionVisibilityWatcher() {
    if (this._selectedVisibilityObserver) {
      this._selectedVisibilityObserver.disconnect();
      this._selectedVisibilityObserver = null;
    }
    if (this._offscreenResumeTimer !== null) {
      clearTimeout(this._offscreenResumeTimer);
      this._offscreenResumeTimer = null;
    }
  }

  /**
   * @param {string|null} itemId
   * @param {'user'|'auto'} [origin='auto']
   * @param {boolean} [reveal=false] - Repeat-click "show me more" gesture: the
   *   selection is unchanged; the tab should just reveal this item's details
   *   column if it has drifted off-screen.
   * @private
   */
  _dispatchItemSelected(itemId, origin = 'auto', reveal = false) {
    this.dispatchEvent(new CustomEvent('item-selected', {
      detail: { itemId, origin, reveal, revealable: itemId ? this._isItemRevealable(itemId) : false },
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
   * column click handler.
   * @param {string} itemId
   * @returns {boolean} True when a reveal scroll is appropriate for this item
   * @private
   */
  _isItemRevealable(itemId) {
    const el = this.querySelector(`[message-id="${itemId}"]`);
    if (!el) return false;
    const tag = el.tagName;
    return tag !== 'USER-MESSAGE' && tag !== 'ASSISTANT-MESSAGE';
  }

  /**
   * Select the next item in the list
   * @private
   */
  _selectNextItem() {
    const items = this._getSelectableItemIds();
    if (items.length === 0) return;

    const currentId = this._localSelectedItemId;
    const currentIndex = currentId ? items.indexOf(currentId) : -1;

    if (currentIndex < items.length - 1) {
      this._selectItem(/** @type {string} */ (items[currentIndex + 1])); // bounded by currentIndex < items.length - 1
    } else if (currentIndex === -1 && items.length > 0) {
      this._selectItem(/** @type {string} */ (items[0])); // bounded by items.length > 0
    }
  }

  /**
   * Select the previous item in the list
   * @private
   */
  _selectPreviousItem() {
    const items = this._getSelectableItemIds();
    if (items.length === 0) return;

    const currentId = this._localSelectedItemId;
    const currentIndex = currentId ? items.indexOf(currentId) : -1;

    if (currentIndex > 0) {
      this._selectItem(/** @type {string} */ (items[currentIndex - 1])); // bounded by currentIndex > 0
    } else if (currentIndex === -1 && items.length > 0) {
      this._selectItem(/** @type {string} */ (items[items.length - 1])); // bounded by items.length > 0
    }
  }

  /**
   * Select the next user message below the current selection.
   * @private
   */
  _selectNextUserMessage() {
    const items = this._getSelectableItemIds();
    if (items.length === 0) return;

    const currentIndex = this._localSelectedItemId ? items.indexOf(this._localSelectedItemId) : -1;
    for (let i = currentIndex + 1; i < items.length; i++) {
      const id = /** @type {string} */ (items[i]);
      if (this._isUserMessageItem(id)) {
        this._selectItem(id);
        return;
      }
    }
  }

  /**
   * Select the previous user message above the current selection.
   * @private
   */
  _selectPreviousUserMessage() {
    const items = this._getSelectableItemIds();
    if (items.length === 0) return;

    const currentIndex = this._localSelectedItemId ? items.indexOf(this._localSelectedItemId) : items.length;
    for (let i = currentIndex - 1; i >= 0; i--) {
      const id = /** @type {string} */ (items[i]);
      if (this._isUserMessageItem(id)) {
        this._selectItem(id);
        return;
      }
    }
  }

  /**
   * Check whether a selectable item is a user message.
   * @param {string} itemId
   * @returns {boolean} True if the item is a user-message element.
   * @private
   */
  _isUserMessageItem(itemId) {
    const el = this.querySelector(`[message-id="${itemId}"]`);
    return el?.tagName === 'USER-MESSAGE';
  }

  /**
   * Get list of selectable item IDs
   * @returns {string[]} Array of message IDs
   * @private
   */
  _getSelectableItemIds() {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return [];

    const selectables = Array.from(messageList.querySelectorAll(
      'user-message[message-id], assistant-message[message-id], thinking-message[message-id], ' +
      'context-item-message[message-id], error-message[message-id], ' +
      'tool-action-message[message-id], thread-message[message-id]'
    ));
    /** @type {string[]} */
    const ids = [];
    for (const el of selectables) {
      const id = el.getAttribute('message-id');
      if (id && id !== '' && this._isItemVisible(id)) {
        ids.push(id);
      }
    }
    return ids;
  }

  /**
   * Check if an item is currently visible
   * @param {string} itemId - Item ID to check
   * @returns {boolean} True if the item is visible
   * @private
   */
  _isItemVisible(itemId) {
    const el = this.querySelector(`[message-id="${itemId}"]`);
    return el !== null;
  }

  /**
   * Toggle the .selected class on the correct DOM element.
   * Pure visual update — no scrolling, no events.
   * @param {string|null} selectedId
   * @private
   */
  _applySelectedClass(selectedId) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;

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

  /**
   * Rules 6–7: Scroll a selected item into view (minimal movement).
   * Used for user-initiated and auto selection.
   *
   * Selecting the TAIL item means "show me the end of the conversation", so it
   * routes through the one layout-guaranteed scroll (_scrollEndIntoView) — the
   * footer, and the input box just below it, pinned to the bottom of the
   * viewport. Any other item gets a minimal, clamped scroll. Neither path uses
   * scrollIntoView, whose ancestor-walking + nearest/end alignment guesswork is
   * exactly what parked the footer past the scroll clamp and shoved the clicked
   * item behind the (tall) input box.
   * `smooth` only applies to the tail/end path (the auto-follow case); a non-tail
   * item gets the same minimal, instant nudge regardless — it's inspection, not
   * an end-follow.
   * @param {string} itemId
   * @param {boolean} [smooth=false]
   * @private
   */
  _scrollItemIntoView(itemId, smooth = false) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;
    const el = messageList.querySelector(`[message-id="${itemId}"]`);
    if (!el) return;
    // Detect the tail by SELECTABLE order, not DOM adjacency: a
    // `nextElementSibling === footer` test misfires when a non-selectable
    // trailing element (e.g. a transaction marker) sits between the last
    // selectable item and the footer, which would route a tail selection to the
    // minimal-scroll path instead of the scroll-to-end path.
    const ids = this._getSelectableItemIds();
    if (ids.length > 0 && ids[ids.length - 1] === itemId) {
      this._scrollEndIntoView(smooth);
      return;
    }
    this._scrollElementIntoView(el);
  }

  /**
   * The single layout-guaranteed scroll: pin the END of all content (the whole
   * footer, plus any queued-message bubbles rendered below it) to the bottom of
   * the message-list viewport. The scroller is column-reverse, so the content
   * end sits at the flex-start edge and "scroll to the end" is simply
   * scrollTop = 0 — clamped by construction, it can neither overshoot nor scroll
   * an ancestor. This is the consistent code-path for "scroll the end of the
   * conversation into view", shared by tail selection and follow-target updates.
   * No scrollIntoView.
   *
   * `smooth` animates the move (used when auto-following the growing end of the
   * conversation), riding the scroller's `scroll-behavior: smooth`. Selection
   * passes `false` to override that with an instant scroll, where a glide would
   * read as lag.
   * @param {boolean} [smooth=false]
   * @private
   */
  _scrollEndIntoView(smooth = false) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;
    // Reversed scroller: the end of the content sits at the flex-start edge, so
    // "scroll to the end of the conversation" is simply scrollTop = 0 — clamped
    // by construction, it can neither overshoot nor scroll an ancestor. The glide
    // comes from the scroller's CSS scroll-behavior; `instant` opts out per-call.
    messageList.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'instant' });
  }

  /**
   * Minimal-movement scroll to bring an element fully into the message-list
   * viewport. Scrolls ONLY the message-list — assigning scrollTop auto-clamps to
   * [0, scrollHeight − clientHeight], so nothing can be driven past the end —
   * never scrollIntoView (which would also scroll ancestors and guess an edge).
   * @param {Element} el
   * @private
   */
  _scrollElementIntoView(el) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;
    const listRect = messageList.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    let delta = 0;
    if (elRect.top < listRect.top) delta = -(listRect.top - elRect.top);
    else if (elRect.bottom > listRect.bottom) delta = elRect.bottom - listRect.bottom;
    if (delta === 0) return;
    // Relative nudge: `delta` comes from viewport rects (direction-agnostic), and
    // in the reversed scroller scrollTop increases toward the content end exactly
    // as it does in a normal column, so the same offset brings the element into
    // view. Clamped, so it can't overshoot. Instant (overriding the scroller's
    // scroll-behavior: smooth) — selection inspection shouldn't glide.
    messageList.scrollTo({ top: messageList.scrollTop + delta, behavior: 'instant' });
  }

  /**
   * Find the most relevant follow target when auto-following.
   *
   * Key principle: if there's content *after* a candidate, the user has
   * moved past it. Only follow a busy thread when it's the tail of the
   * conversation; otherwise follow the footer (or its spinner). This
   * keeps the auto-follow target glued to where new content is actually
   * appearing, not to a sub-thread tile that happens to still be running
   * higher up the list.
   *
   * Preference order:
   *   1. The currently-selected item, but only if it's a busy thread AND
   *      it sits at the tail of the list (otherwise the selection is an
   *      inspection target, not an "I'm watching this" target).
   *   2. The footer's processing spinner (if visible).
   *   3. A busy thread at the tail of the list.
   *   4. The footer itself.
   *   5. The last rendered element.
   * @returns {Element|null} Element to keep visible while auto-following
   * @private
   */
  _getFollowTarget() {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return null;

    const footer = messageList.querySelector('conversation-footer');
    const tailEl = footer?.previousElementSibling || messageList.lastElementChild;
    const tailIsBusyThread = tailEl?.tagName === 'THREAD-MESSAGE'
      && !tailEl.getAttribute('result');

    if (this._localSelectedItemId) {
      const selected = messageList.querySelector(`[message-id="${this._localSelectedItemId}"]`);
      if (selected && selected === tailEl && tailIsBusyThread) return selected;
    }

    if (footer) {
      const processing = footer.querySelector('footer-processing');
      if (processing && !processing.classList.contains('hidden')) {
        return processing;
      }
    }

    if (tailIsBusyThread) return tailEl;

    if (footer) return footer;

    return messageList.lastElementChild;
  }

  /**
   * Rules 7–10: Keep the end of the conversation visible. By default skips work
   * when the view is already pinned to the very bottom of all content (avoids
   * fighting the user's scroll position or causing jank). Pass `force = true` to
   * scroll even from a partially-scrolled position — used on edges that must
   * reveal the end completely (e.g. the processing spinner just becoming visible
   * after a user submit; rules 8 + 10).
   * @param {boolean} [force=false]
   * @private
   */
  _scrollToFollowIfNeeded(force = false) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;
    if (!this._getFollowTarget()) return;

    if (!force) {
      // "Already there?" — in the reversed scroller the very bottom of ALL
      // content (footer + any queued bubbles) sits at scrollTop 0, so the
      // distance from the bottom is just |scrollTop| (WebKit reports it negative
      // when scrolled up). No scrollHeight/clientHeight arithmetic needed.
      if (Math.abs(messageList.scrollTop) <= 1) return;
    }

    // One consistent, layout-safe code-path: pin the very end of the content
    // (footer + queued items) above the input box, no matter how tall the
    // growable box currently is. Direct clamped scrollTop, never scrollIntoView.
    // Smooth-scroll: this is the deliberate auto-follow of the growing end of the
    // conversation, where a glide reads well. (Selection-driven and correction
    // scrolls call _scrollEndIntoView() with no arg and stay instant.)
    this._scrollEndIntoView(true);
  }

  /**
   * Public entry point for callers outside conversation-area that need to
   * land the current follow target (footer spinner / busy thread / footer)
   * unconditionally. Used on user-driven edges — submit, continue — where
   * the column should always reveal the place where the LLM response will
   * appear.
   * @param {boolean} [force=false]
   */
  scrollFollowTargetIntoView(force = false) {
    this._scrollToFollowIfNeeded(force);
  }

  /**
   * Check if user is currently scrolled near bottom
   * @private
   * @returns {boolean} True if within 320px (~20rem) of bottom
   */
  _isScrolledNearBottom() {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return true;

    // Reversed scroller: distance from the bottom is |scrollTop| (0 at bottom).
    if (Math.abs(messageList.scrollTop) <= 320) return true;

    // Last message is at least partially visible (handles tall elements like long responses)
    const footer = messageList.querySelector('conversation-footer');
    const lastMessage = footer?.previousElementSibling;
    if (lastMessage) {
      return lastMessage.getBoundingClientRect().bottom < messageList.getBoundingClientRect().bottom;
    }

    return false;
  }

  /**
   * The topmost message element still touching the viewport (its bottom edge is
   * at or below the viewport top). Used as the anchor for element-based scroll
   * restore and for holding the reader's place while the tail bubble streams.
   * @private
   * @returns {HTMLElement|null} Anchor element, or null if the list is empty.
   */
  _topVisibleMessageElement() {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return null;
    const content = this.querySelector('#message-list-inner');
    if (!content) return null;
    const listTop = messageList.getBoundingClientRect().top;
    for (const el of Array.from(content.children)) {
      if (!MESSAGE_TAGS.has(el.tagName)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > listTop) {
        return /** @type {HTMLElement} */ (el);
      }
    }
    return null;
  }

  /**
   * Id of the topmost message element whose top edge is at or below the
   * viewport top. Used as the anchor for element-based restore.
   * @private
   * @returns {string|null} Anchor item id, or null if the list is empty.
   */
  _getTopVisibleItemId() {
    const el = this._topVisibleMessageElement();
    return el ? el.getAttribute('message-id') : null;
  }

  /**
   * Persist current scroll state (atBottom + element anchor) to localStorage.
   * Called on pagehide; element-anchored so restore survives content height
   * changes that would invalidate an absolute scrollTop.
   */
  saveScrollPositionImmediately() {
    if (!this._conversation) return;
    saveScrollState(this._conversation.id, {
      atBottom: this._isScrolledNearBottom(),
      topItemId: this._getTopVisibleItemId(),
    });
  }

  /**
   * Restore scroll position from localStorage. Called by conversation-tab
   * after messages are rendered. Only restores once per conversation load.
   */
  restoreScrollPosition() {
    if (this._initialScrollRestored) return;
    this._initialScrollRestored = true;

    if (!this._conversation) return;
    const state = getScrollState(this._conversation.id);
    if (!state || state.atBottom) {
      this.scrollToBottom(true);
      return;
    }

    if (state.topItemId) {
      const messageList = this.querySelector('#message-list');
      const anchor = messageList?.querySelector(`[message-id="${state.topItemId}"]`);
      if (anchor) {
        // Restoring to a mid-conversation anchor. scrollIntoView is
        // direction-agnostic — it computes the scrollport offset to land the
        // anchor at block-start regardless of the scroller's flex direction.
        // Instant: this is a one-shot restore on load, not a navigation glide,
        // so it must override the scroller's scroll-behavior: smooth.
        anchor.scrollIntoView({ block: 'start', behavior: 'instant' });
        return;
      }
    }
    this.scrollToBottom(true);
  }

  /**
   * Reset scroll restore flag (called when conversation changes)
   */
  resetScrollRestoreFlag() {
    this._initialScrollRestored = false;
    this._animationsPrimed = false;
  }

  /**
   * Scroll to bottom if conditions allow
   * @param {boolean} [force=false] - If true, scroll regardless of user position
   */
  scrollToBottom(force = false) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;

    // Don't auto-scroll if user has scrolled away, unless forced
    if (!force && !this._isScrolledNearBottom()) {
      return;
    }

    // Cancel any pending scroll animation to prevent multiple queued scrolls
    if (this._scrollAnimationFrame !== null) {
      window.cancelAnimationFrame(this._scrollAnimationFrame);
    }

    // Queue a single scroll operation
    this._scrollAnimationFrame = window.requestAnimationFrame(() => {
      this._scrollEndIntoView();
      this._scrollAnimationFrame = null;
    });
  }

  /**
   * Scroll to a specific message by its itemId
   * @param {string} itemId - The itemId to scroll to
   */
  scrollToMessageId(itemId) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;

    const element = messageList.querySelector(`[message-id="${itemId}"]`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /**
   * Scroll to an item if it's not already visible.
   * Only scrolls if user hasn't manually scrolled away.
   * @param {string} itemId - The itemId to scroll to
   */
  scrollToItem(itemId) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;

    const element = messageList.querySelector(`[message-id="${itemId}"]`);
    if (!element) return;

    // Check if element is already visible
    const listRect = messageList.getBoundingClientRect();
    const elRect = element.getBoundingClientRect();
    if (elRect.top >= listRect.top && elRect.bottom <= listRect.bottom) {
      return; // Already visible
    }

    // Only auto-scroll if near bottom (user hasn't scrolled away)
    if (!this._isScrolledNearBottom()) return;

    this._scrollElementIntoView(element);
  }

  // ============================================================
  // DOM RENDERING (orchestration)
  // ============================================================
  //
  // The heavy lifting — element creation, ID-based diffing, position
  // shuffling — lives in conversation-area-rendering.js as pure
  // functions. This block contains only the orchestration that knows
  // about widget state (selection, footer, scroll).
  //
  // ============================================================

  /**
   * Render conversation from items array using ID-based diffing.
   *
   * Reentrancy guard: _selectItem and _clearSelection dispatch item-selected,
   * which can trigger _rebuildColumns → renderFromItems in conversation-tab.
   * @param {Array<any>} items
   */
  renderFromItems(items) {
    if (this._isRendering) return;
    this._isRendering = true;

    try {
      this._renderFromItemsInner(items);
    } finally {
      this._isRendering = false;
    }
  }

  /**
   * @param {Array<any>} items
   * @private
   */
  _renderFromItemsInner(items) {
    // The content lives in the normal-order inner column, not the reversed
    // scroller. All the structural helpers operate on direct children, so they
    // are handed the inner container.
    const content = /** @type {HTMLElement|null} */ (this.querySelector('#message-list-inner'));
    if (!content) return;

    const footer = ensureFooterExists(this, content);
    ensureResultSpec(this, content);

    if (!items || items.length === 0) {
      removeAllElements(content);
      return;
    }

    const currentElements = buildElementMap(content);
    const elementsToKeep = identifyElementsToKeep(items, currentElements);

    // FLIP "First": capture pre-mutation positions, but ONLY when a real
    // structural change (an insert or a removal) is about to happen AND the user
    // is at the bottom — the one case where the column-reverse relayout would
    // otherwise jump. _renderFromItemsInner also runs on every streaming token
    // (an existing bubble growing has no structural change), so this gate keeps
    // those ticks on the cheap, instant native pinning and animates only genuine
    // item changes.
    const structuralChange =
      items.some((it) => it && !currentElements.has(getItemId(it)))
      || currentElements.size > elementsToKeep.size;
    const animate = structuralChange
      && this._animationsPrimed
      && !prefersReducedMotion()
      && this._isScrolledNearBottom();
    const beforeTops = animate ? this._captureItemTops(content) : null;

    removeDeletedElements(currentElements, elementsToKeep);
    positionElements(this, content, footer, items, currentElements);

    // Terminal "Result" block, synthesized from the thread's `result` field
    // (after positioning items so it lands just before the footer). No-op in
    // the root column.
    ensureThreadResult(this, content, footer);

    // Queued (pending) messages, rendered after the footer. Before the selection
    // re-apply below so a selected queued bubble is seen as visible.
    ensurePendingMessages(this, content);

    // Re-apply .selected class after DOM reconciliation. If the selected item
    // was removed, silently clear — the tab owns selection state. Never
    // dispatch item-selected here (it would loop back via conversation-tab).
    if (this._localSelectedItemId) {
      if (!this._isItemVisible(this._localSelectedItemId)) {
        this._localSelectedItemId = null;
        this._selectionOrigin = null;
        this._teardownSelectionVisibilityWatcher();
        this._applySelectedClass(null);
      } else {
        this._applySelectedClass(this._localSelectedItemId);
      }
    }

    this.updateFooter();

    // FLIP "Invert + Play": now the DOM is in its final position, glide the
    // moved items from where they were and fade newly-inserted ones in.
    if (beforeTops) this._playInsertAnimation(content, beforeTops);
    this._animationsPrimed = true;
  }

  /**
   * FLIP "First": record the viewport-relative top of each on-screen message
   * element, keyed by message-id. Off-screen items above the fold are clipped by
   * the scroller, so animating them would be wasted work — only the visible band
   * is captured.
   * @param {HTMLElement} content - The inner content column.
   * @returns {Map<string, number>} message-id → top (px, viewport-relative).
   * @private
   */
  _captureItemTops(content) {
    /** @type {Map<string, number>} */
    const tops = new Map();
    const scroller = this.querySelector('#message-list');
    if (!scroller) return tops;
    const listRect = scroller.getBoundingClientRect();
    for (const el of Array.from(content.children)) {
      const id = el.getAttribute?.('message-id');
      if (!id) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < listRect.top || rect.top > listRect.bottom) continue;
      tops.set(id, rect.top);
    }
    return tops;
  }

  /**
   * FLIP "Invert + Play": with the new DOM already in its final (instantly
   * relaid-out) position, transform each surviving message back to where it was
   * and start newly-inserted ones slightly faded/offset, then release everything
   * with a transition so the column-reverse jump reads as a glide. Pure
   * transform/opacity — never touches scrollTop, so it composes with the reversed
   * scroller's native bottom pinning.
   * @param {HTMLElement} content - The inner content column.
   * @param {Map<string, number>} beforeTops - Positions captured by _captureItemTops.
   * @private
   */
  _playInsertAnimation(content, beforeTops) {
    const scroller = this.querySelector('#message-list');
    if (!scroller) return;
    const listRect = scroller.getBoundingClientRect();
    /** @type {HTMLElement[]} */
    const touched = [];

    for (const el of Array.from(content.children)) {
      const node = /** @type {HTMLElement} */ (el);
      const id = node.getAttribute?.('message-id');
      if (!id) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < listRect.top || rect.top > listRect.bottom) continue;

      const before = beforeTops.get(id);
      if (before === undefined) {
        // Newly inserted and on-screen: rise + fade in.
        node.style.transition = 'none';
        node.style.opacity = '0';
        node.style.transform = 'translateY(10px)';
        touched.push(node);
      } else {
        const delta = before - rect.top;
        if (Math.abs(delta) < 0.5) continue;
        node.style.transition = 'none';
        node.style.transform = `translateY(${delta}px)`;
        touched.push(node);
      }
    }

    if (touched.length === 0) return;

    // Flush the inverted state, then play it back on the next frame.
    void content.offsetHeight;

    requestAnimationFrame(() => {
      for (const node of touched) {
        node.style.transition = `transform ${INSERT_ANIM_MS}ms ease, opacity ${INSERT_ANIM_MS}ms ease`;
        node.style.transform = '';
        node.style.opacity = '';
        const done = (/** @type {Event} */ e) => {
          if (e.target !== node) return;
          node.style.transition = '';
          node.style.transform = '';
          node.style.opacity = '';
          node.removeEventListener('transitionend', done);
        };
        node.addEventListener('transitionend', done);
      }
    });
  }


  /**
   * Get the conversation footer component
   * @returns {import('./conversation-footer.js').default} The footer component
   * @private
   */
  _getFooter() {
    return /** @type {import('./conversation-footer.js').default} */ (
      this.querySelector('conversation-footer')
    );
  }

  /**
   * Current next steps text for the footer
   * @type {string}
   * @private
   */
  _nextSteps = '';

  /**
   * Whether the Continue button should be visible.
   * Mirrors the runtime guards in MessageThread.continue().
   * @returns {boolean} true if the Continue button should be shown
   * @private
   */
  _canContinue() {
    const mt = this._messageThread;
    if (!mt) return false;
    const hasEffective = mt.getMessages().some(m => isUserMessage(m) || isAssistantMessage(m) || isToolActionMessage(m) || isThreadMessage(m));
    if (!hasEffective) return false;
    // Completed/cancelled threads cannot be continued (use "Reopen" instead)
    if (mt.threadItemId) {
      const result = mt.container.get('result');
      if (result !== null && result !== undefined && result !== '') return false;
    }
    // Don't show Continue while items are busy (tool running, thread pending)
    if (mt.hasBusyItems()) return false;
    return true;
  }

  /**
   * Update the footer based on current conversation state.
   * This is the ONLY method that should modify the footer display.
   * Call this whenever conversation state changes.
   *
   * SINGLE SOURCE OF TRUTH: Status message from LLMState determines isProcessing.
   * If there's a message, we're processing. If not, we're not.
   * This makes it structurally impossible to show a spinner without a message.
   */
  updateFooter() {
    const footer = this._getFooter();

    // Single source for both the footer and any thread-message tiles in this
    // column: the conversation's live LLM status. We resolve it once and use
    // the same `live` object to drive footer copy AND to push into tiles via
    // setLiveStatus — that way the parent tile's status string is literally
    // the same string the sub-thread's footer would render.
    const live = this._snapshotLiveStatus();
    this._broadcastLiveStatusToTiles(live);

    // Footer source 1: LLM status targeting THIS column (so a column whose
    // threadItemId is the active one shows the rich "Streaming • 250 tokens"
    // text; columns whose tiles represent the active thread leave that to
    // the tile face).
    const myThreadId = this._messageThread?.threadItemId || null;
    /** @type {{message: string, spinner: boolean}|null} */
    let llmStatus = null;
    if (live && live.threadId === myThreadId) {
      llmStatus = { message: live.message, spinner: true };
    }

    // Footer source 2: last busy item that wants to be reflected in the
    // footer (tool actions, etc.). Thread-message tiles render themselves
    // and return null here so the footer doesn't double up.
    const itemBusy = this._getLastBusyItemState();

    // LLM status takes priority (most time-sensitive), then item states
    const busyState = llmStatus || itemBusy;

    const hasPendingApprovals = (this._messageThread?.getPendingApprovalMessages().length ?? 0) > 0;
    const canContinue = this._canContinue();
    // While the loop is parked on an approval the worker keeps publishing
    // `processing_tools`, so any busyState here is the LLM loop's idea of
    // "still working" — but the actual blocker is user input. Override the
    // footer text (and drop the spinner) so the status reflects reality.
    const isProcessing = hasPendingApprovals || !!busyState;
    const statusMessage = hasPendingApprovals
      ? StatusMessageBuilder.withBusyMarker('Waiting for user approval')
      : (busyState?.message || '');
    const showSpinner = hasPendingApprovals ? false : (busyState?.spinner ?? true);

    // Close thread is viable only on a sub-thread (root can't be closed) that is
    // open and has content to summarise — same gate as Continue, plus "is a
    // thread". The footer's idle/processing split keeps the button idle-only.
    const showCloseThread = !!this._messageThread?.threadItemId && canContinue;
    // The cheap "Close with last message" close is offered only when the
    // thread's trailing reply is an assistant message (nothing to promote
    // otherwise) — mirrors the worker's selectThreadFallbackResult.
    const showCloseWithLastMessage = showCloseThread
      && !!this._messageThread?.canCloseWithLastMessage;

    // Duplicate tab button lives only on the conversation's root thread
    // (threadItemId null), and only when there's content worth cloning.
    const isRootThread = !this._messageThread?.threadItemId;
    const showDuplicateTab = isRootThread && canContinue;

    footer.update({
      isProcessing,
      canContinue,
      statusMessage,
      showSpinner,
      nextSteps: this._nextSteps,
      showAddContextItem: !this._messageThread?.isClosed,
      showCloseThread,
      showCloseWithLastMessage,
      showDuplicateTab,
      busyItemMessageId: itemBusy?.messageId,
      politePending: !!this._conversation?.isPolitePending?.()
    });
  }

  /**
   * Find the last busy item's state by querying getBusyState() on each conversation-item.
   * The footer has no knowledge of specific item types - it just asks.
   * @returns {{message: string, spinner: boolean, messageId?: string}|null} The last busy item's state, or null if no items are busy
   * @private
   */
  _getLastBusyItemState() {
    /** @type {{message: string, spinner: boolean, messageId?: string}|null} */
    let lastBusy = null;
    for (const el of Array.from(this.querySelectorAll('.conversation-item'))) {
      const state = /** @type {any} */ (el).getBusyState?.();
      if (state) lastBusy = { ...state, messageId: el.getAttribute('message-id') || undefined };
    }
    return lastBusy;
  }

  /**
   * Trigger footer update (called by LLMState when status changes)
   */
  showBusy() {
    // Rule 10: scroll follow target into view (only if near bottom)
    const wasNearBottom = this._isScrolledNearBottom();
    this.updateFooter();
    if (wasNearBottom) {
      this._scrollToFollowIfNeeded();
    }
  }

  /**
   * Trigger footer update (called by LLMState when status changes)
   */
  updateBusyMessage() {
    this.updateFooter();
  }

  /**
   * Trigger footer update and clear next steps (called by LLMState when processing stops)
   */
  hideBusy() {
    this._nextSteps = '';
    this.updateFooter();
  }

  /**
   * Show or hide the next-steps (`<plan>`) indicator for THIS column. The plan
   * is per-thread state: a sub-thread column reads it from its own thread Y.Map
   * (like goal/result/resultSpec), the root column from conversation metadata
   * (root has no Y.Map). So a sub-thread's plan surfaces only on its own
   * column's footer — never on the root or a sibling — and concurrent threads
   * never share one slot.
   * @private
   */
  _refreshNextStepsIndicator() {
    if (!this._conversation) return;
    const plan = this._threadYMap
      ? (this._threadYMap.get('nextSteps') || '')
      : (this._conversation.getMetadata('nextSteps') || '');
    if (plan) {
      this.showNextStepsIndicator(plan);
    } else {
      this.clearNextStepsIndicator();
    }
  }

  /**
   * Show next steps indicator
   * @param {string} text - Next steps text
   */
  showNextStepsIndicator(text) {
    this._nextSteps = text;
    this.updateFooter();
  }

  /**
   * Clear next steps indicator
   */
  clearNextStepsIndicator() {
    this._nextSteps = '';
    this.updateFooter();
  }

}

customElements.define('conversation-area', ConversationArea);
