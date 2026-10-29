//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

import {
  isUserMessage,
  isAssistantMessage,
  isToolActionMessage,
  isThreadMessage,
  isConversationalItemType,
} from '../../sdk/lib/message.js';
import './conversation-footer.js';
import './reply-suggestions-row.js';
import './tool-action-message.js';
import './user-message.js';
import './assistant-message.js';
import './thinking-message.js';
import './context-item-message.js';
import './error-message.js';
import './notice-message.js';
import './thread-message.js';
import './tool-group-message.js';
import { buildDisplayItems, isGroupEntry } from '../utils/item-grouping.js';
import { isToolGroupingEnabled } from '../utils/tool-grouping-pref.js';
import { createIconBadge, createTypeBadge } from '../utils/icon-message-renderer.js';
import { badgeForItem } from '../utils/item-badge.js';
import { SCROLL_TOP_SVG, SCROLL_BOTTOM_SVG, OPEN_IN_FULL_SVG } from '../utils/icons.js';
import { setupColumnResize, startingColumnWidth } from '../utils/column-resize.js';
import {
  hasPendingApprovalInTree,
  hasUnsettledToolInTree,
  runningToolsInTree,
} from '../model/thread-navigation.js';
import { WORKSPACE_ID_KEY, INITIALISED_KEY } from '../model/conversation.js';
import { itemGoal } from '../model/thread-alias.js';
import { liveMessageForThread } from '../utils/thread-display.js';
import { appendDeleteControls } from '../utils/panel-delete-controls.js';
import { findNeighborItemId } from '../services/context-item-utilities.js';
import {
  ensureFooterExists,
  ensureThreadResult,
  removeAllElements,
  buildElementMap,
  identifyElementsToKeep,
  removeDeletedElements,
  positionElements,
  ensurePendingMessages,
  ensureConversationChrome,
  getItemId,
} from './conversation-area-rendering.js';
import { ColumnScroll } from './conversation-area-scroll.js';
import { ColumnSelection } from './conversation-area-selection.js';
import JugglerElement from './juggler-element.js';
import { StatusMessageBuilder } from '../services/status-message-builder.js';
import { guarded } from '../utils/fault-report.js';
import { emptyHintStackMarkup } from './empty-hint-stack.js';
import { isFileDrag, installFileDropGuard, markFileDropAccepted } from '../utils/file-drop.js';
import { ReplySuggestionsController } from '../services/reply-suggestions-controller.js';
import { STARTER_PROMPTS } from '../utils/starter-prompts.js';
import { areReplySuggestionsEnabled, REPLY_SUGGESTIONS_SETTING_EVENT } from '../services/reply-suggestions-setting.js';
import { GUIDANCE_CHANGED_EVENT } from '../services/guidance/nudge-engine.js';
import { COMMAND_MENU_REQUESTED_EVENT } from './juggler-nudge.js';
import { t } from '../../sdk/lib/i18n.js';
import { escapeHtml } from '../../sdk/lib/html.js';

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
 * Air the starting hint needs around its content before it will show at all:
 * a band that can hold the hint only edge-to-edge has no room to teach, and on
 * a small screen the honest layout is none (see _positionEmptyHint).
 */
const EMPTY_HINT_CLEARANCE_PX = 32;

/**
 * The starting hint, laid over the empty background of a conversation with no
 * history yet. The stack inside it is {@link emptyHintStackMarkup}'s, shared
 * with the setup card that carries the same lines while a new conversation is
 * still being asked where it works.
 * @returns {string} The hint's markup.
 */
function emptyHintMarkup() {
  return `
    <conversation-empty-hint class="hidden">
      ${emptyHintStackMarkup()}
    </conversation-empty-hint>
  `;
}

/**
 * The item ids whose own Y.Map fields changed in one observeDeep batch, or
 * null when the batch can't be attributed to specific rows.
 *
 * A streaming token mutates the `content` of exactly one item, but it arrives
 * on a deep observer covering the whole thread container — so without this,
 * every tick of every stream refreshes every row in the transcript and pays
 * two forced layouts per row for the height glide. Narrowing to the changed
 * rows makes that cost proportional to what moved rather than to the length of
 * the conversation.
 *
 * Returns null (meaning "refresh everything", the conservative answer) for an
 * array-level delta, for a target below the item level such as a tool-action's
 * nested `displayData`, and for an empty batch.
 * @param {any[]} events - Yjs observeDeep events.
 * @returns {Set<string>|null} Changed item ids, or null when unknown.
 */
function changedItemIds(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  /** @type {Set<string>} */
  const ids = new Set();
  for (const event of events) {
    if (event?.changes?.delta?.length) return null;
    const id = event?.target?.get?.('itemId');
    if (typeof id !== 'string' || !id) return null;
    ids.add(id);
  }
  return ids;
}

/**
 * Controls that own their own clicks. A click landing on one of these inside a
 * tile is an action on the item — answering a question, retrying, opening a
 * disclosure — not a request to navigate into the item's details, so it never
 * triggers a reveal of the item's child column.
 */
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, summary, [role="button"], [contenteditable="true"]';

/**
 * ConversationArea - one column of a conversation tab: a thread's transcript
 * over its composer.
 *
 * Drawn once, on first connect, and kept: a move or a put-back re-binds the
 * listeners and re-attaches the observers the disconnect released, and leaves
 * the transcript — and the conversation, thread and thread context the tab
 * handed it — exactly as they were. Selection and scrolling are owned by
 * {@link ColumnSelection} and {@link ColumnScroll}; this class holds what
 * neither of them does.
 */
class ConversationArea extends JugglerElement {
  constructor() {
    super();
    /** @type {import('../model/conversation.js').default|null} @private */
    this._conversation = null;
    /** @type {import('../model/message-thread.js').MessageThread|null} @private */
    this._messageThread = null;
    /** @type {*} @private - Thread Y.Map this column represents (null for root). FOR READS AND OBSERVATION ONLY — use messageThread methods for mutations. */
    this._threadYMap = null;
    /** @type {boolean} @private - Set by the first render; a later connect keeps the DOM it drew */
    this._rendered = false;
    /** @type {number} - Position in the tab's column chain, which picks the stored width it takes; set before the column is connected */
    this.columnDepth = 0;
    /** @type {ColumnScroll} @private - Every piece of this column's scroll state */
    this._scroll = new ColumnScroll(this);
    /** @type {ColumnSelection} @private - Which row is selected, by whom, and what auto-selects */
    this._selection = new ColumnSelection(this, this._scroll);
    /** @type {((event: any, transaction: any) => void)|null} @private - Metadata observer for nextSteps, set while the conversation is followed */
    this._metadataObserver = null;
    /** @type {((events: any[]) => void)|null} @private - Deep observer on the thread container, for streaming growth */
    this._streamingScrollObserver = null;
    /** @type {any} @private - The container _streamingScrollObserver is attached to */
    this._observedContainer = null;
    /** @type {((event: any) => void)|null} @private - Yjs observer on thread Y.Map, set while connected */
    this._threadStatusObserver = null;
    /** @type {boolean} @private - True once this column has done its initial bulk render, so later structural inserts/removals animate (FLIP) while the first populate stays instant. */
    this._animationsPrimed = false;
    /** @type {boolean} @private - Reentrancy guard for renderFromItems */
    this._isRendering = false;
    /** @type {ResizeObserver|null} @private - Re-positions the starting hint as the clear band between content and composer changes (see _positionEmptyHint) */
    this._emptyHintObserver = null;
    /** @type {string[]} @private - Suggested replies currently on offer above this column's composer */
    this._replySuggestions = [];
    /** @type {import('../services/reply-suggestions-controller.js').ReplySuggestionsController|null} @private - Decides when to ask the cheap model for those */
    this._replySuggestionsCtl = null;
    /** @type {boolean} @private - True when this column IS a group's contents, so its rows are never re-folded */
    this._isGroupColumn = false;
    /** @type {any[]|null} @private - The folded rows this column shows, when it is a group column (null otherwise) */
    this._groupItems = null;
    /** @type {Map<string, string>} @private - itemId of a folded tool row → display id of the group standing in for it */
    this._memberToGroup = new Map();
    /** @type {import('../model/message-thread.js').MessageThread|null} @private - The thread holding this column's thread item, set by showThreadHeader and left in place when the header hides */
    this._parentMessageThread = null;
    /** @type {(() => void)|null} @private - Unsubscribe from the session feed the workspace banner rides, held alongside the Yjs observers and torn down with them */
    this._unsubscribeSession = null;
  }

