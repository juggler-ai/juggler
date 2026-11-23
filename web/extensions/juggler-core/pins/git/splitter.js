//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's movable splits: where each place's list ends and its detail
 * begins, and how wide a full pin's Refs sidebar is. Each is a handle on the
 * line between the two, dragged, or moved with the arrow keys once focused; a
 * double-click puts it back.
 *
 * A split is a custom property on the pin's root (`--git-split-<name>`) that
 * the stylesheet sizes the columns by, clamped there so that neither side ever
 * goes below what it needs whatever the pin's width. A list's split is a share
 * of its place's width, so it holds its proportion as the window changes; the
 * sidebar's is a width in rem. They are kept in the pin's config, as `splits`,
 * holding only those moved from where they start.
 * @module pins/git/splitter
 */

import { attachSplitDrag, createElement, remPx } from 'juggler/ui';

/**
 * @typedef {object} SplitSpec
 * @property {'share'|'rem'} unit - A share of the place's width, or a width in rem.
 * @property {number} fallback - Where it starts.
 * @property {number} min - The least it is stored as.
 * @property {number} max - The most.
 * @property {number} step - How far an arrow key moves it.
 */

/** @typedef {'changes'|'history'|'refs'|'sidebar'} SplitName */

/** @type {Readonly<Record<SplitName, SplitSpec>>} */
const SPLITS = Object.freeze({
  changes: { unit: 'share', fallback: 0.42, min: 0.15, max: 0.85, step: 0.02 },
  history: { unit: 'share', fallback: 0.55, min: 0.15, max: 0.85, step: 0.02 },
  refs: { unit: 'share', fallback: 0.42, min: 0.15, max: 0.85, step: 0.02 },
  sidebar: { unit: 'rem', fallback: 14, min: 10, max: 32, step: 1 },
});

/** @typedef {Partial<Record<SplitName, number>>} Splits */

/**
 * @param {SplitSpec} spec - The split.
 * @param {number} value - A value for it.
 * @returns {number} Within its bounds, rounded as it is stored.
 */
function clampTo(spec, value) {
  const v = Math.max(spec.min, Math.min(spec.max, value));
  return spec.unit === 'share' ? Math.round(v * 1000) / 1000 : Math.round(v * 10) / 10;
}

/**
 * @param {unknown} value - A config's `splits`.
 * @returns {Splits} The known splits it holds, each within bounds.
 */
export function normalizeSplits(value) {
  /** @type {Splits} */
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [name, spec] of Object.entries(SPLITS)) {
    const v = /** @type {Record<string, unknown>} */ (value)[name];
    if (typeof v === 'number' && Number.isFinite(v)) out[/** @type {SplitName} */ (name)] = clampTo(spec, v);
  }
  return out;
}

/**
 * Put the splits on the pin's root, where the stylesheet reads them; one not
 * given starts where the stylesheet puts it.
 * @param {HTMLElement} root - The pin's root.
 * @param {Splits} splits - The splits.
 */
export function applySplits(root, splits) {
  for (const [name, spec] of Object.entries(SPLITS)) {
    const v = splits[/** @type {SplitName} */ (name)];
    if (v === undefined) root.style.removeProperty(`--git-split-${name}`);
    else root.style.setProperty(`--git-split-${name}`, spec.unit === 'share' ? `${v * 100}%` : `${v}rem`);
  }
}

/**
 * @typedef {object} SplitHandleOptions
 * @property {SplitName} name - Which split.
 * @property {string} label - What it resizes, for assistive technology.
 * @property {HTMLElement} root - The pin's root, which holds the property.
 * @property {() => DOMRect} box - What a share is of, or where a width starts from.
 * @property {() => Splits} splits - The splits as they are.
 * @property {(splits: Splits) => void} onChange - The splits moved; called once a drag ends, and on each key.
 */

/**
 * A handle for one split, to be placed on the line it moves.
 * @param {SplitHandleOptions} options - The split.
 * @returns {HTMLElement} The handle.
 */
export function createSplitHandle({ name, label, root, box, splits, onChange }) {
  const spec = SPLITS[name];
  const handle = createElement('div', `git-split git-split--${name}`);
  handle.dataset.split = name;
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', label);

  const current = () => splits()[name] ?? spec.fallback;
  /**
   * @param {number|undefined} value - Where it goes; undefined for where it starts.
   * @returns {Splits} The splits with it there.
   */
  const moved = (value) => {
    const next = { ...splits() };
    if (value === undefined || clampTo(spec, value) === spec.fallback) delete next[name];
    else next[name] = clampTo(spec, value);
    applySplits(root, next);
    return next;
  };
  /** @type {Splits|null} Where the drag under way has put the splits. */
  let last = null;
  attachSplitDrag(handle, {
    box,
    draggingClass: 'git-split--dragging',
    onStart: () => {
      last = null;
      root.dataset.resizing = 'true';
    },
    onMove: (share, px) => {
      last = moved(spec.unit === 'share' ? share : px / remPx());
    },
    onEnd: () => {
      delete root.dataset.resizing;
      if (last) onChange(last);
    },
    // The pin's own keys move the selection; these move only the split.
    onStep: (direction) => onChange(moved(current() + direction * spec.step)),
    onReset: () => onChange(moved(undefined)),
  });
  return handle;
}
