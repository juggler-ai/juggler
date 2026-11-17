//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A commit message as git keeps it: a summary line, a blank line, a body. The
 * commit box holds body paragraphs unwrapped, so they soft-wrap to whatever
 * width the pane has; the hard wrap git's own tools expect is applied here, as
 * the message is committed. DOM-free and pure.
 * @module lib/commit-message
 */

/** A list item: a bullet or a number, then a space. */
const LIST_ITEM = /^([-*+]|\d+[.)])\s/;

/** A trailer git reads by its key (`Signed-off-by:`, `Co-authored-by:`). */
const TRAILER = /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)+:\s/;

/** A fence opening or closing a block of code. */
const FENCE = /^(```|~~~)/;

/**
 * The summary: the message's first line.
 * @param {string} message - The whole message.
 * @returns {string} Its first line.
 */
export function summaryOf(message) {
  const at = message.indexOf('\n');
  return at < 0 ? message : message.slice(0, at);
}

/**
 * One body line broken at spaces so that no line is longer than `width`,
 * except a single word that is longer on its own (a URL), which keeps a line to
 * itself rather than being cut.
 * @param {string} line - The line.
 * @param {number} width - The column to wrap at.
 * @returns {string[]} The lines it became.
 */
function wrapLine(line, width) {
  /** @type {string[]} */
  const out = [];
  let current = '';
  for (const word of line.split(/ +/).filter(Boolean)) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Hard-wrap a message's body at `width` columns, line by line. The summary is
 * left as typed, as are blank lines, indented lines (code, quoted output), list
 * items, trailers and anything inside a fenced block: reflowing those changes
 * what they say. Lines already short enough are untouched, so line breaks the
 * user typed stay where they are.
 * @param {string} message - The message as typed.
 * @param {number} [width] - The column to wrap at.
 * @returns {string} The message to commit.
 */
export function wrapBody(message, width = 72) {
  const lines = message.split('\n');
  /** @type {string[]} */
  const out = [lines[0] || ''];
  let fenced = false;
  for (const line of lines.slice(1)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      out.push(line);
    } else if (fenced || line.length <= width || /^\s/.test(line) || LIST_ITEM.test(line) || TRAILER.test(line)) {
      out.push(line);
    } else {
      out.push(...wrapLine(line, width));
    }
  }
  return out.join('\n');
}

/**
 * Undo a hard wrap: join each body paragraph's lines into one, as the commit
 * box holds them. A list item's continuation lines, indented or not, join the
 * item. The summary, blank lines, list items' starts, trailers, fenced blocks
 * and indented lines outside a list keep their own lines.
 * @param {string} message - A message whose body may be hard-wrapped.
 * @returns {string} The message with each paragraph on one line.
 */
export function unwrapBody(message) {
  const lines = message.split('\n');
  /** @type {string[]} */
  const out = [lines[0] || ''];
  let fenced = false;
  /** What the last line out was: prose or a list item a next line continues, or neither. */
  /** @type {'prose'|'list'|'none'} */
  let open = 'none';
  const join = (/** @type {string} */ line) => {
    out[out.length - 1] = `${out[out.length - 1]?.trimEnd()} ${line.trim()}`;
  };
  for (const line of lines.slice(1)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      out.push(line);
      open = 'none';
    } else if (fenced || !line.trim() || TRAILER.test(line)) {
      out.push(line);
      open = 'none';
    } else if (LIST_ITEM.test(line)) {
      out.push(line);
      open = 'list';
    } else if (/^\s/.test(line)) {
      if (open === 'list') join(line);
      else {
        out.push(line);
        open = 'none';
      }
    } else if (open !== 'none') {
      join(line);
    } else {
      out.push(line);
      open = 'prose';
    }
  }
  return out.join('\n');
}
