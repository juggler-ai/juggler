//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <empty-hint-tips> — the rolling tip at the foot of the starting hint (see
 * {@link module:components/empty-hint-stack}): one tip from
 * {@link module:services/tips-manager} at a time under a lightbulb, rotating on
 * its own, with ‹ › buttons either side. Each step slides the old tip out and
 * the new one in from the side it came from, so the strip reads as a window on
 * a row of tips rather than one line of text that changes.
 *
 * Every tip is in the rotation, seen or not — a hint read at the start of every
 * conversation that ran out of things to say would just vanish. "Seen" only
 * picks where a mount starts: the first tip the user has not yet learnt by
 * doing, searching on from where the previous mount began, so consecutive new
 * conversations open on different tips.
 *
 * On a touch composer the keyboard-shortcut tips teach keys there are none of,
 * so only the feature tips rotate — keyed off the same `(hover: none) and
 * (pointer: coarse)` query the rest of the hint hides its keyboard rows by.
 *
 * Not an ARIA live region — rotating text would spam a screen reader; the same
 * content is available on demand in Settings › Keyboard shortcuts.
 * @module components/empty-hint-tips
 */

import JugglerElement from './juggler-element.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import { allTips, isSeen } from '../services/tips-manager.js';

/** @typedef {import('../services/tips-manager.js').Tip} Tip */

/**
 * Rotate to the next tip this often (ms): long enough to read the longest tip,
 * short enough that someone who glances at the hint sees it move.
 */
const ROTATE_MS = 8000;

/** How long one tip takes to slide out and the next in (ms). */
const SLIDE_MS = 350;

/** The query the starting hint hides its keyboard-only rows by. */
const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';

/**
 * Index a mount searches for an unseen tip from; each mount moves it on by one,
 * so the next new conversation does not open on the same tip.
 */
let startCursor = 0;

/**
 * @param {'left'|'right'} dir
 * @returns {string} A chevron icon's markup.
 */
function chevron(dir) {
  const points = dir === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6';
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" `
    + `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="${points}"/></svg>`;
}

/**
 * @returns {Tip[]} The tips this composer can use, in priority order.
 */
function rotation() {
  const touch = typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_QUERY).matches;
  return touch ? allTips().filter((t) => t.kind !== 'shortcut') : allTips();
}

class EmptyHintTips extends JugglerElement {
  constructor() {
    super();
    /** @type {Tip[]} @private */
    this._tips = [];
    /** @type {number} @private Index into `_tips` of the tip on show. */
    this._index = 0;
    /** @type {ReturnType<typeof setInterval>|null} @private */
    this._timer = null;
  }

  connectedCallback() {
    this._tips = rotation();
    if (this._tips.length === 0) return;
    this._index = this._startIndex();

    const badge = document.createElement('div');
    badge.className = 'empty-hint-tips__badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.appendChild(Object.assign(document.createElement('span'), { className: 'icon-lightbulb' }));

    const row = document.createElement('div');
    row.className = 'empty-hint-tips__row';
    row.append(
      this._navButton('prev'),
      Object.assign(document.createElement('div'), { className: 'empty-hint-tips__viewport' }),
      this._navButton('next'),
    );

    this.replaceChildren(badge, row);
    this._render(0);
    this._restartRotation();
    this.addCleanup(() => this._stopRotation());
  }

  /**
   * The first unseen tip at or after the shared cursor (wrapping), or the
   * cursor's own tip once every one is seen. Moves the cursor on for the next
   * mount.
   * @returns {number} The index to open on.
   * @private
   */
  _startIndex() {
    const n = this._tips.length;
    const from = startCursor % n;
    startCursor = from + 1;
    for (let i = 0; i < n; i++) {
      const idx = (from + i) % n;
      const tip = this._tips[idx];
      if (tip && !isSeen(tip.id)) return idx;
    }
    return from;
  }

