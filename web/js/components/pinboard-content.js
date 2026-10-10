//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <pinboard-content> — the pinboard's bottom band: the active pin's toolbar, and
 * below it the body its item type fills. Only the active pin is mounted; the rest
 * are tabs and nothing more.
 *
 * The host owns everything around the body — the title, the toolbar controls, the
 * loading and error shells, the placeholder for a pin whose extension has gone
 * away. An item type that throws is shown in its own place rather than taking the
 * board down with it, and the error text it threw is shown as it stands. Its
 * actions are words and behaviour only: it says `Open`, the host decides that is a
 * button and that the other three go behind the `⋯`.
 *
 * Scroll position is remembered per pin for as long as this viewer has the board,
 * so switching tabs and coming back doesn't lose your place. It is deliberately
 * viewer-local and never leaves this element.
 * @module components/pinboard-content
 */

import JugglerElement from './juggler-element.js';
import pinboardItemRegistry from '../registries/pinboard-item-registry.js';
import pinboardStore from '../services/pinboard-store.js';
import pinboardView from '../services/pinboard-view.js';
import wsService from '../services/websocket.js';
import gitStatusCache from '../services/git-status-cache.js';
import gitReviewService from '../services/git-review-service.js';
import { shellKill, shellTaskStatus } from '../services/ops-api.js';
import { openMenuAt } from '../services/context-menu-service.js';
import { reviewDraftBoundsError } from '../utils/review-draft.js';
import { formatReviewMessage } from '../utils/review-message.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { itemField } from '../../sdk/lib/message.js';
import { formatDisplayPath } from '../../sdk/lib/context-item-utils.js';
import { createFileActions } from '../utils/properties-panel-helpers.js';
import { insertAtCaret } from './composer-paste-tokens.js';
import findBar from './find-bar.js';
import { REFRESH_SVG } from '../utils/icons.js';
import { PINBOARD_BODY_ID } from './pinboard-tabbar.js';
import { THREAD_FOCUS_CHANGED } from './conversation-tab.js';
import { itemGoal } from '../model/thread-alias.js';
import { satelliteLink } from '../services/pinboard-link.js';
import { isPinboardView } from '../utils/view-mode.js';

/** @typedef {import('../services/pinboard-store.js').Pin} Pin */
/** @typedef {import('juggler/pinboard-item-type').PinActiveContext} PinActiveContext */
/** @typedef {import('juggler/pinboard-item-type').PinAction} PinAction */
/** @typedef {import('juggler/pinboard-item-type').PinContextItemSnapshot} PinContextItemSnapshot */
/** @typedef {import('juggler/pinboard-item-type').PinTask} PinTask */

/**
 * The glyphs an item type may ask for by name in a `PinAction`. An action naming
 * anything else is drawn as words, so a pin from an extension written against a
 * later Juggler loses its picture rather than its control.
 * @type {Record<string, string>}
 */
const ACTION_ICONS = { refresh: REFRESH_SVG };

/**
 * How often to ask the server which tasks are still running. The answer is a
 * lookup in an in-memory table, so this is cheap — but it is also the only way
 * the board learns a task has ended, so it should not be lazy either.
 */
const TASK_POLL_MS = 2000;

/**
 * How long a pin's news may wait when frames are not coming.
 *
 * The coalescing wait is a frame, because a frame is how often a change can
 * possibly be seen. But a hidden or occluded WebView is not served frames at
 * all — on macOS an unpainted window's callbacks simply stop — and a board that
 * waited for one would stop updating and never say why. So the frame races a
 * timer, and whichever arrives first delivers: a painting window coalesces to
 * its refresh rate, and one that is not painting still keeps up, ten times a
 * second, with the burst collapsed all the same.
 */
const NOTIFY_FALLBACK_MS = 100;

/**
 * How far the arrow keys scroll a pin, in pixels. Roughly three lines: the
 * browser's own step for a scroll box, arrived at the same way — by what reads
 * as a nudge rather than a jump.
 */
const LINE_STEP_PX = 48;

/**
 * How much of the screen a paged scroll keeps, in pixels. Also the floor on a
 * page, so paging a body barely taller than the overlap still moves.
 */
const PAGE_KEEP_PX = 48;

/**
 * What counts as the way into a pin that named no entry point of its own: the
 * first thing in it a reader could have Tabbed to anyway. Deliberately the
 * ordinary tab-stop set — a pin with something better in mind implements
 * `PinController.focus` and is asked that instead.
 */
const ENTRY_SELECTOR = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), '
  + 'textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The conversation tab on screen, which owns column selection and is therefore
 * the only thing that can reveal a thread.
 * @returns {any} The active `<conversation-tab>`, or null.
 */
function activeTab() {
  return document.querySelector('conversation-tab.active');
}

/**
 * Write generated text into a composer at its caret, on a line of its own.
 *
 * Insertion, never replacement, and through the composer's own
 * {@link insertAtCaret} — so a half-written message survives it, one undo takes
 * the text back out, and the box settles exactly as it would around typing.
 * Nothing is sent: the text sits there to be read back, edited and sent by hand.
 * @param {any} composer - The composer element, or null when there is none.
 * @param {string} text - What to put in it.
 * @returns {boolean} True when the text landed.
 */
function pasteIntoComposer(composer, text) {
  const textarea = /** @type {HTMLTextAreaElement|null} */ (composer?.querySelector?.('textarea'));
  if (!textarea) return false;
  const caret = textarea.selectionStart ?? textarea.value.length;
  const before = textarea.value.slice(0, caret);
  // A caret left mid-sentence gets a break first: the review's header has to
  // start a line to be read as one, rather than spliced into what was there.
  const lead = before !== '' && !before.endsWith('\n') ? '\n' : '';
  insertAtCaret(composer, textarea, lead + text);
  return true;
}

/**
 * The composer bound to one thread, or null when this window has none for it.
 *
 * The thread's own box, found by the binding rather than by what is on screen:
 * `getComposer()` answers with whichever column the user is working in, so a
 * review read on a sub-thread would otherwise be pasted into the root's box. A
 * detached board has no tabs at all, which is how a board window discovers it has
 * nowhere of its own to put text.
 *
 * It must also be a box that is still in the document. A conversation holds on to
 * its tab element after the window has taken it out of the page, and text put in
 * that box is text put nowhere: nobody can see it, and nothing will ever send it.
 * @param {any} thread - The thread whose box is wanted.
 * @returns {any} The composer element, or null.
 */
function composerForThread(thread) {
  const tab = thread?.conversation?.getTabElement?.();
  if (!tab?.isConnected) return null;
  const wanted = thread.threadItemId ?? null;
  return [...tab.querySelectorAll('composer-box')]
    .find((box) => (/** @type {any} */ (box).threadItemId ?? null) === wanted) || null;
}

/**
 * Hand generated text to the user on one thread: into that thread's composer,
 * or — when this window has no box for it — sent as an ordinary message rather
 * than dropped.
 *
 * Exported for the same reason {@link revealInConversation} is: it happens in
 * whichever window has the columns. A detached board relays it to the window it
 * was opened from, and that window runs this, so both ends do the identical thing
 * and a pin never has to know which window it is in.
 * @param {any} thread - The thread the text belongs to.
 * @param {string} text - The message.
 * @returns {Promise<void>} Resolves once it is in the box, or away.
 */
export async function composeForThread(thread, text) {
  if (pasteIntoComposer(composerForThread(thread), text)) return;
  const reason = await thread.conversation.sendMessage(
    text, thread.threadItemId ?? null, thread,
    { consumeComposer: false, interpretCommands: false }
  );
  if (reason) throw new Error(`Couldn't send the review: ${reason}`);
}

/**
 * Point the conversation at something a pin found: a thread's column, or one
 * item wherever it lives.
 *
 * Exported because a reveal always happens *here*, in the window that has the
 * columns — a detached board sends it to the window it was detached from, and
 * that window runs this. Both ends therefore do the identical thing, which is
 * what lets a pin be written without knowing which window it is in.
 * @param {{kind: string, id: string|null}} target - What to point at.
 * @returns {void}
 */
export function revealInConversation(target) {
  const tab = activeTab();
  if (!tab) return;
  if (target.kind === 'thread') {
    tab.revealThread?.(target.id ?? null);
    return;
  }
  if (target.kind === 'item' && target.id) tab.revealItem?.(target.id);
}

/**
 * The transcript row that stands for a context item of this type in a thread.
 *
 * Some context items — the plan and the todo list among them — are `isVisible()
 * false` and draw no tile of their own: the tool-action row that wrote them is
 * their whole presence in the column. Nothing records which row that was, so it
 * is found the way it is found everywhere else in the app, by scanning for the
 * last call of the tool that shares the item's type. A row whose result is a
 * context item is skipped, because the renderer draws nothing for one.
 *
 * Null means the item has no row of its own, and a reveal falls back to the
 * thread that owns it.
 * @param {any} thread - The MessageThread to scan.
 * @param {string} type - The context-item type, which is also the tool's name.
 * @returns {string|null} The row's item id, or null.
 */
function writingRowId(thread, type) {
  const items = thread?.items;
  if (!Array.isArray(items)) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (itemField(item, 'type') !== 'tool-action') continue;
    if (itemField(item, 'toolName') !== type) continue;
    if (itemField(itemField(item, 'result'), 'resultType') === 'context') continue;
    return itemField(item, 'itemId') || null;
  }
  return null;
}

