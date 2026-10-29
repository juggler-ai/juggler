//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The recent-conversation switcher behind Ctrl+Tab: the editor's "go back to
 * the last tab" key. Page Up/Down walk the strip in the order it is drawn; this
 * walks it in the order the conversations were last used.
 *
 * A tap shows the conversation used before this one, so tapping again comes
 * straight back — the two most recent are always one keystroke apart. Holding
 * Ctrl opens the list as a HUD: each further Tab moves down it, Shift moves up,
 * letting go of Ctrl shows the one picked, Escape closes it having changed
 * nothing, and a click picks a row. Nothing is shown until the gesture ends, so
 * walking past a long conversation costs nothing.
 *
 * The gesture is the shared {@link HoldToCycleController}'s, driven through its
 * `press()`: the desktop app's native window claims Ctrl+Tab before the page
 * sees it (WKWebView would swallow it) and re-raises it as `juggler:recent-tab`,
 * while the Control key's own keydown and keyup arrive as usual. A browser
 * keeps Ctrl+Tab for its own tabs, so the switcher is a desktop-app feature.
 * @module components/recent-tab-switcher
 */

import HoldToCycleController, { popupAwareShouldHandle } from '../services/hold-to-cycle.js';
import { registerOpenPopup } from '../utils/popup-manager.js';
import { t } from '../../sdk/lib/i18n.js';

/** The popup id the switcher's HUD registers under. */
const RECENT_TABS_POPUP_ID = 'recent-tabs';

/**
 * What one row of the list shows.
 * @typedef {object} RecentTabRow
 * @property {string} name - The conversation's name as its tab shows it.
 * @property {string} place - The workspace it works in, or '' at the top level.
 * @property {string} preset - The status circle's colour preset (`color-*`), as its tab's.
 * @property {string} glyphHtml - The glyph inside the circle, as markup.
 */

/**
 * What the switcher needs from the strip it serves.
 * @typedef {object} RecentTabSwitcherHost
 * @property {() => string[]} order - The open conversations, most recently used
 *   first (see {@link recentTabOrder}).
 * @property {() => string|null} visibleId - The conversation on screen, or null
 *   when something else is (a workspace panel).
 * @property {(id: string) => RecentTabRow} describe - How to draw a conversation's row.
 * @property {(id: string) => void} show - Show a conversation, as a click on its tab would.
 */

/**
 * The open conversations in order of use: the one on screen (or behind the
 * panel on screen), then those switched to most recently, then the rest in the
 * order the strip draws them. Anything the strip does not draw is left out.
 * @param {string[]} recentlyUsed - Switched-to conversations, most recent first.
 * @param {string|null} loadedId - The conversation on screen or behind a panel.
 * @param {string[]} drawn - Every open conversation, in strip order.
 * @returns {string[]} The ids, most recently used first.
 */
export function recentTabOrder(recentlyUsed, loadedId, drawn) {
  const open = new Set(drawn);
  /** @type {Set<string>} */
  const order = new Set();
  for (const id of [loadedId, ...recentlyUsed, ...drawn]) {
    if (id && open.has(id)) order.add(id);
  }
  return [...order];
}

export default class RecentTabSwitcher {
  /**
   * @param {RecentTabSwitcherHost} host
   */
  constructor(host) {
    /** @type {RecentTabSwitcherHost} @private */
    this._host = host;
    /** @type {string[]} @private The list, frozen for the length of a gesture */
    this._ids = [];
    /** @type {number} @private Index of the lit row in {@link _ids} */
    this._cursor = 0;
    /** @type {HTMLElement|null} @private */
    this._hud = null;
    /** @type {(() => void)|null} @private Releases the HUD's popup registration */
    this._releasePopup = null;
    /** @type {HoldToCycleController} @private */
    this._controller = new HoldToCycleController({
      modifierKeys: ['Control'],
      // Window-wide, standing down for any overlay but its own HUD.
      shouldHandle: popupAwareShouldHandle([RECENT_TABS_POPUP_ID]),
      canCycle: () => this._host.order().length >= 2,
      onGestureStart: (step, open) => this._start(step, open),
      onCycle: (step) => this._move(step),
      onCommit: () => this._commit(),
      onCancel: () => this._close(),
    });
  }

