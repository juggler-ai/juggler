//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared column-resize wiring for Miller-column children
 * (conversation-area, properties-panel, conversation-bar). The column
 * itself hosts a `col-resize-handle` on its right edge; dragging it
 * sets a rem-based width on the column and persists it under the
 * caller-supplied preference name, so all columns of the same kind share
 * a width. Storing in rem means widths track the app zoom level (root
 * font-size) automatically.
 *
 * A column wired with a depth — a conversation column's position in its tab's
 * chain, or a workspace panel standing at the root — shares its width only with
 * the columns at that depth: the preference holds one width per depth, and a
 * depth with none stored copies the deepest one that has (`columnWidthAtDepth`).
 * A single stored number is every depth's width. Widening a depth restyles the
 * columns beside it that copy it, so a chain on screen always shows exactly what
 * a rebuild of it would.
 *
 * The width belongs to the window (services/prefs.js), which is what makes it
 * survive a relaunch: it is kept in the project's session rather than in a
 * localStorage partitioned by a port that changes. A mount applies the cached
 * value at once and reconciles when the session answers, so the column never
 * waits on a round trip to have a width.
 *
 * Hiding the handle on the rightmost column is handled by CSS
 * (`properties-panel.column-rightmost col-resize-handle`), not here.
 * @module utils/column-resize
 */

import { cachedWindowPref, getWindowPref, setWindowPref } from '../services/prefs.js';

export const COL_MIN_WIDTH_REM = 12.5;
const COL_MAX_WIDTH_REM = 100;

/**
 * Widest a conversation column starts at. Past this it stops being a column of
 * prose and becomes a page, so extra room goes to whatever stands beside it.
 * @type {number}
 */
const START_WIDTH_MAX_REM = 50;

/**
 * Narrowest a conversation column starts at — the flex basis the CSS gives one
 * that has no inline width (`column-container conversation-area` in
 * layout/app-shell.css).
 * @type {number}
 */
const START_WIDTH_MIN_REM = 30;

/**
 * Room the properties panel needs beside it, mirroring the `min-width` of
 * `column-container properties-panel` in layout/app-shell.css. It is a floor,
 * not a preference: a panel cannot be squeezed below it, so a conversation
 * column that leaves less than this is not narrowing the panel but pushing it
 * off the right-hand edge — `column-container` scrolls rather than reflows.
 * @type {number}
 */
const PROPERTIES_MIN_REM = 30;

/**
 * Room the tab sidebar takes out of the window before any column gets any,
 * mirroring `conversation-bar`'s width in components/conversation-bar.css.
 *
 * Taken off the window rather than measured, because the columns that share
 * this width are wired at different moments — one during a render, one when a
 * workspace first opens — and a measurement taken mid-layout gives them
 * different answers to a question that has one answer.
 * @type {number}
 */
const SIDEBAR_REM = 15;

/**
 * The width a conversation column takes on a window that has never had one
 * resized: as wide as it can be while still leaving the properties panel whole.
 *
 * A fixed default cannot do that, because whether it fits is a fact about the
 * window it opens in. Too wide and the first properties panel the user opens
 * arrives part-way off-screen — a state they have no reason to read as "scroll
 * right", since nothing else in the app scrolls sideways.
 * @param {number} windowPx - Width of the window the columns are opening in.
 * @param {number} [remPx] - Root font size, for converting the budget to rem.
 * @returns {number} Starting width in rem, within [30, 50].
 */
export function startingColumnWidthRem(windowPx, remPx = rootFontSizePx()) {
  const room = windowPx / remPx - SIDEBAR_REM - PROPERTIES_MIN_REM;
  return Math.max(START_WIDTH_MIN_REM, Math.min(START_WIDTH_MAX_REM, room));
}

/**
 * `startingColumnWidthRem` for this window — the one number every column that
 * shares the width has to agree on, so it is read from the window itself.
 * @returns {number} Starting width in rem.
 */
export function startingColumnWidth() {
  return startingColumnWidthRem(window.innerWidth);
}

/**
 * @returns {number} Current root font-size in CSS pixels.
 */
export function rootFontSizePx() {
  return parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
}

/**
 * How far to scroll a column container so the given column is in view: the
 * smallest movement that does it, plus `peek` so the result never comes to rest
 * with a column boundary flush against either edge of the container.
 *
 * Pure arithmetic on two already-measured rects, so the rule can be read and
 * tested without a browser to lay anything out in.
 *
 * A column already fully in view returns 0 — including one resting flush. The
 * peek shapes a movement that was happening anyway; it is never a reason to
 * move a view the user is looking at.
 * @param {{left: number, right: number}} colRect - The column, in client coordinates.
 * @param {{left: number, right: number}} containerRect - The container, same coordinates.
 * @param {number} peek - How much of the column being scrolled past to leave showing, in px.
 * @returns {number} Pixels to add to the container's scrollLeft; 0 to leave it alone.
 */
