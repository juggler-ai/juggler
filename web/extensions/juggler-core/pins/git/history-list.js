//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The History place's list: a history of any length, read a page at a time
 * and drawn a window at a time.
 *
 * **Drawing.** Every row is {@link ROW_PX} high, and the list is drawn a
 * window at a time by a {@link module:sdk/lib/virtual-list} over the rows the
 * history holds, {@link OVERSCAN} either side of the view. A row not held yet
 * is a gap until its page lands.
 *
 * **Reading.** Pages are {@link PAGE} rows, cut on a grid, kept by their
 * position for the session's current generation, and read only when a row in
 * reach is on one not yet held; one read of a page is out at a time. The
 * server names its session (`graph`) and generation (`gen`) in each page. A
 * page of a newer generation, or of a new session, replaces everything held,
 * because the rows have moved under it; a page of an older one is dropped.
 *
 * **Every read is aborted once nothing will look at it:** a page read when a
 * draw finds its page out of reach (a scroll that went past it), a `find`
 * when another selection by id is asked, and all of them when the list starts
 * again. An aborted read closes its request, so the server stops the git it
 * runs and the browser's few connections to it go to the reads that matter.
 *
 * **Refreshing** asks the session to catch up with refs that moved and to find
 * the commit at the top of the view. When the rows moved and the view is within
 * a screen of the top, it goes to the top, so commits that arrived are seen
 * rather than hidden just above it; further down, it scrolls by as many rows
 * as that commit moved, so it is back where it was on screen, to the pixel.
 *
 * **Selecting a commit** that is not held asks the session where it is (a
 * `find`, which reads on until it is there or the history ends), then selects
 * that row, which reads its page. Before the first page has landed it waits for
 * that page, so the session it asks is the one the list reads.
 *
 * **The working tree's row** (`worktree`, which the server lays out above
 * HEAD's) is a row like any other to draw, but not a commit: it is never
 * selected — moving the selection steps over it — and a refresh anchors on the
 * first commit in view rather than on it. A refresh asked for before the first
 * page has landed is made once it has, since that page's read may have been
 * asked with what the refresh is meant to catch up with.
 *
 * **The graph's width** (`cap`) is a style read, taken once per draw and once
 * per page landed, never per row.
 * @module pins/git/history-list
 */

import { createElement } from 'juggler/ui';
import { columnsFor, rowLanes } from './graph-cell.js';
import { createVirtualList } from 'juggler/utils/virtual-list';

/** A row's height, in px. */
export const ROW_PX = 26;
/** Rows a page holds. */
const PAGE = 200;
/** Rows drawn beyond the view at each end. */
const OVERSCAN = 15;

/**
 * @typedef {import('../../lib/git-client.js').GitLog} GitLog
 * @typedef {import('../../lib/git-client.js').GitLogRow} GitLogRow
 */

/**
 * @typedef {object} HistoryListOptions
 * @property {(query: {offset: number, limit: number, graph?: string, refresh?: boolean, find?: string},
 *   signal: AbortSignal) => Promise<GitLog>} fetch - Read one page of the list's session; the
 *   signal is aborted once nothing will look at the answer.
 * @property {(row: GitLogRow, index: number, graph: {entering: number[], columns: number, cap: number}) => HTMLElement} buildRow -
 *   One row's element; the list places it.
 * @property {() => number} cap - The most graph lanes drawn.
 * @property {(row: GitLogRow|null, index: number) => void} onSelect - The selection moved.
 * @property {(e: any) => void} onError - A read failed.
 * @property {(page: GitLog) => void} [onPage] - A page was taken.
 */

/**
 * @typedef {object} HistoryList
 * @property {HTMLElement} element - The scroller.
 * @property {() => void} render - Draw what is in view, reading what it needs.
 * @property {() => void} reset - Start a new session from the top.
 * @property {() => void} refresh - Catch up with moved refs, keeping the top row in view.
 * @property {(index: number) => void} select - Select a row, scrolling it into view; the
 *   working tree's row is not selected.
 * @property {(sha: string) => Promise<number|null>} selectSha - Select a commit, scrolling
 *   it into view: its row, or -1 when the list does not hold it, or null when a later
 *   `selectSha` or a reset came first (nothing is selected by it then).
 * @property {(by: number) => void} move - Move the selection, stepping over the working tree's row.
 * @property {() => {index: number, row: GitLogRow|null}} selected - The selection.
 * @property {(index: number) => GitLogRow|null} rowAt - A held row.
 * @property {(sha: string) => number} indexOf - Where a held commit is, or -1.
 * @property {() => {total: number, loaded: boolean, graphed: boolean, columns: number, cap: number}} state -
 *   What is known of the list, and the graph's columns and width as its rows are drawn.
 * @property {(shas?: Iterable<string>) => void} redraw - Build rows in view again (what decorates
 *   them changed): those of these commits, or every one.
 */