  /**
   * Set conversation reference. Its observers are attached while the column is
   * in the document (see _attachConversationObservers); a column handed one
   * while detached follows it from its next connect.
   * @param {import('../model/conversation.js').default|null} conversation
   */
  set conversation(conversation) {
    // Skip if same conversation (avoids tearing down observers on every sync)
    if (conversation === this._conversation) return;

    this._detachConversationObservers();
    this._selection.stopWatching();
    this._conversation = conversation;
    if (this.isConnected) this._attachConversationObservers();
  }

  /**
   * Follow the conversation: its metadata, the session feed the workspace
   * banner rides, the reply-suggestions controller, and — once there is a
   * thread — the thread container's streaming growth. A no-op while already
   * following, so connect and the setter can both call it.
   * @private
   */
  _attachConversationObservers() {
    const conversation = this._conversation;
    if (!conversation || this._metadataObserver) return;

    this._metadataObserver = (/** @type {any} */ event) => {
      // Conversation metadata holds only the ROOT thread's plan; a sub-thread
      // column reads its own plan off its thread Y.Map (see the thread
      // observer in setThreadContext). Refreshing here is harmless for a
      // sub-thread column (it re-reads its own Y.Map, not this key).
      if (event.keysChanged.has('nextSteps')) {
        this._refreshNextStepsIndicator();
      }
      // The binding is written once, when the conversation is initialised —
      // which for a blank tab is its first send, long after this column was
      // built around it. The flag beside it is what decides between the setup
      // panel and the banner, and it moves on the same hop.
      if (event.keysChanged.has(WORKSPACE_ID_KEY) || event.keysChanged.has(INITIALISED_KEY)) {
        this._refreshConversationTop();
      }
      // Selection is local per-column, held by ColumnSelection.
    };
    conversation.observeMetadata(this._metadataObserver);

    // The other half of what the banner reads: the session's workspace table,
    // replaced whole by every `workspaces-changed` broadcast. A binding can
    // become resolvable (a provision finishing) or stop being one (a peer
    // closing the workspace) with nothing in this conversation's doc moving,
    // so the item path would never hear about it.
    const unsubscribe = conversation.session?.subscribe((event) => {
      if (event.type === 'session:workspaces-changed') this._refreshConversationTop();
    });
    this._unsubscribeSession = unsubscribe || null;

    this._getReplySuggestionsController().attach(conversation);

    // Check initial state
    this._refreshNextStepsIndicator();

    // Follow streaming growth if the message thread is already available.
    // Otherwise it starts when setMessageThread() is called.
    if (this._messageThread) this._setupStreamingScrollObserver(conversation);
  }

  /**
   * Stop following the conversation, keeping the reference: a disconnect drops
   * the observers, which hold strong references back to this column, and the
   * next connect takes them up again.
   * @private
   */
  _detachConversationObservers() {
    if (this._conversation && this._metadataObserver) {
      this._conversation.unobserveMetadata(this._metadataObserver);
    }
    this._metadataObserver = null;
    this._unobserveContainer();
    if (this._unsubscribeSession) {
      this._unsubscribeSession();
      this._unsubscribeSession = null;
    }
    if (this._replySuggestionsCtl) this._replySuggestionsCtl.detach();
  }

  /** @private */
  _unobserveContainer() {
    if (this._streamingScrollObserver && this._observedContainer) {
      this._observedContainer.unobserveDeep(this._streamingScrollObserver);
    }
    this._streamingScrollObserver = null;
    this._observedContainer = null;
  }

  /**
   * The reply-suggestions controller for this column, built on first use.
   *
   * Every question it asks is answered from here rather than from inside it,
   * so the rules stay testable without a rendered column. `isLive` is the one
   * worth reading twice: an inactive tab is `display: none`, which is exactly
   * what makes `offsetParent` null, and the window checks stop a background
   * window's columns all asking at once when a batch of turns lands.
   * @returns {import('../services/reply-suggestions-controller.js').ReplySuggestionsController} The controller.
   * @private
   */
  _getReplySuggestionsController() {
    if (!this._replySuggestionsCtl) {
      this._replySuggestionsCtl = new ReplySuggestionsController({
        getItems: () => this._messageThread?.items || [],
        getDraft: () => /** @type {any} */ (this.composer)?.getText?.() || '',
        isLive: () => !document.hidden && document.hasFocus() && this.offsetParent !== null,
        // A group column is a lens on a folded run of tool rows, sharing the
        // thread of the column to its left and carrying no composer of its own.
        // There is nowhere for a suggestion to go, so there is nothing to buy.
        isOffered: () => !this._isGroupColumn,
        onChange: (/** @type {string[]} */ suggestions) => {
          this._replySuggestions = suggestions;
          this.updateFooter();
        },
      });
    }
    return this._replySuggestionsCtl;
  }

