//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <pinboard-shell> — the pinboard's attached surface: the scrim, and the panel
 * that slides over the working area. The control that opens it is the header
 * bar's own button, which this element adopts rather than builds — the board is
 * one of the window's surfaces, so its toggle stands with the window's controls
 * at every width.
 *
 * The board OVERLAYS the workspace rather than taking width from it. The
 * conversation columns are wide, horizontally scrolling and full of held scroll
 * positions; narrowing them every time the board opens would reflow and jump the
 * thing the user was reading, to show them something beside it.
 *
 * Opening is latched — a click, or the shortcut. Clicking inside the board never
 * closes it, and neither does the pointer leaving: file previews, text selection
 * and drags all need to survive a wandering mouse. There is no hover peek. A
 * finger has one more way out: the board can be swiped back off the edge it
 * arrived from, as the conversation drawer and a bottom sheet can.
 *
 * The board's chords are dispatched here rather than by the shortcut manager: an
 * open board holds a popup token, and the manager stands every command down
 * behind an overlay — which is right for every command except the ones aimed at
 * this one.
 * @module components/pinboard-shell
 */

import JugglerElement from './juggler-element.js';
import pinboardStore from '../services/pinboard-store.js';
import pinboardView from '../services/pinboard-view.js';
import pinboardItemRegistry from '../registries/pinboard-item-registry.js';
import wsService from '../services/websocket.js';
import { REGISTRIES_RELOADED } from '../registries/reload-registries.js';
import keyShortcutManager, { eventMatchesBinding } from '../services/key-shortcut-manager.js';
import { markPopupOpen, isAnyPopupOpen } from '../utils/popup-manager.js';
import { attachSwipeDismiss } from '../utils/swipe-dismiss.js';
import { errorText } from '../../sdk/lib/error-utils.js';
import { isPinboardView } from '../utils/view-mode.js';
import { t } from '../../sdk/lib/i18n.js';
import findBar from './find-bar.js';
import { cachedWindowPref, getWindowPref, setWindowPref } from '../services/prefs.js';
import './pinboard-panel.js';

/** The window preference holding the panel's width, in rem. */
const WIDTH_PREF = 'juggler-pinboard-width';

/**
 * Panel width bounds, in rem. Wide, on purpose: what the board is for changes
 * with what is on it — a task list wants a strip, a file wants half the display
 * — so the bounds are the extremes of usefulness rather than a house opinion,
 * and `_applyWidth` clamps to the viewport on top of them.
 */
const MIN_WIDTH_REM = 20;
const MAX_WIDTH_REM = 80;
const DEFAULT_WIDTH_REM = 34;

class PinboardShell extends JugglerElement {
  constructor() {
    super();
    /** @type {HTMLElement|null} @private The header bar's toggle, adopted on build. */
    this._toggleButton = null;
    /** @type {HTMLElement|null} @private */
    this._scrim = null;
    /** @type {any} @private */
    this._panel = null;
    /** @type {(() => void)|null} @private Popup-manager token held while open. */
    this._releasePopup = null;
    /** @type {HTMLElement|null} @private Where focus was when the board opened. */
    this._focusReturn = null;
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {boolean} @private Whether the board has been fetched for this project. */
    this._loadStarted = false;
    /** @type {Promise<any>|null} @private The board's arrival, for work that must follow it. */
    this._loaded = null;
    /** @type {boolean} @private Whether this viewer has asked to furnish a new board. */
    this._furnishStarted = false;
    /** @type {boolean} @private Whether this viewer has pruned the board's retired pins. */
    this._pruneStarted = false;
    /** @type {number} @private The panel's width in rem, after clamping. */
    this._widthRem = DEFAULT_WIDTH_REM;
  }

  connectedCallback() {
    this._build();
    this.addCleanup(pinboardStore.subscribe(() => this._syncVisibility()));
    this.addCleanup(pinboardView.subscribe(() => this._syncOpen()));
    const onReveal = (/** @type {any} */ data) => this._onPinboardReveal(data);
    wsService.on('pinboard-reveal', onReveal);
    this.addCleanup(() => wsService.off('pinboard-reveal', onReveal));
    // Enabling or disabling an extension can be what gives the board its first
    // item type, or takes its last one away.
    this.onDocument(REGISTRIES_RELOADED, () => this._syncVisibility());
    this.onDocument('keydown', (e) => this._onKeyDown(/** @type {KeyboardEvent} */ (e)));
    this._syncVisibility();
    this._syncOpen();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._releasePopup?.();
    this._releasePopup = null;
  }