  /** Start listening for the held modifier. */
  init() {
    this._controller.init();
  }

  /** Stop listening, closing the HUD if it is open. */
  destroy() {
    this._controller.destroy();
    this._close();
  }

  /**
   * One Ctrl+Tab (`step` 1) or Ctrl+Shift+Tab (`step` -1).
   * @param {number} step
   * @returns {boolean} True when it started or moved a gesture; false when
   *   there was nothing to switch to or an overlay owns the keyboard.
   */
  press(step) {
    return this._controller.press(step);
  }

  /**
   * Freeze the list and light the row the first press asks for: forward, the
   * conversation used before the one on screen — or, over a workspace panel,
   * the conversation behind it, which leads the list; back, the last row.
   * @param {number} step
   * @param {boolean} open - False when the gesture ends with this press, so
   *   there is no HUD to draw.
   * @private
   */
  _start(step, open) {
    this._ids = this._host.order();
    const onScreen = this._host.visibleId() === this._ids[0];
    this._cursor = step < 0 ? this._ids.length - 1 : (onScreen ? 1 : 0);
    if (open) this._open();
  }

  /**
   * @param {number} step
   * @private
   */
  _move(step) {
    const n = this._ids.length;
    if (n === 0) return;
    this._cursor = (((this._cursor + step) % n) + n) % n;
    this._paintSelection();
  }

  /**
   * Show the lit row's conversation and close the HUD. The one already on
   * screen is left as it is.
   * @private
   */
  _commit() {
    const id = this._ids[this._cursor];
    this._close();
    if (id && id !== this._host.visibleId()) this._host.show(id);
  }

  /** @private */
  _open() {
    const hud = document.createElement('nav');
    hud.className = 'dropdown-menu show recent-tabs-hud';
    hud.setAttribute('aria-label', t('Recent conversations'));
    const list = document.createElement('menu');
    list.setAttribute('role', 'listbox');
    for (const id of this._ids) {
      const row = this._host.describe(id);
      const item = document.createElement('li');
      item.className = 'menu-item recent-tabs-row';
      item.dataset.conversationId = id;
      item.setAttribute('role', 'option');
      const circle = document.createElement('span');
      circle.className = `item-circle recent-tabs-status ${row.preset}`;
      circle.setAttribute('aria-hidden', 'true');
      circle.innerHTML = row.glyphHtml;
      const name = document.createElement('span');
      name.className = 'recent-tabs-name';
      name.textContent = row.name;
      item.append(circle, name);
      if (row.place) {
        const place = document.createElement('span');
        place.className = 'recent-tabs-place';
        place.textContent = row.place;
        item.append(place);
      }
      list.append(item);
    }
    hud.append(list);
    // A click picks a row: it is the release, arriving by pointer.
    hud.addEventListener('click', (e) => {
      const item = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.('.recent-tabs-row'));
      const index = item ? this._ids.indexOf(item.dataset.conversationId || '') : -1;
      if (index < 0) return;
      this._cursor = index;
      this._controller.commit();
    });
    document.body.append(hud);
    this._hud = hud;
    // Closed from outside — another popup opening, the Back button — the
    // gesture ends with it, so the release still to come shows nothing.
    this._releasePopup = registerOpenPopup({ id: RECENT_TABS_POPUP_ID, onClose: () => this._controller.cancel() });
    this._paintSelection();
  }

  /** @private */
  _paintSelection() {
    if (!this._hud) return;
    const rows = /** @type {HTMLElement[]} */ (Array.from(this._hud.querySelectorAll('.recent-tabs-row')));
    rows.forEach((row, i) => {
      const lit = i === this._cursor;
      row.classList.toggle('recent-tabs-row--selected', lit);
      row.setAttribute('aria-selected', String(lit));
      if (lit) row.scrollIntoView?.({ block: 'nearest' });
    });
  }

  /**
   * Take the HUD down. Idempotent: Escape, a commit and another popup opening
   * can each arrive here.
   * @private
   */
  _close() {
    const release = this._releasePopup;
    this._releasePopup = null;
    this._hud?.remove();
    this._hud = null;
    release?.();
  }
}