  /**
   * Set the message thread for this column.
   * @param {import('../model/message-thread.js').MessageThread} messageThread
   */
  setMessageThread(messageThread) {
    const containerChanged = this._observedContainer !== messageThread?.container;
    this._messageThread = messageThread;
    // Mode before thread: a group column's footer must know it shows no token
    // meter before it is handed a thread to fetch one for.
    /** @type {any} */ (this._getFooter()).setStatusOnly(this._isGroupColumn);
    /** @type {any} */ (this._getFooter()).setMessageThread(messageThread);

    // Re-target the streaming observer whenever the thread's container changes.
    // Columns are reused across thread navigations (the same conversation-area
    // element is repurposed for a different sub-thread), and without this
    // retarget the observer would stay attached to the previous container and
    // miss streaming chunks on the new one. Only while the conversation is
    // being followed: otherwise the next attach observes the new container.
    if (this._metadataObserver && this._conversation && containerChanged) {
      this._unobserveContainer();
      if (messageThread) this._setupStreamingScrollObserver(this._conversation);
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
   * Make this column a group column listing `items`, or (null) an ordinary
   * column listing its thread. A group column shows a folded run of tool rows
   * and never re-folds them: the user opened it to see the rows.
   *
   * Call it before {@link setMessageThread}, which configures the footer from
   * it: a group column's footer shows no thread-level controls or token meter.
   * @param {any[]|null} items - The folded rows, or null for a thread column.
   */
  setGroupItems(items) {
    this._isGroupColumn = items !== null;
    this._groupItems = items;
  }

  /** @returns {boolean} True when this column lists a group's rows rather than a thread. */
  get isGroupColumn() {
    return this._isGroupColumn;
  }

  /**
   * The rows this column lists: a group column's folded rows, otherwise its
   * thread's items. A group column shares its thread with the column to its
   * left, so the thread's items are NOT what it shows.
   * @returns {any[]} The listed rows (empty before a thread is set).
   */
  get listedItems() {
    return this._isGroupColumn
      ? (this._groupItems ?? [])
      : (this._messageThread?.items ?? []);
  }

  /**
   * Record which item is selected without applying it: no event, no highlight,
   * no scroll. The owning tab calls this while it rebuilds the columns, before
   * {@link renderFromItems}, so that the render finds the selection it is about
   * to show. A stale id left over from a thread this column showed before would
   * otherwise make the render clear the selection, and that path re-enters the
   * rebuild. {@link applySelectedClass} applies it once the render is done.
   * @param {string|null} itemId - The selected item, or null for none.
   */
  presetSelectedItemId(itemId) {
    this._selection.preset(itemId);
  }

  /**
   * Who made the current selection: 'user' while the reader holds it (rule 4),
   * 'auto' for one this column made itself, null for none.
   * @returns {'user'|'auto'|null} The selection's origin.
   */
  get selectionOrigin() {
    return this._selection.origin;
  }

  /**
   * The thread holding this column's thread item, which is where that item is
   * deleted from. Set by {@link showThreadHeader}, so it is only meaningful
   * while the header shows: hiding the header leaves the last one in place.
   * @returns {import('../model/message-thread.js').MessageThread|null} The parent thread.
   */
  get parentMessageThread() {
    return this._parentMessageThread;
  }

  /**
   * Set the thread context for this column.
   * @param {*} threadYMap - The thread Y.Map, or null for root column behavior
   */
  setThreadContext(threadYMap) {
    if (threadYMap !== this._threadYMap) {
      // A different thread context means a fresh bulk populate — don't FLIP it in.
      this._animationsPrimed = false;
      // A column pointed at a sub-thread owes it a landing (rule 12).
      this._scroll.pointAt(!!threadYMap);
    }

    this._unobserveThreadContext();
    this._threadYMap = threadYMap;
    if (this.isConnected) this._observeThreadContext();

    // Re-evaluate the plan indicator for this column's (possibly new) thread:
    // columns are reused across thread navigations, and root vs sub-thread read
    // the plan from different sources.
    this._refreshNextStepsIndicator();
  }

  /**
   * The thread Y.Map this column represents, or null for the root (and for a
   * group column). For reads only — mutations go through the message thread.
   * @returns {*} The thread Y.Map, or null.
   */
  get threadYMap() {
    return this._threadYMap;
  }

  /**
   * Observe the thread Y.Map for header button visibility AND this thread's own
   * `nextSteps` (<plan>) — both are per-thread state on this Y.Map. A no-op for
   * the root, and while already observing.
   * @private
   */
  _observeThreadContext() {
    const threadYMap = this._threadYMap;
    if (!threadYMap || this._threadStatusObserver) return;
    // Guarded before registering, and stored guarded so unobserve still
    // matches: Yjs calls this mid-transaction, so a throw here would abandon
    // the observers queued behind it rather than reaching a caller.
    this._threadStatusObserver = guarded('conversation-area:thread-status', () => {
      this._refreshThreadFooter(threadYMap);
      this._refreshNextStepsIndicator();
    });
    threadYMap.observe(this._threadStatusObserver);
  }

  /** @private */
  _unobserveThreadContext() {
    if (this._threadStatusObserver && this._threadYMap) {
      this._threadYMap.unobserve(this._threadStatusObserver);
    }
    this._threadStatusObserver = null;
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
      // above up without nudging the footer. Off the bottom the footer is not
      // the fixed edge, so the glide has nothing to smooth against and the
      // growth simply lands. Either way this handler issues no catch-up scroll
      // — see the note at the end of it.
      const pinned = !!scroller && Math.abs(scroller.scrollTop) <= 1;
      const animate = pinned && !structural && !prefersReducedMotion();
      // Whether there is a reader's place to hold is rule 11's question, not the
      // glide's: anywhere inside the near-bottom band the reader is following
      // the end, and native column-reverse pinning is already doing exactly what
      // they want. Holding their place there would fight it — every batch's
      // growth would be measured as drift and undone, walking the view backwards
      // out of the band one relayout at a time until the anchor locks it there.
      // Testing that with `pinned` puts any reader a stray pixel off the bottom
      // on the wrong side of it, and disagrees with ColumnScroll.recordAnchor, which
      // keeps no anchor in the band at all — so the two anchor paths would hold
      // a place only one of them believes in.
      const nearEnd = this._scroll.isFollowingEnd();

      // Only the rows this batch actually touched can have grown, and measuring
      // a row costs a forced layout — so never measure the whole transcript on
      // the strength of one streaming token.
      const changed = changedItemIds(events);
      const growEls = animate
        ? Array.from(scroller.querySelectorAll('assistant-message, thinking-message, thread-message'))
          .filter((el) => !changed || changed.has(el.getAttribute('message-id') || ''))
        : [];
      // Capture each streamable element's CURRENT visual height (which, mid-glide,
      // is its in-flight animated height) before the content update lands.
      const fromHeights = growEls.map((el) => /** @type {HTMLElement} */ (el).offsetHeight);

      // Hold the reader's place across this mutation (see ColumnScroll.holdAnchorOver).
      // Near the end we don't: native column-reverse anchoring keeps the newest
      // text in view, and the height glide below smooths it. Auto-follow of new
      // items / approvals comes from onItemsInserted, never from here.
      this._scroll.holdAnchorOver(() => {
        this._notifyChangedElements(events, conversation, changed);

        growEls.forEach((el, i) => {
          this._animateStreamingResize(/** @type {HTMLElement} */ (el), fromHeights[i] ?? 0);
        });
      }, { skip: nearEnd });
    };
    const container = /** @type {import('../model/message-thread.js').MessageThread} */ (this._messageThread).container;
    this._observedContainer = container;
    this._streamingScrollObserver = guarded(
      'conversation-area:streaming-scroll', this._streamingScrollObserver);
    container.observeDeep(this._streamingScrollObserver);
  }

  /**
   * Apply the tool-grouping display transform to this column's items.
   *
   * Display-only: the returned entries are the same Y.Maps, with each run of
   * adjacent tool rows standing behind one group entry. A column that IS a
   * group's contents never re-folds (that would hide what the user just opened).
   * The member → group lookup is cached because selection, visibility and
   * scrolling all have to speak in the ids that are actually in the DOM.
   * @param {any[]} items - The column's items, in document order.
   * @returns {{entries: any[], memberToGroup: Map<string, string>}} Display entries + lookup.
   * @private
   */
  _computeDisplay(items) {
    const enabled = !this._isGroupColumn && isToolGroupingEnabled();
    const display = buildDisplayItems(items, { enabled });
    this._memberToGroup = display.memberToGroup;
    return display;
  }

  /**
   * The id this column actually renders for an item: a folded tool row is
   * represented by its group, everything else by itself. Every selection,
   * visibility and scroll path funnels through here, so the rest of the
   * selection machinery keeps working in document itemIds and lands on the
   * right row either way.
   * @param {string|null|undefined} itemId - A document itemId (or a display id already).
   * @returns {string} The id present in this column's DOM.
   */
  displayIdFor(itemId) {
    if (!itemId) return '';
    return this._memberToGroup.get(itemId) || itemId;
  }

  /**
   * Notify message elements when their items change.
   * Builds a Map of items for O(1) lookup, then iterates streamable elements once.
   * Total complexity: O(N) where N = number of items.
   * @param {any[]} events - Array of Yjs events from observeDeep
   * @param {import('../model/conversation.js').default} _conversation
   * @param {Set<string>|null} [changed] - Item ids this batch touched, from
   *   changedItemIds(). Rows outside the set are left alone; null refreshes all.
   * @private
   */
  _notifyChangedElements(events, _conversation, changed = null) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;

    // observeDeep passes an array of Y.Event objects (one per nesting level).
    // Content updates within a Y.Map item won't have a top-level array delta,
    // so we just check that we received any events at all.
    if (!events || (Array.isArray(events) && events.length === 0)) return;

    // Build Map of itemId -> item for O(1) lookup, holding only the items whose
    // rows are going to be refreshed below.
    const items = this._messageThread ? this._messageThread.items : [];
    /** @type {Map<string, any>} */
    const itemMap = new Map();
    for (const item of items) {
      const msg = /** @type {any} */ (item);
      const id = msg && msg.get('itemId');
      if (!id) continue;
      if (changed && !changed.has(id)) continue;
      itemMap.set(id, msg);
    }

    // Notify all streamable message elements with their current item data
    // Elements that support streaming (assistant, thinking) implement updateFromItem()
    const streamableElements = Array.from(messageList.querySelectorAll('assistant-message, thinking-message, thread-message'));
    const live = this.snapshotLiveStatus();
    for (const element of streamableElements) {
      const itemId = element.getAttribute('message-id');
      if (!itemId) continue;
      if (changed && !changed.has(itemId)) continue;

      const item = itemMap.get(itemId);
      if (item) {
        if (element.tagName === 'THREAD-MESSAGE') {
          /** @type {any} */ (element).updateFromItem?.(item, live);
        } else {
          /** @type {any} */ (element).updateFromItem?.(item);
        }
      }
    }

    // Group tiles read the aggregate state of the rows they hide (a member
    // going pending must turn the tile orange), so they're refreshed from the
    // re-derived groups rather than from itemMap.
    // A group tile stands for rows that are not in the DOM, so it can't be
    // matched by message-id like the streamables above; skip the transform
    // entirely unless this batch touched an item some group is standing for.
    const groupElements = Array.from(messageList.querySelectorAll('tool-group-message'));
    const groupsAffected = !changed
      || [...changed].some((id) => this._memberToGroup.has(id));
    if (groupElements.length > 0 && groupsAffected) {
      const { entries } = this._computeDisplay(items);
      /** @type {Map<string, any>} */
      const groupMap = new Map();
      for (const entry of entries) {
        if (isGroupEntry(entry)) groupMap.set(entry.get('itemId'), entry);
      }
      for (const element of groupElements) {
        const group = groupMap.get(element.getAttribute('message-id') || '');
        if (group) /** @type {any} */ (element).updateFromItem?.(group, live);
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
   * Re-render the block at the top of the transcript alone — the workspace
   * banner this conversation is owed.
   *
   * Its inputs all change without an item changing: the binding is written once
   * and the workspace table is replaced by a broadcast. Neither would reach the
   * transcript on the item path. Cheap enough to call on
   * every edge: both helpers rewrite nothing when the answer has not moved.
   * @private
   */
  _refreshConversationTop() {
    const content = /** @type {HTMLElement|null} */ (this.querySelector('#message-list-inner'));
    if (content) ensureConversationChrome(this, content);
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
   * Snapshot every running thread's live LLM status the same way the footer
   * reads it. A thread mirrors the message filed under its own `itemId`, so a
   * parent and its read-only children each report their own work. The
   * rendering helpers ask it too, when they build a tile that shows it.
   * @returns {import('../utils/thread-display.js').ThreadLiveStatus|null} Live status snapshot, or null when nothing is running.
   */
  snapshotLiveStatus() {
    const conv = this._conversation;
    const llmState = conv?.llmState;
    if (!llmState || !conv?.id) return null;
    const byThread = llmState.getLiveThreadMessages(conv.id);
    if (Object.keys(byThread).length === 0) return null;
    return { byThread };
  }

  /**
   * Push a live LLM status snapshot to every self-rendering status tile in this
   * column (sub-threads and folded tool groups). Called from updateFooter so the
   * tile face and the footer always derive from the same snapshot in the same
   * code path.
   * @param {import('../utils/thread-display.js').ThreadLiveStatus|null} live
   * @private
   */
  _broadcastLiveStatusToTiles(live) {
    const messageList = this.querySelector('#message-list');
    if (!messageList) return;
    for (const el of Array.from(messageList.querySelectorAll('thread-message, tool-group-message'))) {
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
    // Drawn once. A later connect — a move, or a put-back — keeps the transcript
    // and the composer (with whatever is typed in it), and takes up again the
    // listeners and observers the disconnect released.
    if (!this._rendered) this.render();
    this._bindListeners();
    this._scroll.attach();
    this._attachConversationObservers();
    this._observeThreadContext();
    // A starting hint already on show lost the observer that keeps it fitted.
    const hint = this.querySelector('conversation-empty-hint');
    if (hint && !hint.classList.contains('hidden')) this._positionEmptyHint();
  }

  /**
   * The tip or starter-prompt switch in Settings › Defaults moved: re-offer
   * the suggestions row, and re-fit a starting hint that is on show, whose
   * stack just changed height.
   * @private
   */
  _handleNewConversationHintChanged() {
    if (!this._messageThread) return;
    this.updateFooter();
    const hint = this.querySelector('conversation-empty-hint');
    if (hint && !hint.classList.contains('hidden')) this._positionEmptyHint();
  }

  disconnectedCallback() {
    // Every listener, the scroll controller's observers, frame and timer.
    super.disconnectedCallback();
    // The Yjs observers hold strong references back to `this`, so leaving them
    // attached would keep the element (and its captured Conversation) alive.
    // The references themselves stay: a column put back follows them again.
    this._detachConversationObservers();
    this._unobserveThreadContext();
    this._selection.stopWatching();
    this._teardownEmptyHintObserver();
  }

  get composer() {
    return this.querySelector('composer-box');
  }

  /**
   * The suggested-replies row, which sits between the transcript and the
   * composer it writes into.
   * @returns {import('./reply-suggestions-row.js').default|null} The row, or null before render().
   */
  get suggestionsRow() {
    return /** @type {import('./reply-suggestions-row.js').default|null} */ (
      this.querySelector('reply-suggestions')
    );
  }

  /**
   * Draw the column. Runs once, on first connect (or earlier, when a test draws
   * an unconnected column); every listener on what it draws is bound per
   * connection, by _bindListeners.
   */
  render() {
    this._rendered = true;
    // Any observer from a previous DOM is now watching detached nodes; the
    // next _positionEmptyHint re-attaches to the elements this render builds.
    this._teardownEmptyHintObserver();
    this.innerHTML = `
      <header class="thread-column-header hidden">
        <properties-panel-section>
          <header class="properties-panel-header">
            <thread-column-icon-box></thread-column-icon-box>
            <h3 class="properties-panel-title thread-column-goal"></h3>
          </header>
        </properties-panel-section>
      </header>
      <conversation-message-list-wrapper>
        <section class="conversation-message-list u-scrollbar-thin" id="message-list">
          <div class="conversation-message-list-inner" id="message-list-inner">
            <thread-column-actions class="hidden">
              <button class="properties-panel-btn thread-expand-btn" title="${escapeHtml(t('Expand this thread back into the parent'))}">
                ${OPEN_IN_FULL_SVG}
                ${escapeHtml(t('Expand into parent'))}
              </button>
              <button class="properties-panel-btn thread-copy-tab-btn" title="${escapeHtml(t('Copy this thread (with inherited context) to a new conversation'))}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M440-160v-326L336-382l-56-58 200-200 200 200-56 58-104-104v326h-80ZM160-600v-120q0-33 23.5-56.5T240-800h480q33 0 56.5 23.5T800-720v120h-80v-120H240v120h-80Z"/></svg>
                ${escapeHtml(t('Copy thread to new conversation'))}
              </button>
            </thread-column-actions>
            <conversation-footer></conversation-footer>
          </div>
        </section>
        ${emptyHintMarkup()}
        <div class="scroll-controls" id="scroll-controls">
          <button type="button" class="scroll-control-btn hidden" data-scroll="top" title="${escapeHtml(t('Scroll to top'))}" aria-label="${escapeHtml(t('Scroll to top'))}">${SCROLL_TOP_SVG}</button>
          <button type="button" class="scroll-control-btn hidden" data-scroll="bottom" title="${escapeHtml(t('Scroll to bottom'))}" aria-label="${escapeHtml(t('Scroll to bottom'))}">${SCROLL_BOTTOM_SVG}</button>
        </div>
      </conversation-message-list-wrapper>
      <reply-suggestions></reply-suggestions>
      <composer-box id="composer-box"></composer-box>
      <col-resize-handle></col-resize-handle>
    `;

    // A window with no persisted width starts as wide as it can while still
    // leaving a properties panel room to open beside it (startingColumnWidth).
    // The width is this column's depth's, not every conversation column's.
    // Its listeners live on the handle this render drew, and go with it.
    setupColumnResize(this, 'juggler-column-width', undefined, startingColumnWidth(), this.columnDepth);
  }

  /**
   * Where ⌘F searches in a conversation column: the message list, with the bar
   * floating in the positioned wrapper above it so it does not become a
   * scrolling child of the list, and focus returning to the composer on close —
   * a find is nearly always a detour on the way to typing.
   * @returns {import('./find-bar.js').FindTarget|null} The find descriptor, or null before render.
   */
  getFindTarget() {
    const root = this.querySelector('#message-list');
    if (!root) return null;
    return {
      root,
      mount: /** @type {HTMLElement} */ (
        this.querySelector('conversation-message-list-wrapper') || this
      ),
      label: t('Find in conversation'),
      restoreFocus: () => {
        const textarea = /** @type {HTMLElement|null} */ (
          this.querySelector('composer-box textarea')
        );
        if (textarea) textarea.focus();
        else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      },
    };
  }

  /**
   * Show thread column header with goal, status badge, and action buttons
   * @param {string} goal - The thread's goal text
   * @param {*} threadYMap - The thread Y.Map for return operations
   * @param {import('../model/message-thread.js').default} [parentMessageThread] - The parent message thread where the thread item lives
   * @param {string} [viewItemId] - The parent item this column was opened through
   */
  showThreadHeader(goal, threadYMap, parentMessageThread, viewItemId) {
    this._parentMessageThread = parentMessageThread || null;
    const displayGoal = itemGoal(threadYMap) || goal;

    const header = this.querySelector('.thread-column-header');
    if (!header) return;

    header.classList.remove('hidden');
    const actionsEl = /** @type {HTMLElement|null} */ (this.querySelector('thread-column-actions'));
    actionsEl?.classList.remove('hidden');
    const goalEl = header.querySelector('.thread-column-goal');
    if (goalEl) goalEl.textContent = displayGoal;

    // Circular icon + "Thread" lozenge from the one shared badge resolver and
    // component — the identical .message-icon-badge the conversation tile and
    // properties-panel header render, so every thread badge stays in lockstep.
    const iconPlaceholder = header.querySelector('thread-column-icon-box');
    if (iconPlaceholder) {
      const badge = badgeForItem(threadYMap, { fallbackType: 'thread' });
      iconPlaceholder.replaceWith(createIconBadge(badge, createTypeBadge(badge.typeName)));
    }

    // Update status badge
    this._refreshThreadFooter(threadYMap);

    // Expand: splice this thread's items back into the parent and drop the tile.
    // Clone to clear listeners from a prior show.
    const expandBtn = actionsEl?.querySelector('.thread-expand-btn');
    if (expandBtn) {
      const newExpandBtn = expandBtn.cloneNode(true);
      expandBtn.parentNode?.replaceChild(newExpandBtn, expandBtn);
      const tid = threadYMap.get('itemId');
      newExpandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!tid) return;
        this.dispatchEvent(new CustomEvent('expand-thread-requested', {
          detail: { threadItemId: tid },
          bubbles: true,
          composed: true
        }));
      });
    }

    // Wire up Copy to new conversation — the promote-thread-requested event
    // (conversation-tab handles it via promoteThreadToNewTab). Clone to clear
    // listeners from a prior show.
    const copyTabBtn = actionsEl?.querySelector('.thread-copy-tab-btn');
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
    actionsEl?.querySelectorAll('.properties-panel-btn.danger').forEach(b => b.remove());

    // Delete acts on the tile the user opened this column through, which for a
    // thread called more than once is one of several views of the same
    // transcript. Targeting the canonical the column resolves to would delete a
    // different item than the one that was clicked.
    const threadItemId = viewItemId || threadYMap.get('itemId');
    const parentThread = this._parentMessageThread;
    if (actionsEl && parentThread && threadItemId) {
      const idx = parentThread.findIndexByItemId(threadItemId);
      if (idx >= 0) {
        appendDeleteControls(actionsEl, parentThread, threadItemId, () => {
          const clickIdx = parentThread.findIndexByItemId(threadItemId);
          if (clickIdx < 0) return;
          const neighborId = findNeighborItemId(parentThread.items, clickIdx, parentThread);
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
   * Refresh this thread column's footer after a change to its thread Y.Map.
   *
   * The composer is deliberately untouched: a thread is running or stopped, and
   * a stopped thread accepts a message either way. Whether a column shows a box
   * at all is the tab's business (it alone knows the full column chain),
   * expressed through the CSS `conversation-area[data-hide-input] composer-box`
   * rule, so nothing here may force an inline display value that would fight it.
   * @param {*} threadYMap
   * @private
   */
  _refreshThreadFooter(threadYMap) {
    if (!threadYMap) return;
    this.updateFooter();
  }

  /**
   * Hide thread column header
   */
  hideThreadHeader() {
    const header = this.querySelector('.thread-column-header');
    if (header) header.classList.add('hidden');
    this.querySelector('thread-column-actions')?.classList.add('hidden');
  }

  /**
   * The composer a file dropped on this column belongs to, or null when the
   * column has nowhere to put one — a group column hides its input, and a
   * column mid-render has yet to build one.
   * @returns {any|null} The column's composer, if it can take a file.
   * @private
   */
  _dropTargetComposer() {
    if (this.hasAttribute('data-hide-input')) return null;
    const composer = /** @type {any} */ (this.composer);
    return typeof composer?.acceptDroppedFiles === 'function' ? composer : null;
  }

  /**
   * Bind every listener the column needs, for the length of one connection:
   * each goes through JugglerElement's helpers, so the disconnect releases the
   * set and the next connect binds a fresh one — however many times the column
   * is moved, it hears each event once.
   * @private
   */
  _bindListeners() {
    this._bindSuggestionDrafting();
    this._bindFileDrop();
    this._bindTranscriptClicks();
    this.on(this, 'select-item-requested', (e) => {
      const { messageId } = /** @type {CustomEvent} */ (e).detail;
      if (messageId) this._selectItem(messageId, 'user');
    });
    // A hint (components/juggler-nudge.js) asking for the command menu.
    this.on(this, COMMAND_MENU_REQUESTED_EVENT, (e) => {
      e.stopPropagation();
      /** @type {any} */ (this.composer)?.openCommandMenu?.();
    });
    // The tips switch in Settings › Appearance, or the starter-prompt switch.
    const hintChanged = () => this._handleNewConversationHintChanged();
    this.onWindow(REPLY_SUGGESTIONS_SETTING_EVENT, hintChanged);
    this.onWindow(GUIDANCE_CHANGED_EVENT, hintChanged);
  }

  /**
   * A suggestion is DRAFTED, never sent: the words go into the composer with
   * the caret after them, so nothing is ever sent that the user did not read,
   * and the first click teaches the whole feature without an explainer. And
   * their own words beat ours the moment there are any.
   * @private
   */
  _bindSuggestionDrafting() {
    this.on(this, 'reply-suggestion-chosen', (/** @type {any} */ e) => {
      e.stopPropagation();
      /** @type {any} */ (this.composer)?.setDraft?.(e.detail?.text || '');
      this._replySuggestionsCtl?.notifyTyping();
    });
    this.on(this, 'input', (/** @type {Event} */ e) => {
      if (/** @type {HTMLElement} */ (e.target)?.tagName === 'TEXTAREA') {
        this._replySuggestionsCtl?.notifyTyping();
      }
    });
  }

  /**
   * Make the whole column a drop zone, not just its composer.
   *
   * A file dropped on a conversation is meant for the message being written
   * there, and aiming for the box is fiddly when the transcript fills the
   * window — so the column takes the drop anywhere and hands it to its own
   * composer, which is what makes a drop on a thread column attach to THAT
   * thread. The box keeps its own handlers (they run first, and this one stands
   * down when they have taken the drop); what this adds is the rest of the
   * column's area.
   * @private
   */
  _bindFileDrop() {
    installFileDropGuard();

    this.on(this, 'dragover', (e) => {
      if (!isFileDrag(/** @type {DragEvent} */ (e).dataTransfer)) return;
      if (!this._dropTargetComposer()) return;
      e.preventDefault();
      markFileDropAccepted(e);
      this.classList.add('file-drag-over');
    });

    this.on(this, 'dragleave', (e) => {
      // dragleave also fires for every crossing between the column's own
      // children; the element being entered tells the two apart.
      const entering = /** @type {DragEvent} */ (e).relatedTarget;
      if (entering instanceof Node && this.contains(entering)) return;
      this.classList.remove('file-drag-over');
    });

    this.on(this, 'drop', (e) => {
      this.classList.remove('file-drag-over');
      // The composer's own handler cancels the drop it has taken, and it has
      // already run by the time this does.
      if (e.defaultPrevented) return;
      const composer = this._dropTargetComposer();
      if (composer?.acceptDroppedFiles(/** @type {DragEvent} */ (e).dataTransfer)) {
        e.preventDefault();
      }
    });
  }

  /**
   * Clicks in the transcript: selecting a row, clearing the selection from the
   * background, and telling either apart from an action on a row's own
   * controls.
   * @private
   */
  _bindTranscriptClicks() {
    const wrapper = this.querySelector('conversation-message-list-wrapper');
    const composer = this.querySelector('#composer-box');
    if (!wrapper || !composer) return;

    // Where the last pointer press began, and what the click being handled
    // turned out to be — read by the bubble-phase handler below.
    let mousedownInApproval = false;
    let mousedownOnControl = false;
    let clickIsApprovalAction = false;
    let clickOnControl = false;

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
    this.on(wrapper, 'mousedown', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      mousedownInApproval = !!target?.closest?.('action-confirmation');
      mousedownOnControl = !!target?.closest?.(INTERACTIVE_SELECTOR);
    }, true);

    this.on(wrapper, 'click', (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      // The press location is authoritative: a click whose target shifted off
      // the button onto a neighbour after a layout move is still an approval
      // action, not navigation.
      const insideApproval = !!target.closest?.('action-confirmation') || mousedownInApproval;
      clickIsApprovalAction = insideApproval;
      // Same press-location reasoning for controls that live outside an
      // approval widget — an extension's custom form (the question options),
      // a retry button, a link. Decided here, while the DOM the press landed
      // on is still intact, and consumed by the bubble handler below.
      clickOnControl = !!target.closest?.(INTERACTIVE_SELECTOR) || mousedownOnControl;
      mousedownInApproval = false;
      mousedownOnControl = false;
      // Approving / denying is an act of "advance, I'm done with this
      // item", not navigation. Clear the user-origin pin so rule 2b can
      // hand selection to the next pending approval. Otherwise users
      // who clicked to select an item before approving would see
      // selection stay glued to the now-completed item.
      if (insideApproval && this._selection.origin === 'user') {
        this._selection.releasePin();
      }
    }, true);

    // Click handling for item selection. Listener lives on the wrapper (not
    // the inner #message-list) so background clicks that miss the list —
    // e.g. the scrollbar-gap margin, list padding, footer whitespace — still
    // count as "click on the background of the column" and deselect.
    this.on(wrapper, 'click', (e) => {
      const wasApprovalAction = clickIsApprovalAction;
      const onControl = clickOnControl;
      clickIsApprovalAction = false;
      clickOnControl = false;
      if (wasApprovalAction) return;

      const target = /** @type {HTMLElement} */ (e.target);

      // Check if user has selected any text
      const textSelection = window.getSelection();
      if (textSelection && textSelection.toString().length > 0) {
        // User is selecting text, don't steal focus or select
        return;
      }

      // Check if clicked on a selectable item (any message element)
      const selectableItem = target.closest(
        'user-message, assistant-message, thinking-message, context-item-message, ' +
        'error-message, notice-message, tool-action-message, thread-message, tool-group-message'
      );
      if (selectableItem) {
        const itemId = selectableItem.getAttribute('message-id');
        if (itemId) {
          if (this._selection.selectedId === itemId) {
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
            if (!isProse && !onControl) {
              this._selection.dispatchItemSelected(itemId, 'user', true);
            }
            return;
          }
          // A click on a control inside an unselected tile still selects it —
          // the action belongs to that item — but it is not a request to see
          // the item's details, so it must not reveal the child column. Same
          // rule as the repeat click above: without it, answering a question
          // on a narrow viewport pages the columns away mid-answer. Nor does
          // any click scroll the column: the row is already under the pointer.
          this._selectItem(itemId, 'user', { allowReveal: !onControl, scroll: false });
          // Move focus out of textarea so keyboard navigation works
          if (document.activeElement?.tagName === 'TEXTAREA') {
            /** @type {HTMLElement} */ (document.activeElement).blur();
          }
          // A click on a link selects the item AND follows the link: the
          // app's link safety net is a delegated handler on document, so
          // stopping propagation here would leave the anchor to its default
          // same-window navigation — off the app's page, with no way back.
          if (!target.closest?.('a[href]')) {
            e.stopPropagation();
          }
          return;
        }
      }

      // A control that belongs to the column rather than to an item — the
      // setup card's fields and rows, the workspace banner — is not the
      // background, and owns its click. The press has already put the caret
      // where the user aimed it, so treating this as a background click would
      // take the keyboard straight back out of the field they clicked into.
      if (onControl) return;

      // Clicked on the background — deselect any current item in this column,
      // then focus the input so the next keystroke starts composing.
      this._selection.clear();
      const textarea = composer.querySelector('textarea');
      if (textarea) {
        textarea.focus();
      }
    });

    // Rule B: focusing the prompt textarea re-arms auto-follow. The user is
    // composing the next turn, not inspecting a pinned item. Use delegated
    // focusin so we survive any re-creation of the textarea inside composer-box.
    this.on(composer, 'focusin', (e) => {
      const focused = /** @type {HTMLElement} */ (e.target);
      if (focused && focused.tagName === 'TEXTAREA') this._selection.releasePin();
    });
  }

  // --- Public API for keyboard navigation (called by conversation-tab) ---

  /** Select the next item in the list */
  selectNextItem() {
    this._selection.selectNext();
  }

  /** Select the previous item in the list */
  selectPreviousItem() {
    this._selection.selectPrevious();
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
    this._selection.clear();
  }

  /** @returns {string[]} List of selectable item IDs */
  getSelectableItemIds() {
    return this._selection.selectableIds();
  }

  /** @returns {string|null} Currently selected item ID */
  getSelectedItemId() {
    return this._selection.selectedId;
  }

  /** @returns {HTMLElement|null} The currently selected item's DOM element */
  getSelectedElement() {
    const selectedId = this._selection.selectedId;
    if (!selectedId) return null;
    return this.querySelector(`[message-id="${selectedId}"]`);
  }

  /**
   * Whether the selected row opens a column of its own: a sub-thread, or a
   * folded group of tool rows. Both are containers the user drills into, so
   * arrow-right treats them identically.
   * @returns {boolean} True if the selected item can be navigated into
   */
  isSelectedItemDrillable() {
    const selectedId = this._selection.selectedId;
    if (!selectedId) return false;
    const el = this.querySelector(
      `thread-message[message-id="${selectedId}"], ` +
      `tool-group-message[message-id="${selectedId}"]`
    );
    return el !== null;
  }

  // ── Selection & scrolling ────────────────────────────────────────
  //
  // Both engines live in companion modules, each a class owning its own state:
  // the selection rules (1-5b) in ColumnSelection
  // (conversation-area-selection.js), the scroll rules (6-12) and the reader
  // anchor in ColumnScroll (conversation-area-scroll.js). The UX rules they
  // implement, and why each scroll is clamped scrollTop math rather than
  // scrollIntoView, are written up in those two module docs. What stays here
  // are the entry points other files call.
  //
  // Neither engine touches this class's private fields: they read the column
  // through its public surface, and the owning tab drives a column through the
  // methods and accessors declared public here — the type checker holds it to
  // that (`@private` is enforced on the column the tab holds).
  // ────────────────────────────────────────────────────────────────

  /**
   * Handle newly inserted items — auto-select the best candidate.
   * Called by conversation-tab when conversation:changed carries insertedItemIds.
   * @param {string[]} insertedItemIds
   * @param {Array<any>} items - Current full items array
   */
  onItemsInserted(insertedItemIds, items) {
    this._selection.onItemsInserted(insertedItemIds, items);
  }

  /**
   * Rule 2b: the itemId of the pending-approval item that should become the
   * next auto-selection, or null. Called by conversation-tab.
   * @returns {string|null} itemId to auto-select, or null
   */
  getNextPendingApprovalToSelect() {
    return this._selection.nextPendingApproval();
  }

  /**
   * @param {string} itemId
   * @param {'user'|'auto'} [origin='user']
   * @param {{allowReveal?: boolean, scroll?: boolean}} [opts]
   * @private
   */
  _selectItem(itemId, origin = 'user', opts = {}) {
    this._selection.select(itemId, origin, opts);
  }

  /**
   * Highlight `selectedId` as this column's selected row. The tab calls it
   * after a rebuild, once {@link presetSelectedItemId}'s selection has rendered.
   * @param {string|null} selectedId
   */
  applySelectedClass(selectedId) {
    this._selection.applyClass(selectedId);
  }

  /**
   * @param {string} itemId
   * @param {{smooth?: boolean, automatic?: boolean}} [opts] - See
   *   ColumnScroll.itemIntoView.
   */
  scrollItemIntoView(itemId, opts = {}) {
    this._scroll.itemIntoView(itemId, opts);
  }

  /**
   * Rule 11's test, read from outside: is this column following the end of the
   * conversation, or has its reader scrolled away? conversation-tab asks before
   * making any tab-level move that would pull a column out from under them.
   * @returns {boolean} True when the view is within ~20rem of the end.
   */
  isScrolledNearBottom() {
    return this._scroll.isNearBottom();
  }

  /**
   * Let go of the reader's place: the view is being moved on purpose, so there
   * is no place left to keep (ColumnScroll.releaseAnchor).
   */
  releaseReaderAnchor() {
    this._scroll.releaseAnchor();
  }

  /**
   * Persist current scroll state (atBottom + element anchor) to localStorage.
   * Called on pagehide.
   */
  saveScrollPositionImmediately() {
    this._scroll.saveImmediately();
  }

  /**
   * Restore scroll position from localStorage. Called by conversation-tab
   * after messages are rendered. Only restores once per conversation load.
   */
  restoreScrollPosition() {
    this._scroll.restore();
  }

  /**
   * Scroll to bottom if conditions allow
   * @param {boolean} [force=false] - If true, scroll regardless of user position
   */
  scrollToBottom(force = false) {
    this._scroll.toBottom(force);
  }

  /**
   * Reset scroll restore flag (called when conversation changes), along with
   * the reader's place in the conversation the column is leaving.
   */
  resetScrollRestoreFlag() {
    this._scroll.forgetRestore();
    this._animationsPrimed = false;
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
   * Reentrancy guard: selecting and clearing dispatch item-selected,
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
    ensureConversationChrome(this, content);

    if (!items || items.length === 0) {
      this._memberToGroup = new Map();
      removeAllElements(content);
      this._updateEmptyHint(items);
      return;
    }

    // Everything below works on DISPLAY entries: the same Y.Maps, except that a
    // run of adjacent tool rows arrives as one group entry. Group entries carry
    // an itemId and a type like any item, so the id-based diff below is unaware
    // of the difference.
    items = this._computeDisplay(items).entries;

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
    // Following the end, not merely near it: a column holding a pinned row has
    // a reader's place to keep even while parked at the bottom, and both things
    // keyed off this answer belong to following. Skipping the anchor there is
    // what let an arriving item carry a pinned sub-thread tile off the top —
    // native column-reverse pinning keeps the newest content in view, so the
    // tile leaves the viewport with no scroll of ours to blame.
    const nearBottom = this._scroll.isFollowingEnd();
    const animate = structuralChange
      && this._animationsPrimed
      && !prefersReducedMotion()
      && nearBottom;
    const beforeTops = animate ? this._captureItemTops(content) : null;

    this._scroll.holdAnchorOver(() => {
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
      this._selection.reconcileAfterRender();

      this.updateFooter();
    }, { skip: nearBottom });

    this._updateEmptyHint(items);

    // FLIP "Invert + Play": now the DOM is in its final position, glide the
    // moved items from where they were and fade newly-inserted ones in.
    if (beforeTops) this._playInsertAnimation(content, beforeTops);
    this._animationsPrimed = true;
  }

  /**
   * Whether anything has been said in this column yet.
   *
   * A new conversation is not an empty one: it is seeded with standing context
   * items before the first message, so only CONVERSATIONAL items count. A
   * thread column is opened from work that has already happened, so it always
   * has history whatever its items say.
   * @param {Array<any>} [items] - The column's items, before display grouping.
   *   Defaults to the message thread's own.
   * @returns {boolean} True once the column holds a conversational item.
   * @private
   */
  _hasConversationalHistory(items) {
    if (this._threadYMap) return true;
    for (const item of items || this._messageThread?.items || []) {
      if (isConversationalItemType(item?.get?.('type'))) return true;
    }
    return false;
  }

  /**
   * Show or hide the starting hint over the empty background.
   *
   * A new conversation is not an empty one: it is seeded with standing context
   * items before the first message, so the hint is shown while the column holds
   * no CONVERSATIONAL item — the same test the composer's placeholder uses.
   * Only the root column qualifies: a thread column is opened from work that has
   * already happened, so its reader is past needing this.
   *
   * This owns one bit only: whether the hint applies at all. Where it sits and
   * whether it fits are _positionEmptyHint's.
   * @param {Array<any>} items - The column's items, before display grouping.
   * @private
   */
  _updateEmptyHint(items) {
    const hint = /** @type {HTMLElement|null} */ (this.querySelector('conversation-empty-hint'));
    if (!hint) return;

    const hasHistory = this._hasConversationalHistory(items);
    hint.classList.toggle('hidden', hasHistory);
    // The hint's guidance slot learns where it is; the engine decides the rest.
    const conversation = this._messageThread?.conversation;
    for (const nudge of /** @type {NodeListOf<any>} */ (hint.querySelectorAll('juggler-nudge'))) {
      nudge.context = hasHistory ? { turnActive: true } : {
        conversationId: conversation?.id,
        thread: this._messageThread,
        turnActive: false,
      };
    }
    if (hasHistory) {
      // Retired: drop the band measurements too, so a later re-show starts from
      // the element's layout, not a band staler than the DOM.
      hint.classList.remove('no-room', 'no-room-for-tips');
      hint.style.top = '';
      hint.style.height = '';
      this._teardownEmptyHintObserver();
    } else {
      this._positionEmptyHint();
    }
  }

  /**
   * Stop watching the band the starting hint is positioned against.
   * @private
   */
  _teardownEmptyHintObserver() {
    if (!this._emptyHintObserver) return;
    this._emptyHintObserver.disconnect();
    this._emptyHintObserver = null;
  }

  /**
   * Centre the starting hint in the space that is actually clear, and hide it
   * when there isn't enough of that space.
   *
   * The hint sits over the message list, but a fresh conversation's list is not
   * empty: seeded standing-context items and the idle footer sit at its top,
   * and the composer eats from the bottom. Centring in the whole band walks the
   * hint over that content on a short viewport. The clear band is therefore
   * measured: from the bottom edge of the rendered content (`#message-list-inner`)
   * down to the bottom of the scroller. When content is shorter than the
   * viewport the inner column's margin-bottom:auto tops the band at the top of
   * the scroller instead, and the hint centres over the whole background as
   * before.
   *
   * The bottom edge is the scroller's, not the wrapper's, so the measured band
   * excludes the composer — with zero or negative height the hint is hidden:
   * a viewport that small has no room to teach, and on such a screen the
   * composer's own placeholder is the instruction (and on touch, where two of
   * the four gestures don't apply, it is the only one).
   * @private
   */
  _positionEmptyHint() {
    const hint = /** @type {HTMLElement|null} */ (this.querySelector('conversation-empty-hint'));
    const scroller = this.querySelector('#message-list');
    const inner = this.querySelector('#message-list-inner');
    if (!hint || !scroller || !inner) return;
    const stack = /** @type {HTMLElement|null} */ (hint.querySelector('.empty-hint-stack'));
    if (!stack) return;

    // Observed while the hint is live, so streaming growth, footer changes and
    // viewport resizes all re-measure the band. Watching the inner column also
    // covers the scroller, whose box never changes with content.
    if (typeof ResizeObserver === 'undefined') return;
    if (!this._emptyHintObserver) {
      this._emptyHintObserver = new ResizeObserver(() => this._positionEmptyHint());
      this._emptyHintObserver.observe(inner);
      this._emptyHintObserver.observe(scroller);
    }

    // Viewport-relative rects: both elements are in the same column, so their
    // x/y are directly comparable. No clamp on the band's top: when the seeded
    // content stands taller than the viewport its bottom edge sits at or below
    // the scroller's, the band is empty, and the empty band is what hides the
    // hint — clamping would manufacture room the content is already using.
    const innerRect = inner.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const bandTop = innerRect.bottom;
    const bandBottom = scrollerRect.bottom;
    const bandHeight = bandBottom - bandTop;

    // The rolling tip at the stack's foot is the first thing to give: a band
    // that holds the composer gestures only without it sheds the tip and keeps
    // the gestures. Measured whole first, so a band that has grown back gets
    // the tip back.
    hint.classList.remove('no-room-for-tips');
    let fits = bandHeight - stack.offsetHeight >= EMPTY_HINT_CLEARANCE_PX;
    if (!fits && stack.querySelector('.empty-hint-tips:not([hidden]), juggler-nudge:not([hidden])')) {
      hint.classList.add('no-room-for-tips');
      fits = bandHeight - stack.offsetHeight >= EMPTY_HINT_CLEARANCE_PX;
    }

    if (!fits) {
      hint.classList.add('no-room');
      return;
    }
    hint.classList.remove('no-room');
    hint.style.top = `${bandTop - scrollerRect.top}px`;
    hint.style.height = `${bandHeight}px`;
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
    // While THIS thread is being driven, continueThread() bails (its
    // `messageThread.isProcessing` guard) — Continue would be a silent no-op,
    // so hide it rather than offer a dead button. A busy sibling is no reason
    // to hide it: the worker takes a continue on an idle thread while others
    // run.
    if (mt.isProcessing) return false;
    const hasEffective = mt.getMessages().some(m => isUserMessage(m) || isAssistantMessage(m) || isToolActionMessage(m) || isThreadMessage(m));
    if (!hasEffective) return false;
    // A summary does not bar continuing: a thread carrying one has come to rest,
    // which is exactly the state Continue drives it out of.
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
    const live = this.snapshotLiveStatus();
    this._broadcastLiveStatusToTiles(live);

    // Footer source 1: the LLM status of THIS column's own thread (so a running
    // column shows the rich "Streaming • 250 tokens" text; columns whose tiles
    // represent a running thread leave that to the tile face). Asked per
    // thread, so a parent and a read-only child each show their own line at the
    // same time.
    const myThreadId = this._messageThread?.threadItemId || null;
    const myLiveMessage = liveMessageForThread(live, myThreadId);
    // A group column is a SLICE of its parent thread: it shares the parent's
    // message thread outright (ColumnBuilder.conversationColumn), so
    // every thread-level signal below matches in EVERY group column of a busy
    // thread — including runs that finished long ago. Scope those signals to the
    // rows this column actually shows, so only the run holding the live work
    // reports it.
    const groupItems = this._isGroupColumn ? (this._groupItems || []) : null;
    /** @type {{message: string, spinner: boolean}|null} */
    let llmStatus = null;
    if (myLiveMessage && (!groupItems || hasUnsettledToolInTree(groupItems))) {
      llmStatus = { message: myLiveMessage, spinner: true };
    }

    // Footer source 2: last busy item that wants to be reflected in the
    // footer (tool actions, etc.). Thread-message tiles render themselves
    // and return null here so the footer doesn't double up.
    const itemBusy = this._getLastBusyItemState();

    // LLM status takes priority (most time-sensitive), then item states
    const busyState = llmStatus || itemBusy;

    const hasPendingApprovals = groupItems
      ? hasPendingApprovalInTree(groupItems)
      : (this._messageThread?.getPendingApprovalMessages().length ?? 0) > 0;
    // While the loop is parked on an approval the worker keeps publishing
    // `processing_tools`, so any busyState here is the LLM loop's idea of
    // "still working" — but the actual blocker is user input. Override the
    // footer text (and drop the spinner) so the status reflects reality.
    const isProcessing = hasPendingApprovals || !!busyState;

    // Spinner inputs, computed ONLY while a turn is running. Both are read by
    // the busy spinner and by nothing else, and updateFooter runs on every
    // streaming tick — several times a second, on every column — so doing this
    // work on an idle footer would walk the whole item tree many times a second
    // to feed an indicator that isn't on screen.
    //
    // How much is genuinely executing at once, for the club count. Scoped the
    // same way as the status signals above: a group column reports only the run
    // it shows, everything else the whole thread (nested threads included).
    const running = isProcessing
      ? runningToolsInTree(groupItems || this._messageThread?.items)
      : { count: 0, oldestStart: 0 };
    const runningTools = running.count;
    // How long we have been waiting on the tool call we are STILL waiting on,
    // for the tool-wait ramp. Null when nothing is executing, which is what
    // tells the spinner to read the speed off throughput instead. A running
    // tool with no claim stamp yet counts as freshly started (0) rather than as
    // no tool at all — the wait is real, we just can't date it.
    const toolWaitMs = runningTools > 0
      ? Math.max(0, running.oldestStart ? Date.now() - running.oldestStart : 0)
      : null;
    // How fast output is arriving, for the speed while streaming. Zero while
    // parked on a tool call or waiting on the network — the truth of those
    // moments rather than a missing reading.
    const throughput = isProcessing
      ? (this._conversation?.llmState?.getThroughput?.(this._conversation.id, myThreadId) ?? 0)
      : 0;
    const statusMessage = hasPendingApprovals
      ? StatusMessageBuilder.withBusyMarker(t('Waiting for user approval'))
      : (busyState?.message || '');
    const showSpinner = hasPendingApprovals ? false : (busyState?.spinner ?? true);

    // A group column is a lens on a run of tool rows, not a thread. The rows are
    // the parent thread's, and this column shares that thread outright, so every
    // control below (Continue, Close, Duplicate, Add Context Item) would act on
    // the parent from inside the lens, and the meter would count the parent's
    // context. Everything but the status line — which the group-scoped signals
    // above have already narrowed to this run — is left out.
    // Which columns offer suggested replies, and when. Nothing mid-turn, and
    // nothing in a group column — a lens on the thread to its left, with no
    // composer of its own for a suggestion to go into. A sub-thread column has
    // one, and what to say next to a sub-agent is as much a question as what to
    // say next to the root. Decided above the group-column branch below, so a
    // lens clears its row rather than keeping whatever was on offer when it
    // opened.
    // Before anything has been said there is nothing to suggest a reply TO, so
    // the row carries starter prompts instead. One row, one source at a time:
    // the two can never stack, and a starter prompt is drafted by the same
    // handler, so it is read back in the composer rather than sent.
    const canSuggest = !isProcessing && !this._isGroupColumn;
    const started = this._hasConversationalHistory();
    // One switch ("Suggest prompts") governs both: the controller obeys it for
    // the replies, and this for the starters.
    const starters = areReplySuggestionsEnabled() ? STARTER_PROMPTS.map((prompt) => t(prompt)) : [];
    const offered = started ? this._replySuggestions : starters;
    this.suggestionsRow?.update(
      canSuggest ? offered : [],
      started ? t('Suggested replies') : t('Things to ask'),
    );

    if (this._isGroupColumn) {
      footer.setStatusOnly(true);
      footer.update({ isProcessing, canContinue: false, statusMessage, showSpinner, runningTools, throughput, toolWaitMs });
      return;
    }
    footer.setStatusOnly(false);

    const canContinue = this._canContinue();

    // Duplicate tab button lives only on the conversation's root thread
    // (threadItemId null), and only when there's content worth cloning.
    const isRootThread = !this._messageThread?.threadItemId;
    const showDuplicateTab = isRootThread && canContinue;

    // When the thread last changed, for the idle row's timestamp. Read only at
    // rest, for the same reason as the spinner inputs above in reverse: it
    // walks the item list, and the row that shows it is hidden mid-turn.
    const lastActivityAt = isProcessing ? 0 : (this._messageThread?.lastActivityAt ?? 0);

    footer.update({
      isProcessing,
      canContinue,
      statusMessage,
      showSpinner,
      nextSteps: this._nextSteps,
      showDuplicateTab,
      busyItemMessageId: itemBusy?.messageId,
      // Asked of THIS column. A pause covers a thread and everything below it,
      // so the conversation-wide answer would put "Pausing…" on every footer in
      // the window — including the columns the press was not aimed at.
      politePending: !!this._conversation?.isPolitePending?.(myThreadId),
      politePaused: !!this._conversation?.isPolitePaused?.(myThreadId),
      runningTools,
      throughput,
      toolWaitMs,
      lastActivityAt,
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

export default ConversationArea;
