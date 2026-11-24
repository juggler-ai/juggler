//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A windowed list: any number of items, of which only those in view — and
 * {@link OVERSCAN} rows either side — are elements.
 *
 * **Layout.** The list is a spacer as tall as every item, inside a scroller
 * the caller owns. An item is a row or a section header; rows are one fixed
 * height and headers another. While the two are the same, or there are no
 * headers, an item's offset is its index times that height; otherwise the
 * offsets are a prefix sum, taken when the items are set. Each drawn element
 * is placed absolutely at its offset, at its height. A height read anew —
 * when the items are set, or the scroller resized — places every drawn
 * element again, retained ones too, so none is left at the old pitch over
 * the rows drawn at the new one.
 *
 * **Drawing** reads `scrollTop` and `clientHeight` (layout reads, no paint)
 * to find the window, then makes sure each item in it has its element. An
 * element is kept by its item's key for as long as that item stays in the
 * window — across scrolls, across new items, and when the item moves to
 * another index — so focus, hover and a transition on it survive a redraw.
 * An item whose key changes is drawn anew, its old element removed; one that
 * leaves the window is removed, unless `retain` holds for its element. A
 * retained element is removed once its place is back in the window, where it
 * would lie over whatever is drawn there.
 *
 * **When.** A scroll that brings in items not yet drawn draws at once, so the
 * view is never blank; one that stays within what is drawn defers to the next
 * animation frame, coalesced. A resize of the scroller draws again.
 *
 * **Sharing a scroller.** A spacer need not be the scroller's first child:
 * given `originOf`, the list reads where its spacer starts each time it works
 * out the window, so several lists — each below a heading of its own, of
 * whatever height — can share one scroller. A list wholly out of view draws
 * nothing.
 *
 * `juggler/utils/virtual-list` in the document import maps, for the viewer and
 * extensions alike. It needs a DOM, so the engine worker has no use for it.
 * @module sdk/lib/virtual-list
 */

import { createElement } from './html.js';

/** Rows drawn beyond the view at each end, by default. */
const OVERSCAN = 15;

/**
 * Rows a sectioned list (Changes, Refs) draws whole; one with more is
 * windowed. Below it a list lays out in normal flow, exactly as it always has.
 */
export const WINDOWED_ABOVE = 200;

/**
 * @param {number} rem - A height in rem.
 * @returns {() => number} What reads it in px, at the root's font size then.
 */
export const remHeight = (rem) => () => rem * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);

/**
 * An item of a sectioned list: a row or a header, built on demand.
 * @typedef {object} SectionItem
 * @property {string} key - What its element is kept by.
 * @property {boolean} header - Whether it is a section header.
 * @property {() => HTMLElement} build - Its element.
 * @property {string} [row] - The row's key (rows only).
 */

/**
 * @template T
 * @typedef {object} VirtualListOptions
 * @property {HTMLElement} scroller - The scrolling element the spacer goes in.
 * @property {string} [spacerClass] - The spacer's class.
 * @property {number | (() => number)} rowHeight - A row's height, in px.
 * @property {number | (() => number)} [headerHeight] - A header's height, in px (default: a row's).
 * @property {number} [overscan] - Rows drawn beyond the view at each end.
 * @property {(item: T, index: number) => string} keyOf - What an item's element is kept by; a new key draws it anew.
 * @property {(item: T, index: number) => HTMLElement} build - An item's element; the list places it.
 * @property {(item: T) => boolean} [isHeader] - Whether an item is a section header.
 * @property {(el: HTMLElement, item: T, index: number) => void} [decorate] - Brought up to date on every draw (selection, say).
 * @property {() => number} [originOf] - Where the spacer starts in the scroller's content, in px (default 0).
 * @property {(el: HTMLElement) => boolean} [retain] - Keep a drawn element that leaves the window while this holds — the one with focus, say, so a scroll does not drop focus to the page. Never one whose place is in the window: its item's key changed, and another element is drawn there.
 * @property {(window: VirtualWindow) => void} [beforeDraw] - Told the window before each draw.
 * @property {() => void} [afterDraw] - Told after each draw.
 */

/**
 * @typedef {object} VirtualWindow
 * @property {number} first - The first item in view.
 * @property {number} count - Rows the view holds.
 * @property {number} from - The first item drawn.
 * @property {number} to - One past the last item drawn (not clamped to the items).
 */