/**
 * A detached copy of a context item's data, so a pin holds a snapshot and cannot
 * write back through it. Context-item data is plain JSON by construction — it is
 * restored from the Yjs map's own `toJSON()` — so a round trip is enough, and it
 * fails closed on anything that turns out not to be.
 * @param {any} data - The item's stored data.
 * @returns {Record<string, any>} A copy, or an empty object if it would not clone.
 */
function cloneData(data) {
  try {
    return JSON.parse(JSON.stringify(data ?? {}));
  } catch {
    return {};
  }
}

/**
 * When an item was stamped, as Unix ms. Zero-free: an item the worker has not
 * echoed back carries no timestamp, and that only happens while it is the newest
 * thing in the thread, so it reads as now rather than as the beginning of time.
 * @param {any} ymap - The item.
 * @returns {number} Unix ms, or Infinity when it carries no timestamp yet.
 */
function itemTime(ymap) {
  const raw = ymap?.get?.('timestamp');
  if (!raw) return Infinity;
  const ms = new Date(String(raw)).getTime();
  return Number.isNaN(ms) ? Infinity : ms;
}

class PinboardContent extends JugglerElement {
  constructor() {
    super();
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {HTMLElement|null} @private */
    this._toolbar = null;
    /** @type {HTMLElement|null} @private */
    this._title = null;
    /** @type {HTMLElement|null} @private */
    this._subtitle = null;
    /** @type {HTMLElement|null} @private */
    this._actions = null;
    /** @type {HTMLElement|null} @private */
    this._body = null;
    /** @type {Pin|null} @private The pin currently mounted. */
    this._pin = null;
    /** @type {PinActiveContext|null} @private */
    this._active = null;
    /** @type {import('juggler/pinboard-item-type').PinController|null} @private */
    this._controller = null;
    /** @type {AbortController|null} @private */
    this._abort = null;
    /**
     * The pins that stay mounted while another tab is showing, by pin id — the
     * ones whose type asked for `retain`. Each holds the element it was mounted
     * into, its controller, its own AbortController — retention means the pin's
     * signal outlives the tab switch that hid it — and the pin exactly as it was
     * handed over, normalized config and all, so that what a hidden pin is told
     * later is what it was mounted with rather than a second reading of the
     * board that might have moved on.
     *
     * The element is hidden in place and never moved: reparenting an `<iframe>`
     * reloads it, which would undo the whole point of keeping it.
     * @type {Map<string, {element: HTMLElement, controller: import('juggler/pinboard-item-type').PinController|null, abort: AbortController, pin: Pin}>} @private
     */
    this._retained = new Map();
    /**
     * The element the pin on screen was mounted into, when that pin is not a
     * retained one. Removed on the way out; a retained pin's element is in
     * {@link _retained} instead and is only hidden.
     * @type {HTMLElement|null} @private
     */
    this._transientSlot = null;
    /** @type {HTMLElement|null} @private Where the empty/missing/error states are drawn. */
    this._placeholder = null;
    /**
     * Where each pin was scrolled to, by pin id. Viewer-local reading position,
     * kept for the life of this element.
     * @type {Map<string, number>} @private
     */
    this._scrollTops = new Map();
    /** @type {Set<() => void>} @private Watchers of the running-task list. */
    this._taskListeners = new Set();
    /**
     * Watchers of the review draft, each with the observer it currently has on
     * the thread being read. The thread moves under them — that is what
     * switching thread or conversation does — so the observer is re-bound rather
     * than registered once, and the entry is what there is to re-bind.
     * @type {Set<{listener: () => void, detach: (() => void)|null}>} @private
     */
    this._reviewWatchers = new Set();
    /**
     * Listeners with news waiting — one entry each, however many times they
     * were told. See {@link _scheduleNotify}.
     * @type {Map<(...args: any[]) => void, {what: string, signal: AbortSignal|undefined}>} @private
     */
    this._pendingNotify = new Map();
    /** @type {number|null} @private The frame the pending notifications will go out on. */
    this._notifyFrame = null;
    /** @type {ReturnType<typeof setTimeout>|null} @private The frame's understudy. */
    this._notifyTimer = null;
    /**
     * The actions the toolbar's buttons stand for, read at click time rather
     * than captured when they were drawn. The buttons outlive any one list —
     * that is the point of {@link _renderActions}'s guard — and a button holding
     * the list it was built from would run an action assembled against a
     * transcript that has since moved on.
     * @type {PinAction[]} @private
     */
    this._actionList = [];
    /** @type {string} @private What the drawn toolbar says, to spot a real change. */
    this._actionSignature = '';
    /**
     * Whether anyone can read what is drawn here. The surface above says so:
     * the docked panel is put away with a transform and stays in the document,
     * so nothing about this element or its layout gives the answer. True until
     * told otherwise, because an element nobody has claimed is an element on
     * screen.
     * @type {boolean} @private
     */
    this._visible = true;
    /**
     * The tasks confirmed running at the last probe, or null when none has come
     * back yet. Null is a state of its own: "nothing running" is a claim, and
     * making it before asking would be a guess.
     * @type {PinTask[]|null} @private
     */
    this._tasks = null;
    /** @type {string} @private The last probe's failure, kept beside the last answer. */
    this._taskError = '';
    /** @type {string} @private What the watchers were last told, to spot a real change. */
    this._taskSignature = '';
    /** @type {ReturnType<typeof setInterval>|null} @private */
    this._taskTimer = null;
    /** @type {boolean} @private Guards against a slow probe overlapping the next tick. */
    this._taskProbing = false;
    /**
     * Bound so the focus listener can be removed again.
     * @private
     */
    this._taskPoll = () => {
      if (typeof document !== 'undefined' && !document.hasFocus()) return;
      void this._pollTasks();
    };
  }

  connectedCallback() {
    this._build();
  }

  /**
   * Say whether the board is on screen. A closed board holds its pin's news
   * instead of drawing it, and is handed all of it at once when it comes back.
   * @param {boolean} visible - Whether anyone can read this.
   * @returns {void}
   */
  setVisible(visible) {
    if (this._visible === visible) return;
    this._visible = visible;
    if (visible && this._pendingNotify.size) this._scheduleFlush();
  }

  /**
   * Supply the session the context-items service reads through. The panel above
   * owns it; this element only ever reads.
   * @param {import('../model/session.js').default|null} session - The viewer's session.
   * @returns {void}
   */
  setSession(session) {
    this._session = session;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unmount();
    // Retention is for a pin that is off screen, not for one whose board has
    // left the document: nothing may still be running against a board nobody
    // can reach.
    this._dropAllSlots();
    this._cancelNotify();
  }

  /**
   * Show a pin, or the empty state when there is nothing pinned. Re-showing the
   * pin already mounted leaves it alone — a board change elsewhere must not
   * rebuild the pin being read.
   * @param {Pin|null} pin - The active pin, or null for the empty state.
   * @param {PinActiveContext} active - The current active-context snapshot.
   * @returns {boolean} True if the body was rebuilt, false if the pin already
   *   mounted was left alone.
   */
  setPin(pin, active) {
    this._active = active;
    if (pin && this._pin && pin.id === this._pin.id
      && JSON.stringify(pin.config) === JSON.stringify(this._pin.config)) {
      this._pin = pin;
      this._renderToolbar();
      this._renderActions();
      return false;
    }
    // A find belongs to the pin it was run against, and that pin is about to be
    // put away. Its matches would otherwise stay counted against a body that no
    // longer holds them.
    findBar.closeFor(this);
    this._unmount();
    this._pin = pin;
    this._renderToolbar();
    if (!pin) {
      this._renderEmpty();
      this._renderActions();
      return true;
    }
    this._mount(pin);
    this._renderActions();
    return true;
  }

  /**
   * Hand the mounted pin a new active-context snapshot. An item type that offers
   * `update()` re-renders in place; one that doesn't is a view of its config
   * alone and has nothing to re-read.
   * @param {PinActiveContext} active - The new snapshot.
   * @returns {void}
   */
  setActiveContext(active) {
    const previousConversation = this._active?.conversation?.id || '';
    const previousThread = this._active?.thread?.id ?? null;
    this._active = active;
    // A review draft belongs to the thread it will be sent to, so a move between
    // threads — or between conversations — puts a different draft in front of
    // the pin. Re-point the watchers before anything below can re-read.
    if ((active?.conversation?.id || '') !== previousConversation
      || (active?.thread?.id ?? null) !== previousThread) {
      this._rebindReviewWatchers();
    }
    // The running-task list belongs to one conversation. Showing the previous
    // one's tasks against the new one's name would be a lie for as long as the
    // next probe takes, so go back to "still looking" and ask again now.
    if ((active?.conversation?.id || '') !== previousConversation) {
      this._tasks = null;
      this._taskError = '';
      this._notifyTaskWatchers();
      if (this._taskListeners.size > 0) void this._pollTasks();
    }
    this._renderToolbar();
    // Every mounted pin hears this, not only the one on screen: a retained pin
    // is still running against the active context, and one that learned of a
    // conversation change only when the user happened to switch back to it
    // would have been reading the wrong conversation until they did.
    for (const [pinId, kept] of [...this._retained]) {
      if (this._pin && pinId === this._pin.id) continue;
      this._updateRetained(kept);
    }
    const update = this._controller?.update;
    if (!update || !this._pin || !this._abort) return;
    try {
      update(this._pinContext(this._pin, this._abort));
    } catch (err) {
      this._renderError(err);
      return;
    }
    this._renderActions();
  }

