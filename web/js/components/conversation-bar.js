//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @typedef {object} SessionEvent
 * @property {string} type - Event type name
 * @property {any} data - Event data
 */

/**
 * @typedef {object} ModalOptions
 * @property {string} [confirmText] - Text for confirm button
 * @property {string} [cancelText] - Text for cancel button
 * @property {boolean} [danger] - Show danger styling for destructive actions
 */

/**
 * @typedef {object} WindowWithConversationBar
 * @property {typeof ConversationBar} ConversationBar - ConversationBar class
 */

import { MAX_CONVERSATIONS, CONVERSATION_LIMIT_MESSAGE } from '../model/session.js';
import { UNTITLED_BASE } from '../model/conversation-naming.js';
import { BIN_LARGE_BYTES, MAX_CONVERSATION_NAME_LENGTH, MAX_WORKSPACE_LABEL_LENGTH } from '../utils/constants.js';
import { setupColumnResize, applyColumnWidthPx } from '../utils/column-resize.js';
import { startReorderDrag, settledRect } from '../utils/reorder-drag.js';
import { DRAG_GRIP_HTML, pointerMayGrab } from '../utils/drag-grip.js';
import { openInlineRename } from '../utils/inline-rename.js';
import { workspaceTint } from '../utils/workspace-colour.js';
import { formatBytes } from '../utils/format.js';
import { registerContextMenuProvider } from '../services/context-menu-service.js';
import scheduledSendService, { SCHEDULED_SEND_ARMED_EVENT } from '../services/scheduled-send-service.js';
import { CLOCK_SVG } from '../utils/icons.js';
import { isPinboardView } from '../utils/view-mode.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import { isAutoNameEnabled, refreshAutoNameSetting } from '../services/auto-name-setting.js';
import { isTabHighlightEnabled, ATTENTION_PREFS_EVENT } from '../utils/attention-manager.js';
import { workspaceGroups, selectedWorkspace } from '../services/workspace-provisioning.js';
import { openWorkspaceMove } from './workspace-move-dialog.js';
import { openWorkspaceCreate } from './workspace-create-dialog.js';
import JugglerElement from './juggler-element.js';
import { showAlert, showNotice } from './modal-dialog.js';
import { whyNotRebind } from '../services/workspace-rebinding.js';
import './bin-modal.js';
import './info-rail.js';
import './workspace-box-header.js';

// Leading-edge debounce window for new-conversation creation. Guards against
// accidental double-activation — most commonly a double-click on the "+"
// button, where the second click lands before the async create resolves and
// would spawn a second tab.
const NEW_CONVERSATION_DEBOUNCE_MS = 500;

// How far below a workspace box's top edge still counts as the strip above it
// rather than the inside of it, while a drag is looking for somewhere to land
// (see `_dropPlaceAt`). It is taken out of the header, which is a title and is
// not somewhere a tab is ever dropped — so no slot in the box loses any of its
// own height, and the slot above the box's first tab keeps most of the header
// besides.
//
// The top edge alone. Below the last tab there is only the box's padding, and
// that padding is the end of the box: a tab let go there belongs to the box, so
// there is nothing at that edge to take.
const BOX_TOP_BAND_PX = 14;

// Material "delete" (trash can) icon — the per-tab "move to bin" affordance.
const BIN_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="1rem" viewBox="0 -960 960 960" width="1rem" fill="currentColor" aria-hidden="true"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg>`;

// Material "add" icon — the mark on the outline that makes a workspace. It sits
// in the slot a tab keeps for its drag handle, so the words beside it line up
// with the tab names below.
const ADD_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="1rem" viewBox="0 -960 960 960" width="1rem" fill="currentColor" aria-hidden="true"><path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z"/></svg>`;

// Material "undo" icon — the arrow on the bin toast's Undo button, matching the
// column-footer undo offer.
const UNDO_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M280-200v-80h284q63 0 109.5-40T720-420q0-60-46.5-100T564-560H312l104 104-56 56-200-200 200-200 56 56-104 104h252q97 0 166.5 63T800-420q0 94-69.5 157T564-200H280Z"/></svg>`;

// Keys in `_cachedElements` that name the bar's own furniture rather than a
// conversation tab, so render()'s cleanup pass leaves them alone.
const CHROME_ELEMENT_KEYS = new Set([
  'nav', 'tabs-menu', 'add-button', 'new-workspace', 'bin-button', 'bin-undo', 'info-rail'
]);

// The rows of the strip that make something rather than hold something: the "+"
// at the top, which makes a conversation, and the outline at the foot, which
// makes a workspace. They are the ends of the strip, and they stand aside
// together for the length of a drag.
const CREATE_ROW_KEYS = ['add-button', 'new-workspace'];

// How long the Undo button rests above the Bin. Long enough to catch the click
// you regret, short enough that it never becomes furniture — the Bin itself is
// the unhurried way back.
const BIN_UNDO_TIMEOUT_MS = 5000;

/**
 * ConversationBar - Vertical sidebar of conversation tabs.
 *
 * Fixed-left, resizable column of stacked tab buttons. Allows switching,
 * creating, deleting, and drag-reordering conversations along the Y axis.
 */
/**
 * The currently-connected ConversationBar instance. Tracked at module scope so
 * the single context-menu provider (registered once below) can reach the live
 * bar's session + helpers without re-registering on every connect/disconnect.
 * @type {ConversationBar|null}
 */
let _activeBar = null;

class ConversationBar extends JugglerElement {
  constructor() {
    super();

    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;

    /** @type {Function|null} @private */
    this._unsubscribe = null;

    /** @type {Map<string, HTMLElement>} @private Map of conversationId -> conversation-tab element */
    this._tabElements = new Map();

    /** @type {HTMLElement|null} @private */
    this._tabsContainer = null;

    /** @type {boolean} @private Whether a reorder drag is arranging the strip */
    this._dragging = false;

    /** @type {boolean} @private Track if a drag just occurred to prevent click/dblclick */
    this._dragJustOccurred = false;

    /**
     * Cache of DOM elements for diff-based rendering to preserve scroll position
     * @type {Map<string, HTMLElement>} @private
     * Keys: conversationId -> <li> tab element, 'add-button' -> add button <li>, 'tabs-menu' -> <menu>, 'nav' -> <nav>
     */
    this._cachedElements = new Map();

    /** @type {Function|null} @private Unsubscribe from LLMState status observer */
    this._llmStateUnsubscribe = null;

    /** @type {number} @private Timestamp (ms) of the last accepted new-conversation create, for leading-edge debounce */
    this._lastCreateAt = 0;

    /**
     * Conversations with a bin in flight. A bin spans a server round-trip, and
     * every affordance that starts one — the per-tab button, the context menu,
     * the shortcut — stays live for the whole of it. Without this, binning the
     * same conversation twice tears it down twice and sends two requests for a
     * folder that moved on the first.
     * @type {Set<string>} @private
     */
    this._binningIds = new Set();

    /** @type {number|null} @private Timer retiring the bin Undo toast */
    this._binUndoTimer = null;

    /** @type {string|null} @private Conversation the visible bin Undo toast would restore */
    this._binUndoId = null;

    /**
     * Conversation whose tab was last scrolled into view, so the scroll is only
     * issued when the selection actually moves. render() runs on every Yjs
     * transaction — up to ~100 times a second while a turn streams — and a
     * smooth scrollIntoView restarted that often keeps the tab list in
     * perpetual motion, which eats clicks: a `click` fires on the nearest
     * common ancestor of its mousedown and mouseup targets, so a list that
     * shifts mid-press delivers the event to the menu instead of the tab.
     * @type {string|null} @private
     */
    this._lastScrolledTabId = null;

    /** @type {number|null} @private Pending frame for a coalesced render (see _scheduleRender) */
    this._renderFrame = null;

    /** @type {boolean} @private A render arrived while dragging and is owed on release */
    this._renderDeferred = false;

    /**
     * The box drawn for each workspace, by workspace id. Kept apart from
     * {@link _cachedElements}, which render()'s cleanup pass reads as "a tab,
     * unless it is named chrome" — a box is neither, and its lifetime is the
     * workspace's rather than any conversation's.
     * @type {Map<string, HTMLElement>} @private
     */
    this._workspaceBoxes = new Map();
  }

