//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's small line icons, drawn at the text's size in its colour. The
 * app's icon set has no lock, eye, worktree or offline cloud, so the pin carries
 * its own.
 * @module pins/git/icons
 */

/** Each icon's shapes, on a 16-unit grid. */
const SHAPES = /** @type {const} */ ({
  wt: [['rect', { x: '2.5', y: '5', width: '8', height: '8.5', rx: '1.5' }],
    ['path', { d: 'M5.5 5V3.5A1.5 1.5 0 0 1 7 2h5.5A1.5 1.5 0 0 1 14 3.5V9a1.5 1.5 0 0 1-1.5 1.5h-2' }]],
  repo: [['path', { d: 'M3 2.5h8.5a1 1 0 0 1 1 1V13H4.5A1.5 1.5 0 0 1 3 11.5z' }], ['path', { d: 'M3 11.5A1.5 1.5 0 0 1 4.5 10h8' }]],
  branch: [['circle', { cx: '4.5', cy: '3.5', r: '1.5' }], ['circle', { cx: '4.5', cy: '12.5', r: '1.5' }],
    ['circle', { cx: '11.5', cy: '5', r: '1.5' }], ['path', { d: 'M4.5 5v6M11.5 6.5c0 3.5-7 2.5-7 4.5' }]],
  tag: [['path', { d: 'M2.5 2.5h5l6 6-5 5-6-6z' }], ['circle', { cx: '5.5', cy: '5.5', r: '.8' }]],
  stash: [['path', { d: 'M2.5 6.5h11v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM1.5 3.5h13v3h-13zM6.5 9h3' }]],
  cloud: [['path', { d: 'M4.5 12.5a3 3 0 0 1-.4-6A4 4 0 0 1 11.8 6a3.2 3.2 0 0 1 .2 6.5z' }]],
  chat: [['path', { d: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z' }]],
  chev: [['path', { d: 'M4.5 6.5 8 10l3.5-3.5' }]],
  eye: [['path', { d: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z' }], ['circle', { cx: '8', cy: '8', r: '2' }]],
  lock: [['rect', { x: '3.5', y: '7', width: '9', height: '6.5', rx: '1' }], ['path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2' }]],
  sync: [['path', { d: 'M13 8a5 5 0 0 1-8.6 3.5M3 8a5 5 0 0 1 8.6-3.5' }], ['path', { d: 'M11.8 2v2.7H9.1M4.2 14v-2.7h2.7' }]],
  up: [['path', { d: 'M8 13V3M4 7l4-4 4 4' }]],
  down: [['path', { d: 'M8 3v10M4 9l4 4 4-4' }]],
  forward: [['path', { d: 'M3 8h10M9 4l4 4-4 4' }]],
  offline: [['path', { d: 'M4.5 12.5a3 3 0 0 1-.4-6A4 4 0 0 1 11.8 6a3.2 3.2 0 0 1 .2 6.5z' }], ['path', { d: 'M2.5 2.5l11 11' }]],
  fetch: [['path', { d: 'M4.5 11.5a3 3 0 0 1-.4-6A4 4 0 0 1 11.8 5a3.2 3.2 0 0 1 .2 6.5' }], ['path', { d: 'M8 7.5v6.5M6 12l2 2 2-2' }]],
  plus: [['path', { d: 'M8 3v10M3 8h10' }]],
  check: [['path', { d: 'M3 8.5 6.5 12 13 4.5' }]],
  copy: [['rect', { x: '5.5', y: '5.5', width: '8', height: '8', rx: '1.5' }],
    ['path', { d: 'M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5' }]],
  expand: [['path', { d: 'M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9' }]],
  shrink: [['path', { d: 'M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14' }]],
});

const SVG = 'http://www.w3.org/2000/svg';

/**
 * @param {keyof typeof SHAPES} name - Which icon.
 * @returns {SVGSVGElement} It, hidden from assistive technology: the text beside it says what it means.
 */
export function icon(name) {
  const svg = /** @type {SVGSVGElement} */ (document.createElementNS(SVG, 'svg'));
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `git-pin__icon git-pin__icon--${name}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of SHAPES[name]) {
    const shape = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}