  /**
   * Hand one hidden retained pin a new active-context snapshot. Its failure is
   * its own: a pin nobody is looking at must not replace the body of the pin
   * they are, so this logs and drops the pin rather than drawing an error over
   * something unrelated.
   * @param {{controller: import('juggler/pinboard-item-type').PinController|null, abort: AbortController, pin: Pin}} kept - Its mount.
   * @private
   */
  _updateRetained(kept) {
    const update = kept.controller?.update;
    if (typeof update !== 'function') return;
    try {
      update(this._pinContext(kept.pin, kept.abort));
    } catch (err) {
      console.error(`[Pinboard] Retained item type "${kept.pin.type}" failed to update:`, err);
      this._dropSlot(kept.pin.id);
    }
  }

  /**
   * Where ⌘F searches on the board: the body, which is the one thing here that
   * scrolls, with the bar floating in this element so it sits under the pin's
   * toolbar rather than over it, and out of the body's own scroll.
   *
   * Only a pin actually on screen can be searched — a slot exists per pin, and a
   * retained one that isn't the active tab is hidden, so the visible slot is the
   * test. No slot means the empty state or a placeholder, and ⌘F falls through to
   * the browser's own find. A pin that draws itself into an `<iframe>` can't be
   * searched either: matching walks this document's text nodes and stops at the
   * frame boundary.
   * @returns {import('./find-bar.js').FindTarget|null} The find descriptor, or null when no pin is on screen.
   */
  getFindTarget() {
    const root = /** @type {HTMLElement|null} */ (this.querySelector('.pinboard-content__body'));
    if (!root || !root.querySelector('.pinboard-content__slot:not([hidden])')) return null;
    return {
      root,
      mount: this,
      label: 'Find in pinboard',
      restoreFocus: () => this.focusBody(),
    };
  }

  /**
   * Move focus into the body: the item type's own entry point if it named one,
   * else the panel region itself.
   * @returns {void}
   */
  focusBody() {
    try {
      if (this._controller?.focus) {
        this._controller.focus();
        return;
      }
    } catch (err) {
      console.error('[Pinboard] Item type failed to take focus:', err);
    }
    this.focusRegion();
  }

  /**
   * Put focus on the region itself, deliberately short of the pin.
   *
   * This is where the arrow keys leave focus as they step along the tabs, and
   * why they are not {@link focusBody}: a pin that names an entry point means it
   * for a reader who has arrived, and a pin whose entry point is a text field
   * would swallow the next press of the very key that brought them here.
   * @returns {void}
   */
  focusRegion() {
    // The board is an overlay over a scroll box, so taking focus must never be
    // what scrolls the workspace behind it. Without `preventScroll` this is
    // where opening the board throws the workspace about: focus arrives in the
    // same tick the panel is still translated off the right edge, and the
    // browser scrolls every ancestor to reveal it — including `.app-main`, whose
    // `overflow: hidden` makes it a scroll box all the same. The columns lurch
    // left, the sliding panel overshoots with them, and it all springs back when
    // the transform settles.
    this.focus({ preventScroll: true });
  }

  /**
   * Move focus into the pin, for a reader who asked to be in it: the type's own
   * entry point if it named one, else the first control it drew.
   * @returns {boolean} True when focus went somewhere inside the pin.
   */
  enterPin() {
    try {
      if (this._controller?.focus) {
        this._controller.focus();
        return true;
      }
    } catch (err) {
      console.error('[Pinboard] Item type failed to take focus:', err);
    }
    const first = /** @type {HTMLElement|null} */ (this._body?.querySelector(ENTRY_SELECTOR) ?? null);
    if (!first) return false;
    first.focus({ preventScroll: true });
    return true;
  }

  /**
   * Whether a node is part of the pin rather than the region around it. What the
   * board may act on without taking something out of a reader's hands is decided
   * by this: inside the pin, the pin's keys are its own.
   * @param {EventTarget|null} node - Usually a keystroke's target.
   * @returns {boolean} True when the node sits inside the mounted pin.
   */
  isInsidePin(node) {
    return !!this._body && node instanceof Node && this._body.contains(node) && node !== this._body;
  }

  /**
   * Scroll the pin from the keyboard.
   *
   * Done by hand because focus is on the region and the scroll box is inside it:
   * the browser scrolls the nearest scrollable ANCESTOR of what is focused, which
   * from here is the page, not the pin.
   * @param {'line'|'page'|'edge'} step - How far.
   * @param {number} direction - -1 for up, 1 for down.
   * @returns {boolean} True when there was a pin to scroll.
   */
  scrollPin(step, direction) {
    const body = this._body;
    if (!body) return false;
    if (step === 'edge') {
      body.scrollTo({ top: direction < 0 ? 0 : body.scrollHeight });
      return true;
    }
    // A page keeps a couple of lines of what was on screen, so a paged read has
    // an overlap to pick the thread up from rather than a seam.
    const amount = step === 'page'
      ? Math.max(body.clientHeight - PAGE_KEEP_PX, PAGE_KEEP_PX)
      : LINE_STEP_PX;
    body.scrollBy({ top: amount * direction });
    return true;
  }

  /**
   * Build the fixed chrome once.
   * @private
   */
  _build() {
    if (this._body) return;
    this.id = PINBOARD_BODY_ID;
    // Focusable, but not a tab stop. It is the tab strip's panel, so focusBody()
    // has to be able to put focus here when an item type offers nowhere better;
    // reaching it by Tab only drew a ring around the whole band on the way to
    // the controls inside it, which are the things worth stopping on.
    this.tabIndex = -1;

    const toolbar = document.createElement('div');
    toolbar.className = 'pinboard-item-toolbar';
    const text = document.createElement('div');
    text.className = 'pinboard-item-toolbar__text';
    const title = document.createElement('div');
    title.className = 'pinboard-item-toolbar__title';
    const subtitle = document.createElement('div');
    subtitle.className = 'pinboard-item-toolbar__subtitle';
    text.append(title, subtitle);
    const actions = document.createElement('div');
    actions.className = 'pinboard-item-toolbar__actions';
    actions.hidden = true;
    toolbar.append(text, actions);

    const body = document.createElement('div');
    body.className = 'pinboard-content__body';
    body.addEventListener('scroll', () => {
      if (this._pin) this._scrollTops.set(this._pin.id, body.scrollTop);
    });

    // The states the host draws in a pin's place get an element of their own
    // rather than the run of the body, because the body may be holding retained
    // pins that are merely hidden, and emptying it would end them.
    const placeholder = document.createElement('div');
    placeholder.className = 'pinboard-content__placeholder';
    placeholder.hidden = true;
    body.appendChild(placeholder);

    this.append(toolbar, body);
    this._toolbar = toolbar;
    this._title = title;
    this._subtitle = subtitle;
    this._actions = actions;
    this._body = body;
    this._placeholder = placeholder;
  }

  /**
   * Say what the active pin is. The board toolbar above establishes the surface,
   * so this names the thing, not the board.
   *
   * A pin that names a path is titled by the path alone, in monospace: the name
   * above the path it came from said the same thing twice, and the half worth
   * reading was the one underneath. The path is stamped on the element for the
   * app-wide right-click menu, which is why nothing here builds one.
   * @private
   */
  _renderToolbar() {
    if (!this._toolbar || !this._title || !this._subtitle) return;
    const pin = this._pin;
    if (!pin) {
      this._toolbar.hidden = true;
      // Emptied as well as hidden. What is left here is the name of a pin that is
      // no longer on the board, and the path stamp arms the app-wide right-click
      // menu — neither should outlive the tab it described.
      this._title.classList.remove('pinboard-item-toolbar__title--path');
      delete this._title.dataset.filePath;
      this._title.textContent = '';
      this._subtitle.textContent = '';
      this._subtitle.hidden = true;
      this.removeAttribute('role');
      this.removeAttribute('aria-labelledby');
      return;
    }
    this._toolbar.hidden = false;
    this.setAttribute('role', 'tabpanel');
    this.setAttribute('aria-labelledby', `pinboard-tab-${pin.id}`);
    const description = describePin(pin, this._active);
    const path = description.path || '';
    this._title.classList.toggle('pinboard-item-toolbar__title--path', !!path);
    if (path) {
      this._title.dataset.filePath = path;
      this._writePathTitle(formatDisplayPath(path));
    } else {
      delete this._title.dataset.filePath;
      this._title.textContent = description.title;
    }
    const subtitle = path ? '' : (description.subtitle || '');
    this._subtitle.textContent = subtitle;
    this._subtitle.hidden = !subtitle;
  }

  /**
   * Write a path as its directories and its name, so the two can be treated
   * differently: only the directories ellipse when the board is narrow, and the
   * name keeps the foreground colour. `textContent` still reads as the whole
   * path, which is what a copy or a test asks for.
   * @param {string} path - The path to show, as the user should read it.
   * @private
   */
  _writePathTitle(path) {
    if (!this._title) return;
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;
    const dir = document.createElement('span');
    dir.className = 'pinboard-item-toolbar__dir';
    dir.textContent = path.slice(0, cut);
    const name = document.createElement('span');
    name.className = 'pinboard-item-toolbar__name';
    name.textContent = path.slice(cut);
    this._title.replaceChildren(dir, name);
  }

