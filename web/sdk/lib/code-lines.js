//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Line-numbered code rendering for {@link module:sdk/lib/context-item-utils}.
 *
 * A short file renders every line, so the browser's own find-in-page and
 * select-across-the-file work on it. A long one renders only the lines its
 * scroller can show, between two spacer boxes that stand in for the rest, so
 * cost tracks the window rather than the file — the file is shown whole either
 * way, and nothing is truncated.
 *
 * Every row is exactly one line tall (`.ci-line` is `white-space: pre` with a
 * `min-height`, so even a blank line holds its row), which is what makes the
 * arithmetic here exact rather than an estimate.
 * @module sdk/lib/code-lines
 */

import { highlightCode, highlightCodeLines } from './syntax-highlight.js';

/**
 * Line count up to which every line is rendered. Sized from measurement: at
 * this length a full render costs roughly a tenth of a second, and paying it
 * buys find-in-page over the whole file.
 */
export const EAGER_LINE_LIMIT = 2000;

/** Rows drawn beyond each edge of the viewport, so a small scroll needs no redraw. */
const OVERSCAN_ROWS = 20;

/** Rows drawn before anything has been measured, purely so the first paint is not empty. */
const INITIAL_ROWS = 120;

/**
 * Attempts at the first row measurement that are made on the next tick rather
 * than after a wait. A block is appended by its caller in the same task as it
 * is built, so it has almost always landed by then, and a wait here would leave
 * the block claiming to be INITIAL_ROWS tall for that whole time.
 */
const MEASURE_IMMEDIATE_ATTEMPTS = 4;

/** Gap between the attempts after those, for a block put in the document later. */
const MEASURE_RETRY_MS = 50;

/** How many attempts the first measurement gets before it gives up. */
const MEASURE_ATTEMPTS = 40;

/**
 * Build one rendered line from its highlighted markup.
 * @param {string} html - Safe HTML for the line, from the shared highlighter
 * @param {number} number - Line number to show in the gutter
 * @returns {HTMLElement} The line element
 */
function buildLine(html, number) {
  const line = document.createElement('span');
  line.className = 'ci-line';
  line.dataset.line = String(number);
  line.innerHTML = html;
  return line;
}

/**
 * Nearest ancestor that scrolls vertically, or null when the page itself does.
 *
 * Being overflow-scrollable is necessary but not sufficient: an element whose
 * height is unconstrained grows to fit its content instead of scrolling it, and
 * treating one as the viewport would ask for a window the size of the whole
 * file. The enclosing `.ci-code-content` is exactly that case — it sets
 * `overflow-x: auto`, which forces the computed `overflow-y` to `auto` too —
 * so the height must be shown to actually constrain something.
 * @param {HTMLElement} el - Element to search up from
 * @returns {HTMLElement|null} The scrolling ancestor, if any
 */
