//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Positions a dropdown menu relative to a button with viewport constraints.
 *
 * The dropdown is placed on the side of the button that has the most usable
 * room, never covering the button and never spilling past the viewport edge.
 * The chosen side's available height is enforced as `max-height` so a tall
 * menu scrolls inside that bound rather than overflowing the page; the
 * caller's CSS `overflow-y` rule handles the scrollbar.
 *
 * Decision order:
 *   1. If the menu fits below the button at its natural height → open below.
 *   2. Else if it fits above at its natural height → open above.
 *   3. Else open on whichever side has more room and cap the height.
 * @param {HTMLElement} dropdown - The dropdown element to position
 * @param {HTMLElement} button - The button that triggered the dropdown
 * @param {number} [gap=4] - Gap between button and dropdown in pixels
 * @param {object} [options] - Positioning options
 * @param {'left'|'right'} [options.align='left'] - Preferred horizontal alignment
 */
export function positionDropdown(dropdown, button, gap = 4, options = {}) {
  const { align = 'left' } = options;
  const edge = 8; // minimum clearance from viewport edges (px)

  // Anything inside the menu that is scrolled is only scrolled because the cap
  // below bounds it, so clearing that cap to measure takes its overflow away and
  // the browser drops the offset to zero. Repositioning must not move the user's
  // place in a long list, so note where each scroller is before the measurement
  // and put it back after every geometry write.
  const scrollers = takeScrollOffsets(dropdown);

  // Measure the menu's natural height. A previous call may have applied an
  // inline `max-height`; clear it before measuring so the decision below is
  // based on actual content size, not a stale cap. The width clamp below may
  // also have pinned an inline `min-width`/`max-width` last time — clear those
  // too so the natural width is re-measured cleanly.
  //
  // The menu's own size is read from its layout box (offsetWidth/Height), not
  // getBoundingClientRect: placement runs during the scale-up entrance
  // (popup-surface.css), and a transformed rect would place the menu for the
  // size it is mid-animation rather than the size it comes to rest at.
  dropdown.style.maxHeight = 'none';
  dropdown.style.removeProperty('min-width');
  dropdown.style.removeProperty('max-width');
  const buttonRect = measureRestingRect(button);
  const naturalHeight = dropdown.offsetHeight;

  // --- Y: choose the side that fits, falling back to the larger side ---
  const spaceBelow = Math.max(0, window.innerHeight - buttonRect.bottom - gap - edge);
  const spaceAbove = Math.max(0, buttonRect.top - gap - edge);

  let openBelow;
  if (naturalHeight <= spaceBelow) {
    openBelow = true;
  } else if (naturalHeight <= spaceAbove) {
    openBelow = false;
  } else {
    openBelow = spaceBelow >= spaceAbove;
  }

  const available = openBelow ? spaceBelow : spaceAbove;
  const usedHeight = Math.min(naturalHeight, available);

  let y;
  if (openBelow) {
    y = buttonRect.bottom + gap;
  } else {
    y = buttonRect.top - gap - usedHeight;
  }

  // Cap the menu height to the available space. Use the full side, not just
  // the current content size — if the content grows later the cap should
  // still keep it on-page (the menu will scroll). No artificial minimum: a
  // floor here would push the menu off-screen when the button is near the
  // edge.
  dropdown.style.maxHeight = `${available}px`;

  // Clamp width to the viewport so a menu with a pinned `min-width` wider than
  // the screen can't spill past the right edge. min-width normally beats
  // max-width, so override both inline. Anchored mode only — narrow viewports
  // present these as full-width sheets (see popup-surface.js), governed by CSS.
  const maxWidth = window.innerWidth - 2 * edge;
  if (dropdown.offsetWidth > maxWidth) {
    dropdown.style.minWidth = '0';
    dropdown.style.maxWidth = `${maxWidth}px`;
  }

  // --- X: re-measure width AFTER applying max-height (a scrollbar may have
  // appeared, changing the width) and the width clamp above. ---
  const widthAfter = dropdown.offsetWidth;
  let x;
  if (align === 'right') {
    // Pin the menu's right edge to the button's right edge (grows left); if that
    // pushes the left edge off-screen, fall back to growing rightward.
    x = buttonRect.right - widthAfter;
    if (x < edge) x = buttonRect.left;
  } else {
    // Pin the menu's left edge to the button's left edge (grows right); if that
    // pushes the right edge off-screen, fall back to growing leftward.
    x = buttonRect.left;
    if (x + widthAfter > window.innerWidth - edge) x = buttonRect.right - widthAfter;
  }
  x = Math.min(x, window.innerWidth - widthAfter - edge);
  x = Math.max(edge, x);

  dropdown.style.setProperty('--dropdown-x', `${x}px`);
  dropdown.style.setProperty('--dropdown-y', `${Math.max(edge, y)}px`);

  // The entrance grows the menu out of its trigger: from the edge that faces
  // the button, centred on the button horizontally (clamped to the menu).
  const originX = Math.min(widthAfter, Math.max(0, buttonRect.left + buttonRect.width / 2 - x));
  dropdown.style.setProperty('--popup-origin', `${originX}px ${openBelow ? 'top' : 'bottom'}`);

  for (const [el, top] of scrollers) el.scrollTop = top;
}