  /**
   * Draw the toolbar's controls from whatever the mounted item type offers. A
   * pin that names a path gets the app's file controls first, so open, copy and
   * reveal are the same three buttons in the same order here as anywhere else a
   * path is shown. Then each action: one with a `primary` flag or an icon gets a
   * button of its own; the rest wait behind the `⋯`, which is not drawn at all
   * when there is nothing to put in it.
   * @private
   */
  _renderActions() {
    const host = this._actions;
    if (!host) return;

    const actions = this._pinActions();
    const path = this._pin ? (describePin(this._pin, this._active).path || '') : '';
    // What the toolbar can be asked to do changes far less often than what the
    // pin is showing — most of the time, never. Throwing away every button and
    // building it again on each notification would rebuild the whole toolbar
    // for every pin on every transaction of every conversation.
    // The list itself is always kept, because the buttons dispatch through it.
    const signature = [path, ...actions.map((action) => [
      action.label, action.disabled === true, !!action.primary, action.icon || '',
    ].join('\u0000'))].join('\u0001');
    this._actionList = actions;
    if (signature === this._actionSignature) return;
    this._actionSignature = signature;

    host.replaceChildren();
    const fileActions = createFileActions(path);
    if (fileActions) host.appendChild(fileActions);
    if (!actions.length) {
      host.hidden = !fileActions;
      return;
    }
    host.hidden = false;

    /** @type {number[]} */
    const overflow = [];
    actions.forEach((action, index) => {
      const icon = ACTION_ICONS[action.icon || ''] || '';
      if (!icon && !action.primary) {
        overflow.push(index);
        return;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-ghost pinboard-item-toolbar__action';
      if (icon) {
        // The label is what the control is called, whether it is drawn as words
        // or as a picture — so it stays, as the tooltip and to a screen reader.
        button.classList.add('pinboard-item-toolbar__action--icon');
        button.innerHTML = icon;
        button.title = action.label;
        button.setAttribute('aria-label', action.label);
      } else {
        button.textContent = action.label;
      }
      button.disabled = action.disabled === true;
      button.addEventListener('click', () => this._runActionAt(index, button));
      host.appendChild(button);
    });
    if (!overflow.length) return;

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'btn-ghost pinboard-item-toolbar__more';
    more.textContent = '⋯';
    more.setAttribute('aria-label', 'More actions');
    more.setAttribute('aria-haspopup', 'menu');
    more.addEventListener('click', () => {
      const rect = more.getBoundingClientRect();
      openMenuAt(overflow.map((index) => ({
        label: this._actionList[index]?.label || '',
        disabled: this._actionList[index]?.disabled === true,
        onClick: () => this._runActionAt(index),
      })), rect.left, rect.bottom + 4, more);
    });
    host.appendChild(more);
  }

  /**
   * Run the action a drawn button stands for, as the pin most recently listed
   * it. A button is kept while its label, its state and its place are unchanged,
   * so what it stands for has to be looked up when it is pressed rather than
   * held from when it was drawn — the words are the same, but the closure behind
   * them was assembled against whatever the pin had read at the time.
   * An icon button turns while its action is in flight and ignores a second
   * press until it settles: a picture that stays exactly as it was is otherwise
   * the whole of the feedback for a refresh that found nothing changed.
   * @param {number} index - The action's place in the list last returned.
   * @param {HTMLButtonElement} [button] - The control pressed, when there is one.
   * @private
   */
  _runActionAt(index, button) {
    const action = this._actionList[index];
    if (!action) return;
    const spins = !!button?.classList.contains('pinboard-item-toolbar__action--icon');
    if (spins && button?.classList.contains('is-spinning')) return;
    const settled = this._runAction(action);
    if (!spins || !button || !settled) return;
    button.classList.add('is-spinning');
    void settled.then(() => button.classList.remove('is-spinning'));
  }

  /**
   * Hand the mounted pin one piece of news, then re-ask what it can now do.
   *
   * An action is a function of what the pin found, so anything that changes the
   * body can change the toolbar with it — and the pin has no way to say so. A
   * board window shows why: it mounts its pins against a conversation this
   * viewer has never opened, finds no plan, and learns of one only when the load
   * lands here. Asked once at mount and never again, the list would fill in
   * behind a `Reveal in conversation` still dimmed from the moment there was
   * nothing to reveal.
   * @param {(...args: any[]) => void} listener - The item type's callback.
   * @param {any[]} args - What to hand it.
   * @param {string} what - What changed, for the log when it throws.
   * @private
   */
  _notifyPin(listener, args, what) {
    try {
      listener(...args);
    } catch (err) {
      console.error(`[Pinboard] Item type failed to handle ${what}:`, err);
    }
    this._renderActions();
  }

  /**
   * Hold one piece of news for a listener until the next frame, and tell it once
   * however many times it arrives.
   *
   * The signals a pin watches are not paced by anything a pin would recognise.
   * `conversation:changed` is emitted per applied Yjs transaction, so a
   * streaming turn delivers around a hundred a second — and every one of them
   * had the pin walk the whole transcript and rebuild its body, for frames that
   * were never painted. Coalescing is the same answer the conversation bar
   * reached for the same firehose, and the pin does not have to know: it is told
   * that something changed and re-reads, which is what it always did.
   *
   * A closed board holds its news instead of scheduling it. The pin still learns
   * of it — once, on the way back — rather than a hundred times over while
   * nobody is looking.
   *
   * Only the streaming firehose comes through here. A file change, a git
   * status, a task ending and a move between threads are all discrete and
   * already paced by something, and callers read what a pin shows immediately
   * after them — so those are delivered as they arrive.
   * @param {(...args: any[]) => void} listener - The item type's callback.
   * @param {string} what - What changed, for the log when it throws.
   * @param {AbortSignal} signal - The signal of the pin the listener belongs to,
   *   so news held for a pin that has since gone away is dropped rather than
   *   delivered to a controller that has been torn down. Several pins can be
   *   mounted at once — the one on screen and any retained behind it — so "the
   *   pin on screen" is not the same question as "the pin this listener is for".
   * @private
   */
  _scheduleNotify(listener, what, signal) {
    this._pendingNotify.set(listener, { what, signal });
    if (this._visible) this._scheduleFlush();
  }

  /**
   * Book the flush, if one isn't booked. See {@link NOTIFY_FALLBACK_MS} for why
   * two of them are booked and the first to arrive wins.
   * @private
   */
  _scheduleFlush() {
    if (this._notifyFrame !== null || this._notifyTimer !== null) return;
    this._notifyFrame = requestAnimationFrame(() => this._flushNotify());
    this._notifyTimer = setTimeout(() => this._flushNotify(), NOTIFY_FALLBACK_MS);
  }

  /**
   * Deliver everything held. Taken as a batch first, so a listener that watches
   * more than one thing cannot be handed the same news twice by a re-entrant
   * schedule.
   * @private
   */
  _flushNotify() {
    this._clearFlush();
    if (!this._pendingNotify.size) return;
    const pending = this._pendingNotify;
    this._pendingNotify = new Map();
    for (const [listener, held] of pending) {
      if (held.signal?.aborted) continue;
      this._notifyPin(listener, [], held.what);
    }
  }

  /**
   * Drop everything held without delivering it. For a pin on its way out: its
   * listeners belong to a controller that has been torn down.
   * @private
   */
  _cancelNotify() {
    this._pendingNotify.clear();
    this._clearFlush();
  }

  /**
   * Drop the news held for one pin's listeners, leaving everyone else's alone.
   * A board can have several pins mounted at once — the one on screen and any
   * retained ones behind it — so a pin going away must not silence them too.
   * @param {AbortSignal|undefined} signal - The going pin's signal, if it had one.
   * @private
   */
  _dropNotifyFor(signal) {
    if (!signal) return;
    for (const [listener, held] of this._pendingNotify) {
      if (held.signal === signal) this._pendingNotify.delete(listener);
    }
    if (!this._pendingNotify.size) this._clearFlush();
  }

  /**
   * Drop the news held for one listener, because that subscription has ended.
   *
   * News is held for a frame before it is delivered, so a listener can be told
   * to stop while something is still waiting for it. Delivering that afterwards
   * calls back into a pin that has finished with the subscription — the one
   * thing an unsubscribe is asked to prevent — and a pin need not be going away
   * to unsubscribe: one that swaps what it watches keeps its mount, and its
   * signal, throughout.
   *
   * News is held per listener, so a listener subscribed to two services shares
   * one entry and is told once however many of them changed. Ending either
   * subscription drops that entry; the one still running is told again by the
   * next change, which the pin re-reads for in full.
   * @param {(...args: any[]) => void} listener - The listener that has stopped.
   * @private
   */
  _dropPendingNotify(listener) {
    if (!this._pendingNotify.delete(listener)) return;
    if (!this._pendingNotify.size) this._clearFlush();
  }

  /**
   * Stand both booked flushes down — the one that ran, and the one that lost.
   * @private
   */
  _clearFlush() {
    if (this._notifyFrame !== null) cancelAnimationFrame(this._notifyFrame);
    this._notifyFrame = null;
    if (this._notifyTimer !== null) clearTimeout(this._notifyTimer);
    this._notifyTimer = null;
  }

  /**
   * The mounted item type's actions, asked for fresh each time and believed only
   * as far as they are usable. An item type with nothing to offer is the norm.
   * @returns {PinAction[]} The actions to draw.
   * @private
   */
  _pinActions() {
    const getActions = this._controller?.getActions;
    if (!getActions || !this._pin) return [];
    try {
      const actions = getActions();
      if (!Array.isArray(actions)) return [];
      return actions.filter((action) => action
        && typeof action.label === 'string' && action.label
        && typeof action.run === 'function');
    } catch (err) {
      console.error(`[Pinboard] Item type "${this._pin.type}" failed to list its actions:`, err);
      return [];
    }
  }

  /**
   * Run one toolbar action. What it does is the item type's business; that it
   * failed is the board's, and the status line says so with the error intact.
   * @param {PinAction} action - The action the user chose.
   * @returns {Promise<void>|null} When the action is asynchronous, a promise that
   *   fulfils once it has finished either way — the failure has been reported by
   *   then, so a caller waiting on it only has to know that the waiting is over.
   *   Null when the action was done and dusted before it returned.
   * @private
   */
  _runAction(action) {
    const lead = `Couldn't ${action.label.charAt(0).toLowerCase()}${action.label.slice(1)}.`;
    /** @param {any} err - What the action threw or rejected with. */
    const failed = (err) => {
      console.error('[Pinboard] Item action failed:', err);
      pinboardView.setStatus(`${lead} ${extractErrorMessage(err)}`);
    };
    try {
      const result = action.run();
      if (result && typeof result.then === 'function') return result.then(() => {}, failed);
    } catch (err) {
      failed(err);
    }
    return null;
  }

  /**
   * Mount one pin's body.
   * @param {Pin} pin - The pin to show.
   * @private
   */
  _mount(pin) {
    const body = this._body;
    if (!body) return;
    this._hidePlaceholder();

    const type = pinboardItemRegistry.getType(pin.type);
    if (!type) {
      this._renderMissing(pin);
      return;
    }

    let config = pin.config;
    try {
      config = type.normalizeConfig(pin.config) ?? config;
    } catch (err) {
      this._renderError(err);
      return;
    }

    // A retained pin that is still mounted is revealed rather than built again —
    // that is the whole of what retaining one means. A config change is a
    // different thing in the same tab, so that one is rebuilt like any other.
    const kept = this._retained.get(pin.id);
    if (kept) {
      if (JSON.stringify(kept.pin.config) === JSON.stringify(config)) {
        this._abort = kept.abort;
        this._controller = kept.controller;
        kept.element.hidden = false;
        this._callController(kept.controller, 'show');
        this._restoreScroll(pin);
        return;
      }
      this._dropSlot(pin.id);
    }

    // Every pin is mounted into an element of its own, retained or not, so that
    // one being hidden is never the others being disturbed.
    const slot = document.createElement('div');
    slot.className = 'pinboard-content__slot';
    body.appendChild(slot);

    const abort = new AbortController();
    this._abort = abort;
    const mounted = { ...pin, config };
    /** @type {any} */
    let result;
    try {
      result = type.mount(slot, this._pinContext(mounted, abort));
    } catch (err) {
      slot.remove();
      this._abort = null;
      this._renderError(err);
      return;
    }
    this._controller = typeof result === 'function' ? { teardown: result } : (result || null);

    if (type.retainsMount) {
      this._retained.set(pin.id, {
        element: slot,
        controller: this._controller,
        abort,
        pin: mounted,
      });
    } else {
      this._transientSlot = slot;
    }
    this._restoreScroll(pin);
  }

  /**
   * Put the reader back where they were reading, now the body has content.
   * @param {Pin} pin - The pin just shown.
   * @private
   */
  _restoreScroll(pin) {
    const scrollTop = this._scrollTops.get(pin.id);
    if (scrollTop && this._body) this._body.scrollTop = scrollTop;
  }

  /**
   * Call one of a controller's optional lifecycle methods. Best-effort, like
   * everything else an item type is asked to do: one that throws on the way past
   * is logged and stepped over, never allowed to take the board with it.
   * @param {import('juggler/pinboard-item-type').PinController|null} controller - The controller.
   * @param {'hide'|'show'} method - Which to call.
   * @private
   */
  _callController(controller, method) {
    const fn = controller?.[method];
    if (typeof fn !== 'function') return;
    try {
      fn.call(controller);
    } catch (err) {
      const what = method === 'hide' ? 'go off screen' : 'come back';
      console.error(`[Pinboard] Item type failed to ${what}:`, err);
    }
  }

  /**
   * End a retained pin for good: abort its signal, tear its controller down and
   * take its element out of the document. The counterpart to hiding one, and the
   * only thing that undoes a mount.
   * @param {string} pinId - The pin to drop.
   * @private
   */
  _dropSlot(pinId) {
    const kept = this._retained.get(pinId);
    if (!kept) return;
    this._retained.delete(pinId);
    try {
      kept.abort.abort();
    } catch (err) {
      console.error('[Pinboard] Abort failed:', err);
    }
    this._dropNotifyFor(kept.abort.signal);
    try {
      kept.controller?.teardown?.();
    } catch (err) {
      console.error('[Pinboard] Item type failed to tear down:', err);
    }
    kept.element.remove();
    if (this._abort === kept.abort) {
      this._abort = null;
      this._controller = null;
    }
  }

  /**
   * Drop every retained pin. For the cases where nothing may still be running
   * against this board at all — the element leaving the document, or the board
   * losing the conversation it was a view of.
   * @private
   */
  _dropAllSlots() {
    for (const pinId of [...this._retained.keys()]) this._dropSlot(pinId);
  }

  /**
   * Say which pins are still on the board, so the ones that have gone can be
   * ended rather than left running out of sight. The board is shared, so a pin
   * may be removed by a viewer that is not this one.
   * @param {Pin[]} pins - The board as it now stands.
   * @returns {void}
   */
  syncPins(pins) {
    if (!this._retained.size) return;
    const live = new Set(pins.map((pin) => pin.id));
    for (const pinId of [...this._retained.keys()]) {
      if (!live.has(pinId)) this._dropSlot(pinId);
    }
  }

  /**
   * The context handed to an item type: the pin, the active snapshot, the host
   * services, a signal that fires when the pin goes away, and the one way it may
   * write anything down.
   *
   * The mount's own AbortController is carried through every service rather than
   * read off the host at subscription time, because several pins are mounted at
   * once and an item type may subscribe long after the call that handed it this
   * context — from a promise it resolved, from a timer. Whichever pin is on
   * screen when that happens is not the question; whose subscription it is, is.
   * @param {Pin} pin - The pin being mounted.
   * @param {AbortController} abort - The mount this context belongs to.
   * @returns {import('juggler/pinboard-item-type').PinContext} The context.
   * @private
   */
  _pinContext(pin, abort) {
    const signal = abort.signal;
    return {
      pin: { id: pin.id, type: pin.type, config: pin.config },
      active: /** @type {PinActiveContext} */ (this._active),
      services: {
        files: { onChange: (listener) => this._watchFiles(listener, signal) },
        contextItems: {
          find: (type, from) => this._findContextItem(type, from),
          onChange: (listener) => this._watchContextItems(listener, signal),
          reveal: (threadId, itemId) => this._reveal(itemId
            ? { kind: 'item', id: itemId }
            : { kind: 'thread', id: threadId ?? null }),
        },
        git: {
          status: () => gitStatusCache.get(),
          error: () => gitStatusCache.getError(),
          onChange: (listener) => this._watchGitStatus(listener, signal),
          refresh: async () => {
            await gitStatusCache.refresh();
          },
          review: (options) => this._gitRequest(
            signal, options?.signal,
            (linked) => gitReviewService.review({ signal: linked, scope: options?.scope })
          ),
          diff: (repo, path, options) => this._gitRequest(
            signal, options?.signal,
            (linked) => gitReviewService.diff(repo, path, {
              signal: linked, contextLines: options?.contextLines, scope: options?.scope,
            })
          ),
        },
        tasks: {
          // A copy, like every other service here: what a pin is handed is a
          // snapshot, and mutating it must not reach the next reader.
          list: () => (this._tasks ? this._tasks.map((task) => ({ ...task })) : null),
          error: () => this._taskError,
          onChange: (listener) => this._watchTasks(listener, signal),
          reveal: (itemId) => this._reveal({ kind: 'item', id: itemId }),
          stop: (taskId) => this._stopTask(taskId),
        },
        review: {
          draft: () => this._reviewDraft(),
          onChange: (listener) => this._watchReviewDraft(listener, signal),
          save: (draft) => this._saveReviewDraft(draft),
          clear: () => this._saveReviewDraft(null),
          compose: () => this._composeReview(),
        },
      },
      signal,
      updateConfig: async (nextConfig) => {
        await pinboardStore.updateConfig(pin.id, nextConfig);
      },
    };
  }

  /**
   * Point the conversation at something the mounted pin found — the one door all
   * three reveals go through.
   *
   * In a detached board there are no columns to move, so the reveal is sent to
   * the window the board was detached from and carried out there. It travels with
   * the board's own conversation, which that window may long since have left —
   * being pointed at something is a request to go and look at it, so the window
   * switches to it before it points. The pin cannot tell the difference, and that
   * is the point: a board behaves the same whichever window it is in.
   * @param {{kind: string, id: string|null}} target - The thread or item to point at.
   * @private
   */
  _reveal(target) {
    if (isPinboardView()) {
      const conversationId = this._active?.conversation?.id || '';
      if (target.kind === 'thread') satelliteLink.revealThread(target.id, conversationId);
      else if (target.id) satelliteLink.revealItem(target.id, conversationId);
      return;
    }
    revealInConversation(target);
  }

  /**
   * Subscribe an item type to file changes, absolute-path side out. The watcher
   * reports paths relative to the project it is rooted at, which is the host's
   * business and not a provider's — a pin holds a path and wants to know whether
   * it is the one that moved.
   *
   * The subscription is tied to the pin's own signal as well as to the returned
   * function, so an item type that forgets to unsubscribe still stops listening
   * when it goes away.
   * @param {(changes: import('juggler/pinboard-item-type').PinFileChange[]) => void} listener - Called with each batch.
   * @param {AbortSignal} signal - The subscribing pin's mount signal.
   * @returns {() => void} Unsubscribe.
   * @private
   */
  _watchFiles(listener, signal) {
    const root = (this._active?.project?.path || '').replace(/\/+$/, '');
    const handler = (/** @type {any} */ changes) => {
      if (!Array.isArray(changes) || !changes.length) return;
      const resolved = changes.map((/** @type {any} */ change) => ({
        path: root && !String(change.path).startsWith('/') ? `${root}/${change.path}` : change.path,
        event: change.event,
      }));
      this._notifyPin(listener, [resolved], 'a file change');
    };
    wsService.on('file-change', handler);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      wsService.off('file-change', handler);
    };
    signal.addEventListener('abort', stop, { once: true });
    return stop;
  }

