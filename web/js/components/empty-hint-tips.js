//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <empty-hint-tips> — the rolling tip at the foot of the starting hint (see
 * {@link module:components/empty-hint-stack}): one tip from
 * the nudge catalogue ({@link module:services/guidance/nudge-catalogue}) at a
 * time under a lightbulb, rotating on
 * its own, with ‹ › buttons either side. Each step slides the old tip out and
 * the new one in from the side it came from, so the strip reads as a window on
 * a row of tips rather than one line of text that changes.
 *
 * Every tip is in the rotation, seen or not — a hint read at the start of every
 * conversation that ran out of things to say would just vanish. "Seen" only
 * picks where a mount starts: the first tip the user has not yet learnt by
 * doing, searching on from where the previous mount began, so consecutive new
 * conversations open on different tips — unless a `lead` tip applies (the
 * project has no AGENTS.md), which opens the strip every time. Which tips
 * apply is the engine's to say, from the `context` the conversation area
 * hands over.
 *
 * On a touch composer the keyboard-shortcut tips teach keys there are none of,
 * so only the feature tips rotate — keyed off the same `(hover: none) and
 * (pointer: coarse)` query the rest of the hint hides its keyboard rows by.
 *
 * Settings › Appearance can switch the strip off (the engine's guidanceShown);
 * it then stays in the stack empty and hidden, and comes back on the switch's
 * event.
 *
 * Not an ARIA live region — rotating text would spam a screen reader; the same
 * content is available on demand in Settings › Keyboard shortcuts.
 * @module components/empty-hint-tips
 */

import JugglerElement from './juggler-element.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import { allTips, isTipLearnt, guidanceShown, GUIDANCE_CHANGED_EVENT } from '../services/guidance/nudge-engine.js';
import { FACTS_CHANGED_EVENT } from '../services/guidance/facts.js';
import { t } from '../../sdk/lib/i18n.js';

/** @typedef {import('../services/guidance/nudge-engine.js').Tip} Tip */
/** @typedef {import('../services/guidance/nudge-catalogue.js').NudgeContext} NudgeContext */

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
 * @param {NudgeContext} ctx - Where the strip is.
 * @returns {Tip[]} The tips this composer can use, in priority order.
 */
function rotation(ctx) {
  const touch = typeof window.matchMedia === 'function' && window.matchMedia(TOUCH_QUERY).matches;
  const tips = allTips(ctx);
  return touch ? tips.filter((tip) => tip.kind !== 'shortcut') : tips;
}

/**
 * @param {Tip[]} tips
 * @returns {string} What identifies a rotation: its ids, in order.
 */
function rotationKey(tips) {
  return tips.map((tip) => tip.id).join('\n');
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
    /** @type {NudgeContext} @private */
    this._context = {};
  }

  connectedCallback() {
    const onChanged = () => this._sync();
    window.addEventListener(GUIDANCE_CHANGED_EVENT, onChanged);
    window.addEventListener(FACTS_CHANGED_EVENT, onChanged);
    this.addCleanup(() => {
      window.removeEventListener(GUIDANCE_CHANGED_EVENT, onChanged);
      window.removeEventListener(FACTS_CHANGED_EVENT, onChanged);
    });
    this.addCleanup(() => this._stopRotation());
    // Every mount starts afresh: a re-attached strip opens on the next tip, and
    // the rotation its last disconnect stopped is started again by the build.
    this.replaceChildren();
    this._sync();
  }

  /** @returns {NudgeContext} What the surface last said about where it is. */
  get context() { return this._context; }

  /**
   * Where the strip is: the conversation decides which `when` tips are in the
   * rotation. Set as often as the surface likes; the strip rebuilds only when
   * that changes which tips there are.
   * @param {NudgeContext} ctx
   */
  set context(ctx) {
    this._context = ctx || {};
    this._sync();
  }

  /**
   * Build the strip, or take it down, to match the Settings › Defaults switch
   * and the tips that apply here. Switched off, the element stays in the stack
   * but empty and `hidden`, with no rotation running — a strip that is not
   * there has nothing to tick. A change to which tips apply (a fact arriving,
   * a different conversation) rebuilds it, so a `lead` tip that has just become
   * true opens it; anything else leaves the tip on show alone.
   * @private
   */
  _sync() {
    if (!this.isConnected) return;
    const shown = guidanceShown();
    this.hidden = !shown;
    if (!shown) {
      this._stopRotation();
      this.replaceChildren();
      return;
    }
    const tips = rotation(this._context);
    if (this.childElementCount > 0 && rotationKey(tips) === rotationKey(this._tips)) return;
    this._stopRotation();
    this.replaceChildren();
    this._build(tips);
  }

  /**
   * Fill the strip and start it rotating.
   * @param {Tip[]} tips - The rotation.
   * @private
   */
  _build(tips) {
    this._tips = tips;
    // A tip with buttons stands taller than the rest; every tip gets its height
    // while one is in the rotation, so stepping never resizes the stack.
    this.classList.toggle('empty-hint-tips--tall', tips.some((tip) => (tip.actions?.length ?? 0) > 0));
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
    this._showTip(0);
    this._restartRotation();
  }

  /**
   * A `lead` tip (the rotation puts them first), or else the first unseen tip
   * at or after the shared cursor (wrapping), or the cursor's own tip once every
   * one is seen. The cursor moves on only when it chose, so a lead tip does not
   * cost the next conversation its turn through the others.
   * @returns {number} The index to open on.
   * @private
   */
  _startIndex() {
    if (this._tips[0]?.lead) return 0;
    const n = this._tips.length;
    const from = startCursor % n;
    startCursor = from + 1;
    for (let i = 0; i < n; i++) {
      const idx = (from + i) % n;
      const tip = this._tips[idx];
      if (tip && !isTipLearnt(tip.id)) return idx;
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
    btn.setAttribute('aria-label', which === 'prev' ? t('Previous tip') : t('Next tip'));
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
    this._showTip(Math.sign(delta));
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
  _showTip(direction) {
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
   * so a rebinding shows on the next render, and its English text
   * is translated here. Built with
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
    title.appendChild(document.createTextNode(t(tip.title)));

    const body = document.createElement('div');
    body.className = 'empty-hint-tips__body';
    body.textContent = t(tip.body);

    slot.append(title, body);
    if (tip.actions?.length) {
      const actions = document.createElement('div');
      actions.className = 'empty-hint-tips__actions';
      for (const action of tip.actions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm btn-secondary empty-hint-tips__action';
        btn.textContent = t(action.label);
        btn.addEventListener('click', () => { void this._run(action); });
        actions.appendChild(btn);
      }
      slot.appendChild(actions);
    }
    slot.setAttribute('data-tip-id', tip.id);
    return slot;
  }

  /**
   * Carry out a tip's button: its command, sent exactly as if typed into the
   * conversation the strip is in, so it shows and records itself as one.
   * @param {import('../services/guidance/nudge-catalogue.js').NudgeAction} action
   * @returns {Promise<void>}
   * @private
   */
  async _run(action) {
    const thread = this._context.thread;
    if (!action.command || !thread) return;
    await thread.conversation?.sendMessage?.(`/${action.command}`, thread.threadItemId ?? null, thread);
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