  connectedCallback() {
    _activeBar = this;
    this.render();
    this._findTabsContainer();
    this._setupKeyboardNavigation();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (_activeBar === this) _activeBar = null;
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._llmStateUnsubscribe) {
      this._llmStateUnsubscribe();
      this._llmStateUnsubscribe = null;
    }
    if (this._renderFrame !== null) {
      cancelAnimationFrame(this._renderFrame);
      this._renderFrame = null;
    }
    this._hideBinUndo();
  }

  /**
   * Render at most once per frame.
   *
   * `conversation:changed` is emitted per applied Yjs transaction, so while a
   * turn streams it arrives at the server's sync rate — one every 10ms, ~100 a
   * second — and delivery is a synchronous listener loop with no batching of
   * its own. Rendering the whole bar that often costs a forced layout each time
   * (the info rail measures itself) and leaves the sidebar mutating under the
   * pointer, which loses clicks. Coalescing to one pass per frame collapses a
   * burst into the single render the display can actually show.
   *
   * Only the streaming firehose comes through here. Discrete events
   * (create/delete/switch/reorder) still render synchronously, because callers
   * and tests read tab state immediately after them.
   * @private
   */
  _scheduleRender() {
    if (this._renderFrame !== null) return;
    this._renderFrame = requestAnimationFrame(() => {
      this._renderFrame = null;
      this.render();
    });
  }

  /**
   * Find and store reference to conversation-tabs-container
   * @private
   */
  _findTabsContainer() {
    // A detached board draws no transcript, so it builds no conversation tabs:
    // it is a view of the one conversation its URL names, and a tab here would
    // be a second, invisible answer to which one that is. Every path that
    // creates a tab already declines to when there is nowhere to put one.
    if (isPinboardView()) {
      this._tabsContainer = null;
      return;
    }
    this._tabsContainer = document.querySelector('conversation-tabs-container');
    if (!this._tabsContainer) {
      console.error('[ConversationBar] Could not find conversation-tabs-container');
    }
  }

  /**
   * Set up keyboard navigation for the tab list focus mode.
   * @private
   */
  _setupKeyboardNavigation() {
    this.onDocument('juggler:focus-tab-list', () => this._enterTabListFocus());

    // A click on the bar's empty background focuses the tab list — the same
    // mode ArrowLeft out of the leftmost conversation column enters — so a bar
    // click becomes a way into keyboard tab navigation (↑/↓ switch, Enter
    // renames, → enters the conversation, Esc leaves), and fixes a click landing
    // on inert chrome that left focus somewhere Return couldn't reach.
    //
    // The empty area is mostly the info-rail (flex:1, it grows to fill the space
    // above the Bin), so we can't exclude the rail wholesale — only the things
    // with their own click behaviour: tabs, workspace boxes, the info cards, and
    // any interactive control (the +, Bin, card buttons/links, the resize
    // handle). A click that misses all of those — bare rail, gaps, padding —
    // enters tab-list focus.
    //
    // A box is on that list because it is a thing in the list, not chrome
    // between things: left off it, selecting a workspace also put the keyboard
    // in the bar, and the box came up wearing the focus ring that says so —
    // which no tab does when it is clicked, because clicking a tab leaves.
    this.on(this, 'click', (/** @type {Event} */ e) => {
      const target = /** @type {HTMLElement|null} */ (e.target);
      if (!target) return;
      if (target.closest(
        '.conversation-tab, .conversation-box, .info-card, col-resize-handle, button, a, input, textarea, select',
      )) return;
      this._enterTabListFocus();
    });

    this.onDocument('keydown', (/** @type {Event} */ evt) => {
      const e = /** @type {KeyboardEvent} */ (evt);
      if (!this.classList.contains('tab-list-focused')) return;

      // Stand down while an overlay owns the keyboard: this document-level
      // handler switches tabs behind the popup, so ↑/↓ must not reach it. Same
      // shared rule as the central dispatcher (KeyShortcutManager).
      if (keyShortcutManager.suppressedByOverlay()) return;

      const target = /** @type {Element|null} */ (e.target);
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      if (target?.closest('action-confirmation')) return;

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          this._switchAdjacentTab(-1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          this._switchAdjacentTab(1);
          break;
        case 'ArrowRight':
          // Move right, out of the tab list and into the conversation — commit
          // the selection and focus its composer (same as _enterActiveTab).
          e.preventDefault();
          this._enterActiveTab();
          break;
        case 'Escape':
          e.preventDefault();
          this._exitTabListFocus();
          break;
        case 'Enter':
          // Return, while the tab bar itself is focused, renames the active
          // tab (Finder-style). Escape / ArrowRight remain the "leave tab-list
          // focus" affordances.
          e.preventDefault();
          this._exitTabListFocus();
          this._enterRenameMode(this._session?.visibleConversationId || '');
          break;
      }
    });

    this.on(this, 'focusout', () => {
      queueMicrotask(() => {
        if (!this.matches(':focus-within')) {
          this._exitTabListFocus();
        }
      });
    });

    this.onWindow('juggler:cycle-tab', (/** @type {Event} */ e) => this._handleCycleTab(e));

    // Command shortcuts route here so a keystroke and a click share one path:
    // "new conversation" reuses the cap + inline-rename UX; "bin" reuses the
    // running-turn guard + fly-to-bin animation, always targeting the visible tab.
    this.onDocument('juggler:new-conversation', () => { void this._createConversation(); });
    // The workspace panel offers the same thing for the workspace it is showing.
    // It asks here rather than doing it, so the debounce and the conversation
    // cap stay one set of rules however many places carry the button.
    this.onDocument('juggler:new-conversation-in-workspace', (e) => {
      const workspaceId = /** @type {CustomEvent} */ (e).detail?.workspaceId;
      if (workspaceId) void this._createConversation(workspaceId);
    });
    this.onDocument('juggler:bin-active-conversation', () => {
      const id = this._session?.visibleConversationId;
      if (id) void this._binConversation(id);
    });
    // F2 (from the KeyShortcutManager) opens inline rename on the visible tab —
    // the same UX as clicking the already-active tab.
    this.onDocument('juggler:rename-active-conversation', () => {
      const id = this._session?.visibleConversationId;
      if (id) this._enterRenameMode(id);
    });

    // The tab-highlight preference decides whether an awaiting tab pulses at
    // all, so a change to it must repaint the tabs currently pulsing — the whole
    // point of the toggle is to quiet them now, not once their approval clears.
    this.onWindow(ATTENTION_PREFS_EVENT, () => this._refreshAllTabStatus());

    // Arming or cancelling a scheduled send changes which tabs show a clock,
    // and nothing else repaints them: the schedule lives on a draft, which the
    // bar doesn't read.
    this.onDocument(SCHEDULED_SEND_ARMED_EVENT, () => this._refreshAllTabStatus());
  }

  /**
   * Enter tab-list focus mode: the bar itself takes keyboard focus, so ↑/↓
   * switch tabs, Enter renames the active tab, → enters the conversation, and
   * Esc leaves. Reached two ways — ArrowLeft out of the leftmost conversation
   * column (via the juggler:focus-tab-list event) and a click on the bar's
   * empty background (see the click handler in _setupKeyboardNavigation).
   * @private
   */
  _enterTabListFocus() {
    this.classList.add('tab-list-focused');
    this.setAttribute('tabindex', '-1');
    this.focus({ preventScroll: true });
    this._scrollActiveTabIntoView();
  }

  /** @private */
  _exitTabListFocus() {
    this.classList.remove('tab-list-focused');
    if (document.activeElement === this) this.blur();
  }

  /** @private */
  _enterActiveTab() {
    this._exitTabListFocus();
    const activeTab = /** @type {any} */ (this._tabElements.get(this._session?.visibleConversationId || ''));
    activeTab?._focusInput?.();
  }

  /** @private */
  _scrollActiveTabIntoView() {
    const activeTab = /** @type {HTMLElement|null} */ (this.querySelector('.conversation-tab.active'));
    activeTab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  /**
   * @param {number} step
   * @param {{focusInput?: boolean}} [options]
   * @private
   */
  _switchAdjacentTab(step, options = {}) {
    if (!this._session) return;
    const ids = Array.from(this._session.conversations.keys());
    if (ids.length < 2) return;

    // Cycling starts from the conversation behind a workspace panel as readily
    // as from one on screen: there is no tab to step from while the panel has
    // the selection, and stepping from the one it was opened over is what the
    // keystroke is asking for.
    const currentId = this._session.loadedConversationId;
    const currentIdx = currentId ? ids.indexOf(currentId) : -1;
    const nextIdx = ((currentIdx < 0 ? 0 : currentIdx + step) + ids.length) % ids.length;
    const nextId = ids[nextIdx];
    if (nextId && nextId !== currentId) {
      this._switchConversation(nextId, options);
      requestAnimationFrame(() => this._scrollActiveTabIntoView());
    }
  }

  /**
   * Handle the Ctrl+Tab / Ctrl+Shift+Tab accelerator, dispatched from the
   * native window as a `juggler:cycle-tab` event (WKWebView eats the keystroke
   * before page JS, so the round-trip through Wails is required; in a browser
   * the event never fires). Unlike arrow-key navigation within the tab list,
   * cycling commits like a click: it leaves tab-list-focus mode and gives the
   * newly-shown tab's composer keyboard focus.
   * @param {Event} e
   * @private
   */
  _handleCycleTab(e) {
    const detail = /** @type {CustomEvent} */ (e).detail;
    const step = detail?.direction === 'prev' ? -1 : 1;
    this._exitTabListFocus();
    this._switchAdjacentTab(step, { focusInput: true });
  }

  /**
   * Set the session to display conversations from
   * @param {import('../model/session.js').default} session
   */
  setSession(session) {
    // Unsubscribe from old session
    if (this._unsubscribe) {
      this._unsubscribe();
    }
    if (this._llmStateUnsubscribe) {
      this._llmStateUnsubscribe();
      this._llmStateUnsubscribe = null;
    }

    this._session = session;

    // Seed the auto-naming setting cache (best-effort, fire-and-forget) so the
    // new-tab rename-vs-focus decision reads a current value.
    void refreshAutoNameSetting();

    // Subscribe to LLM status changes so we can update per-tab indicator classes
    // without re-rendering the whole bar. The feed is session-wide, so an empty
    // session subscribes just as well as a loaded one.
    this._llmStateUnsubscribe = session.onLLMStatusChange(
      (/** @type {string} */ convId) => this._refreshTabStatus(convId)
    );

    // Subscribe to session changes
    this._unsubscribe = session.subscribe(/** @param {SessionEvent} event */ (event) => {
      if (event.type === 'conversation:created') {
        this._handleConversationCreated(event.data);
      } else if (event.type === 'conversation:deleted') {
        this._handleConversationDeleted(event.data);
      } else if (event.type === 'conversation:switched') {
        this._handleConversationSwitched(event.data);
      } else if (event.type === 'conversation:rename-requested') {
        // A fresh unnamed tab was activated. With auto-naming on (the default),
        // leave the "Untitled N" name for the LLM to replace after the first message
        // and drop focus straight into the composer; with it off, open the inline
        // rename editor so the user names it now.
        if (isAutoNameEnabled()) {
          this._focusConversationInput(event.data.conversationId);
        } else {
          this._enterRenameMode(event.data.conversationId);
        }
      }

      // Re-render tab buttons whenever conversations change. Discrete events,
      // including a folder rename, render immediately — callers read tab state
      // straight after them, and requestAnimationFrame may be suspended while a
      // WebView is hidden. conversation:changed streams at the sync rate for the
      // whole duration of a turn, so only that event is coalesced per frame.
      // The workspace table is in that list because the strip draws it: a
      // workspace appearing, being finished with, or losing its root adds or
      // removes a box, and nothing about a conversation has changed to say so.
      if (event.type === 'conversation:created' ||
          event.type === 'conversation:deleted' ||
          event.type === 'conversation:renamed' ||
          event.type === 'conversation:switched' ||
          event.type === 'conversation:reordered' ||
          event.type === 'workspace:selected' ||
          event.type === 'session:workspaces-changed') {
        this.render();
      } else if (event.type === 'conversation:changed') {
        this._scheduleRender();
      }
    });

    // Create conversation-tab elements for existing conversations
    this._initializeConversationTabs();

    this.render();
  }

  /**
   * Initialize conversation-tab elements for all existing conversations
   * @private
   */
  _initializeConversationTabs() {
    if (!this._session || !this._tabsContainer) {
      return;
    }

    // Create tab element for each conversation
    this._session.conversations.forEach((conversation) => {
      this._createConversationTab(conversation);
    });

    // Show the visible conversation's tab
    const visibleId = this._session.visibleConversationId;
    if (visibleId) {
      this._showTab(visibleId);
    }
  }

  /**
   * Create a conversation-tab element for a conversation
   * @param {import('../model/conversation.js').default} conversation
   * @private
   */
  _createConversationTab(conversation) {
    if (!this._tabsContainer) {
      console.error('[ConversationBar] Cannot create tab: container not found');
      return;
    }

    // Idempotent: if a tab already exists for this id, rebind the
    // conversation object and return. Guards against duplicate
    // `conversation:created` events (e.g. originator + broadcast echo race
    // on create) leaking an orphaned `<conversation-tab>` into the DOM —
    // _tabElements.set would overwrite the Map entry but the first element
    // would stay parented in the container, untouched by future setActive/
    // setHidden/remove calls and visible forever.
    const existing = this._tabElements.get(conversation.id);
    if (existing) {
      // @ts-ignore - setConversation is a method on conversation-tab
      existing.setConversation(conversation);
      return;
    }

    // Import and create tab element
    const tabElement = document.createElement('conversation-tab');
    tabElement.id = `conversation-tab-${conversation.id}`;

    // Start hidden
    // @ts-ignore - setHidden is a method on conversation-tab
    tabElement.setHidden();

    // Store reference
    this._tabElements.set(conversation.id, tabElement);

    // Append to container FIRST (this triggers connectedCallback)
    this._tabsContainer.appendChild(tabElement);

    // THEN link conversation to tab (child elements now exist)
    // @ts-ignore - setConversation is a method on conversation-tab
    tabElement.setConversation(conversation);
  }

  /**
   * Show a specific conversation tab, hide others
   * @param {string} conversationId
   * @private
   */
  _showTab(conversationId) {
    // The sidebar row and this panel host come from two different mechanisms:
    // render() paints a row for every `session.conversations` entry, while the
    // host is only built from `conversation:created`. Anything that seeds the
    // map ahead of that notify (a restore's unloaded stub, which waits on a
    // worker spawn) — or never notifies at all (a load that failed and left an
    // `error` stub) — leaves a clickable row with no host, and activating a
    // missing host is a silent no-op that still hides every other tab: a blank
    // page until a reload. Build it on demand so a selection always has
    // something to activate; the tab renders its own spinner/retry overlay
    // while `loadState !== 'loaded'` and re-syncs when that state lands.
    const conversation = this._session?.conversations?.get(conversationId);
    if (conversation && !this._tabElements.has(conversationId)) {
      this._createConversationTab(conversation);
    }

    // Activate first: a newly-created selected tab starts hidden, and parking the
    // old tabs must not transiently leave the page without a live transcript.
    const activeTab = this._tabElements.get(conversationId);
    // @ts-ignore - setActive is a method on conversation-tab
    activeTab?.setActive();
    this._tabElements.forEach((tabElement, id) => {
      if (id === conversationId) return;
      // @ts-ignore - setHidden is a method on conversation-tab
      tabElement.setHidden();
    });
  }

  /**
   * Handle conversation created event
   * @param {import('../model/conversation.js').default} conversation
   * @private
   */
  _handleConversationCreated(conversation) {
    this._createConversationTab(conversation);
    // A switch normally arrives as its own `conversation:switched` event, which
    // shows the tab. When the session was already pointed at this conversation
    // before its element existed, that event has been and gone — reconcile now,
    // or the panel stays blank on whatever _showTab hid last.
    if (this._session?.visibleConversationId === conversation.id) {
      this._showTab(conversation.id);
    }
  }

  /**
   * Handle conversation deleted event
   * @param {import('../model/conversation.js').default} conversation
   * @private
   */
  _handleConversationDeleted(conversation) {
    const tabElement = this._tabElements.get(conversation.id);
    if (tabElement) {
      // Remove from DOM
      tabElement.remove();
      // Remove from map
      this._tabElements.delete(conversation.id);
    }
  }

  /**
   * Handle conversation switched event
   * @param {import('../model/conversation.js').default} conversation
   * @private
   */
  _handleConversationSwitched(conversation) {
    this._showTab(conversation.id);
  }

  render() {
    // A render now satisfies any frame already queued by _scheduleRender.
    if (this._renderFrame !== null) {
      cancelAnimationFrame(this._renderFrame);
      this._renderFrame = null;
    }

    // A drag has the strip arranged as the drop would leave it, and is holding
    // one tab under the pointer. Rendering now would snatch them back, add a
    // tab the gesture never saw, or remove one it is measuring against — so a
    // change arriving mid-gesture is drawn when the drag lets go. Deferred
    // whole rather than skipping the reorder pass alone: creation and removal
    // move the strip just as surely as reordering does.
    if (this._dragging) {
      this._renderDeferred = true;
      return;
    }

    if (!this._session) {
      this.innerHTML = '<div class="conversation-bar-empty">No session loaded</div>';
      return;
    }

    // Get or create nav container (only created once)
    let nav = /** @type {HTMLElement|null} */ (this._cachedElements.get('nav'));
    if (!nav) {
      nav = document.createElement('nav');
      nav.className = 'conversation-bar';
      this._cachedElements.set('nav', nav);
      this.innerHTML = '';
      this.appendChild(nav);

      // Resize handle on the right edge of the sidebar (reuses miller-column logic)
      const handle = document.createElement('col-resize-handle');
      this.appendChild(handle);

      // Detect double-tap/double-click via timing so it works for both mouse
      // and touch (dblclick doesn't fire reliably on touch devices).
      let lastTapTime = 0;
      handle.addEventListener('pointerdown', (e) => {
        const now = Date.now();
        if (now - lastTapTime < 300) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this._autoFitWidth();
          lastTapTime = 0;
        } else {
          lastTapTime = now;
        }
      }, true);

      setupColumnResize(this, 'juggler-tab-sidebar-width', 8);
    }

    // Get or create tabs menu container (only created once, preserves scroll position)
    let tabsMenu = /** @type {HTMLElement|null} */ (this._cachedElements.get('tabs-menu'));
    if (!tabsMenu) {
      tabsMenu = document.createElement('menu');
      tabsMenu.className = 'conversation-tabs';
      this._cachedElements.set('tabs-menu', tabsMenu);
      nav.appendChild(tabsMenu);
    }

    // Ambient info cards (Tips, Git status, …), parked in the empty space above
    // the Bin. Created once and cached; it manages its own visibility and measures
    // the sidebar's free space to decide how many cards fit, reconciling off its
    // own ResizeObserver rather than anything here. Sits between the flex:1 tabs
    // menu and the Bin, resting above it.
    let infoRail = /** @type {any} */ (this._cachedElements.get('info-rail'));
    if (!infoRail) {
      infoRail = document.createElement('info-rail');
      this._cachedElements.set('info-rail', infoRail);
      nav.appendChild(infoRail);
    }
    infoRail.setSession(this._session);

    // Restore button, docked directly above the Bin — the conversation it
    // restores went in there, so that's where the way back belongs. It names
    // the Bin rather than offering a bare "Undo" for two reasons: nothing was
    // deleted, and this button lasts a few seconds while the Bin below it holds
    // the conversation indefinitely, so the label has to leave the reader
    // knowing where it went even when they miss the click. "Undo" would also
    // promise a Ctrl+Z that belongs to the conversation's own edit history.
    // Created once and cached, hidden except for the few seconds after a bin
    // (see _showBinUndo).
    let undoToast = /** @type {HTMLButtonElement|null} */ (this._cachedElements.get('bin-undo'));
    if (!undoToast) {
      undoToast = document.createElement('button');
      undoToast.className = 'conversation-bin-undo';
      undoToast.type = 'button';
      undoToast.title = 'Put the conversation you just binned back';
      undoToast.setAttribute('aria-label', 'Restore the conversation from the bin');
      undoToast.hidden = true;
      undoToast.innerHTML = `${UNDO_ICON_SVG}<span>Restore from Bin</span>`;
      undoToast.addEventListener('click', () => this._undoBin());
      this._cachedElements.set('bin-undo', undoToast);
      nav.appendChild(undoToast);
    }

    // Bottom-of-bar "Bin" button — opens the bin modal.
    let binBtn = /** @type {HTMLButtonElement|null} */ (this._cachedElements.get('bin-button'));
    if (!binBtn) {
      binBtn = document.createElement('button');
      binBtn.className = 'btn-ghost conversation-bin-button';
      binBtn.title = 'View binned conversations';
      binBtn.setAttribute('aria-label', 'Open bin');
      binBtn.innerHTML = `${BIN_ICON_SVG}<span class="conversation-bin-label">Bin</span><span class="conversation-bin-size" hidden></span><span class="conversation-bin-count" hidden></span>`;
      binBtn.addEventListener('click', () => this._openBinModal());
      this._cachedElements.set('bin-button', binBtn);
      nav.appendChild(binBtn);
    }

    // Refresh the count badge + size hint from session state on every render.
    const count = this._session.binnedCount || 0;
    const sizeBytes = this._session.binSizeBytes || 0;
    const countEl = /** @type {HTMLElement|null} */ (binBtn.querySelector('.conversation-bin-count'));
    if (countEl) {
      // Compared before writing, like every other text in this pass: render()
      // runs on every doc change, and a textContent write is a text-node swap.
      const countText = count > 0 ? String(count) : '';
      if (countEl.textContent !== countText) countEl.textContent = countText;
      countEl.hidden = count <= 0;
    }
    // Approximate folder size, shown only when there's something in the bin
    // and the server has reported a non-zero tally (it refreshes lazily).
    const sizeEl = /** @type {HTMLElement|null} */ (binBtn.querySelector('.conversation-bin-size'));
    if (sizeEl) {
      const showSize = count > 0 && sizeBytes > 0;
      const sizeText = showSize ? formatBytes(sizeBytes) : '';
      if (sizeEl.textContent !== sizeText) sizeEl.textContent = sizeText;
      sizeEl.hidden = !showSize;
      // Nothing empties the bin on a timer, so a large one is only ever noticed
      // if the number stops looking like a label.
      sizeEl.classList.toggle('is-large', showSize && sizeBytes >= BIN_LARGE_BYTES);
    }
    let binTitle = 'View binned conversations';
    if (count > 0) {
      const items = `${count} ${count === 1 ? 'conversation' : 'conversations'}`;
      binTitle = sizeBytes > 0
        ? `View binned conversations — ${items} (${formatBytes(sizeBytes)})`
        : `View binned conversations — ${items}`;
    }
    if (binBtn.title !== binTitle) binBtn.title = binTitle;

    // Convert Map to array for rendering
    const conversations = Array.from(this._session.conversations.values());
    // The strip draws what the session says is selected, and asks it once: a
    // box holding the selection is already why there is no visible
    // conversation, so there is nothing to reconcile between the two answers.
    const selectedWorkspaceId = selectedWorkspace(this._session)?.id ?? null;
    const visibleId = this._session.visibleConversationId;

    // Get or create add button (only created once) and pin it to the top
    let addButton = /** @type {HTMLElement|null} */ (this._cachedElements.get('add-button'));
    if (!addButton) {
      addButton = document.createElement('li');
      addButton.className = 'conversation-add-item';
      addButton.innerHTML = `
        <button class="conversation-add"
                title="New conversation" data-shortcut-id="new-conversation"
                aria-label="Create new conversation">+</button>
      `;
      this._cachedElements.set('add-button', addButton);

      const addBtn = addButton.querySelector('.conversation-add');
      if (addBtn) {
        addBtn.addEventListener('click', () => this._createConversation());
      }
    }
    if (addButton.parentNode !== tabsMenu || tabsMenu.firstChild !== addButton) {
      tabsMenu.insertBefore(addButton, tabsMenu.firstChild);
    }

    // With no tabs below it the bare "+" is the only mark in an empty column,
    // and reads as decoration rather than the way out. Spell it out while the
    // list is empty; it shrinks back to the glyph as soon as a tab exists,
    // where the tabs themselves make what it does obvious.
    const addBtn = /** @type {HTMLElement|null} */ (addButton.querySelector('.conversation-add'));
    if (addBtn) {
      const labelled = conversations.length === 0;
      addBtn.classList.toggle('conversation-add-labelled', labelled);
      const label = labelled ? '+ New conversation' : '+';
      if (addBtn.textContent !== label) addBtn.textContent = label;
    }

    // The way to make a workspace, drawn as an empty one. A box with a dashed
    // edge and a name in it is the shape of the thing it makes, standing where
    // that thing will stand, which is the whole of how the idea is introduced:
    // the strip is two hundred pixels wide and has no room to explain what a
    // workspace is, so it shows one instead. It is the outline of a container
    // rather than another "+" beside the first, because what it makes holds
    // conversations and the button above it makes one.
    let newWorkspace = /** @type {HTMLElement|null} */ (this._cachedElements.get('new-workspace'));
    if (!newWorkspace) {
      newWorkspace = document.createElement('li');
      newWorkspace.className = 'conversation-box-new';
      newWorkspace.innerHTML = `
        <button class="conversation-box-new-button" type="button"
                title="Create a new workspace"
                aria-label="New workspace">${ADD_ICON_SVG}<span class="conversation-box-new-label">New workspace</span></button>
      `;
      this._cachedElements.set('new-workspace', newWorkspace);
      newWorkspace.querySelector('button')?.addEventListener('click', () => { void this._createWorkspace(); });
    }

    // Track which conversation IDs are still present
    /** @type {Set<string>} */
    const currentConversationIds = new Set(conversations.map(c => c.id));

    // Forget the last-scrolled tab once its conversation is gone (binned or
    // deleted), so restoring it and selecting it again scrolls to it afresh.
    // Done here rather than in the bin path because _flyTabToBin drops out
    // early under prefers-reduced-motion and never runs.
    if (this._lastScrolledTabId && !currentConversationIds.has(this._lastScrolledTabId)) {
      this._lastScrolledTabId = null;
    }

    // Where each conversation is drawn. A conversation working in a workspace
    // goes inside that workspace's box; everything else stays flat in the strip
    // — the project's conversations, and any whose binding names a place that
    // cannot be worked in, which the stranded banner explains rather than this.
    // A conversation's place is the Map order above; a box's is its own row's
    // `after` field. `workspaceGroups` reads the two together.
    const groups = workspaceGroups(this._session);
    for (const group of groups) {
      const container = group.workspace
        ? this._renderWorkspaceBox(group.workspace, tabsMenu, selectedWorkspaceId)
        : tabsMenu;
      for (const conv of group.conversations) {
        this._renderOrUpdateTab(conv, visibleId, container);
      }
    }

    // Reorder boxes and the tabs within them to match, but only move what is
    // out of place — re-inserting a node restarts CSS animations on it (used by
    // the tab status bar pulse), so we skip moves that don't change position.
    // A tab already in the right box is left alone; only one that has changed
    // workspace is ever re-parented.
    //
    // A drag never reaches here — render() returns early for the whole of one —
    // so this always reconciles against a strip nobody is holding.
    let expected = addButton.nextSibling;
    for (const group of groups) {
      const box = group.workspace ? this._workspaceBoxes.get(group.workspace.id) : null;
      if (!box) {
        expected = this._orderTabs(tabsMenu, expected, group.conversations);
        continue;
      }
      // An empty box is the case this whole layout exists for: the workspace
      // outlived its conversations and is still there to be worked in or
      // finished with. So it says so, rather than collapsing to a line.
      const empty = /** @type {HTMLElement|null} */ (box.querySelector('.conversation-box-empty'));
      if (empty) empty.hidden = group.conversations.length > 0;

      if (box !== expected) tabsMenu.insertBefore(box, expected);

      const body = /** @type {HTMLElement} */ (box.querySelector('.conversation-box-tabs'));
      this._orderTabs(body, body.firstChild, group.conversations);

      // Read after the tabs have moved, not before: a conversation that has
      // just been drawn into this box was, a moment ago, the node after it in
      // the strip, and a cursor read early would name a node no longer here.
      expected = box.nextSibling;
    }

    // Remove tabs for deleted conversations
    for (const [id, element] of this._cachedElements) {
      if (!CHROME_ELEMENT_KEYS.has(id) && !currentConversationIds.has(id)) {
        element.remove();
        this._cachedElements.delete(id);
      }
    }

    // And boxes for workspaces that no longer get one — finished with, or gone.
    // Their conversations, if any, were moved out to the flat strip by the pass
    // above, so this takes nothing with it that is still being drawn.
    const boxed = new Set(groups.map(group => group.workspace?.id).filter(Boolean));
    for (const [id, box] of this._workspaceBoxes) {
      if (boxed.has(id)) continue;
      box.remove();
      this._workspaceBoxes.delete(id);
    }

    // Last in the strip, under the boxes it is the outline of. Placed after the
    // reconciliation pass rather than in it: the pass walks a cursor through the
    // tabs and boxes it knows about, and this belongs to none of those runs — it
    // simply comes after all of them, however they end up ordered.
    if (tabsMenu.lastChild !== newWorkspace) tabsMenu.appendChild(newWorkspace);

    // The info rail is NOT reconciled from here. It measures itself off its own
    // ResizeObserver, and its height is this column's leftover space (flex: 1 1 0),
    // so laying out the tabs is exactly what makes it resize — the observer fires
    // after layout and before paint, catching every case this call used to.
    // Reconciling it per render would be a poll: render() runs on every doc
    // change, and each reconcile tears down and rebuilds every card that doesn't
    // fit, so the cards would remount (and refetch) once a frame while streaming.
  }

  /**
   * The box drawn for one workspace: its header, the list its conversations go
   * in, and what it says when that list is empty.
   *
   * Created once per workspace and then updated in place, like the tabs. The
   * box is put on the end of the strip and render()'s reconciliation pass moves
   * it to where the group belongs, so that nothing here has to know the order.
   * @param {any} workspace - The row being drawn.
   * @param {HTMLElement} tabsMenu - The strip the box lives in.
   * @param {string|null} selectedWorkspaceId - Which workspace holds the strip's selection.
   * @returns {HTMLElement} The list its conversations are drawn into.
   * @private
   */
  _renderWorkspaceBox(workspace, tabsMenu, selectedWorkspaceId) {
    let box = this._workspaceBoxes.get(workspace.id);
    if (!box) {
      box = document.createElement('li');
      box.className = 'conversation-box';
      box.dataset.workspaceId = workspace.id;
      box.setAttribute('role', 'group');
      // The hue the box is drawn in, set once: it comes from the id, and the
      // element is kept for as long as the workspace is. What the tint is worth
      // in this theme is the stylesheet's business; this only says which.
      box.style.setProperty('--workspace-tint', workspaceTint(workspace.id));
      // The line that says the box is empty lives in the list the tabs go in,
      // and is the last thing in it. That is where it reads from, and it is
      // also what makes an empty box a place a tab can be dropped: a drag lands
      // in front of something, and until now an empty box had nothing to be in
      // front of.
      //
      // The "+" and the grip are the box's rather than the header's.
      // `<workspace-box-header>` shows the name and nothing else — a title, a
      // status line and a row of controls in the width of a tab is what the
      // workspace panel exists to undo — so the affordances the box carries sit
      // outside that element: the button laid over its top corner, and the grip
      // in a row alongside the header, where a tab keeps its own.
      //
      // The grip is the same one the tabs have, from the same place, and a box
      // needs it for the same reason: a finger cannot start a reorder anywhere
      // that has not taken the gesture off the browser, and the header spans the
      // whole width, so it is not allowed to.
      box.innerHTML = `
        <div class="conversation-box-top">
          ${DRAG_GRIP_HTML}
          <workspace-box-header class="conversation-box-header"></workspace-box-header>
        </div>
        <button class="conversation-box-add" type="button"
                title="New conversation in this workspace"
                aria-label="New conversation in this workspace">+</button>
        <menu class="conversation-box-tabs">
          <li class="conversation-box-empty" hidden>No conversations</li>
        </menu>
      `;
      this._workspaceBoxes.set(workspace.id, box);
      tabsMenu.appendChild(box);

      const workspaceId = workspace.id;
      const dragged = box;
      dragged.querySelector('.conversation-box-add')?.addEventListener('click', (e) => {
        e.stopPropagation();
        void this._createConversation(workspaceId);
      });

      /**
       * Whether a press here is a press on the box itself.
       *
       * The top row — the name, and the grip beside it — is always the box. So
       * is the whole of an empty box: there is nothing else in it to aim at, and
       * a band of dead space around a short line of text is a box that looks
       * draggable and is not. A box with tabs in it keeps them for themselves —
       * a press on a tab selects that conversation, and dragging one moves it
       * between boxes.
       * @param {HTMLElement|null} target - What the pointer went down on.
       * @returns {boolean} True when the box should take it.
       */
      const onTheBox = (target) => {
        if (!target || target.closest('button')) return false;
        if (target.closest('.conversation-box-top')) return true;
        return !dragged.querySelector('.conversation-tab');
      };

      // Selecting a box is selecting a workspace, and it is done the way a tab
      // is selected: by clicking it. The release that ends a drag also produces
      // a click, which is not one.
      //
      // And renaming rides on the second click, as it does on a tab: once the
      // box is the chosen thing, a click on the name it is showing is a click
      // on a name rather than a request for what is already on screen. Only on
      // the name — a box with nothing in it answers a press anywhere, and
      // renaming the place because someone aimed at the empty space below its
      // conversations is not what they asked for.
      dragged.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement|null} */ (e.target);
        if (!onTheBox(target)) return;
        // macOS ctrl-click is a secondary click: WebKit fires `contextmenu`
        // (which opens the box's menu) and a plain `click` alongside it.
        if (/** @type {MouseEvent} */ (e).ctrlKey) return;
        if (this._dragJustOccurred) return;
        if (this._session?.visibleWorkspaceId === workspaceId && target?.closest('.conversation-box-top')) {
          this._enterWorkspaceRenameMode(workspaceId);
          return;
        }
        this._session?.selectWorkspace?.(workspaceId);
      });

      // Same rule as a tab's, from the same place: a mouse drags the box from
      // anywhere on it, a finger only from the grip. Without that gate a touch
      // anywhere on a full-width header would be taken for a drag and the
      // sidebar would lose its scroll.
      dragged.addEventListener('pointerdown', (e) => {
        const event = /** @type {PointerEvent} */ (e);
        if (event.button !== 0 || event.ctrlKey) return;
        const target = /** @type {HTMLElement|null} */ (event.target);
        if (!onTheBox(target)) return;
        if (target?.closest('.inline-rename')) return;
        if (!pointerMayGrab(event)) return;
        this._startBoxDrag(event, dragged);
      });
    }

    // The header names the place, and marks it when the tree is holding
    // uncommitted work. Everything else about the workspace is the panel's,
    // shown when the box is selected — so all this passes is what it is about.
    const header = /** @type {any} */ (box.querySelector('.conversation-box-header'));
    header?.setContext({ session: this._session, workspace });

    const label = workspace.label || workspace.root || '';
    if (box.getAttribute('aria-label') !== label) box.setAttribute('aria-label', label);

    // The same selected state a tab carries, for the same reason and in the
    // same colours: the strip is one list of things to choose between, and it
    // was asked once, by render(), which thing that is.
    const chosen = selectedWorkspaceId === workspace.id;
    box.classList.toggle('active', chosen);
    box.setAttribute('aria-current', chosen ? 'true' : 'false');

    return /** @type {HTMLElement} */ (box.querySelector('.conversation-box-tabs'));
  }

  /**
   * Put a run of tabs in order inside one container, moving only the ones that
   * are out of place. See render() for why that matters.
   * @param {HTMLElement} container - Where this run is drawn.
   * @param {ChildNode|null} start - The node the run begins at.
   * @param {any[]} members - The conversations, in the order they are drawn.
   * @returns {ChildNode|null} The node the next run begins at.
   * @private
   */
  _orderTabs(container, start, members) {
    let expected = start;
    for (const conv of members) {
      const tab = this._cachedElements.get(conv.id);
      if (!tab) continue;
      if (tab !== expected) container.insertBefore(tab, expected);
      expected = tab.nextSibling;
    }
    return expected;
  }

  /**
   * The strip passes into the gesture's hands.
   *
   * A tab and a whole box are dragged by different code and claim the strip in
   * exactly the same way, so they claim it here: whatever a gesture is of, what
   * it does to the strip around it is one thing, said once.
   * @returns {void}
   * @private
   */
  _dragStarted() {
    this._dragging = true;
    this._showCreateRows(false);
  }

  /**
   * The strip goes back to the session.
   * @param {boolean} dragged - Whether the press ever became a drag.
   * @returns {void}
   * @private
   */
  _dragEnded(dragged) {
    this._dragging = false;
    this._showCreateRows(true);
    // Draw whatever arrived while the strip was held — including the
    // arrangement this gesture has just committed. The commit runs first and its
    // notify lands while _dragging is still true, so without this the strip
    // keeps the drag's arrangement until some later, unrelated event happens to
    // repaint it.
    if (this._renderDeferred) {
      this._renderDeferred = false;
      this.render();
    }
    if (!dragged) return;
    // The release that ends a drag also produces a click, which would otherwise
    // act on whatever the item landed on: the conversation whose tab it is, or
    // the workspace whose box it is.
    this._dragJustOccurred = true;
    setTimeout(() => { this._dragJustOccurred = false; }, 100);
  }

  /**
   * Show or hide the rows that make something, for the length of a gesture.
   *
   * Neither is somewhere to land, and a drag is about the places something can
   * go — so while something is in the air they are only ever in the way, each in
   * its own manner. The outline at the foot is in the way twice over: a drop
   * aimed at the bottom of the bar is aimed over it, and the placeholder a drag
   * past the end leaves behind is drawn below it. The "+" at the top is in the
   * way of the pointer, which passes over it holding a tab and lights it up on
   * the way — and a pointer the gesture has captured never tells it that it left,
   * so the button it lit stays lit after the drag is over.
   *
   * Making a conversation or a workspace is also not an offer worth leaving open
   * while one is being moved. So both stand aside, and both come back whether
   * the drag landed or was abandoned. What standing aside looks like is the
   * stylesheet's: the mark goes on here, the fade and the layout are there.
   * @param {boolean} shown - Whether they are drawn.
   * @returns {void}
   * @private
   */
  _showCreateRows(shown) {
    for (const key of CREATE_ROW_KEYS) {
      const row = /** @type {HTMLElement|undefined} */ (this._cachedElements.get(key));
      row?.classList.toggle('stands-aside', !shown);
    }
  }

  /**
   * Which workspace's box something in the strip is drawn inside.
   * @param {HTMLElement} element - A tab, or anything else in the strip.
   * @returns {string} The workspace id, or '' for the flat strip — which is the
   *   project folder, and is spelled the same way a binding to it is.
   * @private
   */
  _workspaceBoxOf(element) {
    const box = /** @type {HTMLElement|null} */ (element.closest('.conversation-box'));
    return box?.dataset.workspaceId ?? '';
  }

  /**
   * The places a drop can land in one list: its tabs, the whole boxes it holds,
   * and the line an empty box shows instead of tabs.
   *
   * A box is one slot rather than a way through to the tabs inside it, which is
   * what makes the strip readable at the top level: from outside, a box is a
   * thing you land above or below, and the only way to land *in* one is to be
   * inside it.
   * @param {HTMLElement} container - The list being read.
   * @param {HTMLElement|null} dragged - The item under the pointer, which is not
   *   a place it can land.
   * @returns {HTMLElement[]} The slots, in the order they are drawn.
   * @private
   */
  _dropSlots(container, dragged) {
    return /** @type {HTMLElement[]} */ (Array.from(container.children)).filter((child) =>
      child !== dragged
      && !child.classList.contains('drag-ghost')
      && (child.classList.contains('conversation-tab')
        || child.classList.contains('conversation-box')
        || (child.classList.contains('conversation-box-empty') && !child.hidden)));
  }

  /**
   * Where a pointer would drop, read from where the boxes actually are.
   *
   * A box is entered, not approached. The strip is a column of lists with a
   * gutter round each box, so there are pointer positions inside the strip and
   * inside no list at all — below the last box, above the first — and at every
   * one of them the nearest tab is a tab drawn inside a box the pointer never
   * went near. Landing a drop in the list that tab happens to live in turns a
   * reorder past a box into a proposal to move a conversation's working tree.
   * So containment decides, and nothing else: a drop is in a box when the
   * pointer is within that box, and is in the strip the rest of the time.
   *
   * Within, less a band below the top edge. Taken at the box's own outline, the
   * whole of "beside this box" was the gap between it and the next one — a few
   * pixels, for a position that is a different act from the ones either side of
   * it and the one an ordinary reorder wants. The band moves that outline down
   * through the header, which is not a row and is not somewhere a tab lands, so
   * the strip between two boxes is three times the width it was and no slot
   * inside a box loses any of its own height.
   *
   * Capped for a box shorter than the band assumes — an empty one is mostly
   * header, and has to stay somewhere a conversation can be dropped.
   *
   * Every rect here is a {@link settledRect}: a gesture asks this again while
   * the last shift it caused is still animating, and where a tab is on its way
   * to is the only thing worth asking about.
   * @param {number} clientX - Pointer x in client coordinates.
   * @param {number} clientY - Pointer y in client coordinates.
   * @param {HTMLElement} dragged - What is being dragged.
   * @returns {{parent: HTMLElement|null, anchor: Element|null}|null} The list to
   *   drop into and what to land in front of, or null before the strip is drawn.
   * @private
   */
  _dropPlaceAt(clientX, clientY, dragged) {
    const tabsMenu = /** @type {HTMLElement|null} */ (this._cachedElements.get('tabs-menu'));
    if (!tabsMenu) return null;

    // The clone a box drag floats under the pointer is a box-shaped thing that
    // is nowhere, so it is not somewhere to drop into.
    const box = /** @type {HTMLElement[]} */ (
      Array.from(this.querySelectorAll('.conversation-box:not(.drag-ghost)')))
      .find((candidate) => {
        const rect = settledRect(candidate);
        if (clientX < rect.left || clientX > rect.right) return false;
        const band = Math.min(BOX_TOP_BAND_PX, rect.height / 4);
        return clientY >= rect.top + band && clientY <= rect.bottom;
      });

    const list = box
      ? /** @type {HTMLElement|null} */ (box.querySelector('.conversation-box-tabs'))
      : tabsMenu;
    if (!list) return null;

    for (const slot of this._dropSlots(list, dragged)) {
      const rect = settledRect(slot);
      if (clientY < rect.top + rect.height / 2) return { parent: list, anchor: slot };
    }
    // Past the last tab in a box is the end of that box, which is a place in the
    // strip and not the end of it: every box ends with its "Nothing here." line,
    // so name that and the landing stays inside the box it was read from. A null
    // anchor is the end of the strip, and the strip is the only thing with one —
    // a box that reported one would be asking for its conversation to be sent to
    // the bottom of the sidebar, and the box is drawn wherever its conversations
    // are, so the box would follow it there.
    const end = box?.querySelector('.conversation-box-empty') ?? null;
    return { parent: list, anchor: box ? end : null };
  }

  /**
   * Record the strip exactly as it is drawn.
   *
   * A drag rearranges the strip under the pointer, and by the time it is let go
   * the arrangement on screen *is* the answer: the tabs are in their new order
   * and each box is between the tabs the user put it between. So the drop reads
   * it off, top to bottom, and hands the session the lot.
   *
   * Nothing works the arrangement out a second time, because the one thing a
   * drop landed in front of cannot describe it: above a box and below it name
   * the same neighbour, and a box the drop never touched would be left to a
   * place derived from the conversation list, which the drop has just
   * rewritten. Neither fault shows until the strip redraws from what was
   * recorded, by which time the user is looking at something they never asked
   * for.
   * @param {string} [moved] - The conversation the gesture moved, for the redraw.
   * @returns {void}
   * @private
   */
  _commitArrangement(moved = '') {
    const arrangement = this._readArrangement();
    if (arrangement) this._session?.applyStripArrangement({ ...arrangement, moved });
  }

  /**
   * The strip as it is drawn, in the terms the session records it in.
   *
   * Read rather than written, because a drop that has a question to ask first
   * must take the arrangement while it is still on the screen and hand it over
   * only when the question has been answered — see {@link _startDrag}. The
   * reading and the recording are the same reading either way: there is one
   * arrangement, and it is this one.
   *
   * The dragged tab is in this walk like any other: it is left in the strip as
   * the drag's placeholder, in the place it landed.
   * @returns {{order: string[], places: Map<string, string>}|null} The strip, or
   *   null before there is one to read.
   * @private
   */
  _readArrangement() {
    // Read from the document rather than the element cache: what is being
    // recorded is what is on the screen, and the screen is the only thing that
    // cannot be out of date with itself.
    const tabsMenu = /** @type {HTMLElement|null} */ (this.querySelector('.conversation-tabs'));
    if (!tabsMenu || !this._session) return null;

    /** @type {string[]} */
    const order = [];
    /** @type {Map<string, string>} */
    const places = new Map();

    for (const slot of this._dropSlots(tabsMenu, null)) {
      if (slot.classList.contains('conversation-tab')) {
        const id = slot.dataset.conversationId;
        if (id) order.push(id);
        continue;
      }
      const workspaceId = slot.dataset.workspaceId;
      if (!workspaceId) continue;

      // Where the box sits, said in the only terms a place has: the tab above
      // it, or the head of the bar when there is nothing above it. Its own
      // members come after it in the order, which is what makes that reading
      // land the box in front of them again.
      places.set(workspaceId, order[order.length - 1] ?? 'head');
      for (const member of Array.from(slot.querySelectorAll('.conversation-tab'))) {
        const id = /** @type {HTMLElement} */ (member).dataset.conversationId;
        if (id) order.push(id);
      }
    }

    return { order, places };
  }

  /**
   * Render or update a tab element for a conversation (diff-based update)
   * @param {import('../model/conversation.js').default} conv - The conversation
   * @param {string|null} visibleId - The currently visible conversation ID
   * @param {HTMLElement} container - The list this tab is drawn in: the strip
   *   itself, or the tabs of the box for the workspace it works in
   * @private
   */
  _renderOrUpdateTab(conv, visibleId, container) {
    const name = conv.name || UNTITLED_BASE;
    const isActive = conv.id === visibleId;

    // Get existing tab element or create new one
    let tab = /** @type {HTMLElement|null} */ (this._cachedElements.get(conv.id));

    if (!tab) {
      // Create new tab element
      tab = document.createElement('li');
      tab.className = 'conversation-tab';
      tab.dataset.conversationId = conv.id;

      tab.innerHTML = `
        ${DRAG_GRIP_HTML}
        <button class="conversation-tab-button">
          <span class="conversation-tab-name"></span>
        </button>
      `;
      const newName = tab.querySelector('.conversation-tab-name');
      if (newName) newName.textContent = name;

      this._cachedElements.set(conv.id, tab);

      // Attach event listeners (only once per tab)
      this._attachTabEventListeners(tab, conv.id);

      // Add to DOM (render() reorders to the correct position after this).
      container.appendChild(tab);
    } else {
      // Update existing tab in-place. DO NOT re-append unconditionally:
      // moving a node restarts its CSS animations (status-bar pulse).
      // render() fixes order separately and only moves nodes that need to move.
      const tabName = tab.querySelector('.conversation-tab-name');

      // Don't disturb the input while the user is mid-rename. Closing the editor
      // removes .is-renaming, and a subsequent render() paints the name.
      // Compare before writing: assigning textContent replaces the text node
      // even when the string is identical, and this runs on every render.
      if (tabName && !tab.classList.contains('is-renaming') && tabName.textContent !== name) {
        tabName.textContent = name;
      }
    }

    // Update classes (toggle rather than overwrite — overwriting .className
    // would clear .is-running and restart the CSS pulse animation).
    tab.classList.toggle('active', isActive);
    tab.classList.add('has-close');

    // Scroll the active tab into view, but ONLY when the selection has actually
    // moved — never on every render. The smooth scroll is an animation, and
    // re-issuing it each pass would leave the tab list permanently in motion
    // while a turn streams, which loses clicks aimed at other tabs (see
    // _lastScrolledTabId). requestAnimationFrame lets the DOM settle first.
    if (isActive && this._lastScrolledTabId !== conv.id) {
      this._lastScrolledTabId = conv.id;
      requestAnimationFrame(() => {
        tab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      });
    }

    // Clock, shown while a send is scheduled on any of this conversation's
    // threads. It has its own slot ahead of the trailing one because a send
    // waiting for the end of the turn is armed WHILE that turn runs — so the
    // clock and the activity blob have to be readable at the same time.
    let schedule = /** @type {HTMLElement|null} */ (tab.querySelector('.conversation-tab-schedule'));
    if (!schedule) {
      schedule = document.createElement('span');
      schedule.className = 'conversation-tab-schedule';
      schedule.title = 'A send is scheduled';
      schedule.setAttribute('aria-hidden', 'true');
      schedule.innerHTML = CLOCK_SVG;
      tab.appendChild(schedule);
    }

    // The trailing slot holds two mutually-exclusive elements at the same size:
    // the activity blob (pulsing green circle, shown while the LLM loop runs)
    // and the bin button. CSS shows whichever fits the tab's state —
    // archiving is suppressed mid-loop, so the layout never shifts.
    let activity = tab.querySelector('.conversation-tab-activity');
    if (!activity) {
      activity = document.createElement('span');
      activity.className = 'conversation-tab-activity';
      activity.setAttribute('aria-hidden', 'true');
      tab.appendChild(activity);
    }

    // Every tab carries a "move to bin" button (the last one included —
    // binning to an empty session is allowed). It's hover-only (see CSS); the
    // Bin entry at the bottom of the bar keeps the feature discoverable
    // without per-tab visual clutter.
    let binButton = /** @type {HTMLButtonElement|null} */ (tab.querySelector('.conversation-tab-bin'));
    if (!binButton) {
      binButton = document.createElement('button');
      binButton.className = 'conversation-tab-bin';
      binButton.title = 'Move conversation to bin';
      // The tooltip-manager appends the platform-correct combo (e.g. " (⌘⌫)")
      // from this shortcut id — no hard-coded key text in the markup.
      binButton.setAttribute('data-shortcut-id', 'bin-conversation');
      binButton.setAttribute('aria-label', `Move ${name} to bin`);
      binButton.innerHTML = BIN_ICON_SVG;
      tab.appendChild(binButton);

      binButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this._binConversation(conv.id);
      });
    } else {
      // Only when it changed — an attribute write invalidates on every render.
      const binLabel = `Move ${name} to bin`;
      if (binButton.getAttribute('aria-label') !== binLabel) {
        binButton.setAttribute('aria-label', binLabel);
      }
    }

    // Sync the running / awaiting-approval indicator classes for this conversation.
    this._refreshTabStatus(conv.id);
  }

  /**
   * Toggle the indicator classes (.is-running / .is-awaiting from the current
   * LLMState, .has-scheduled-send from scheduledSendService) on a single tab.
   * Targeted update — no full re-render.
   *
   * `.is-awaiting` pulses the whole tab yellow for as long as the approval is
   * parked, which makes it the tab bar's loudest demand for attention — so it is
   * suppressed when the user has turned tab highlighting off, leaving an
   * awaiting tab looking exactly like an idle one. Only the paint is gated:
   * {@link _conversationActivity} still reports the true state, so the bin guard
   * and every other consumer are unaffected.
   * @param {string} convId
   * @private
   */
  _refreshTabStatus(convId) {
    const tab = this._cachedElements.get(convId);
    if (!tab) return;
    const { awaiting, running } = this._conversationActivity(convId);
    tab.classList.toggle('is-awaiting', awaiting && isTabHighlightEnabled());
    tab.classList.toggle('is-running', running);
    // Read from the service's set rather than the drafts: this runs on every
    // render, and walking the thread tree here would allocate a MessageThread
    // per thread once a frame while a turn streams.
    tab.classList.toggle('has-scheduled-send', scheduledSendService.hasArmedSchedule(convId));
  }

  /**
   * Repaint every tab's status classes. Used when something other than a
   * conversation's own state changes what a tab should look like — namely the
   * tab-highlight preference, which must take effect on tabs already pulsing
   * rather than at the next status change.
   * @private
   */
  _refreshAllTabStatus() {
    for (const convId of this._session?.conversations.keys() || []) {
      this._refreshTabStatus(convId);
    }
  }

  /**
   * Single source of truth for a conversation's live activity, split into the
   * two visually-distinct states a tab can be in. `awaiting` trumps `running`:
   * while a turn is parked on a tool approval the worker keeps publishing
   * processing_tools, so isConversationProcessing() stays true — we report
   * `awaiting` and subtract it back out of `running`. Both consumers read from
   * here so they can never drift:
   *  - _refreshTabStatus paints .is-awaiting (orange) / .is-running (green).
   *  - _isConversationBusy gates binning on `running` ALONE — an awaiting tab is
   *    parked on the user, executes nothing, and bins reversibly, so it is
   *    deliberately NOT busy for the purpose of the bin guard.
   *
   * "Awaiting" comes from Yjs (tool-action state === PENDING / AWAITING_APPROVAL
   * anywhere in the tree) via `Conversation.isAwaitingApproval()` — the shared
   * source of truth across the engine and every viewer, and the same subtraction
   * the registry rebuild makes before deferring to a turn.
   * @param {string} convId
   * @returns {{awaiting: boolean, running: boolean}} The tab's two activity flags.
   * @private
   */
  _conversationActivity(convId) {
    const conv = this._session?.conversations.get(convId);
    const llm = conv?.llmState;
    if (!conv || !llm) return { awaiting: false, running: false };
    const awaiting = conv.isAwaitingApproval();
    return { awaiting, running: !awaiting && llm.isConversationProcessing(convId) };
  }

  /**
   * Attach event listeners to a tab element (called once per tab on creation)
   * @param {HTMLElement} tab - The tab element
   * @param {string} id - The conversation ID
   * @private
   */
  _attachTabEventListeners(tab, id) {
    // Click to switch or rename
    tab.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement|null} */ (e.target);
      if (target?.closest('.conversation-tab-bin')) return;

      // macOS ctrl-click is a secondary click: WebKit fires `contextmenu` (which
      // opens the tab menu) and a plain `click` alongside it. Ignore it here so
      // opening the menu on the active tab doesn't also start a rename.
      if (/** @type {MouseEvent} */ (e).ctrlKey) return;

      this._exitTabListFocus();

      // Prevent click after drag
      if (this._dragJustOccurred) return;

      if (tab.classList.contains('is-renaming')) return;

      if (id === this._session?.visibleConversationId) {
        this._enterRenameMode(id);
      } else {
        this._switchConversation(id, { focusInput: true });
      }
    });

    // Rename rides on click, not dblclick (WebKit/touch misfires dblclick for
    // rapid taps across different elements): first click switches to the tab, a
    // second click on the now-active tab renames it.

    // Drag to reorder. Which pointers may grab where is the shared rule
    // (utils/drag-grip.js): a mouse anywhere on the tab, a finger or pen only
    // from the grip.
    tab.addEventListener('pointerdown', (e) => {
      const event = /** @type {PointerEvent} */ (e);
      if (event.button !== 0) return;
      // A macOS ctrl-click arrives as button 0; it opens the tab menu, so it
      // must not also grab the pointer for a reorder drag.
      if (event.ctrlKey) return;
      const target = /** @type {HTMLElement|null} */ (event.target);
      if (target?.closest('.conversation-tab-bin')) return;
      if (target?.closest('.inline-rename')) return;
      if (!pointerMayGrab(event)) return;
      this._startDrag(event, tab);
    });
  }

  /**
   * Switch to a different conversation.
   * @param {string} conversationId
   * @param {{focusInput?: boolean}} [options]
   * @private
   */
  _switchConversation(conversationId, options = {}) {
    const { focusInput = false } = options;
    if (!this._session) {
      return;
    }

    const success = this._session.switchConversation(conversationId);
    if (!success) {
      console.error('[ConversationBar] Failed to switch conversation:', conversationId);
      return;
    }

    if (focusInput) {
      requestAnimationFrame(() => {
        const activeTab = /** @type {any} */ (this._tabElements.get(conversationId));
        activeTab?._focusInput?.();
      });
    }
  }

  /**
   * Move a conversation to the bin (.juggler/bin/). No confirmation, ever:
   * binning is reversible from the Bin modal at any time. Plays a brief
   * fly-into-Bin animation in parallel with the backend call, honoring
   * prefers-reduced-motion, and offers a few seconds of Undo above the Bin for
   * the click the user regrets immediately.
   *
   * Nothing is asked about the workspace it was working in, even when it was
   * the last thing working there. A workspace outliving its conversations is
   * the normal case and it is drawn: its box stays in the strip, saying it is
   * empty and holding every ending its provider offers. There is no last chance
   * to be the reason for a question, so there is no question.
   * @param {string} conversationId
   * @private
   * @async
   */
  async _binConversation(conversationId) {
    if (!this._session) {
      return;
    }
    // Refuse only while a turn is genuinely in flight (.is-running): binning
    // mid-stream would orphan it at the turn boundary. An awaiting-approval tab
    // is parked on the user and executes nothing, so it bins reversibly and is
    // intentionally allowed through. The per-tab bin button is already hidden by
    // CSS while .is-running, but that's cosmetic and races the
    // just-sent→is-running transition, and the context-menu "Move to Bin" has no
    // CSS gate at all — so this guard backstops every affordance at the single
    // action site they all route through.
    if (this._isConversationBusy(conversationId)) {
      return;
    }
    if (this._binningIds.has(conversationId)) {
      return;
    }
    // The tab flies only when the bin behind it will actually happen. A
    // conversation the session no longer holds is precisely the case
    // binConversation refuses, and flying the tab for it would take the tab
    // away and leave the conversation — so the next render, reading the map,
    // puts the tab straight back. Checked here rather than inferred from the
    // return value, which arrives a round-trip too late to withhold an
    // animation that has already played.
    if (!this._session.conversations.has(conversationId)) {
      return;
    }

    this._binningIds.add(conversationId);
    try {
      this._flyTabToBin(conversationId);
      const binned = await this._session.binConversation(conversationId);
      if (binned) {
        this._showBinUndo(conversationId);
      }
    } finally {
      this._binningIds.delete(conversationId);
    }
  }

  /**
   * Show the transient Undo button above the Bin.
   *
   * One button, always about the most recent bin: a second bin retargets it and
   * restarts the clock rather than stacking, so it can only ever undo the thing
   * the user just did. When it times out nothing is lost — the Bin below it
   * holds the conversation until the user empties it.
   * @param {string} conversationId - Conversation the Undo would restore
   * @private
   */
  _showBinUndo(conversationId) {
    const toast = this._cachedElements.get('bin-undo');
    if (!toast) return;
    this._binUndoId = conversationId;

    // Hide-reflow-show restarts the entrance animation from scratch. It matters
    // on the retarget path: the button is already on screen pointing at the
    // previous bin, and silently repurposing it would let a second bin look
    // like nothing happened.
    toast.hidden = true;
    void toast.offsetWidth;
    toast.hidden = false;

    if (this._binUndoTimer !== null) window.clearTimeout(this._binUndoTimer);
    this._binUndoTimer = window.setTimeout(() => {
      this._binUndoTimer = null;
      this._hideBinUndo();
    }, BIN_UNDO_TIMEOUT_MS);
  }

  /**
   * Retire the bin Undo toast. Safe to call when none is showing.
   * @private
   */
  _hideBinUndo() {
    if (this._binUndoTimer !== null) {
      window.clearTimeout(this._binUndoTimer);
      this._binUndoTimer = null;
    }
    this._binUndoId = null;
    const toast = this._cachedElements.get('bin-undo');
    if (toast) toast.hidden = true;
  }

  /**
   * Restore the conversation the visible toast refers to. The tab comes back
   * via the server's `conversations-changed` op="restored" broadcast, the same
   * path the Bin modal's Restore uses.
   * @private
   * @async
   */
  async _undoBin() {
    const id = this._binUndoId;
    this._hideBinUndo();
    if (!id || !this._session) return;
    try {
      await this._session.restoreConversation(id);
    } catch (e) {
      console.error('[ConversationBar] restore from bin failed:', e);
      await showAlert(
        `Couldn’t restore it from the bin: ${/** @type {any} */ (e)?.message || e}`,
        'Restore failed'
      );
    }
  }

  /**
   * Whether a conversation has a turn genuinely in flight — i.e. the .is-running
   * (green) state: actively streaming or executing, NOT merely parked on a tool
   * approval. Reads the shared _conversationActivity predicate so this can never
   * disagree with the tab's status light. An awaiting-approval tab returns false
   * here on purpose: it executes nothing and bins reversibly. Pure read; safe to
   * call from action handlers.
   * @param {string} conversationId
   * @returns {boolean} True only while a turn is actively running.
   * @private
   */
  _isConversationBusy(conversationId) {
    return this._conversationActivity(conversationId).running;
  }

  /**
   * Duplicate a specific conversation and switch to the clone. Mirrors the
   * Cmd-shortcut path in app.js but targets an explicit conversation id (the
   * right-clicked tab), not necessarily the visible one.
   * @param {string} conversationId
   * @private
   * @async
   */
  async _duplicateConversation(conversationId) {
    if (!this._session) return;
    if (this._session.conversations.size >= MAX_CONVERSATIONS) {
      await showAlert(
        CONVERSATION_LIMIT_MESSAGE,
        'Too many conversations'
      );
      return;
    }
    const newId = await this._session.duplicateConversation(conversationId);
    if (newId) {
      this._session.switchConversation(newId);
    }
  }

  /**
   * Detach the tab from layout and fly it toward the Bin button.
   * No-op if motion is reduced or either element is missing. The tab is
   * removed from `_cachedElements` so the next render() cleanup pass
   * leaves it alone; the animation removes the DOM node itself.
   * @param {string} conversationId
   * @private
   */
  _flyTabToBin(conversationId) {
    const tabEl = this._cachedElements.get(conversationId);
    const binBtn = this._cachedElements.get('bin-button');
    if (!tabEl || !binBtn) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const from = tabEl.getBoundingClientRect();
    const to = binBtn.getBoundingClientRect();
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);

    // Detach from layout so neighbouring tabs collapse smoothly.
    this._cachedElements.delete(conversationId);
    tabEl.style.position = 'fixed';
    tabEl.style.left = `${from.left}px`;
    tabEl.style.top = `${from.top}px`;
    tabEl.style.width = `${from.width}px`;
    tabEl.style.margin = '0';
    tabEl.style.pointerEvents = 'none';
    tabEl.style.zIndex = '1000';
    document.body.appendChild(tabEl);

    const anim = tabEl.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.15)`, opacity: 0 }
      ],
      { duration: 280, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' }
    );
    anim.onfinish = () => tabEl.remove();
    anim.oncancel = () => tabEl.remove();
  }

  /**
   * Open the Bin modal listing binned conversations.
   * @private
   * @async
   */
  async _openBinModal() {
    if (!this._session) return;
    let modal = /** @type {any} */ (document.querySelector('bin-modal'));
    if (!modal) {
      modal = document.createElement('bin-modal');
      document.body.appendChild(modal);
    }
    modal.open(this._session);
  }

  /**
   * Ask what kind of workspace to make, make it, and select the box it lands in.
   *
   * No conversation is started in it. That is the point of being able to make
   * one from here: the place comes first, and what works in it arrives after —
   * started from the box's own "+", dragged into it, or moved there. The box that
   * appears says `No conversations` until one does, which is the invitation.
   * @private
   */
  async _createWorkspace() {
    if (!this._session) return;
    const outcome = await openWorkspaceCreate(this._session);
    if (!outcome.created || !outcome.workspaceId) return;
    // Selected, so that the panel for the thing just made is the thing on
    // screen. A workspace created and then left unselected is a box that
    // appeared in the corner of the eye.
    this._session.selectWorkspace?.(outcome.workspaceId);
    this.render();
  }

  /**
   * Create a new conversation with smart numbering
   * Finds the smallest unused number for "Untitled N"
   * @param {string} [workspaceId] - The workspace it is to work in, when it is
   *   started from that workspace's box. Without one it is a blank tab that has
   *   yet to be told where it works.
   * @private
   */
  async _createConversation(workspaceId = '') {
    if (!this._session) {
      return;
    }

    // Debounce accidental double-activation (notably a double-click on the "+"
    // button): the create is async, so the second click lands before the first
    // `createConversation` resolves and would spawn a second tab. Leading edge —
    // the first activation acts immediately, repeats within the window are
    // swallowed. Stamped before the cap check so a double-click at the cap
    // raises only one alert, and covers every path that funnels here (the "+"
    // click, the new-conversation shortcut/event), not just the button.
    const now = Date.now();
    if (now - this._lastCreateAt < NEW_CONVERSATION_DEBOUNCE_MS) {
      return;
    }
    this._lastCreateAt = now;

    // Cap reached: don't create — point the user at archiving instead. The
    // model enforces the same limit (so duplicate/other paths can't exceed it);
    // pre-checking here keeps the "+" UX side-effect-free (no rename popover).
    if (this._session.conversations.size >= MAX_CONVERSATIONS) {
      await showAlert(
        CONVERSATION_LIMIT_MESSAGE,
        'Too many conversations'
      );
      return;
    }

    // Empty name → the session assigns the canonical "Untitled N" and, because this
    // is an activated unnamed create, asks the bar to open inline rename (see the
    // 'conversation:rename-requested' branch in setSession). The /new command
    // creates the same way, so both share one "name it now" behaviour.
    // Where it works is known before it exists: the workspace whose box it was
    // started in, or the project folder for the "+" at the top of the strip.
    await this._session.createConversation('', {
      activate: true,
      origin: workspaceId ? 'workspace-box' : 'plus-button',
      workspaceId
    });
  }

  /**
   * Move keyboard focus into a conversation's composer. Used on new-tab
   * creation when auto-naming is on: instead of prompting for a name, we drop
   * the user straight into the composer (the LLM names the tab from the first
   * message). Deferred a frame so the freshly-activated tab's composer-box exists
   * and is laid out, matching the tab-switch focus path.
   * @param {string} conversationId
   * @private
   */
  _focusConversationInput(conversationId) {
    requestAnimationFrame(() => {
      const activeTab = /** @type {any} */ (this._tabElements.get(conversationId));
      activeTab?._focusInput?.();
    });
  }


  /**
   * Rename the tab for the given conversation, in place.
   *
   * The editor itself is the shared one (utils/inline-rename.js), opened over
   * the tab `<li>`; what is here is everything true of a conversation and not
   * of anything else that gets renamed — when a rename is allowed at all, how
   * long a name may be, what the server says when it refuses one, and the offer
   * to hand naming back to the model. When the editor closes, however it
   * closes, keyboard focus moves to the visible conversation's message input so
   * the user can type straight after naming.
   * @param {string} conversationId
   * @param {object} [options]
   * @param {string} [options.initialValue] - Seed value for the input,
   *   overriding `conv.name`. The new-tab flow passes the canonical name to
   *   avoid a refresh race where the input briefly shows the wrong value.
   * @private
   */
  _enterRenameMode(conversationId, { initialValue } = {}) {
    if (!this._session) return;

    const conv = this._session.getConversation(conversationId);
    if (!conv) return;

    // Renaming a stub would race the worker's metadata: the rename writes to
    // the doc, then the worker's first metadata observer fires and clobbers
    // the new name with the disk-loaded one. Force the user to wait until
    // hydration finishes (panel spinner makes this state visible).
    if (conv.loadState !== 'loaded') return;

    const tab = /** @type {HTMLElement|null} */ (this._cachedElements.get(conversationId));
    if (!tab) return;

    openInlineRename(tab, {
      value: initialValue ?? conv.name,
      // UI-level enforcement of the shared name-length cap: the browser blocks
      // further typed input at the limit. This editor backs both rename and the
      // "name a new conversation" flow, so both paths are covered here. The data
      // level (Session.renameConversation) is the backstop for paste/programmatic
      // input that can exceed maxlength.
      maxLength: MAX_CONVERSATION_NAME_LENGTH,

      commit: async (newName) => {
        try {
          await /** @type {NonNullable<typeof this._session>} */ (this._session).renameConversation(conv.id, newName);
          return '';
        } catch (e) {
          const code = /** @type {any} */ (e)?.code;
          // A name already taken is the one refusal the user can answer, so it
          // is the one that keeps the editor open. A name the server calls
          // invalid closes it: the editor has nothing to add that the empty
          // result doesn't already say.
          if (code === 'COLLISION') {
            return `“${newName}” is already used by another conversation.`;
          }
          if (code !== 'INVALID') {
            await showAlert(
              `Couldn't rename the conversation: ${/** @type {any} */ (e)?.message || e}`,
              'Rename failed'
            );
          }
          return '';
        }
      },

      // "Auto-name": hand off to the model to name the tab from the first
      // message instead of typing a name. Only offered once the conversation has
      // a first user message to derive from — for a brand-new empty tab there's
      // nothing to name, and the request would be a server-side no-op, so the
      // button is omitted entirely (the empty actions row then collapses).
      // pointerdown preventDefault keeps focus on the input so the button press
      // doesn't trigger a blur→commit of the current (unchanged) value first. The
      // server renames + broadcasts, which updates the tab; we just close the editor.
      actions: ({ close }) => {
        if (!conv.hasAutoNameSource()) return null;
        const autoNameBtn = document.createElement('button');
        autoNameBtn.type = 'button';
        autoNameBtn.className = 'conversation-tab-auto-name';
        autoNameBtn.textContent = 'Auto-name';
        autoNameBtn.title = 'Let the model name this conversation from your first message';
        autoNameBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); });
        autoNameBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const session = /** @type {NonNullable<typeof this._session>} */ (this._session);
          // The user handed naming back to the model, so the tab's name is
          // provisional again — mark it before requesting, so a later /handoff of
          // this conversation stays eligible for a derived title.
          session.setNameIsProvisional(conv.id, true);
          session.requestAutoName(conv.id);
          close();
        });
        return autoNameBtn;
      },

      // A tab being renamed is left alone by every repaint (_renderOrUpdateTab
      // will not write a name under an open field), so the tab is still showing
      // the old name until a render lands after the editor has gone. This is
      // that render: every way out of the editor ends here, and the renders
      // during the rename — this bar's own, and the server's echo of the
      // broadcast — all landed while the field was still over the tab.
      //
      // Then hand off to the visible conversation's composer-box so the user can
      // type straight after naming. We look it up through the conversation-tab
      // element registered with the bar rather than a global query, so the
      // lookup stays correct even when multiple conversation-tabs are mounted
      // side-by-side.
      onClose: () => {
        this.render();
        const tabEl = this._tabElements.get(conversationId);
        const textarea = /** @type {HTMLTextAreaElement|null} */ (
          tabEl?.querySelector('composer-box textarea') || null
        );
        textarea?.focus();
      },
    });
  }


  /**
   * Rename a workspace, in place on the box drawn for it.
   *
   * The same editor a tab opens (utils/inline-rename.js), over the row the name
   * is on rather than over the whole box: what is being renamed is the place,
   * and the conversations drawn below it are not part of the question.
   *
   * A label is only ever a name — nothing on disk is called after it, and two
   * workspaces are free to share one — so there is nothing to refuse here that
   * the server will not refuse itself, and no confirmation to ask for.
   * @param {string} workspaceId - The workspace to rename.
   * @private
   */
  _enterWorkspaceRenameMode(workspaceId) {
    if (!this._session) return;

    const workspace = this._session.getWorkspace(workspaceId);
    if (!workspace) return;

    const top = /** @type {HTMLElement|null} */ (
      this._workspaceBoxes.get(workspaceId)?.querySelector('.conversation-box-top') || null
    );
    if (!top) return;

    openInlineRename(top, {
      // The label alone, never the root the box falls back to showing: a
      // workspace with no label has no name yet, and offering its path as one to
      // edit would make a name out of a fallback.
      value: workspace.label || '',
      maxLength: MAX_WORKSPACE_LABEL_LENGTH,

      commit: async (label) => {
        try {
          await /** @type {NonNullable<typeof this._session>} */ (this._session).renameWorkspace(workspaceId, label);
          this.render();
          return '';
        } catch (e) {
          // Whatever the server refused for — a workspace finished with while
          // the editor was open, a label longer than it stores — the name is
          // still in the field to be fixed or abandoned, so the editor stays
          // open and says what happened.
          return `Couldn't rename it: ${/** @type {any} */ (e)?.message || e}`;
        }
      },
    });
  }


  /**
   * Drag a tab to reorder it, on the shared gesture (utils/reorder-drag.js).
   *
   * The strip is one column that scrolls rather than wraps, so the drag is read
   * along the Y axis and the clone keeps the tab's column. The clone is parked
   * on the bar itself rather than in the list, so it escapes the list's
   * `overflow: auto` clip and can travel the full height of the sidebar.
   *
   * What lands is decided here, because the order is the session's: the module
   * reports a position and this turns it into the move that persists it.
   * @param {PointerEvent} e - The pointerdown that started it.
   * @param {HTMLElement} tab - The tab being dragged.
   * @private
   */
  _startDrag(e, tab) {
    // The menu is both the box the drag auto-scrolls and the strip the
    // stylesheet gates the shift animation on. It has to be named rather than
    // left to default to the tab's parent, because a tab drawn inside a
    // workspace box has that box's list for a parent: the mark would land on
    // something no rule mentions, and the tabs shoved aside would jump to their
    // new slots instead of travelling to them.
    const tabsMenu = /** @type {HTMLElement|null} */ (this.querySelector('.conversation-tabs'));
    // Every place a tab can land, top to bottom. The floating clone lives on
    // the host yet still carries the tab class, so it has to be kept out.
    //
    // A box with nothing in it is a slot too. Its "No conversations" line sits
    // exactly where its tabs would, and a drag lands in front of something —
    // without it, the workspace that outlived its conversations would be the
    // one box you could not put a conversation back into.
    const listTabs = () => /** @type {HTMLElement[]} */ (
      Array.from(this.querySelectorAll(
        '.conversation-tab:not(.drag-ghost), .conversation-box-empty:not([hidden])'))
    );

    // Which box this tab was drawn in when it was picked up. Read from the DOM
    // rather than from its binding: a conversation whose workspace cannot be
    // worked in is drawn flat, and dragging it about the strip is a reorder
    // like any other — it is the box it visibly leaves that makes a drop a move.
    const homeWorkspaceId = this._workspaceBoxOf(tab);

    // The strip is claimed from the press, not from the moment the gesture
    // passes its slop threshold. A bump or a remote reorder landing in between
    // would rearrange the tabs under a finger already down, leaving the drag
    // measuring against one strip and the user looking at another.
    this._dragging = true;

    startReorderDrag(e, {
      item: tab,
      items: listTabs,
      strip: tabsMenu,
      ghostHost: this,
      scrollContainer: tabsMenu,
      axis: 'y',
      dropPlaceAt: (clientX, clientY) => this._dropPlaceAt(clientX, clientY, tab),
      prepareGhost: (clone) => {
        // A copy of a tab is not a tab: render()'s reconciliation and the
        // element cache both key on the conversation id, and a tab caught
        // mid-rename would clone its overlay along with it.
        clone.classList.remove('is-renaming');
        clone.removeAttribute('data-conversation-id');
      },
      onDragStart: () => this._dragStarted(),
      onDragEnd: ({ dragged }) => this._dragEnded(dragged),
      onCommit: () => {
        const draggedId = tab.dataset.conversationId;
        if (!draggedId || !this._session) return;

        // A drop in another box is a rebinding, and a rebinding is not
        // something an eighth of a second of slipped finger may do: it moves
        // where a conversation's files and commands happen, under an agent that
        // may be working. So the gesture confirms itself first, through the
        // dialog that owns the move — which is told where the tab landed, since
        // the drop has already said. The strip goes back to what the session
        // says in the meantime: render() is held for the length of a gesture and
        // draws the tab back in the box it came from as it lets go.
        //
        // The question is only ever about the binding. Where in the strip the
        // tab goes was settled by the gesture, so it is read off the screen here
        // — before the snap-back, which is the last moment it is there to read —
        // and handed over when the move is agreed to. Nothing downstream of the
        // drop knows where the drop was: a rebinding places a conversation the
        // way a new one is placed, which is a different question with a
        // different answer.
        //
        // A move that cannot happen is said here instead, because a dialog
        // asking whether to do something it will then refuse puts the user's
        // answer and the outcome the wrong way round: they are made to decide,
        // and then told it was never theirs to decide. The service asks the same
        // question again when it writes — this is the drop declining to raise a
        // question it already knows the answer to, not the check itself.
        const landedIn = this._workspaceBoxOf(tab);
        const dragged = this._session.conversations.get(draggedId);
        if (dragged && landedIn !== homeWorkspaceId) {
          const arrangement = this._readArrangement();
          this.render();
          const refusal = whyNotRebind(dragged, landedIn);
          if (refusal) {
            showNotice(refusal);
            return;
          }
          const session = this._session;
          void openWorkspaceMove(dragged, landedIn).then(({ moved }) => {
            // A move declined, or refused when it came to be written, has moved
            // nothing: the strip is already back to what the session says, and
            // the arrangement goes with the question. A window that has moved
            // on to another session keeps it too — the strip that was dropped
            // in is not the one on the screen.
            if (!moved || !arrangement || this._session !== session) return;
            session.applyStripArrangement({ ...arrangement, moved: draggedId });
          });
          return;
        }

        // Everything else the drop has to say is on the screen already.
        this._commitArrangement(draggedId);
      },
    });
  }

  /**
   * Drag a whole workspace box to a new place in the strip.
   *
   * A box travels among the tabs and boxes at the top level and never inside
   * another one: a workspace does not live in a workspace, so the only
   * containment question a tab drag has to answer does not arise here.
   *
   * What is committed is the strip as it stands — see {@link _commitArrangement}
   * — which for a box drag is its new place, the place of any box it travelled
   * past, and the conversation order it now reads in: a box's members travel
   * with it, because the order is the strip top to bottom and they are drawn
   * inside the thing that moved. None of that is visible in the strip beyond
   * the box having moved, which is what was asked for. A box with nothing in it
   * commits the same field as any other: having no members to speak for it is
   * no longer having nothing to say.
   * @param {PointerEvent} e - The pointerdown that started it.
   * @param {HTMLElement} box - The box being dragged.
   * @private
   */
  _startBoxDrag(e, box) {
    const tabsMenu = /** @type {HTMLElement|null} */ (this._cachedElements.get('tabs-menu'));
    if (!tabsMenu) return;
    const scrollContainer = /** @type {HTMLElement|null} */ (this.querySelector('.conversation-tabs'));

    this._dragging = true;

    startReorderDrag(e, {
      item: box,
      items: () => this._dropSlots(tabsMenu, null),
      strip: tabsMenu,
      ghostHost: this,
      scrollContainer,
      axis: 'y',
      dropPlaceAt: (clientX, clientY) => {
        for (const slot of this._dropSlots(tabsMenu, box)) {
          const rect = settledRect(slot);
          if (clientY < rect.top + rect.height / 2) return { parent: tabsMenu, anchor: slot };
        }
        return { parent: tabsMenu, anchor: null };
      },
      prepareGhost: (clone) => {
        // A copy of a box is not a box, and the tabs drawn in the copy are not
        // tabs: everything that reads the strip keys on these identities, and a
        // picture of the strip answering to them would be read as part of it.
        clone.removeAttribute('data-workspace-id');
        for (const tab of Array.from(clone.querySelectorAll('.conversation-tab'))) {
          tab.removeAttribute('data-conversation-id');
        }
      },
      onDragStart: () => this._dragStarted(),
      onDragEnd: ({ dragged }) => this._dragEnded(dragged),
      onCommit: () => this._commitArrangement(),
    });
  }

  /**
   * Auto-fit sidebar width to the widest tab (deterministic — measures every
   * tab li in an unbounded off-screen container, so the result doesn't depend
   * on the sidebar's current width).
   *
   * Triggered by double-clicking the resize handle.
   * @private
   */
  _autoFitWidth() {
    const tabs = Array.from(this.querySelectorAll('.conversation-tab:not(.drag-ghost)'))
      .map(el => /** @type {HTMLElement} */ (el));
    const tabsMenu = /** @type {HTMLElement|null} */ (this._cachedElements.get('tabs-menu'));
    if (!tabs.length || !tabsMenu) return;

    // Off-screen sizing host appended to the menu so it inherits exactly the
    // same fonts/padding/box-sizing cascade as the real tabs. Each tab is
    // cloned, given an unbounded layout (auto width, no wrapping), measured,
    // then thrown away. The sizing host is hidden and removed before return.
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;width:max-content;display:block;';
    tabsMenu.appendChild(host);

    let maxTabWidth = 0;
    for (const tab of tabs) {
      const clone = /** @type {HTMLElement} */ (tab.cloneNode(true));
      // Strip any drag-related inline transform/state so a tab that happens to be
      // mid-drag (an invisible .drag-source) still measures at its natural size.
      clone.style.transform = '';
      clone.style.visibility = '';
      clone.classList.remove('drag-source');
      // Force natural width on the clone and its name span.
      clone.style.width = 'max-content';
      clone.style.flex = '0 0 auto';
      clone.style.maxWidth = 'none';
      clone.style.whiteSpace = 'nowrap';
      const name = /** @type {HTMLElement|null} */ (clone.querySelector('.conversation-tab-name'));
      if (name) {
        name.style.flex = '0 0 auto';
        name.style.overflow = 'visible';
        name.style.textOverflow = 'clip';
        name.style.maxWidth = 'none';
        name.style.whiteSpace = 'nowrap';
      }
      host.appendChild(clone);
      const cloneWidth = clone.getBoundingClientRect().width;
      host.removeChild(clone);
      // A tab inside a workspace box is inset by the box's own chrome, which
      // the clone — measured at the top level — does not carry. Measured off
      // the box rather than assumed, so a change to the CSS cannot leave this
      // fitting to a width the tabs no longer have. The header is deliberately
      // not measured: it truncates, and a long branch name must not be able to
      // widen the whole sidebar.
      const body = tab.parentElement;
      const box = body?.closest('.conversation-box');
      const inset = box && body
        ? box.getBoundingClientRect().width - body.getBoundingClientRect().width
        : 0;
      if (cloneWidth + inset > maxTabWidth) maxTabWidth = cloneWidth + inset;
    }

    tabsMenu.removeChild(host);

    // Outer chrome that the tab li doesn't include: the menu's own padding +
    // reserved scrollbar gutter + the sidebar's right-edge resize handle.
    const menuStyle = window.getComputedStyle(tabsMenu);
    const menuPadLeft = parseFloat(menuStyle.paddingLeft) || 0;
    const menuPadRight = parseFloat(menuStyle.paddingRight) || 0;
    const scrollbarGutter = Math.max(0, tabsMenu.offsetWidth - tabsMenu.clientWidth);
    const handleEl = /** @type {HTMLElement|null} */ (this.querySelector(':scope > col-resize-handle'));
    const handleWidth = handleEl ? handleEl.getBoundingClientRect().width : 0;

    const remPx = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
    // Extra 1rem of breathing room so descenders/italic glyphs don't ellipsise.
    const target = Math.max(
      8 * remPx,
      Math.min(
        50 * remPx,
        Math.ceil(maxTabWidth + menuPadLeft + menuPadRight + scrollbarGutter + handleWidth + remPx)
      )
    );

    applyColumnWidthPx(this, 'juggler-tab-sidebar-width', target, 8);
  }
}