  /**
   * Subscribe an item type to the shared git status. The poll belongs to the
   * cache and runs only while something is watching, so a pin that goes away
   * stops the git invocations along with itself.
   *
   * Tied to the pin's signal as well as to the returned function, like the file
   * watcher, so forgetting to unsubscribe leaks nothing.
   * @param {() => void} listener - Called when a new status has arrived.
   * @param {AbortSignal} signal - The subscribing pin's mount signal.
   * @returns {() => void} Unsubscribe.
   * @private
   */
  _watchGitStatus(listener, signal) {
    const unsubscribe = gitStatusCache.subscribe(() => {
      this._notifyPin(listener, [], 'a git status change');
    });
    signal.addEventListener('abort', unsubscribe, { once: true });
    return unsubscribe;
  }

  /**
   * Run one read of git under both signals that may end it: the pin's mount, and
   * whatever the pin passed for the request itself.
   *
   * A pin that passes nothing still gets the first, which is the point — a review
   * a pin asked for and then went away from is a read nobody will look at, and
   * leaving it running is how a board that has been closed for a minute is still
   * shelling out to git. Both listeners come off again the moment the read
   * settles, because a pin selects file after file and the mount outlives every
   * one of them.
   * @template T
   * @param {AbortSignal} mount - The pin's mount signal.
   * @param {AbortSignal|undefined} caller - The signal the pin passed, if any.
   * @param {(signal: AbortSignal) => Promise<T>} read - The read to run.
   * @returns {Promise<T>} What it answered.
   * @private
   */
  async _gitRequest(mount, caller, read) {
    const child = new AbortController();
    const abort = () => child.abort();
    if (mount.aborted || caller?.aborted) abort();
    else {
      mount.addEventListener('abort', abort);
      caller?.addEventListener('abort', abort);
    }
    try {
      return await read(child.signal);
    } finally {
      mount.removeEventListener('abort', abort);
      caller?.removeEventListener('abort', abort);
    }
  }