/**
 * @param {HistoryListOptions} options - What the list works through.
 * @returns {HistoryList} The list.
 */
export function createHistoryList(options) {
  const element = createElement('div', 'git-history__scroll');
  element.setAttribute('role', 'listbox');
  element.tabIndex = -1;

  /** Which session reading this is, so an answer for one reset away is ignored. */
  let epoch = 0;
  /** @type {string} */
  let graph = '';
  let gen = 0;
  let graphed = true;
  /** @type {Map<number, {page: GitLog, entering: number[][]}>} By page number. */
  const pages = new Map();
  /** @type {Map<string, {p: number, abort: AbortController}>} Pages being read, by `gen:page`. */
  const reading = new Map();
  /** Aborted when the list starts again, as each page read is: a refresh's and a `find`'s signal. */
  let session = new AbortController();
  /** @type {AbortController|null} The `find` a selection by id has out. */
  let finding = null;
  /** The graph's width in lanes, as last read. */
  let cap = 0;
  /** @type {Map<string, number>} A commit's row is built again when its count here moves. */
  const versions = new Map();
  /** Rows the list holds, once counted; -1 before. */
  let total = -1;
  /** Rows known to exist while the total is being counted. */
  let extent = 0;
  let columns = 1;
  let selectedIndex = -1;
  /** @type {string} */
  let selectedSha = '';
  let reported = '';
  let refreshing = false;
  let refreshAgain = false;
  /** Whether a refresh was asked for before the first page landed. */
  let refreshDue = false;
  let loaded = false;
  /** @type {((taken: boolean) => void)[]} Waiting for the first page of this session. */
  let waiting = [];

  /**
   * Tell what waits for the first page whether one was taken.
   * @param {boolean} taken - False when the read failed or the list started again.
   */
  const wake = (taken) => {
    const woken = waiting;
    waiting = [];
    for (const w of woken) w(taken);
  };

  /** @returns {number} Rows the spacer stands for. */
  const known = () => (total >= 0 ? total : extent);

  /**
   * @param {number} index - A row.
   * @returns {GitLogRow|null} It, when held.
   */
  const rowAt = (index) => {
    const held = pages.get(Math.floor(index / PAGE));
    return held?.page.rows[index - held.page.offset] || null;
  };

  /**
   * @param {string} sha - A commit.
   * @returns {number} Its row among those held, or -1.
   */
  const indexOf = (sha) => {
    for (const { page } of pages.values()) {
      const at = page.rows.findIndex((r) => r.sha === sha);
      if (at >= 0) return page.offset + at;
    }
    return -1;
  };

  /**
   * Take one page, if it is still of this list.
   * @param {GitLog} page - The page.
   * @param {number} asked - The epoch it was asked in.
   * @returns {boolean} Whether it was taken.
   */
  const adopt = (page, asked) => {
    if (asked !== epoch) return false;
    if (page.graph !== graph || page.gen > gen) {
      graph = page.graph;
      gen = page.gen;
      pages.clear();
      total = -1;
      extent = 0;
    } else if (page.gen < gen) {
      return false;
    }
    graphed = page.graphed;
    loaded = true;
    const entering = page.graphed ? rowLanes(page) : page.rows.map(() => []);
    pages.set(Math.floor(page.offset / PAGE), { page, entering });
    if (page.total >= 0) total = page.total;
    extent = Math.max(extent, page.offset + page.rows.length + (page.more ? PAGE : 0));
    if (page.graphed) {
      cap = options.cap();
      const next = columnsFor(entering, page.rows, cap);
      if (next > columns) {
        columns = next;
        clearDrawn();
      }
    }
    if (selectedSha && rowAt(selectedIndex)?.sha !== selectedSha) {
      const at = indexOf(selectedSha);
      if (at >= 0) selectedIndex = at;
    }
    options.onPage?.(page);
    wake(true);
    return true;
  };

  /**
   * Read one page, unless it is held or on its way.
   * @param {number} p - The page.
   */
  const want = (p) => {
    const key = `${gen}:${p}`;
    if (pages.has(p) || reading.has(key)) return;
    const abort = new AbortController();
    const mine = { p, abort };
    reading.set(key, mine);
    const asked = epoch;
    const { signal } = abort;
    options.fetch({ offset: p * PAGE, limit: PAGE, ...(graph ? { graph } : {}) }, signal).then((page) => {
      if (reading.get(key) === mine) reading.delete(key);
      if (signal.aborted) return;
      if (adopt(page, asked)) {
        render();
        if (refreshDue) {
          refreshDue = false;
          refresh();
        }
      } else if (asked === epoch) {
        render();
      }
    }, (e) => {
      if (reading.get(key) === mine) reading.delete(key);
      if (asked !== epoch || signal.aborted) return;
      options.onError(e);
      wake(false);
    });
  };

  /**
   * Abort the page reads a draw no longer reaches; one is read again if a
   * later draw does.
   * @param {Set<number>} reach - The pages the draw wants.
   */
  const dropOutOfReach = (reach) => {
    for (const [key, r] of reading) {
      if (reach.has(r.p)) continue;
      reading.delete(key);
      r.abort.abort();
    }
  };

  /** @type {import('juggler/utils/virtual-list').VirtualList<GitLogRow>} */
  const list = createVirtualList({
    scroller: element,
    spacerClass: 'git-history__spacer',
    rowHeight: ROW_PX,
    overscan: OVERSCAN,
    keyOf: (row) => `${gen}:${row.sha}:${versions.get(row.sha) || 0}`,
    // The row under the pointer is the target of the wheel turning it; it is
    // left in the document until the pointer leaves it, so a wheel that has
    // scrolled it out of the window is still turning something attached.
    retain: (el) => el.matches(':hover'),
    build: (row, index) => {
      const held = /** @type {{page: GitLog, entering: number[][]}} */ (pages.get(Math.floor(index / PAGE)));
      const el = options.buildRow(row, index, { entering: held.entering[index - held.page.offset] || [], columns, cap });
      el.dataset.sha = row.sha;
      return el;
    },
    decorate: (el, _row, index) => {
      el.dataset.index = String(index);
      el.setAttribute('aria-selected', String(index === selectedIndex));
    },
    beforeDraw: ({ from, to }) => {
      const end = loaded ? Math.min(to, known()) : to;
      /** @type {Set<number>} */
      const reach = new Set();
      if (!loaded) reach.add(0);
      for (let p = Math.floor(from / PAGE); p * PAGE < end; p++) reach.add(p);
      dropOutOfReach(reach);
      for (const p of reach) want(p);
    },
    afterDraw: () => {
      const row = selectedIndex >= 0 ? rowAt(selectedIndex) : null;
      const said = row ? `${selectedIndex}:${row.sha}` : '';
      if (row && said !== reported) {
        reported = said;
        selectedSha = row.sha;
        options.onSelect(row, selectedIndex);
      }
    },
  });
  element.append(list.spacer);
  const clearDrawn = () => list.clear();
  const windowOf = () => list.windowOf();

  const render = () => {
    cap = options.cap();
    list.setItems({ count: known(), at: rowAt });
    list.render();
  };

  /**
   * Bring a row into view, if it is not.
   * @param {number} index - The row.
   */
  const reveal = (index) => {
    list.reveal(index);
  };

  /**
   * @param {number} index - The row to select.
   */
  const select = (index) => {
    const most = known() - 1;
    if (most < 0) return;
    const at = Math.max(0, Math.min(most, index));
    if (rowAt(at)?.worktree) return;
    selectedIndex = at;
    selectedSha = rowAt(selectedIndex)?.sha || '';
    reported = '';
    reveal(selectedIndex);
    render();
  };

  /**
   * @param {string} sha - A full commit id.
   * @returns {Promise<number|null>} Its row, -1 when not held, null when superseded.
   */
  const selectSha = async (sha) => {
    finding?.abort();
    finding = null;
    const held = indexOf(sha);
    if (held >= 0) {
      select(held);
      return held;
    }
    const asked = epoch;
    const mine = new AbortController();
    finding = mine;
    if (!graph) {
      render();
      const taken = await new Promise((resolve) => { waiting.push(resolve); });
      if (asked !== epoch || mine.signal.aborted) return null;
      if (!taken) return -1;
      return selectSha(sha);
    }
    const { first } = windowOf();
    const p = Math.floor(first / PAGE);
    const { signal } = mine;
    session.signal.addEventListener('abort', () => mine.abort(), { once: true });
    let page;
    try {
      page = await options.fetch({ offset: p * PAGE, limit: PAGE, graph, find: sha }, signal);
    } catch (e) {
      if (asked !== epoch || signal.aborted) return null;
      options.onError(e);
      return -1;
    } finally {
      if (finding === mine) finding = null;
    }
    if (asked !== epoch || signal.aborted) return null;
    if (!adopt(page, asked) || page.found < 0) {
      render();
      return -1;
    }
    select(page.found);
    return page.found;
  };

  /**
   * @param {number} by - Rows to move by.
   */
  const move = (by) => {
    const step = by < 0 && selectedIndex >= 0 ? -1 : 1;
    let at = selectedIndex < 0 ? 0 : selectedIndex + by;
    if (rowAt(at)?.worktree) at += step;
    // Above the top, past the working tree's row: the selection stays.
    if (at < 0) return;
    select(at);
  };

  const refresh = () => {
    if (!graph) {
      refreshDue = !loaded;
      render();
      return;
    }
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    let { first } = windowOf();
    if (rowAt(first)?.worktree) first++;
    const anchor = rowAt(first)?.sha || '';
    const asked = epoch;
    const p = Math.floor(first / PAGE);
    options.fetch({ offset: p * PAGE, limit: PAGE, graph, refresh: true, ...(anchor ? { find: anchor } : {}) }, session.signal).then((page) => {
      const was = gen;
      // Where the view is as the answer lands, so a scroll made meanwhile counts.
      const nearTop = element.scrollTop < element.clientHeight;
      if (!adopt(page, asked)) {
        if (asked === epoch) render();
        return;
      }
      if (page.gen !== was && nearTop) {
        // The rows moved under a view within a screen of the top: what came
        // is most likely new on top, and is what the user wants to see.
        list.spacer.style.height = `${known() * ROW_PX}px`;
        element.scrollTop = 0;
      } else if (anchor && page.found >= 0 && page.found !== first) {
        // Everything held moved as the anchor did; a scroll made while the
        // read was out moves with it rather than being undone.
        list.spacer.style.height = `${known() * ROW_PX}px`;
        element.scrollTop += (page.found - first) * ROW_PX;
      }
      if (asked === epoch) render();
    }, (e) => {
      if (asked === epoch) options.onError(e);
    }).finally(() => {
      // A reset since has let this one go, and may have a refresh of its own out.
      if (asked !== epoch) return;
      refreshing = false;
      if (refreshAgain) {
        refreshAgain = false;
        refresh();
      }
    });
  };

  const reset = () => {
    epoch++;
    session.abort();
    session = new AbortController();
    finding = null;
    for (const r of reading.values()) r.abort.abort();
    reading.clear();
    versions.clear();
    graph = '';
    gen = 0;
    pages.clear();
    total = -1;
    extent = 0;
    columns = 1;
    loaded = false;
    selectedIndex = -1;
    selectedSha = '';
    reported = '';
    refreshing = false;
    refreshAgain = false;
    refreshDue = false;
    wake(false);
    clearDrawn();
    element.scrollTop = 0;
    render();
  };

  return {
    element,
    render,
    reset,
    refresh,
    select,
    selectSha,
    move,
    selected: () => ({ index: selectedIndex, row: selectedIndex >= 0 ? rowAt(selectedIndex) : null }),
    rowAt,
    indexOf,
    state: () => ({ total: known(), loaded, graphed, columns, cap }),
    redraw: (shas) => {
      if (shas) for (const sha of shas) versions.set(sha, (versions.get(sha) || 0) + 1);
      else clearDrawn();
      render();
    },
  };
}
