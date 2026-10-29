//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Content utilities for processing LLM response content
 * @module content-utils
 */

/**
 * @typedef {object} Span A `[start, end)` slice of a string.
 * @property {number} start - First offset in the slice.
 * @property {number} end - First offset past the slice.
 */

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Split `content` into its lines, as spans rather than substrings so offsets
 * stay relative to the whole string.
 * @param {string} content
 * @returns {Span[]} One span per line, in order, excluding the newline itself.
 */
function lineSpans(content) {
  /** @type {Span[]} */
  const lines = [];
  for (let pos = 0; ;) {
    const nl = content.indexOf('\n', pos);
    lines.push({ start: pos, end: nl === -1 ? content.length : nl });
    if (nl === -1) return lines;
    pos = nl + 1;
  }
}

/**
 * Index every span of `content` that Markdown will render as code: fenced
 * blocks and inline spans. Stripping runs before the Markdown parser, so
 * backticks cannot protect anything on their own — this is what lets the
 * strippers tell a tag the model *emitted* from one it is merely quoting.
 * An unterminated fence runs to the end of the string, matching how the
 * renderer treats it.
 * @param {string} content
 * @returns {Span[]} Spans in ascending order of start offset.
 */
function codeSpans(content) {
  /** @type {Span[]} */
  const spans = [];
  const lines = lineSpans(content);

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line) break;
    const marker = FENCE_OPEN.exec(content.slice(line.start, line.end))?.[1];
    if (!marker) { i++; continue; }

    let j = i + 1;
    let end = content.length;
    for (; j < lines.length; j++) {
      const candidate = lines[j];
      if (!candidate) break;
      const close = FENCE_CLOSE.exec(content.slice(candidate.start, candidate.end))?.[1];
      if (close && close.charAt(0) === marker.charAt(0) && close.length >= marker.length) {
        end = candidate.end;
        break;
      }
    }
    spans.push({ start: line.start, end });
    i = j + 1;
  }

  const fences = spans.slice();
  const inFence = (/** @type {number} */ idx) => {
    for (const f of fences) {
      if (idx >= f.start && idx < f.end) return true;
    }
    return false;
  };

  // Inline spans: a run of N backticks opens, the next run of exactly N closes.
  // A run with no matching closer is literal text, not a span.
  for (let i = 0; i < content.length;) {
    if (content.charAt(i) !== '`' || inFence(i)) { i++; continue; }
    let n = 0;
    while (content.charAt(i + n) === '`') n++;

    let close = -1;
    for (let j = i + n; j < content.length;) {
      if (content.charAt(j) !== '`' || inFence(j)) { j++; continue; }
      let m = 0;
      while (content.charAt(j + m) === '`') m++;
      if (m === n) { close = j; break; }
      j += m;
    }
    if (close === -1) { i += n; continue; }
    spans.push({ start: i, end: close + n });
    i = close + n;
  }

  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/**
 * Find the next occurrence of `needle` at or after `from` that does not fall
 * inside one of `spans`.
 * @param {string} content
 * @param {string} needle
 * @param {number} from
 * @param {Span[]} spans
 * @returns {number} Offset, or -1 if there is none.
 */
function indexOfOutside(content, needle, from, spans) {
  for (let i = content.indexOf(needle, from); i !== -1; i = content.indexOf(needle, i + 1)) {
    if (!spans.some((s) => i >= s.start && i < s.end)) return i;
  }
  return -1;
}

/**
 * Strip `<think>…</think>` sections from content for display.
 *
 * No provider in this tree emits these: the tag is a leak from models whose
 * chat template writes reasoning into the standard content stream instead of a
 * reasoning field, so this is a display-time safety net rather than a decoder
 * for a known wire format. It matches the bare lowercase tag only, and only
 * outside code — an assistant explaining `<think>` in a fenced block or a
 * backtick span keeps every word of it.
 *
 * Only matched pairs are removed. A closing tag with no opener is left alone:
 * it may be all that separates a heading from the prose under it, and there is
 * no way to tell leaked reasoning from a sentence about the tag.
 * @param {string} content - Raw content
 * @returns {string} Content with thinking sections removed
 */
export function stripThinkingTags(content) {
  if (!content) return content;
  if (content.indexOf('</think>') === -1) return content.trim();

  const spans = codeSpans(content);
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = indexOfOutside(content, '<think>', cursor, spans);
    if (open === -1) break;
    const close = indexOfOutside(content, '</think>', open + '<think>'.length, spans);
    if (close === -1) break;
    out += content.slice(cursor, open);
    cursor = close + '</think>'.length;
  }
  return (out + content.slice(cursor)).trim();
}