  /**
   * The threads to look in for a context item, nearest first: the thread being
   * read, then each ancestor, ending at the root — which owns no thread item of
   * its own and is therefore null.
   *
   * This is the ownership order the columns themselves show. A plan made inside a
   * sub-thread belongs to that sub-thread and to nothing above it, so looking
   * upwards finds the nearest one that exists rather than aggregating several
   * threads' plans into a claim no thread is making.
   * @param {any} conversation - The conversation being read.
   * @param {string|null} threadItemId - The focused thread, null for the root.
   * @returns {(string|null)[]} Thread ids nearest-first, always ending with null.
   * @private
   */
  _ancestry(conversation, threadItemId) {
    /** @type {(string|null)[]} */
    const chain = [];
    const seen = new Set();
    let id = threadItemId;
    // A malformed tree must not spin here; the guard costs one Set.
    while (id && !seen.has(id)) {
      seen.add(id);
      chain.push(id);
      const parent = conversation.findParentContainer?.(id);
      id = parent ? parent.get('itemId') : null;
    }
    chain.push(null);
    return chain;
  }

  /**
   * What to call a thread: the name its own column header shows, and the
   * conversation's title for the root.
   * @param {any} conversation - The conversation being read.
   * @param {string|null} threadItemId - The thread, null for the root.
   * @returns {string} A name to show, or '' when the thread was never named.
   * @private
   */
  _threadLabel(conversation, threadItemId) {
    if (!threadItemId) return conversation?.name || '';
    try {
      const ymap = conversation.findItemById?.(threadItemId);
      return ymap ? (itemGoal(ymap) || '') : '';
    } catch {
      return '';
    }
  }

  /**
   * The nearest context item of a type, as a copy. Walks a thread and then its
   * ancestors, and reports which one it came from — a pin showing a parent
   * thread's plan has to be able to say so.
   *
   * The walk normally starts at the thread being read, so a pin follows the
   * reader. A pin that watches one thread names it instead: same resolution,
   * different starting point, and the source it reports is still whichever
   * thread in that chain actually owns the item.
   * @param {string} type - The context-item type id, e.g. 'plan'.
   * @param {string|null} [from] - The thread to start at; omit to follow the reader.
   * @returns {PinContextItemSnapshot|null} The snapshot, or null if nothing has one.
   * @private
   */
  _findContextItem(type, from) {
    const conversationId = this._active?.conversation?.id;
    const conversation = conversationId ? this._session?.getConversation?.(conversationId) : null;
    if (!conversation) return null;

    const focused = from === undefined ? (this._active?.thread?.id ?? null) : from;
    for (const threadId of this._ancestry(conversation, focused)) {
      let item = null;
      let itemId = null;
      try {
        // resolveMessageThread throws for an id that is not a thread item, which
        // a stale snapshot can easily hold.
        const thread = conversation.resolveMessageThread(threadId);
        item = thread?.contextItems?.find((/** @type {{type: string}} */ ci) => ci.type === type);
        if (item) itemId = writingRowId(thread, type);
      } catch {
        continue;
      }
      if (!item) continue;
      return {
        id: item.id,
        type: item.type,
        // A copy, so a pin cannot write through it into the conversation.
        data: cloneData(item.data),
        source: {
          threadId,
          label: this._threadLabel(conversation, threadId),
          inherited: threadId !== focused,
          itemId,
        },
      };
    }
    return null;
  }