/**
 * Record the scroll offset of the menu and everything scrolled inside it.
 * @param {HTMLElement} dropdown
 * @returns {[Element, number][]} Each scrolled element with its offset.
 */
function takeScrollOffsets(dropdown) {
  /** @type {[Element, number][]} */
  const offsets = [];
  for (const el of [dropdown, ...Array.from(dropdown.querySelectorAll('*'))]) {
    if (el.scrollTop > 0) offsets.push([el, el.scrollTop]);
  }
  return offsets;
}

/**
 * Measure a trigger's resting (untransformed) viewport rect.
 *
 * The header/control buttons that open anchored popups are `.btn-ghost`, which
 * applies `transform: scale(0.95)` on `:active` AND transitions `transform`
 * (utilities/utilities.css). A popup opened on click is positioned while the button is
 * still animating back to full size, so a plain `getBoundingClientRect()` reads
 * the shrunken, mid-animation box and anchors the popup there; the first content
 * change then repositions against the settled button, nudging the popup a few px
 * on both axes (the reported "popup shifts the moment I start typing").
 *
 * Every button also dips and springs back as a Web Animation of `scale`
 * (utils/press-feedback.js), which no plain inline style outranks — an
 * animation sits above normal declarations in the cascade. A menu placed
 * during that spring, and placed again when its content changes, steps by the
 * dip: on a small button, a few px.
 *
 * Neutralising the button's own transforms for the measurement gives the
 * resting box every time: `transform` and the individual `scale`, `rotate` and
 * `translate`, each set `!important`, which outranks an animation. Killing the
 * transition first is essential: with the transition live, setting
 * `transform: none` animates toward it rather than applying instantly, so the
 * immediate measurement would still read the scaled value. Every inline
 * override is restored synchronously, before any paint, so the button's visual
 * press animation is untouched.
 * @param {HTMLElement} button
 * @returns {DOMRect} The button's rect with its own transforms neutralised.
 */
function measureRestingRect(button) {
  const props = ['transition', 'transform', 'scale', 'rotate', 'translate'];
  const prev = props.map((p) => ({ p, value: button.style.getPropertyValue(p), priority: button.style.getPropertyPriority(p) }));
  for (const p of props) button.style.setProperty(p, 'none', 'important');
  const rect = button.getBoundingClientRect();
  for (const { p, value, priority } of prev) {
    if (value) button.style.setProperty(p, value, priority);
    else button.style.removeProperty(p);
  }
  return rect;
}