/**
 * @template T
 * @typedef {object} VirtualList
 * @property {HTMLElement} spacer - The spacer; it goes in the scroller, where the caller puts it.
 * @property {(items: T[] | {count: number, at: (index: number) => T|null}) => void} setItems -
 *   What the list holds: an array, or a count and the item at an index (null while not known, which leaves a gap).
 * @property {() => void} render - Draw what is in view.
 * @property {(index: number, block?: 'nearest'|'start') => void} reveal - Scroll an item into view, without drawing.
 * @property {(index: number, block?: 'nearest'|'start') => void} scrollIntoView - Scroll an item into view and draw.
 * @property {() => VirtualWindow} windowOf - The window as the scroller stands.
 * @property {(index: number) => number} offsetOf - Where an item starts, in px.
 * @property {(index: number) => HTMLElement|null} elementAt - An item's element, when drawn.
 * @property {() => void} clear - Drop every drawn element, so the next draw builds them all.
 * @property {() => void} destroy - Stop watching the scroller.
 */

/**
 * @param {number | (() => number) | undefined} h - A height or what reads it.
 * @returns {number} The height.
 */
const heightOf = (h) => (typeof h === 'function' ? h() : (h || 0));

/**
 * @template T
 * @param {VirtualListOptions<T>} options - What the list draws and how.
 * @returns {VirtualList<T>} The list.
 */