export function columnScrollDelta(colRect, containerRect, peek) {
  if (colRect.left < containerRect.left) {
    return colRect.left - containerRect.left - peek;
  }
  if (colRect.right > containerRect.right) {
    // Never drive the left edge out of view chasing the right one — and never
    // scroll backwards doing it, which clamping the second arm at 0 prevents
    // for a column already sitting within a peek of the left edge.
    return Math.min(
      colRect.right - containerRect.right + peek,
      Math.max(0, colRect.left - containerRect.left - peek));
  }
  return 0;
}

/**
 * Set a column's width without storing it, and report what it settled on.
 * @param {HTMLElement} element
 * @param {number} rem
 * @param {number} minWidthRem
 * @returns {number} The clamped width, in rem.
 * @private
 */
function _styleColumnWidth(element, rem, minWidthRem) {
  const clamped = Math.max(minWidthRem, Math.min(COL_MAX_WIDTH_REM, rem));
  element.style.width = `${clamped}rem`;
  return clamped;
}

/**
 * @typedef {object} DepthColumn
 * @property {string} prefName - The preference holding the widths by depth.
 * @property {number} depth - The column's position in its chain.
 * @property {number} minWidthRem - The narrowest it may be dragged to.
 * @property {number|undefined} defaultWidthRem - Unstored fallback width.
 */

/**
 * The columns wired with a depth, so a width stored for one depth can reach the
 * columns beside it that copy it.
 * @type {WeakMap<HTMLElement, DepthColumn>}
 */
const _depthColumns = new WeakMap();

/**
 * The width a column at `depth` takes from what is stored: that depth's own,
 * else the deepest stored above it. A single number is every depth's width.
 * @param {unknown} stored - The preference's value: a number, or widths by depth
 *   with null where a depth has none.
 * @param {number} depth
 * @returns {number|null} The width in rem, or null when nothing applies.
 */
export function columnWidthAtDepth(stored, depth) {
  if (!Array.isArray(stored)) return _storedWidthRem(stored);
  for (let d = Math.min(depth, stored.length - 1); d >= 0; d--) {
    const rem = _storedWidthRem(stored[d]);
    if (rem !== null) return rem;
  }
  return null;
}

/**
 * Apply a width (in rem) to `element` and store it under `prefName` — as its
 * depth's width, when it was wired with one.
 * @param {HTMLElement} element
 * @param {string} prefName
 * @param {number} rem
 * @param {number} [minWidthRem]
 */
export function applyColumnWidthRem(element, prefName, rem, minWidthRem = COL_MIN_WIDTH_REM) {
  const clamped = _styleColumnWidth(element, rem, minWidthRem);
  const column = _depthColumns.get(element);
  if (!column || column.prefName !== prefName) {
    void setWindowPref(prefName, clamped);
    return;
  }
  const stored = cachedWindowPref(prefName, null);
  const widths = Array.isArray(stored) ? [...stored] : [_storedWidthRem(stored)];
  while (widths.length <= column.depth) widths.push(null);
  widths[column.depth] = clamped;
  void setWindowPref(prefName, widths);
  _restyleSiblings(element, prefName, widths);
}

/**
 * Give the columns beside `element` that share its preference the widths their
 * depths now resolve to — a deeper one copying the depth just widened follows
 * it, and one with a width of its own is unchanged.
 * @param {HTMLElement} element
 * @param {string} prefName
 * @param {ReadonlyArray<unknown>} widths
 * @private
 */
function _restyleSiblings(element, prefName, widths) {
  for (const sibling of Array.from(element.parentElement?.children ?? [])) {
    const column = _depthColumns.get(/** @type {HTMLElement} */ (sibling));
    if (sibling === element || !column || column.prefName !== prefName) continue;
    if (sibling.querySelector('col-resize-handle.dragging')) continue;
    const rem = columnWidthAtDepth(widths, column.depth) ?? column.defaultWidthRem;
    if (typeof rem === 'number') _styleColumnWidth(/** @type {HTMLElement} */ (sibling), rem, column.minWidthRem);
  }
}

/**
 * Apply a width (in CSS pixels) to `element` and store it as rem.
 * Convenience for callers that compute widths in px (e.g. auto-fit
 * tab-bar sizing).
 * @param {HTMLElement} element
 * @param {string} prefName
 * @param {number} px
 * @param {number} [minWidthRem]
 */
export function applyColumnWidthPx(element, prefName, px, minWidthRem = COL_MIN_WIDTH_REM) {
  applyColumnWidthRem(element, prefName, px / rootFontSizePx(), minWidthRem);
}