// Register custom element
customElements.define('conversation-bar', ConversationBar);

// Export for modules
/** @type {WindowWithConversationBar} */ (/** @type {any} */ (window)).ConversationBar = ConversationBar;

// Right-click menu for conversation tabs in the bar. Wired to the active bar's
// own helpers so rename/duplicate/bin behave exactly like the built-in
// affordances. Targets the tab `<li>` carrying the conversation id.
registerContextMenuProvider({
  match: (start) => start?.closest('.conversation-tab[data-conversation-id]') || null,
  build: (subject) => {
    const bar = /** @type {any} */ (_activeBar);
    const convId = /** @type {HTMLElement} */ (subject).dataset.conversationId || '';
    if (!bar || !convId) return null;
    /** @type {import('../services/context-menu-service.js').ContextMenuItem[]} */
    const items = [
      { label: 'Rename', onClick: () => bar._enterRenameMode(convId) },
      { label: 'Duplicate', onClick: () => { void bar._duplicateConversation(convId); } },
    ];
    // Omit "Move to Bin" mid-loop — same intent as the CSS that hides the
    // per-tab bin button while running. _binConversation enforces this too;
    // dropping the entry keeps the menu honest rather than offering a no-op.
    if (!bar._isConversationBusy(convId)) {
      items.push(
        { separator: true },
        { label: 'Move to Bin', danger: true, onClick: () => { void bar._binConversation(convId); } }
      );
    }
    return items;
  },
});

// Right-click menu for the workspace boxes. Rename is all it offers: everything
// else a workspace can be asked — where it is, how it is doing, the ways of
// finishing with it — is <workspace-panel>'s, where there is room to read it.
//
// A tab inside a box is still a tab, and claimed here first so it cannot be:
// the menus resolve in registration order, and a right-click that renamed the
// place instead of the conversation would be the same click doing two things.
registerContextMenuProvider({
  match: (start) => {
    if (start?.closest('.conversation-tab[data-conversation-id]')) return null;
    return start?.closest('.conversation-box[data-workspace-id]') || null;
  },
  build: (subject) => {
    const bar = /** @type {any} */ (_activeBar);
    const workspaceId = /** @type {HTMLElement} */ (subject).dataset.workspaceId || '';
    if (!bar || !workspaceId) return null;
    return [{ label: 'Rename', onClick: () => bar._enterWorkspaceRenameMode(workspaceId) }];
  },
});

export default ConversationBar;