export function createVirtualList(options) {
  const { scroller } = options;
  const overscan = options.overscan ?? OVERSCAN;
  const spacer = createElement('div', options.spacerClass || '');
  spacer.style.position = 'relative';

  let count = 0;
  /** @type {(index: number) => T|null} */
  let at = () => null;
  let rowPx = 1;
  /** @type {Float64Array|null} Each item's offset, and the total last, while heights differ. */
  let offsets = null;
  /** Counts the measures, so an element placed before the last one is placed again. */
  let layout = 0;
  /** @type {Map<string, {el: HTMLElement, index: number, layout: number}>} Drawn elements, by key, with the place they were given. */
  const drawn = new Map();
  /** @type {Map<number, string>} The key drawn at each index. */
  const keyAt = new Map();
  /** The items drawn, as [from, end). */
  let drawnFrom = 0;
  let drawnEnd = 0;
  let frame = 0;

  /**
   * Take an element out of the list, and off the place it was given, so a
   * caller that keeps its elements can lay it out in normal flow again.
   * @param {HTMLElement} el - A drawn element.
   */
  const release = (el) => {
    el.remove();
    for (const prop of ['position', 'left', 'right', 'top', 'height']) el.style.removeProperty(prop);
  };

  const measure = () => {
    layout++;
    rowPx = Math.max(1, heightOf(options.rowHeight));
    const headerPx = options.headerHeight === undefined ? rowPx : Math.max(1, heightOf(options.headerHeight));
    offsets = null;
    if (!options.isHeader || headerPx === rowPx) return;
    const sums = new Float64Array(count + 1);
    let any = false;
    for (let i = 0; i < count; i++) {
      const item = at(i);
      const header = item !== null && options.isHeader(item);
      any ||= header;
      sums[i + 1] = (sums[i] ?? 0) + (header ? headerPx : rowPx);
    }
    if (any) offsets = sums;
  };

  /**
   * @param {number} index - An item, or the count for the end.
   * @returns {number} Where it starts, in px.
   */
  const offsetOf = (index) => (offsets ? (offsets[Math.max(0, Math.min(count, index))] ?? 0) : index * rowPx);
  /**
   * @param {number} index - An item.
   * @returns {number} Its height, in px.
   */
  const sizeOf = (index) => offsetOf(index + 1) - offsetOf(index);
  /**
   * @param {number} px - An offset.
   * @returns {number} The item that holds it.
   */
  const indexAt = (px) => {
    if (!offsets) return Math.max(0, Math.floor(px / rowPx));
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((offsets[mid] ?? 0) <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  /** @returns {number} The view's height, or the window's while the scroller is not laid out. */
  const viewPx = () => scroller.clientHeight || window.innerHeight || rowPx;

  /** @returns {number} Where the spacer starts in the scroller's content, in px. */
  const originPx = () => options.originOf?.() ?? 0;

  /** @returns {VirtualWindow} The window. */
  const windowOf = () => {
    const top = scroller.scrollTop - originPx();
    const view = viewPx();
    if (options.originOf && (top + view <= 0 || top >= offsetOf(count))) {
      const edge = top >= offsetOf(count) ? count : 0;
      return { first: edge, count: 0, from: edge, to: edge };
    }
    const first = indexAt(Math.max(0, top));
    const last = indexAt(top + view);
    const rows = Math.max(1, last - first + 1, offsets ? 0 : Math.ceil(view / rowPx));
    return { first, count: rows, from: Math.max(0, first - overscan), to: first + rows + overscan };
  };

  /**
   * Put a drawn element at an item's place, at the heights as last measured.
   * @param {{el: HTMLElement, index: number, layout: number}} entry - The element and where it was put.
   * @param {number} index - The item.
   */
  const place = (entry, index) => {
    entry.index = index;
    entry.layout = layout;
    entry.el.style.top = `${offsetOf(index)}px`;
    entry.el.style.height = `${sizeOf(index)}px`;
  };

  const render = () => {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    const win = windowOf();
    options.beforeDraw?.(win);
    spacer.style.height = `${offsetOf(count)}px`;
    const end = Math.min(win.to, count);
    /** @type {Set<string>} */
    const keep = new Set();
    keyAt.clear();
    for (let index = win.from; index < end; index++) {
      const item = at(index);
      if (item === null) continue;
      const key = options.keyOf(item, index);
      keep.add(key);
      keyAt.set(index, key);
      let entry = drawn.get(key);
      if (!entry) {
        const el = options.build(item, index);
        el.style.position = 'absolute';
        el.style.left = '0';
        el.style.right = '0';
        entry = { el, index: -1, layout: -1 };
        drawn.set(key, entry);
      }
      if (entry.index !== index || entry.layout !== layout || !entry.el.isConnected) {
        place(entry, index);
        if (entry.el.parentNode !== spacer) spacer.append(entry.el);
      }
      options.decorate?.(entry.el, item, index);
    }
    for (const [key, entry] of drawn) {
      if (keep.has(key)) continue;
      // Retained only while out of the window: where it was is drawn, and
      // what stands there now is another item's element (its key changed),
      // so keeping it would draw it over that one.
      const outside = entry.index < win.from || entry.index >= end;
      if (outside && options.retain?.(entry.el)) {
        if (entry.layout !== layout) place(entry, entry.index);
        continue;
      }
      release(entry.el);
      drawn.delete(key);
    }
    drawnFrom = win.from;
    drawnEnd = end;
    options.afterDraw?.();
  };

  /**
   * @param {number} index - The item.
   * @param {'nearest'|'start'} [block] - Where it should end up.
   */
  const reveal = (index, block = 'nearest') => {
    const top = originPx() + offsetOf(index);
    const bottom = top + sizeOf(index);
    if (block === 'start' || top < scroller.scrollTop) {
      scroller.scrollTop = top;
    } else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      // Both numbers err toward cutting the row off at the bottom: clientHeight
      // is the view's height rounded (up by as much as half a pixel), and the
      // browser truncates a fractional scrollTop. So the half pixel is given
      // back and the result rounded up, which can leave a hair of gap below
      // the row but never leaves its last pixel out of view.
      scroller.scrollTop = Math.ceil(bottom - scroller.clientHeight + 0.5);
    }
  };

  const clear = () => {
    for (const { el } of drawn.values()) release(el);
    drawn.clear();
    keyAt.clear();
    drawnFrom = 0;
    drawnEnd = 0;
  };

  const onScroll = () => {
    const { first, count: rows } = windowOf();
    const missing = first < drawnFrom || Math.min(first + rows, count) > drawnEnd;
    if (missing) render();
    else if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  };
  scroller.addEventListener('scroll', onScroll);
  const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    measure();
    render();
  }) : null;
  resizes?.observe(scroller);

  return {
    spacer,
    setItems: (items) => {
      if (Array.isArray(items)) {
        count = items.length;
        at = (i) => (i >= 0 && i < items.length ? items[i] ?? null : null);
      } else {
        count = items.count;
        at = items.at;
      }
      measure();
    },
    render,
    reveal,
    scrollIntoView: (index, block) => {
      reveal(index, block);
      render();
    },
    windowOf,
    offsetOf,
    elementAt: (index) => {
      const key = keyAt.get(index);
      return key === undefined ? null : drawn.get(key)?.el || null;
    },
    clear,
    destroy: () => {
      scroller.removeEventListener('scroll', onScroll);
      resizes?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