  /**
   * Tell an item type when what it read may have changed: the conversation's
   * items, or which thread is being read. Both matter, and neither carries what
   * changed — the pin re-reads, which is cheap and always right.
   *
   * The thread being read is answered from the active-context snapshot, not from
   * the conversation, so the snapshot has to be the new one by the time a pin
   * re-reads. It is: the panel above listens for the same thread-focus event and
   * registered for it when it connected, which is necessarily before it mounted
   * anything here, and same-target listeners run in the order they were added.
   * So the panel has already pushed the new snapshot down. That also covers the
   * pin that implements `onChange` and no `update()`, which is why this listens
   * for a thread move at all rather than leaving it to the panel's `update()`.
   *
   * Tied to the pin's own signal as well as to the returned function, exactly as
   * {@link _watchFiles} is.
   * @param {() => void} listener - Called after a change.
   * @param {AbortSignal} signal - The subscribing pin's mount signal.
   * @returns {() => void} Unsubscribe.
   * @private
   */
  _watchContextItems(listener, signal) {
    const fire = () => this._scheduleNotify(listener, 'a context-item change', signal);
    /** @param {{type: string, data?: any}} event - A session event. */
    const onSession = (event) => {
      if (event.type !== 'context-items:changed' && event.type !== 'conversation:changed') return;
      // A pin reads one conversation. Every other conversation in the session
      // emits these too, and without this filter a turn streaming in a tab
      // nobody is looking at would re-read this pin's transcript at the sync rate.
      const changed = event.data?.conversationId;
      if (changed && changed !== (this._active?.conversation?.id || '')) return;
      fire();
    };
    const unsubscribeSession = this._session?.subscribe?.(onSession) || null;
    // Moving between threads is one deliberate act, not a stream, and what a pin
    // shows has to have followed by the time the move is over.
    const onFocus = () => this._notifyPin(listener, [], 'a thread-focus change');
    document.addEventListener(THREAD_FOCUS_CHANGED, onFocus);

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unsubscribeSession?.();
      document.removeEventListener(THREAD_FOCUS_CHANGED, onFocus);
      // This is the only service whose news is coalesced, so it is the only one
      // that can have a notification still in hand at this point.
      this._dropPendingNotify(listener);
    };
    signal?.addEventListener('abort', stop, { once: true });
    return stop;
  }

  /**
   * The thread a review is written to and read from: the one the reader is in,
   * in the conversation the board is showing. Resolved at the moment it is
   * asked for rather than held, because both halves of that move under a pin —
   * the reader changes thread, the board changes conversation — and a held
   * thread would go on answering for the one they left.
   * @returns {import('../model/message-thread.js').default|null} The thread, or
   *   null when there is no conversation to write to.
   * @private
   */
  _reviewThread() {
    const conversationId = this._active?.conversation?.id;
    const conversation = conversationId ? this._session?.getConversation?.(conversationId) : null;
    if (!conversation) return null;
    try {
      // resolveMessageThread throws for an id that is not a thread item, which a
      // stale snapshot can easily hold.
      return conversation.resolveMessageThread(this._active?.thread?.id ?? null);
    } catch {
      return null;
    }
  }

  /**
   * The unsent review on the thread being read, as a copy — the normalising read
   * builds every comment fresh, so a pin cannot write through one into the
   * document.
   * @returns {import('../utils/review-draft.js').ReviewDraft|null} The draft, or
   *   null when there is no conversation to hold one.
   * @private
   */
  _reviewDraft() {
    const thread = this._reviewThread();
    return thread ? thread.gitReviewDraft : null;
  }

  /**
   * Replace the review draft on the thread being read, or clear it with null.
   *
   * Refuses rather than trims. The destination is checked first because it is
   * the more fundamental absence, and the bounds are checked before anything is
   * written so that a refused save leaves the previous draft exactly as it was —
   * the surface that asked still holds the text, and can show what came back
   * beside it.
   * @param {{comments?: import('../utils/review-draft.js').ReviewComment[]}|null} draft - The draft to store.
   * @returns {Promise<void>} Resolves once it is in the document.
   * @private
   */
  async _saveReviewDraft(draft) {
    const thread = this._reviewThread();
    if (!thread) throw new Error('There is no conversation open to keep review comments in.');
    const problem = reviewDraftBoundsError(draft);
    if (problem) throw new Error(problem);
    thread.gitReviewDraft = draft;
  }

  /**
   * Put the review in the prompt, for the reader to send themselves.
   *
   * The feedback is the user's own words about their own code, and the last look
   * at it belongs to them: it goes into the box so it can be read back, added
   * to, cut down or abandoned. Three places it can land, in this order —
   *
   * - the composer for the thread being read, when this window has one;
   * - the window this board was detached from, which has the columns (see
   *   {@link module:services/pinboard-link}); the owner decides what happens
   *   there, exactly as it does for a reveal;
   * - failing both, the conversation itself, as one ordinary user message. A
   *   board whose owner has closed still has somewhere to put the feedback, and
   *   a review that cannot be handed over is worth more said than dropped.
   *
   * The comments are never cleared. Pasting is not saying — the text can still
   * be deleted out of the box — so the batch stays the reader's to discard, and
   * the panel goes on counting it until they do.
   * @returns {Promise<void>} Resolves once the review has been handed over.
   * @private
   */
  async _composeReview() {
    const thread = this._reviewThread();
    if (!thread) throw new Error('There is no conversation open to put a review in.');
    const draft = thread.gitReviewDraft;
    if (!draft.comments.length) throw new Error('There are no review comments to hand over.');
    const text = formatReviewMessage(draft);

    if (pasteIntoComposer(composerForThread(thread), text)) return;
    if (isPinboardView()
      && satelliteLink.compose(text, thread.conversation.id, thread.threadItemId ?? null)) return;
    await composeForThread(thread, text);
  }

  /**
   * Tell a pin when the review draft it is showing may have changed. Two
   * different things count, and a pin cannot tell them apart: the draft was
   * written — here, or in another window sharing the conversation — or the
   * thread being read moved, so the draft is now a different one. Both mean the
   * same thing to the pin, which re-reads.
   *
   * Tied to the pin's own signal as well as to the returned function, exactly as
   * {@link _watchContextItems} is.
   * @param {() => void} listener - Called after a change.
   * @param {AbortSignal} signal - The subscribing pin's mount signal.
   * @returns {() => void} Unsubscribe.
   * @private
   */
  _watchReviewDraft(listener, signal) {
    /** @type {{listener: () => void, detach: (() => void)|null}} */
    const entry = { listener, detach: null };
    this._reviewWatchers.add(entry);
    this._bindReviewWatcher(entry);

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      entry.detach?.();
      entry.detach = null;
      this._reviewWatchers.delete(entry);
    };
    signal?.addEventListener('abort', stop, { once: true });
    return stop;
  }

  /**
   * Point one watcher at the thread now being read. A board with no conversation
   * has nothing to observe and is left unbound — it is re-bound the moment one
   * arrives, which is what {@link _rebindReviewWatchers} is for.
   * @param {{listener: () => void, detach: (() => void)|null}} entry - The watcher.
   * @private
   */
  _bindReviewWatcher(entry) {
    entry.detach?.();
    entry.detach = null;
    const thread = this._reviewThread();
    if (!thread) return;
    entry.detach = thread.observeGitReviewDraft(
      () => this._notifyPin(entry.listener, [], 'a review-draft change')
    );
  }

  /**
   * Move every watcher to the thread now being read, and tell it. The telling is
   * the point: nothing was written, but what a pin is showing belongs to the
   * thread the reader has just left, and a pin that learned of the move only
   * when someone next typed would show another thread's comments until they did.
   * @private
   */
  _rebindReviewWatchers() {
    for (const entry of this._reviewWatchers) {
      this._bindReviewWatcher(entry);
      this._notifyPin(entry.listener, [], 'a move to another review draft');
    }
  }

  /**
   * Every background task this conversation's transcript says it started, alive
   * or not. The id is the receipt `shellBackground` returned, stored on the tool
   * action that spawned it — so `bash` with `run_in_background` and `Monitor`
   * both land here, and a foreground command, which has no task id, does not.
   *
   * This is only half of the answer. The transcript is a record of what was
   * started and can never be a record of what is still running: the durable
   * snapshot beside it freezes at whatever it last said, so after a restart it
   * claims `running` forever. {@link _pollTasks} joins this to the server, which
   * is the only thing that knows.
   *
   * Reads fields one at a time with {@link itemField} and never calls `toJSON`: a
   * background `bash` action's result holds the command's accumulated output.
   * @returns {PinTask[]} Candidates, newest first.
   * @private
   */
  _listTaskCandidates() {
    const conversationId = this._active?.conversation?.id;
    const conversation = conversationId ? this._session?.getConversation?.(conversationId) : null;
    if (!conversation) return [];

    /** @type {(PinTask & {_order: number})[]} */
    const found = [];
    let order = 0;

    for (const thread of conversation.getAllMessageThreads?.() || []) {
      for (const ymap of thread.items || []) {
        order++;
        if (typeof ymap?.get !== 'function') continue;
        if (ymap.get('type') !== 'tool-action') continue;

        const result = ymap.get('result');
        if (!result) continue;
        const payload = itemField(itemField(result, 'fullResult'), 'result');
        const taskId = itemField(payload, 'task_id');
        if (typeof taskId !== 'string' || !taskId) continue;

        const input = ymap.get('toolInput');
        found.push({
          taskId,
          itemId: ymap.get('itemId'),
          threadId: thread.threadItemId || null,
          toolName: String(ymap.get('toolName') || ''),
          command: String(itemField(input, 'command') || ''),
          label: String(itemField(input, 'description') || ''),
          at: itemTime(ymap),
          _order: order,
        });
      }
    }

    found.sort((a, b) => (b.at - a.at) || (b._order - a._order));
    return found.map(({ _order, ...task }) => task);
  }

  /**
   * Ask the server which of the transcript's tasks are still running, and keep
   * the ones that are.
   *
   * The probe names the ids rather than asking what exists, so there is no
   * listing to be wrong about and nothing to see beyond what this conversation
   * already shows. A task that has ended, been reaped, or died with a previous
   * server simply is not in the answer — which is why an empty board after a
   * restart needs no special case to be honest.
   * @returns {Promise<void>} Resolves once the list has been refreshed.
   * @private
   */
  async _pollTasks() {
    if (this._taskProbing) return;
    const convId = this._active?.conversation?.id;
    if (!convId) {
      this._tasks = [];
      this._taskError = '';
      this._notifyTaskWatchers();
      return;
    }

    const candidates = this._listTaskCandidates();
    if (!candidates.length) {
      this._tasks = [];
      this._taskError = '';
      this._notifyTaskWatchers();
      return;
    }

    this._taskProbing = true;
    try {
      const answer = await shellTaskStatus({
        conv_id: convId,
        task_ids: candidates.map((task) => task.taskId),
      });
      // The conversation may have changed while the probe was out; its answer is
      // about a conversation nobody is looking at any more.
      if ((this._active?.conversation?.id || '') !== convId) return;
      const running = new Set(
        (answer?.tasks || []).filter((task) => task.running).map((task) => task.task_id)
      );
      this._tasks = candidates.filter((task) => running.has(task.taskId));
      this._taskError = '';
    } catch (err) {
      this._taskError = extractErrorMessage(err);
    } finally {
      this._taskProbing = false;
    }
    this._notifyTaskWatchers();
  }

  /**
   * Tell every task watcher the list may have changed.
   * @private
   */
  _notifyTaskWatchers() {
    // The probe runs every two seconds and almost always comes back with the
    // same tasks still running. That is not news, and a watcher told about it
    // rebuilt itself thirty times a minute to draw the identical list. What does
    // change between identical answers is how long each task has been going,
    // which is the watcher's own clock to keep.
    const signature = JSON.stringify({
      tasks: this._tasks && this._tasks.map((task) => `${task.taskId} ${task.itemId}`),
      error: this._taskError,
    });
    if (signature === this._taskSignature) return;
    this._taskSignature = signature;
    for (const listener of this._taskListeners) {
      this._notifyPin(listener, [], 'a task change');
    }
  }

  /**
   * Run the poll exactly while something is watching.
   * @private
   */
  _updateTaskPolling() {
    const wanted = this._taskListeners.size > 0;
    if (wanted === (this._taskTimer !== null)) return;
    if (wanted) {
      this._taskTimer = setInterval(this._taskPoll, TASK_POLL_MS);
      if (typeof window !== 'undefined') window.addEventListener('focus', this._taskPoll);
      return;
    }
    if (this._taskTimer) clearInterval(this._taskTimer);
    this._taskTimer = null;
    if (typeof window !== 'undefined') window.removeEventListener('focus', this._taskPoll);
  }

  /**
   * Subscribe an item type to the running-task list, starting the poll for the
   * first watcher and stopping it after the last — so nothing asks the server
   * about tasks for a surface nobody has open.
   *
   * Tied to the pin's signal as well as to the returned function, like every
   * other service here.
   * @param {() => void} listener - Called when the list may have changed.
   * @param {AbortSignal} signal - The subscribing pin's mount signal.
   * @returns {() => void} Unsubscribe.
   * @private
   */
  _watchTasks(listener, signal) {
    this._taskListeners.add(listener);
    this._updateTaskPolling();
    void this._pollTasks();

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      this._taskListeners.delete(listener);
      this._updateTaskPolling();
    };
    signal.addEventListener('abort', stop, { once: true });
    return stop;
  }

  /**
   * Stop a running task, by whichever of the two means actually fits it.
   *
   * A Monitor's task is owned by its delivery binding, and cancelling that is
   * what stops it: the worker sees the flag, stops the pump and kills the task,
   * so the binding's own status stays the truth about it. A plain background task
   * has no binding, and is killed directly — the same op its properties panel's
   * Stop button calls. Which of the two a task is, is the host's knowledge; a pin
   * asks for it to stop and does not need to know how.
   * @param {string} taskId - The task to stop.
   * @returns {Promise<void>} Resolves once it has been asked to stop.
   * @private
   */
  async _stopTask(taskId) {
    const convId = this._active?.conversation?.id || '';
    const task = (this._tasks || []).find((candidate) => candidate.taskId === taskId);
    const conversation = convId ? this._session?.getConversation?.(convId) : null;
    const thread = (conversation?.getAllMessageThreads?.() || [])
      .find((/** @type {any} */ candidate) => (candidate.threadItemId || null) === (task?.threadId ?? null));

    if (thread?.cancelTaskOutputDelivery?.(taskId)) {
      await this._pollTasks();
      return;
    }
    await shellKill({ shell_id: taskId, conv_id: convId });
    await this._pollTasks();
  }

  /**
   * Tear down whatever is mounted. Best-effort: an item type that throws on the
   * way out has already been replaced by the time it does.
   * @private
   */
  _unmount() {
    const kept = this._pin ? this._retained.get(this._pin.id) : null;
    if (kept) {
      // Put it away rather than end it. Its signal stays unaborted and its
      // subscriptions stay live, so what happens while it is hidden is still
      // news it will be told — which is the difference between a pin that
      // survives a tab switch and one that merely gets rebuilt quickly.
      this._callController(kept.controller, 'hide');
      kept.element.hidden = true;
    } else {
      // News held for a controller that is going away is news for nobody — but
      // only that controller's, because a retained pin next to it is still
      // listening and its news is still wanted.
      this._dropNotifyFor(this._abort?.signal);
      try {
        this._abort?.abort();
      } catch (err) {
        console.error('[Pinboard] Abort failed:', err);
      }
      try {
        this._controller?.teardown?.();
      } catch (err) {
        console.error('[Pinboard] Item type failed to tear down:', err);
      }
      this._transientSlot?.remove();
      this._transientSlot = null;
    }
    this._abort = null;
    this._controller = null;
    this._pin = null;
    this._hidePlaceholder();
    this._actionList = [];
    // The toolbar has been emptied, so whatever it last said is no longer a
    // description of what is drawn — and the next pin's actions must not be
    // mistaken for the ones already there.
    this._actionSignature = '';
    if (this._actions) {
      this._actions.replaceChildren();
      this._actions.hidden = true;
    }
  }

  /**
   * Nothing is pinned. The `+` above stays exactly where it is; this offers the
   * same picker a second way.
   * @private
   */
  _renderEmpty() {
    if (!this._placeholder) return;
    const empty = document.createElement('div');
    empty.className = 'pinboard-empty';
    const line = document.createElement('p');
    line.className = 'pinboard-empty__line';
    line.textContent = 'Nothing pinned.';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'pinboard-empty__add';
    add.textContent = 'Add…';
    add.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('pinboard-add', { bubbles: true }));
    });
    empty.append(line, add);
    this._showPlaceholder(empty);
  }

  /**
   * Draw one of the host's own states in the pin's place. It goes in an element
   * of its own so that retained pins, which are hidden rather than removed, are
   * still there when the board has something to show again.
   * @param {HTMLElement} content - What to show.
   * @private
   */
  _showPlaceholder(content) {
    if (!this._placeholder) return;
    this._placeholder.replaceChildren(content);
    this._placeholder.hidden = false;
  }

  /**
   * Take the placeholder down and let go of what it was holding.
   * @private
   */
  _hidePlaceholder() {
    if (!this._placeholder) return;
    this._placeholder.replaceChildren();
    this._placeholder.hidden = true;
  }

  /**
   * A pin whose item type no enabled extension provides. The pin stays, and so
   * does its config — re-enabling the extension brings it back as it was.
   * @param {Pin} pin - The orphaned pin.
   * @private
   */
  _renderMissing(pin) {
    if (!this._placeholder) return;
    const missing = document.createElement('div');
    missing.className = 'pinboard-placeholder';
    const line = document.createElement('p');
    line.className = 'pinboard-placeholder__line';
    line.textContent = `Nothing provides "${pin.type}".`;
    const note = document.createElement('p');
    note.className = 'pinboard-placeholder__note';
    note.textContent = 'The pin keeps its settings until you remove it.';
    missing.append(line, note);
    this._showPlaceholder(missing);
  }

  /**
   * An item type that failed. The lead goes above the error, never in place of it.
   *
   * The controller goes with it: something that threw on the way through is in no
   * position to be offering the toolbar actions it advertised a moment ago, and a
   * button that cannot work is worse than no button.
   * @param {unknown} err - What was thrown.
   * @private
   */
  _renderError(err) {
    if (!this._placeholder) return;
    console.error('[Pinboard] Item type failed:', err);
    // A retained pin that has thrown is dropped outright rather than kept: what
    // retention protects is a thing still working, and this one has said it is
    // not. Dropping it takes its element and its subscriptions with it.
    if (this._pin && this._retained.has(this._pin.id)) {
      this._dropSlot(this._pin.id);
    } else {
      try {
        this._controller?.teardown?.();
      } catch (teardownErr) {
        console.error('[Pinboard] Item type failed to tear down after an error:', teardownErr);
      }
      this._transientSlot?.remove();
      this._transientSlot = null;
    }
    this._controller = null;
    this._renderActions();
    const shell = document.createElement('div');
    shell.className = 'pinboard-placeholder';
    const line = document.createElement('p');
    line.className = 'pinboard-placeholder__line';
    line.textContent = "Couldn't show this pin.";
    const detail = document.createElement('pre');
    detail.className = 'pinboard-placeholder__error';
    detail.textContent = extractErrorMessage(err);
    shell.append(line, detail);
    this._showPlaceholder(shell);
  }
}

/**
 * What the chrome should say about a pin — the item type's own words where it has
 * an opinion, and the bare type id where nothing is left to ask.
 * @param {Pin} pin - The pin.
 * @param {PinActiveContext|null} active - The active-context snapshot.
 * @returns {import('juggler/pinboard-item-type').PinDescription} Title, subtitle and badge.
 */
export function describePin(pin, active) {
  const type = pinboardItemRegistry.getType(pin.type);
  if (!type) return { title: pin.type };
  try {
    const described = type.describe(pin.config, /** @type {PinActiveContext} */ (active));
    if (described && typeof described.title === 'string' && described.title) return described;
  } catch (err) {
    console.error(`[Pinboard] Item type "${pin.type}" failed to describe a pin:`, err);
  }
  return { title: type.name };
}

customElements.define('pinboard-content', PinboardContent);

export default PinboardContent;
