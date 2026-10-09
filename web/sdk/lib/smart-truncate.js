//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Smart output truncation for context-efficient tool results.
 *
 * Reduces tool output size to fit within a token budget while preserving
 * the most relevant content. Uses keyword-aware windowing when possible,
 * falls back to head/tail split.
 */

/**
 * @typedef {object} TruncateOptions
 * @property {number} [maxChars=30000] - Character budget (~7500 tokens)
 * @property {string[]} [keywords] - Keep windows around lines matching these
 * @property {number} [windowSize=5] - Lines of context around each keyword match
 */

/**
 * @typedef {object} TruncateResult
 * @property {string} content - Truncated (or original) content
 * @property {boolean} truncated - Whether truncation occurred
 * @property {number} originalChars - Original content length
 */

/**
 * Truncate content intelligently, preserving keyword context when possible.
 *
 * Algorithm:
 * 1. Under budget -> return as-is
 * 2. Keywords provided -> extract windows around matching lines, merge overlaps
 * 3. Still over or no keywords -> head (60%) + tail (40%) with omission marker
 * @param {string} content - Full content to truncate
 * @param {TruncateOptions} [options={}] - Truncation options
 * @returns {TruncateResult} Truncated result
 */
export function smartTruncate(content, options = {}) {
  const {
    maxChars = 30000,
    keywords = [],
    windowSize = 5
  } = options;

  const originalChars = content.length;

  // Under budget - return as-is
  if (originalChars <= maxChars) {
    return { content, truncated: false, originalChars };
  }

  const lines = content.split('\n');

  // Try keyword-based windowing first
  if (keywords.length > 0) {
    const result = _keywordTruncate(lines, keywords, windowSize, maxChars);
    if (result) {
      return { content: result, truncated: true, originalChars };
    }
  }

  // Fallback: head (60%) + tail (40%)
  const result = _headTailTruncate(lines, maxChars);
  return { content: result, truncated: true, originalChars };
}

/**
 * Extract windows around keyword-matching lines
 * @param {string[]} lines - All lines
 * @param {string[]} keywords - Keywords to match
 * @param {number} windowSize - Context lines around each match
 * @param {number} maxChars - Character budget
 * @returns {string|null} Truncated content or null if result exceeds budget
 * @private
 */
function _keywordTruncate(lines, keywords, windowSize, maxChars) {
  // Find matching line indices
  const lowerKeywords = keywords.map(k => k.toLowerCase());
  /** @type {Set<number>} */
  const matchIndices = new Set();

  for (let i = 0; i < lines.length; i++) {
    const lower = /** @type {string} */ (lines[i]).toLowerCase(); // bounded by i < lines.length
    for (const kw of lowerKeywords) {
      if (lower.includes(kw)) {
        matchIndices.add(i);
        break;
      }
    }
  }

  if (matchIndices.size === 0) {
    return null; // No matches, fall through to head/tail
  }

  // Build windows and merge overlapping ones
  /** @type {Array<{start: number, end: number}>} */
  const windows = [];
  const sortedIndices = [...matchIndices].sort((a, b) => a - b);

  for (const idx of sortedIndices) {
    const start = Math.max(0, idx - windowSize);
    const end = Math.min(lines.length - 1, idx + windowSize);

    // Merge with previous window if overlapping
    const lastWindow = windows[windows.length - 1];
    if (lastWindow && start <= lastWindow.end + 1) {
      lastWindow.end = end;
    } else {
      windows.push({ start, end });
    }
  }

  // Build output with omission markers
  /** @type {string[]} */
  const parts = [];
  let prevEnd = -1;

  for (const win of windows) {
    if (win.start > prevEnd + 1) {
      const omitted = win.start - prevEnd - 1;
      parts.push(`\n... (${omitted} lines omitted) ...\n`);
    }
    parts.push(lines.slice(win.start, win.end + 1).join('\n'));
    prevEnd = win.end;
  }

  // Trailing omission
  if (prevEnd < lines.length - 1) {
    const omitted = lines.length - 1 - prevEnd;
    parts.push(`\n... (${omitted} lines omitted) ...`);
  }

  const result = parts.join('');

  // If keyword extraction still exceeds budget, return null to fall through
  if (result.length > maxChars) {
    return null;
  }

  return result;
}

/**
 * Head (60%) + tail (40%) truncation with omission marker
 * @param {string[]} lines - All lines
 * @param {number} maxChars - Character budget
 * @returns {string} Truncated content
 * @private
 */
function _headTailTruncate(lines, maxChars) {
  // Reserve chars for the omission marker
  const markerReserve = 50;
  const available = maxChars - markerReserve;
  const headBudget = Math.floor(available * 0.6);
  const tailBudget = available - headBudget;

  // Collect head lines
  /** @type {string[]} */
  const headLines = [];
  let headChars = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = /** @type {string} */ (lines[i]); // bounded by i < lines.length
    const lineLen = line.length + 1; // +1 for newline
    if (headChars + lineLen > headBudget && headLines.length > 0) break;
    headLines.push(line);
    headChars += lineLen;
  }

  // Collect tail lines (from end)
  /** @type {string[]} */
  const tailLines = [];
  let tailChars = 0;
  for (let i = lines.length - 1; i >= headLines.length; i--) {
    const line = /** @type {string} */ (lines[i]); // bounded: i >= headLines.length, i < lines.length
    const lineLen = line.length + 1;
    if (tailChars + lineLen > tailBudget && tailLines.length > 0) break;
    tailLines.unshift(line);
    tailChars += lineLen;
  }

  const omitted = lines.length - headLines.length - tailLines.length;
  const marker = `\n... (${omitted} lines omitted) ...\n`;

  return headLines.join('\n') + marker + tailLines.join('\n');
}