/**
 * Attach drag handlers and persistence to `element`'s `.col-resize-handle`
 * child.
 * @param {HTMLElement} element - The column element (must be position: relative).
 * @param {string} prefName - The window preference the width is stored under.
 * @param {number} [minWidthRem] - Minimum width in rem (defaults to COL_MIN_WIDTH_REM).
 * @param {number} [defaultWidthRem] - Initial width (rem) to apply when this
 *   window has stored none. Applied as an inline style only (never stored), so
 *   the first drag is what a window remembers.
 * @param {number} [depth] - The column's position in its chain, when the
 *   preference holds one width per depth (see the module header). Without it
 *   the preference is a single width.
 */
export function setupColumnResize(
  element,
  prefName,
  minWidthRem = COL_MIN_WIDTH_REM,
  defaultWidthRem = undefined,
  depth = undefined,
) {
  const handle = element.querySelector('col-resize-handle');
  if (!handle) return;

  if (typeof depth === 'number') _depthColumns.set(element, { prefName, depth, minWidthRem, defaultWidthRem });
  _loadColumnWidth(element, prefName, minWidthRem, defaultWidthRem, depth);

  // Prevent resize-handle clicks from bubbling to the column-container's
  // click handler, which would change active column and scroll into view.
  handle.addEventListener('click', (e) => e.stopPropagation());

  // Only highlight on mouse hover — touch devices don't get a hover state.
  handle.addEventListener('pointerenter', (e) => {
    if (/** @type {PointerEvent} */ (e).pointerType === 'mouse') handle.classList.add('hovered');
  });
  handle.addEventListener('pointerleave', () => handle.classList.remove('hovered'));

  handle.addEventListener('pointerdown', (/** @type {Event} */ e) => {
    const pointerEvent = /** @type {PointerEvent} */ (e);
    pointerEvent.preventDefault();
    /** @type {HTMLElement} */ (handle).setPointerCapture(pointerEvent.pointerId);

    const startX = pointerEvent.clientX;
    const startWidth = element.getBoundingClientRect().width;
    const remPx = rootFontSizePx();
    const minPx = minWidthRem * remPx;
    const maxPx = COL_MAX_WIDTH_REM * remPx;

    handle.classList.add('dragging');

    const onMove = (/** @type {Event} */ e) => {
      const moveEvent = /** @type {PointerEvent} */ (e);
      const deltaX = moveEvent.clientX - startX;
      let newWidth = startWidth + deltaX;
      newWidth = Math.max(minPx, Math.min(maxPx, newWidth));
      // Use px during drag for smooth pixel-accurate feedback;
      // converted back to rem on pointerup.
      element.style.width = `${newWidth}px`;
    };

    const onUp = () => {
      handle.classList.remove('dragging');
      const finalPx = element.getBoundingClientRect().width;
      applyColumnWidthPx(element, prefName, finalPx, minWidthRem);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

/**
 * A stored width, or null when there is nothing usable.
 * @param {unknown} value
 * @returns {number|null} The width in rem.
 * @private
 */
function _storedWidthRem(value) {
  const rem = typeof value === 'number' ? value : typeof value === 'string' ? parseFloat(value) : NaN;
  return Number.isFinite(rem) && rem > 0 ? rem : null;
}

/**
 * Give a column its width: the cached one now, and the window's stored one when
 * the session answers.
 *
 * Nothing is written back here. A width the column was merely given is not a
 * width the user chose, and storing it would stamp the default over a value
 * this window has not heard about yet. The reconcile stands down mid-drag —
 * a column jumping under the pointer is worse than a late correction.
 * @param {HTMLElement} element
 * @param {string} prefName
 * @param {number} minWidthRem
 * @param {number} [defaultWidthRem] - Unstored fallback width (rem) when nothing
 *   is stored for this window.
 * @param {number} [depth] - The column's depth, when widths are stored by depth.
 */
function _loadColumnWidth(element, prefName, minWidthRem, defaultWidthRem = undefined, depth = undefined) {
  /**
   * @param {unknown} stored
   * @returns {number|null} This column's width in rem, or null.
   */
  const widthOf = (stored) => (typeof depth === 'number'
    ? columnWidthAtDepth(stored, depth)
    : _storedWidthRem(stored));
  const cached = widthOf(cachedWindowPref(prefName, null));
  if (cached !== null) {
    _styleColumnWidth(element, cached, minWidthRem);
  } else if (typeof defaultWidthRem === 'number') {
    // The caller's default gives a new user a sensible fixed width instead of
    // the flex-fill one, which otherwise has the column resize to fill the page
    // as its siblings are shown and hidden.
    _styleColumnWidth(element, defaultWidthRem, minWidthRem);
  }

  void getWindowPref(prefName, null).then((stored) => {
    const rem = widthOf(stored);
    if (rem === null || rem === cached) return;
    if (element.querySelector('col-resize-handle.dragging')) return;
    _styleColumnWidth(element, rem, minWidthRem);
  });
}
