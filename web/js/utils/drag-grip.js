//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The grip a row is dragged by, and the rule about which pointers must use it.
 *
 * A mouse needs no grip. It can grab a row anywhere, because it has a hover to
 * reveal what is grabbable and nothing else is competing for the press. A finger
 * has neither: it arrives with no warning, and the browser has already decided
 * the gesture is a scroll. So a touch reorder is possible only from an element
 * carrying `touch-action: none`, and only discoverable from one that is visible
 * without a hover — which is this element, styled by `css/patterns/drag-grip.css`.
 * The two files are halves of one thing; change neither alone.
 *
 * For a strip that reorders through {@link module:utils/reorder-drag} from a
 * handle: the pinboard's tab strip. The other way to give a finger a reorder is
 * to make it hold still first — reorder-drag's `hold` option — which is what
 * the conversation sidebar does, and why it carries no grip.
 * @module utils/drag-grip
 */

/** Six raised dots — a grip, in the one place that decides what one looks like. */
const GRIP_GLYPH = '⠿';

/**
 * A grip, as a node, for a row assembled from elements.
 *
 * Decorative, so `aria-hidden`: it names no action a screen reader can take, and
 * reordering without a pointer is offered as a keyboard shortcut on the row
 * itself rather than as a control here.
 * @returns {HTMLElement} The grip. Put it at the leading edge of the row.
 */
export function createDragGrip() {
  const grip = document.createElement('span');
  grip.className = 'drag-grip';
  grip.setAttribute('aria-hidden', 'true');
  grip.textContent = GRIP_GLYPH;
  return grip;
}

/**
 * Whether a pointerdown is allowed to become a reorder drag.
 *
 * A mouse may grab the row anywhere on it. Anything else — a finger, a pen —
 * must have landed on a grip, because it is the grip alone that has taken the
 * gesture off the browser. Callers apply their own exclusions (buttons, editors)
 * either side of this; it answers the one question about pointer type.
 * @param {PointerEvent} event - The pointerdown.
 * @returns {boolean} True when the press may start a drag.
 */
export function pointerMayGrab(event) {
  if (event.pointerType === 'mouse') return true;
  const target = /** @type {HTMLElement|null} */ (event.target);
  return !!target?.closest?.('.drag-grip');
}