  /**
   * @param {'prev'|'next'} which
   * @returns {HTMLButtonElement} A step button.
   * @private
   */
  _navButton(which) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = which === 'prev'
      ? 'btn-ghost empty-hint-tips__nav empty-hint-tips__nav--prev'
      : 'btn-ghost empty-hint-tips__nav empty-hint-tips__nav--next';
    btn.setAttribute('aria-label', which === 'prev' ? 'Previous tip' : 'Next tip');
    btn.innerHTML = chevron(which === 'prev' ? 'left' : 'right');
    btn.addEventListener('click', () => {
      this.step(which === 'prev' ? -1 : 1);
      this._restartRotation();
    });
    return btn;
  }

  /**
   * Move through the tips by `delta`, wrapping at either end.
   * @param {number} delta - +1 for the next tip, -1 for the previous one.
   * @returns {void}
   */
  step(delta) {
    const n = this._tips.length;
    if (n === 0) return;
    this._index = (((this._index + delta) % n) + n) % n;
    this._render(Math.sign(delta));
  }

  /** @returns {string|null} Id of the tip on show, or null when there is none. */
  get currentTipId() {
    return this._tips[this._index]?.id ?? null;
  }

  /**
   * Show the current tip in the viewport, sliding it in from the side `direction`
   * points away from (+1 enters from the right, -1 from the left, 0 just
   * appears). The incoming tip goes FIRST in the viewport and holds the layout;
   * the outgoing one is taken out of flow while it slides away, so neither the
   * buttons nor the stack's height move. A step made mid-slide drops the tip
   * still leaving, so at most two are ever present.
   * @param {number} direction
   * @private
   */
  _render(direction) {
    const viewport = this.querySelector('.empty-hint-tips__viewport');
    const tip = this._tips[this._index];
    if (!viewport || !tip) return;

    viewport.querySelectorAll('.empty-hint-tips__tip--leaving').forEach((leaving) => leaving.remove());
    const old = /** @type {HTMLElement|null} */ (viewport.querySelector('.empty-hint-tips__tip'));
    const slot = this._buildTip(tip);
    viewport.prepend(slot);
    if (!old) return;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (direction === 0 || reduced || typeof slot.animate !== 'function') {
      old.remove();
      return;
    }
    old.classList.add('empty-hint-tips__tip--leaving');
    const offset = direction > 0 ? 100 : -100;
    const timing = { duration: SLIDE_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' };
    slot.animate([
      { transform: `translateX(${offset}%)`, opacity: 0 },
      { transform: 'translateX(0)', opacity: 1 },
    ], timing);
    const out = old.animate([
      { transform: 'translateX(0)', opacity: 1 },
      { transform: `translateX(${-offset}%)`, opacity: 0 },
    ], timing);
    out.onfinish = () => old.remove();
    out.oncancel = () => old.remove();
  }

  /**
   * One tip's markup. Shortcut tips lead with the live key glyph, formatted now
   * so a rebinding shows on the next render. Built with
   * createElement/textContent (CSP-safe).
   * @param {Tip} tip
   * @returns {HTMLElement} The tip element.
   * @private
   */
  _buildTip(tip) {
    const slot = document.createElement('div');
    slot.className = 'empty-hint-tips__tip';

    const title = document.createElement('div');
    title.className = 'empty-hint-tips__title';
    if (tip.kind === 'shortcut' && tip.shortcutId) {
      const combo = keyShortcutManager.formatBinding(tip.shortcutId);
      if (combo) {
        const key = document.createElement('span');
        key.className = 'empty-hint-key empty-hint-tips__key';
        key.textContent = combo;
        title.appendChild(key);
      }
    }
    title.appendChild(document.createTextNode(tip.title));

    const body = document.createElement('div');
    body.className = 'empty-hint-tips__body';
    body.textContent = tip.body;

    slot.append(title, body);
    slot.setAttribute('data-tip-id', tip.id);
    return slot;
  }

  /**
   * (Re)start the rotation clock, so a tip the user just stepped to gets its
   * full turn. A hint that is not on screen (its conversation has history, or
   * the tab is in the background) skips the tick rather than rewriting text no
   * one can see.
   * @private
   */
  _restartRotation() {
    this._stopRotation();
    this._timer = setInterval(() => {
      if (this.checkVisibility?.() === false) return;
      this.step(1);
    }, ROTATE_MS);
  }

  /** @private */
  _stopRotation() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

customElements.define('empty-hint-tips', EmptyHintTips);

export default EmptyHintTips;
