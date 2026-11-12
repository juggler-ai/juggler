//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Custom tooltip controller.
 *
 * Replaces the browser's native `title=` tooltip — which is slow (~1s delay),
 * unstyleable, and OS-dependent — with a single styled surface that matches the
 * app's popup chrome. It is a *drop-in*: it consumes the `title` attributes
 * already present across the markup, so no element needs to change. On hover the
 * native `title` is stashed away (suppressing the OS tooltip) and restored on
 * leave, keeping the attribute the source of truth for accessibility tools.
 *
 * One delegated listener at the document root handles every current and future
 * titled element (dynamically-rendered nodes included). A single reused surface
 * is appended to <body>.
 *
 * Text that ellipsises can opt in with `data-tooltip-overflow` instead of a
 * `title`: the element offers its own text, and only while it is actually cut
 * short (`scrollWidth > clientWidth`). That is measured when the element is
 * pointed at rather than when it is written, so a rename or a resize needs no
 * bookkeeping from the owner — and nothing is offered from under an open
 * inline-rename editor (`.is-renaming`, utils/inline-rename.js), which lies over
 * the name it would describe. An overflow element that fits gives way to any
 * titled ancestor.
 *
 * A keyboard shortcut never goes in the title text. The anchor names it with
 * `data-shortcut-id` (or a literal `data-tooltip-keys`), and the surface sets it
 * beside the text as a keycap — see {@link TooltipManager#_shortcutOf}.
 * @module services/tooltip-manager
 */

import keyShortcutManager from './key-shortcut-manager.js';
import { isKeyboardFocus } from './focus-modality.js';

/** ms a pointer must rest on an element before the tooltip appears. */
const SHOW_DELAY = 900;
/** After a tooltip hides, re-show within this window is instant (toolbar feel). */
const WARM_WINDOW = 400;
/**
 * Screen-edge keepout (CSS px) for the viewport-clamp math. This operates purely
 * in the px coordinate space of getBoundingClientRect/clientWidth — it is window
 * geometry, not an authored component size (the surface's own gap, padding, and
 * caret inset are all rem, in components.css).
 */
const VIEWPORT_KEEPOUT = 8;

class TooltipManager {
  constructor() {
    /**
     * The single reused surface.
     * @type {HTMLElement|null}
     * @private
     */
    this._el = null;
    /**
     * Element the visible/pending tooltip belongs to.
     * @type {HTMLElement|null}
     * @private
     */
    this._anchor = null;
    /**
     * setTimeout handle for the show delay.
     * @type {number}
     * @private
     */
    this._showTimer = 0;
    /**
     * Timestamp of the last hide, for the warm window.
     * @type {number}
     * @private
     */
    this._lastHide = 0;
    /**
     * Stashed native title text per element.
     * @type {WeakMap<Element,string>}
     * @private
     */
    this._stash = new WeakMap();
    /** @private */
    this._installed = false;
  }

  /**
   * Show the tooltip for an element right now, bypassing the hover delay. For
   * controls whose explanation must also surface on click/tap — touch has no
   * hover, so a native `title` alone would never appear there. Adopts the anchor
   * (stashing its `title`) and shows immediately; it then dismisses on the next
   * pointerdown / scroll / keypress like any other tooltip.
   * @param {HTMLElement|null} anchor - The titled element to describe.
   */
  showFor(anchor) {
    if (!anchor) return;
    if (this._anchor !== anchor) this._begin(anchor);
    clearTimeout(this._showTimer);
    this._showTimer = 0;
    this._show(anchor);
  }

  /** Wire the global listeners. Idempotent. */
  install() {
    if (this._installed || typeof document === 'undefined') return;
    this._installed = true;

    // Pointer path. pointerover/out bubble, so one pair covers everything.
    document.addEventListener('pointerover', this._onPointerOver, true);
    document.addEventListener('pointerout', this._onPointerOut, true);

    // Keyboard path — show on keyboard focus only (not programmatic/mouse focus,
    // which would pop tooltips the user never asked for).
    document.addEventListener('focusin', this._onFocusIn, true);
    document.addEventListener('focusout', this._onDismiss, true);

    // Anything that moves the anchor or shifts intent kills the tooltip at once.
    document.addEventListener('pointerdown', this._onDismiss, true);
    document.addEventListener('keydown', this._onKeyDown, true);
    window.addEventListener('scroll', this._onDismiss, true);
    window.addEventListener('blur', this._onDismiss, true);
    document.addEventListener('visibilitychange', this._onDismiss, true);
  }

  /**
   * The nearest ancestor (incl. self) that carries a tooltip, or null.
   * Matches a live `title` or our stashed marker (the element currently hovered
   * has had its `title` removed and replaced by `data-has-tooltip`).
   * @param {EventTarget|null} target - Event target to resolve from.
   * @returns {HTMLElement|null} The titled anchor element, or null.
   * @private
   */
  _resolveAnchor(target) {
    let node = /** @type {any} */ (target);
    while (node && typeof node.closest === 'function') {
      const el = /** @type {HTMLElement|null} */ (
        node.closest('[title], [data-has-tooltip], [data-tooltip-overflow]'));
      if (!el) return null;
      const text = this._textOf(el);
      if (text !== null) return el;
      // An overflow element that fits says nothing; a title around it may.
      if (!el.hasAttribute('data-tooltip-overflow')) return null;
      node = el.parentElement;
    }
    return null;
  }

  /**
   * The text an element's own tooltip would show, or null if it has none: its
   * title (live or stashed), else — for `data-tooltip-overflow` — its text,
   * only while that text is cut short and no rename editor lies over it.
   * @param {HTMLElement} el - A candidate anchor.
   * @returns {string|null} The tooltip text, or null.
   * @private
   */
  _textOf(el) {
    const title = el.getAttribute('title') ?? this._stash.get(el);
    if (title !== undefined && title !== null) return title.trim() ? title : null;
    if (!el.hasAttribute('data-tooltip-overflow')) return null;
    if (el.closest('.is-renaming')) return null;
    if (el.scrollWidth <= el.clientWidth) return null;
    const text = el.textContent?.trim() ?? '';
    return text || null;
  }

  /**
   * The text the tooltip would show for a pointer resting on `target`, or null
   * when nothing there carries one. The same resolution hover uses, exposed so
   * callers and tests can ask without waiting out the show delay.
   * @param {EventTarget|null} target - The element pointed at.
   * @returns {string|null} The tooltip text, or null.
   */
  textFor(target) {
    const anchor = this._resolveAnchor(target);
    return anchor ? this._textOf(anchor) : null;
  }

  /**
   * @param {PointerEvent} e - The pointerover event.
   * @private
   */
  _onPointerOver = (e) => {
    // Touch has no hover — tapping shouldn't summon a tooltip.
    if (e.pointerType === 'touch') return;
    const anchor = this._resolveAnchor(e.target);
    if (!anchor || anchor === this._anchor) return;
    this._begin(anchor);
  };

  /**
   * @param {PointerEvent} e - The pointerout event.
   * @private
   */
  _onPointerOut = (e) => {
    if (!this._anchor) return;
    // Ignore moves that stay inside the current anchor (child → child).
    const to = /** @type {Node|null} */ (e.relatedTarget);
    if (to && this._anchor.contains(to)) return;
    this._end();
  };

  /**
   * @param {FocusEvent} e - The focusin event.
   * @private
   */
  _onFocusIn = (e) => {
    const anchor = this._resolveAnchor(e.target);
    if (!anchor || anchor === this._anchor) return;
    // Only for keyboard focus; mouse/programmatic focus shouldn't pop a tooltip.
    if (!isKeyboardFocus(anchor)) return;
    this._begin(anchor);
  };

  /**
   * @param {KeyboardEvent} e - The keydown event.
   * @private
   */
  _onKeyDown = (e) => {
    if (e.key === 'Escape') this._end();
    else this._onDismiss();
  };

  /** @private */
  _onDismiss = () => { if (this._anchor) this._end(); };

  /**
   * Adopt an anchor: stash its native title and schedule (or warm-show) the tip.
   * @param {HTMLElement} anchor - The element to attach the tooltip to.
   * @private
   */
  _begin(anchor) {
    if (this._anchor) this._restore(this._anchor);
    clearTimeout(this._showTimer);

    this._anchor = anchor;
    const text = anchor.getAttribute('title');
    if (text !== null) {
      // Strip the native title so the OS tooltip never fires; mark for selector
      // matching while stripped. Restored verbatim on leave.
      this._stash.set(anchor, text);
      anchor.removeAttribute('title');
      anchor.setAttribute('data-has-tooltip', '');
    }

    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (now - this._lastHide < WARM_WINDOW) {
      this._show(anchor);
    } else {
      this._showTimer = window.setTimeout(() => this._show(anchor), SHOW_DELAY);
    }
  }

  /**
   * Tear down the current anchor: cancel any pending show, hide, restore title.
   * @private
   */
  _end() {
    clearTimeout(this._showTimer);
    this._showTimer = 0;
    const anchor = this._anchor;
    this._anchor = null;
    if (anchor) this._restore(anchor);
    if (this._el && this._el.classList.contains('is-visible')) {
      this._el.classList.remove('is-visible');
      this._lastHide = typeof performance !== 'undefined' ? performance.now() : 0;
    }
  }

  /**
   * Put a stashed native title back on its element — unless the element was
   * given a new title while the tooltip held the old one (a control whose
   * state changed under the pointer), in which case the new one stands.
   * @param {Element} anchor - The element to restore.
   * @private
   */
  _restore(anchor) {
    const text = this._stash.get(anchor);
    if (text !== undefined) {
      if (!anchor.hasAttribute('title')) anchor.setAttribute('title', text);
      this._stash.delete(anchor);
    }
    anchor.removeAttribute('data-has-tooltip');
  }

  /**
   * The lazily-created surface.
   * @returns {HTMLElement} The reused tooltip element.
   * @private
   */
  _surface() {
    if (this._el) return this._el;
    const el = document.createElement('div');
    el.className = 'app-tooltip';
    el.setAttribute('role', 'tooltip');
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    this._el = el;
    return el;
  }

  /**
   * The keystroke a tooltip advertises beside its text, kept out of the title so
   * the surface can set it apart as a keycap. An anchor names it by
   * `data-shortcut-id` (the key-shortcut manager supplies the platform-correct
   * combo, so markup holds no key text) or, for a key no registered command
   * owns, spells it out in `data-tooltip-keys`. `data-tooltip-keys-note` adds a
   * short qualifier after the keycap ("hold for menu").
   * @param {HTMLElement} anchor - The titled anchor.
   * @returns {{keys: string, note: string}|null} The keystroke, or null when none applies.
   * @private
   */
  _shortcutOf(anchor) {
    const id = anchor.getAttribute('data-shortcut-id');
    const keys = id ? keyShortcutManager.formatBinding(id) : (anchor.getAttribute('data-tooltip-keys') ?? '');
    if (!keys) return null;
    return { keys, note: anchor.getAttribute('data-tooltip-keys-note') ?? '' };
  }

  /**
   * Fill the surface: the text, then — when the anchor advertises one — the
   * keystroke as a keycap (and its note) in a trailing column of its own.
   * @param {HTMLElement} el - The surface.
   * @param {string} text - The tooltip text.
   * @param {{keys: string, note: string}|null} shortcut - The keystroke, if any.
   * @private
   */
  _fill(el, text, shortcut) {
    el.classList.toggle('app-tooltip--with-keys', !!shortcut);
    if (!shortcut) {
      el.textContent = text;
      return;
    }
    const body = document.createElement('span');
    body.className = 'app-tooltip__text';
    body.textContent = text;
    const hint = document.createElement('span');
    hint.className = 'app-tooltip__hint';
    const kbd = document.createElement('kbd');
    kbd.className = 'app-tooltip__keys';
    kbd.textContent = shortcut.keys;
    hint.appendChild(kbd);
    if (shortcut.note) {
      const note = document.createElement('span');
      note.className = 'app-tooltip__note';
      note.textContent = shortcut.note;
      hint.appendChild(note);
    }
    el.replaceChildren(body, hint);
  }

  /**
   * Render and position the surface against an anchor, then animate it in.
   * @param {HTMLElement} anchor - The element the tooltip describes.
   * @private
   */
  _show(anchor) {
    // Guard against a hide that landed during the delay.
    if (this._anchor !== anchor || !anchor.isConnected) return;
    // Read now, not at hover: an overflow name may have been renamed, or come
    // to fit, during the delay.
    const text = this._textOf(anchor);
    if (!text) return;

    const el = this._surface();
    this._fill(el, text, this._shortcutOf(anchor));

    // Measure with the surface laid out but not yet animating, from the origin:
    // a fixed box with auto width shrinks to the room right of its `left`, so
    // measured where the last tooltip was left (near the right edge, say) it
    // would wrap text that fits.
    el.style.left = '0px';
    el.style.top = '0px';
    const a = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;

    // Position the surface so it just touches the anchor edge; the visible gap
    // is applied in CSS (margin-top, in rem) so it scales with font-size zoom.
    // Prefer above; flip below when there's no room above the anchor.
    let below = false;
    let top = a.top - th;
    if (top < VIEWPORT_KEEPOUT) {
      const belowTop = a.bottom;
      if (belowTop + th <= vh - VIEWPORT_KEEPOUT || belowTop < a.top) {
        top = belowTop;
        below = true;
      }
    }

    // Centre horizontally on the anchor, clamped to the viewport.
    let left = a.left + a.width / 2 - tw / 2;
    left = Math.max(VIEWPORT_KEEPOUT, Math.min(left, vw - tw - VIEWPORT_KEEPOUT));

    // Caret offset within the surface (px coordinate); CSS clamps it clear of
    // the rounded corners via clamp() with a rem inset.
    const arrowX = a.left + a.width / 2 - left;

    el.classList.toggle('app-tooltip--below', below);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.setProperty('--tt-arrow-x', `${Math.round(arrowX)}px`);
    el.setAttribute('aria-hidden', 'false');
    // Next frame so the transition runs from the hidden state.
    requestAnimationFrame(() => {
      if (this._anchor === anchor) el.classList.add('is-visible');
    });
  }
}

const tooltipManager = new TooltipManager();
tooltipManager.install();

export default tooltipManager;