  /**
   * Supply the session, and fetch the board once there is a project to have one.
   * @param {import('../model/session.js').default} session - The viewer's session.
   * @returns {void}
   */
  setSession(session) {
    this._session = session;
    this._panel?.setSession(session);
    this._syncVisibility();
    if (!session) return;
    this.addCleanup(session.subscribe((event) => {
      if (event.type === 'session:loaded') this._syncVisibility();
    }));
  }

  /**
   * Follow an advisory request to show a pin when it came from the conversation
   * this viewer is watching and doing so would not cover a draft in progress.
   * Detached boards ignore it: the agent targets the shared docked board, while
   * a detached window is an arrangement the user made for its own purpose.
   * @param {{board?: string, pin?: string, from?: string}} data - Reveal request.
   * @private
   */
  _onPinboardReveal(data) {
    if (isPinboardView() || data?.board !== 'main' || !data?.pin) return;
    const from = data.from || '';
    if (!from || !this._session?.shouldFollowRequest?.(from)) return;
    if (!pinboardStore.getPin(data.pin)) return;
    pinboardView.reveal(data.pin);
  }

  /**
   * Build the surface once: scrim, panel and its resize handle, and adopt the
   * header bar's toggle.
   * @private
   */
  _build() {
    if (this._panel) return;
    if (isPinboardView()) {
      this._buildDetached();
      return;
    }

    const scrim = document.createElement('div');
    scrim.className = 'pinboard-scrim';
    // Dimming is decoration; the click it catches is the outside-click dismissal.
    scrim.setAttribute('aria-hidden', 'true');
    this.on(scrim, 'click', () => pinboardView.close());

    const panel = document.createElement('pinboard-panel');
    panel.id = 'pinboard-panel';
    panel.className = 'pinboard-panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', t('Pinboard'));

    const handle = document.createElement('div');
    handle.className = 'pinboard-resize-handle';
    handle.setAttribute('aria-hidden', 'true');
    this.on(handle, 'pointerdown', (e) => this._beginResize(/** @type {PointerEvent} */ (e)));
    panel.appendChild(handle);

    this.append(scrim, panel);
    this._scrim = scrim;
    this._panel = panel;

    // Push it back off the right edge it came in from — the mirror of the
    // sidebar drawer's leftward swipe, and the same gesture. Two of the panel's
    // own drags are conceded by name: the resize grip on its left edge, and a
    // tab's reorder grip. The rest is conceded by scroll position, because the
    // board's content is a scroll box and its commonest occupant is a code block
    // wider than a phone — a rightward drag there is the reader coming back to
    // the left margin until there is no margin left to come back to.
    this.addCleanup(attachSwipeDismiss(panel, {
      direction: 'right',
      thresholdPx: 60,
      isActive: () => pinboardView.isOpen(),
      exclude: '.pinboard-resize-handle, .drag-grip',
      yieldToScroll: true,
      onDismiss: () => pinboardView.close(),
    }));

    this._applyWidth(loadWidth());
    // And again with the width this window actually has stored, once the
    // session answers. A viewer that has never set one keeps the default rather
    // than being handed another window's.
    void getWindowPref(WIDTH_PREF, null).then((stored) => {
      const rem = parseFloat(stored);
      if (Number.isFinite(rem) && rem > 0 && rem !== this._widthRem) this._applyWidth(rem);
    });