function nearestScroller(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    const scrollable = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    if (scrollable && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * Render `lines` into `code`, windowing the long case.
 * @param {HTMLElement} code - The `<code>` element to fill
 * @param {string[]} lines - Source split on newlines
 * @param {string} language - Prism language id
 * @param {number} lineNumberStart - Line number of `lines[0]`
 * @returns {(() => void)|null} A teardown for the windowed case, else null
 */
export function renderLineNumberedCode(code, lines, language, lineNumberStart) {
  code.textContent = '';
  code.classList.add('ci-code-lines');

  // The gutter is sized from the widest line number the block will show, so the
  // browser never has to measure a number column to lay the file out.
  const lastNumber = lineNumberStart + Math.max(lines.length - 1, 0);
  code.style.setProperty('--line-digits', String(String(lastNumber).length));

  if (lines.length <= EAGER_LINE_LIMIT) {
    // One pass over the whole block, split into per-line markup: each line still
    // gets its own row (so it aligns with its number and wraps on its own), but
    // a construct spanning several lines — a block comment, a multi-line
    // template literal — is tokenised as a whole rather than restarting on every
    // line. Affordable here precisely because the block is short.
    const markup = highlightCodeLines(lines.join('\n'), language);
    for (let i = 0; i < lines.length; i++) {
      code.appendChild(buildLine(markup[i] ?? '', lineNumberStart + i));
    }
    return null;
  }
  return mountWindowed(code, lines, language, lineNumberStart);
}

/**
 * Draw only the visible rows, keeping total height right with spacers.
 * @param {HTMLElement} code - The `<code>` element to fill
 * @param {string[]} lines - Source split on newlines
 * @param {string} language - Prism language id
 * @param {number} lineNumberStart - Line number of `lines[0]`
 * @returns {() => void} Teardown: unsubscribes and clears the element
 */
function mountWindowed(code, lines, language, lineNumberStart) {
  // Pin the horizontal extent to the widest line in the whole file. Without it
  // the scroll width would be whatever the current window happens to contain,
  // and the horizontal scrollbar would jump about as you scroll vertically.
  let widest = 0;
  for (const line of lines) if (line.length > widest) widest = line.length;
  code.style.minWidth = `calc(${widest}ch + var(--line-gutter))`;

  const topSpacer = document.createElement('span');
  topSpacer.className = 'ci-line-spacer';
  const bottomSpacer = document.createElement('span');
  bottomSpacer.className = 'ci-line-spacer';
  code.append(topSpacer, bottomSpacer);

  let rowHeight = 0;
  let firstDrawn = -1;
  let lastDrawn = -1;
  let lastWidth = 0;

  /**
   * @param {number} first - First line index to draw, inclusive
   * @param {number} last - Last line index to draw, exclusive
   */
  const draw = (first, last) => {
    const fragment = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      // Each drawn line is highlighted on its own, so the cost of a scroll is
      // the window rather than the file. The price is that a construct spanning
      // several lines is tokenised per line here — the whole-block pass the
      // eager path uses would mean highlighting a file we are windowing exactly
      // because it is too big for that.
      fragment.appendChild(buildLine(highlightCode(lines[i] || '', language), lineNumberStart + i));
    }
    while (topSpacer.nextSibling && topSpacer.nextSibling !== bottomSpacer) {
      topSpacer.nextSibling.remove();
    }
    code.insertBefore(fragment, bottomSpacer);
    topSpacer.style.height = `${first * rowHeight}px`;
    bottomSpacer.style.height = `${(lines.length - last) * rowHeight}px`;
    firstDrawn = first;
    lastDrawn = last;
  };

  // Something to show, and something to measure, before any layout has happened.
  draw(0, Math.min(lines.length, INITIAL_ROWS));

  const ref = new WeakRef(code);
  /** @type {HTMLElement|null} */
  let scroller = null;

  let everConnected = false;

  const update = () => {
    const el = ref.deref();
    // Collected, or removed after having been in the document without its
    // teardown being run: this is the safety net, not the intended path.
    if (!el || (everConnected && !el.isConnected)) {
      stop();
      return;
    }
    // Built but not appended yet — a block is assembled detached and put in the
    // document by its caller, so this is the ordinary state at mount. There is
    // nothing to measure until it lands, and it must not be mistaken for one
    // that has been thrown away.
    if (!el.isConnected) return;
    everConnected = true;

    if (!rowHeight) {
      const sample = el.querySelector('.ci-line');
      rowHeight = sample ? sample.getBoundingClientRect().height : 0;
      // Laid out to nothing so far — the retry below, or a later scroll or
      // resize, will measure.
      if (!rowHeight) return;
      // The provisional window's spacers were sized with no row height, so it
      // must be redrawn even when the measured window covers the same rows.
      firstDrawn = -1;
    }
    // Keep looking until one is found: on the first pass nothing may have
    // enough height to overflow yet. Once found it is kept, so the search does
    // not cost a forced reflow on every scroll event.
    if (!scroller) scroller = nearestScroller(el);

    const viewTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const viewHeight = scroller ? scroller.clientHeight : window.innerHeight;
    const offset = viewTop - el.getBoundingClientRect().top;

    const first = Math.max(0, Math.floor(offset / rowHeight) - OVERSCAN_ROWS);
    const last = Math.min(lines.length, Math.ceil((offset + viewHeight) / rowHeight) + OVERSCAN_ROWS);
    if (first !== firstDrawn || last !== lastDrawn) draw(first, last);
  };

  const onScroll = () => update();

  // Width changes re-wrap nothing (lines never wrap) but do change how many
  // rows fit.
  const resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? 0;
    // Only react to a real width change: redrawing keeps total height constant,
    // so reacting to height would be answering our own notification.
    if (width === lastWidth && rowHeight) return;
    lastWidth = width;
    update();
  });

  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let measureTimer;

  const stop = () => {
    clearTimeout(measureTimer);
    resizeObserver.disconnect();
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
  };

  // Captured at the window, so it hears the scroll of whichever ancestor is the
  // scroller without having to have resolved it first.
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  resizeObserver.observe(code);

  // Until a row has been measured the spacers stand at nothing, so the block is
  // INITIAL_ROWS tall and the scrollbar agrees: a long file shown cut short.
  // Getting out of that state cannot be left to a notification. The block is
  // not in the document yet, so there is nothing to measure here; and the
  // observer's first delivery rides the rendering update step, which a hidden
  // or unpainted page can defer indefinitely. A timer rides nothing, so ask on
  // one until a row measures — which needs only that the block has landed and
  // been laid out, whether or not anything has painted.
  let attempts = 0;
  const measure = () => {
    if (rowHeight) return;
    update();
    if (rowHeight || ++attempts >= MEASURE_ATTEMPTS) return;
    measureTimer = setTimeout(
      measure,
      attempts < MEASURE_IMMEDIATE_ATTEMPTS ? 0 : MEASURE_RETRY_MS,
    );
  };
  measure();

  return () => {
    stop();
    code.textContent = '';
  };
}
