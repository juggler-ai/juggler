//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * One row of the History place's commit graph, as an SVG cell.
 *
 * The server lays the lanes out (gitview/graph.go) and a page carries the lanes
 * occupied entering its first row. Lanes never move, so the lanes entering each
 * later row follow from the row above alone ({@link advanceLanes}), and a row is
 * drawn from those and its own `lane` and `out`: every other entering lane runs
 * straight through, its own lane runs in from the top if it was waiting, and an
 * edge runs from its dot to the bottom of each parent's lane.
 *
 * The graph is as wide as `cap` lanes (the list's `--git-history-lanes`). A lane
 * past it is not drawn; a dot in one is a hollow marker in the last column, so
 * the row still says where its commit is not.
 * @module pins/git/graph-cell
 */

/** One lane's width, in px. */
const LANE_PX = 12;
/** The palette's size: lane colours are `--git-history-lane-0` … `--git-history-lane-7`. */
const PALETTE = 8;
const SVG = 'http://www.w3.org/2000/svg';

/**
 * The lanes occupied entering the row after one placed in `lane` with
 * out-edges `out`, given those entering it: its own lane ends at its dot, and
 * each of its parents' lanes runs on.
 * @param {number[]} occ - The lanes entering the row, in order.
 * @param {number} lane - The row's lane.
 * @param {number[]} out - Its parents' lanes.
 * @returns {number[]} The lanes entering the next row, in order.
 */
function advanceLanes(occ, lane, out) {
  const next = occ.filter((i) => i !== lane);
  for (const j of out) if (!next.includes(j)) next.push(j);
  return next.sort((a, b) => a - b);
}

/**
 * The lanes entering each row of a page.
 * @param {{lanes: number[], rows: {lane: number, out: number[]}[]}} page - The page.
 * @returns {number[][]} One list per row.
 */
export function rowLanes(page) {
  /** @type {number[][]} */
  const all = [];
  let occ = page.lanes || [];
  for (const row of page.rows) {
    all.push(occ);
    occ = advanceLanes(occ, row.lane, row.out);
  }
  return all;
}

/**
 * The columns a run of rows needs, up to the cap.
 * @param {number[][]} entering - Each row's entering lanes.
 * @param {{lane: number, out: number[]}[]} rows - The rows.
 * @param {number} cap - The most columns drawn.
 * @returns {number} The columns.
 */
export function columnsFor(entering, rows, cap) {
  let most = 0;
  rows.forEach((row, i) => {
    most = Math.max(most, row.lane, ...row.out, ...(entering[i] || []));
  });
  return Math.max(1, Math.min(cap, most + 1));
}

/**
 * @param {number} i - A lane.
 * @returns {string} Its colour.
 */
const colour = (i) => `var(--git-history-lane-${i % PALETTE})`;

/**
 * @param {string} cls - Its class.
 * @param {string} d - Its path.
 * @param {number} lane - The lane it is coloured as.
 * @returns {SVGPathElement} A stroke.
 */
function stroke(cls, d, lane) {
  const p = /** @type {SVGPathElement} */ (document.createElementNS(SVG, 'path'));
  p.setAttribute('class', cls);
  p.setAttribute('d', d);
  p.setAttribute('stroke', colour(lane));
  return p;
}

/**
 * The working tree's changes, as a cell on the graph's grid: a ring in HEAD's
 * lane, and, when `joined`, a stem from it to the cell's bottom, which HEAD's
 * row carries on (`graphCell`'s `wip`) — the changes as the next commit in line.
 * @param {{lane: number, cap: number, columns: number, height: number, joined: boolean}} options -
 *   HEAD's lane, the most lanes drawn, the cell's columns, its height in px,
 *   and whether the stem is drawn.
 * @returns {SVGSVGElement} The cell.
 */
export function wipCell({ lane, cap, columns, height, joined }) {
  const svg = /** @type {SVGSVGElement} */ (document.createElementNS(SVG, 'svg'));
  svg.setAttribute('class', 'git-graph git-graph--wip');
  const last = Math.max(0, Math.min(cap, columns) - 1);
  const at = Math.min(lane, last);
  svg.setAttribute('width', String(Math.max(columns, at + 1) * LANE_PX));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');
  const xc = LANE_PX / 2 + at * LANE_PX;
  const mid = height / 2;
  if (joined && lane <= last) {
    // On past the bottom: the row's border lies between this cell and HEAD's.
    svg.append(stroke('git-graph__wip-stem', `M${xc},${mid} V${height + 2}`, lane));
  }
  const ring = /** @type {SVGCircleElement} */ (document.createElementNS(SVG, 'circle'));
  ring.setAttribute('class', 'git-graph__dot git-graph__dot--wip');
  ring.setAttribute('cx', String(xc));
  ring.setAttribute('cy', String(mid));
  ring.setAttribute('r', '4');
  svg.append(ring);
  return svg;
}

/**
 * One row's cell.
 * @param {number[]} entering - The lanes entering the row.
 * @param {{lane: number, out: number[]}} row - The row.
 * @param {{cap: number, columns: number, height: number, head: boolean, wip?: boolean}} options -
 *   The most lanes drawn, the cell's columns, its height in px, whether
 *   the row is the viewed tree's HEAD (a ring rather than a dot), and whether
 *   the working tree's changes sit right above it (a stem in from the top).
 * @returns {SVGSVGElement} The cell.
 */
export function graphCell(entering, row, { cap, columns, height, head, wip = false }) {
  const svg = /** @type {SVGSVGElement} */ (document.createElementNS(SVG, 'svg'));
  svg.setAttribute('class', 'git-graph');
  svg.setAttribute('width', String(columns * LANE_PX));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');
  const mid = height / 2;
  const last = Math.max(0, Math.min(cap, columns) - 1);
  /**
   * @param {number} i - A lane.
   * @returns {number} Its centre.
   */
  const x = (i) => LANE_PX / 2 + Math.min(i, last) * LANE_PX;
  const over = row.lane > last;
  const xc = x(row.lane);

  for (const i of entering) {
    if (i === row.lane || i > last) continue;
    const p = stroke('git-graph__through', `M${x(i)},0 V${height}`, i);
    p.setAttribute('data-lane', String(i));
    svg.append(p);
  }
  if (entering.includes(row.lane) && !over) {
    svg.append(stroke('git-graph__in', `M${xc},0 V${mid}`, row.lane));
  } else if (wip && !over) {
    svg.append(stroke('git-graph__in git-graph__in--wip', `M${xc},0 V${mid}`, row.lane));
  }
  for (const j of row.out) {
    if (over && j > last) continue;
    const xj = x(j);
    const d = xj === xc
      ? `M${xc},${mid} V${height}`
      : `M${xc},${mid} C${xc},${mid + height * 0.3} ${xj},${height - height * 0.3} ${xj},${height}`;
    const p = stroke('git-graph__out', d, j);
    p.setAttribute('data-to', String(j));
    svg.append(p);
  }

  const dot = /** @type {SVGCircleElement} */ (document.createElementNS(SVG, 'circle'));
  dot.setAttribute('cx', String(xc));
  dot.setAttribute('cy', String(mid));
  dot.setAttribute('data-lane', String(row.lane));
  if (over) {
    dot.setAttribute('class', 'git-graph__dot git-graph__dot--over');
    dot.setAttribute('r', '3');
    dot.setAttribute('stroke', colour(row.lane));
  } else if (head) {
    dot.setAttribute('class', 'git-graph__dot git-graph__dot--head');
    dot.setAttribute('r', '4');
    dot.setAttribute('stroke', colour(row.lane));
  } else {
    dot.setAttribute('class', 'git-graph__dot');
    dot.setAttribute('r', '3.2');
    dot.setAttribute('fill', colour(row.lane));
  }
  svg.append(dot);
  return svg;
}