    // The toggle belongs to the header bar, beside the window's other controls,
    // and is written in the markup there — the shell only wires it up and keeps
    // its expanded state honest.
    const toggle = document.getElementById('pinboard-header-button');
    if (toggle) {
      this._toggleButton = toggle;
      toggle.title = t('Toggle Pinboard');
      toggle.setAttribute('aria-label', t('Toggle Pinboard'));
      this.on(toggle, 'click', () => this._toggle());
    }
  }

  /**
   * Build the board as the whole window rather than as an overlay in one: the
   * panel and nothing else. There is no toggle to adopt because there is nothing
   * to open, no scrim because there is no workspace behind to dim, and no resize
   * handle because the window itself is the width control.
   * @private
   */
  _buildDetached() {
    const panel = document.createElement('pinboard-panel');
    panel.id = 'pinboard-panel';
    panel.className = 'pinboard-panel';
    panel.setAttribute('role', 'main');
    panel.setAttribute('aria-label', t('Pinboard'));
    this.append(panel);
    this._panel = panel;
  }

  /**
   * Open or close the board, remembering where focus was so closing can put it
   * back.
   * @private
   */
  _toggle() {
    if (pinboardView.isOpen()) {
      pinboardView.close();
      return;
    }
    const focused = document.activeElement;
    this._focusReturn = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    pinboardView.open();
  }

  /**
   * Reflect the view state: the class the CSS animates from, the popup token
   * Escape and Back dismiss through, and where focus goes.
   * @private
   */
  _syncOpen() {
    const open = pinboardView.isOpen();
    if (open === this.classList.contains('open')) return;
    this.classList.toggle('open', open);
    this._toggleButton?.setAttribute('aria-expanded', String(open));

    // A detached board is the window's only content, so it holds no popup token
    // — Escape dismisses the topmost surface, and here that would be everything
    // the window has — and there is nowhere to return focus to on close.
    if (isPinboardView()) return;

    if (open) {
      // Escape and the browser/mobile Back button dismiss via popup-manager. The
      // token is id-less, so the board is not closed by the add picker (or any
      // other menu) opening over it.
      this._releasePopup = markPopupOpen(() => pinboardView.close());
      this._panel?.focusInto();
      return;
    }

    this._releasePopup?.();
    this._releasePopup = null;
    // Before focus is handed back, so the bar's own restore doesn't take it
    // again on the way out.
    findBar.closeFor(this);
    const back = this._focusReturn?.isConnected ? this._focusReturn : this._toggleButton;
    this._focusReturn = null;
    // Scrolling is the workspace's business, not focus's: the element focus goes
    // back to may have been scrolled away while the board was up, and hauling
    // the columns to it would move what the reader was reading.
    back?.focus({ preventScroll: true });
  }

  /**
   * Show the board only when it is worth having: a project to own it, and either
   * an item type that can fill a tab or a pin already on the board. A toggle that
   * opens an empty board with nothing to put in it is worse than no toggle — so
   * with no pinboard extension enabled, the surface stays away rather than
   * advertising itself.
   *
   * A pin whose extension has been disabled still counts: it is the only way
   * back to a board holding pins nothing can currently render.
   * @private
   */
  _syncVisibility() {
    const hasProject = !!this._session?.projectPath;
    if (hasProject && !this._loadStarted) {
      this._loadStarted = true;
      this._loaded = pinboardStore.load().catch((err) => {
        pinboardView.setStatus(t('Couldn\'t load the pinboard. {error}', { error: errorText(err) }));
      });
    }
    const enabled = pinboardItemRegistry.getEnabledTypes();
    // A new board is furnished with its starting tabs once, and this waits for
    // two things before asking whose turn it is. The board, because a load still
    // in flight would land on top of the tabs just written. And an item type to
    // furnish it with, because the registry fills after the extensions arrive —
    // a board claimed while it was empty would be laid out with nothing and
    // never asked about again.
    if (this._loaded && !this._furnishStarted && enabled.length > 0) {
      this._furnishStarted = true;
      void this._loaded.then(() => pinboardView.furnish());
    }
    // A withdrawn pin type is taken off the board once its board has arrived.
    // Unlike furnishing, this waits for nothing else and is not claimed: the
    // registry can never learn the type, every board carries its own copy of
    // the tab, and a remove of a pin already gone changes nothing.
    if (this._loaded && !this._pruneStarted) {
      this._pruneStarted = true;
      void this._loaded.then(() => pinboardView.prune());
    }
    const usable = enabled.length > 0 || pinboardStore.get().length > 0;
    this.hidden = !hasProject || !usable;
    // The toggle lives in the header rather than in here, so it does not go away
    // with the shell and has to be told.
    if (this._toggleButton) this._toggleButton.hidden = this.hidden;
    if (this.hidden) {
      pinboardView.close();
      return;
    }
    // Open is the detached board's only state, and this is the moment it can
    // first be in it: the shell is built before the session arrives, so at build
    // time there is no project yet and nothing to show.
    if (isPinboardView()) pinboardView.open();
  }

  /**
   * The board's own chord. Dispatched here rather than through the shortcut
   * manager's loop: while the board is open it holds a popup token, and the
   * manager suppresses every command behind an overlay — including this one.
   * @param {KeyboardEvent} e - The keydown.
   * @private
   */
  _onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (this.hidden) return;
    if (this._cyclePins(e)) return;
    if (this._openFind(e)) return;
    // Nothing to toggle when the board is the window: closing it would mean
    // closing the window, which is what the window's own controls are for.
    if (isPinboardView()) return;
    const bindings = keyShortcutManager.getBindings('toggle-pinboard');
    if (!bindings.some((binding) => eventMatchesBinding(binding, e))) return;
    // Opening the board over a modal would put it behind that modal's own
    // dismissal; closing it from inside is the whole reason this lives here.
    if (!pinboardView.isOpen() && isAnyPopupOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    this._toggle();
  }

  /**
   * Step along the tabs from wherever focus is.
   *
   * The panel's own plain arrows are the ones reached for, and they defer to
   * whatever is inside the pin. These do not: focus in a text field, in a pin
   * that has claimed the arrows for itself, anywhere in the window at all, and
   * the board still moves. That is the whole job — one gesture that is never
   * anyone else's.
   *
   * Only while the board is open, and it fires over the board's own popup token
   * exactly as the toggle above does: keys aimed at an overlay are the reason
   * both of them live here.
   * @param {KeyboardEvent} e - The keydown.
   * @returns {boolean} True when the keystroke was the board's.
   * @private
   */
  _cyclePins(e) {
    if (!pinboardView.isOpen()) return false;
    for (const [id, delta] of /** @type {[string, number][]} */ ([['prev-pin', -1], ['next-pin', 1]])) {
      if (!keyShortcutManager.getBindings(id).some((binding) => eventMatchesBinding(binding, e))) continue;
      e.preventDefault();
      e.stopPropagation();
      pinboardView.selectRelative(delta);
      return true;
    }
    return false;
  }

  /**
   * Open the find bar on the pin being read.
   *
   * Dispatched here for the same reason the toggle above is: an open board holds
   * a popup token, so ⌘F never reaches the shortcut manager's handler from in
   * here. It shares that handler's binding, since it is the same command aimed
   * at whatever is in front — and falls through untouched when the board has no
   * pin to search, leaving the browser's own find to it.
   * @param {KeyboardEvent} e - The keydown.
   * @returns {boolean} True when the keystroke was the board's.
   * @private
   */
  _openFind(e) {
    if (!pinboardView.isOpen()) return false;
    const bindings = keyShortcutManager.getBindings('find-in-conversation');
    if (!bindings.some((binding) => eventMatchesBinding(binding, e))) return false;
    const content = /** @type {any} */ (this.querySelector('pinboard-content'));
    if (!content?.getFindTarget?.()) return false;
    e.preventDefault();
    e.stopPropagation();
    findBar.open(content);
    return true;
  }

  /**
   * Drag the panel's left edge. Dragging left widens it, so the delta is the
   * opposite way round from a column handle.
   * @param {PointerEvent} start - The pointerdown on the handle.
   * @private
   */
  _beginResize(start) {
    if (start.button !== 0) return;
    start.preventDefault();
    const handle = /** @type {HTMLElement} */ (start.currentTarget);
    handle.setPointerCapture(start.pointerId);
    handle.classList.add('dragging');
    const startX = start.clientX;
    const startWidth = /** @type {HTMLElement} */ (this._panel).getBoundingClientRect().width;

    const onMove = (/** @type {PointerEvent} */ move) => {
      this._applyWidth((startWidth + (startX - move.clientX)) / remPx());
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', /** @type {any} */ (onMove));
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      saveWidth(this._widthRem);
    };
    handle.addEventListener('pointermove', /** @type {any} */ (onMove));
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  /**
   * Set the panel width, clamped to its bounds and to a viewport that may be
   * narrower than either of them.
   * @param {number} rem - The requested width in rem.
   * @private
   */
  _applyWidth(rem) {
    const viewportRem = window.innerWidth / remPx();
    const max = Math.min(MAX_WIDTH_REM, Math.max(MIN_WIDTH_REM, viewportRem - 2));
    this._widthRem = Math.max(MIN_WIDTH_REM, Math.min(max, rem));
    this.style.setProperty('--pinboard-width', `${this._widthRem}rem`);
  }
}

/**
 * @returns {number} The root font size in CSS pixels.
 */
function remPx() {
  return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * The width this window last chose, as far as is known without waiting.
 *
 * The width belongs to the window it is on: a desktop window keeps it in the
 * project's session, and a remote viewer — a phone, a second laptop — keeps its
 * own on its own device, since the server refuses that write. That is what
 * stops a laptop and a large display arguing about how wide the board is, and
 * the session is what makes the answer survive a relaunch.
 * @returns {number} A width in rem.
 */
function loadWidth() {
  const saved = parseFloat(cachedWindowPref(WIDTH_PREF, null));
  return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_WIDTH_REM;
}

/**
 * Remember a width for next time.
 * @param {number} rem - The width to store.
 * @returns {void}
 */
function saveWidth(rem) {
  void setWindowPref(WIDTH_PREF, rem);
}

customElements.define('pinboard-shell', PinboardShell);
