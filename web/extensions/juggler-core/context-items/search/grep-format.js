//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * How a grep result is rendered for the LLM, for every tool that runs one.
 *
 * Extracted from SearchContextItem because `batch_grep` was rendering the same
 * three output modes from its own copy, and the copies had drifted: batch ran
 * its content mode with no blank line between file groups, said only "No
 * matches found" where search names the pattern, and had none of the
 * `match.line || '?'` / `match.file || 'unknown'` fallbacks, so one malformed
 * match printed "undefined: undefined". The functions never touched `this`
 * beyond calling each other, so the move is verbatim.
 *
 * Pagination (`head_limit`/`offset`) is inert for a caller that passes neither,
 * which is how batch uses it.
 */

/** @typedef {import('../search-context-item.js').SearchResult} SearchResult */
/** @typedef {import('../search-context-item.js').SearchMatch} SearchMatch */

/**
 * Format search results for LLM based on output_mode
 * @param {SearchResult} result - Search result from backend
 * @param {Record<string, unknown>} params - Original params
 * @returns {string} Formatted search results
 */
export function formatGrepResults(result, params) {
  const pattern = /** @type {string} */ (params.pattern) || 'unknown';
  const matches = result.matches || [];
  const outputMode = /** @type {string} */ (params.output_mode) || 'files_with_matches';
  const headLimit = /** @type {number|undefined} */ (params.head_limit);
  const offset = /** @type {number|undefined} */ (params.offset) || 0;

  if (matches.length === 0) {
    return `No matches found for pattern: ${pattern}`;
  }

  // Group by file for better readability
  const fileGroups = groupMatchesByFile(matches);
  const files = Object.keys(fileGroups);

  // Handle different output modes
  if (outputMode === 'count') {
    // Just show counts per file
    let results = '';
    let fileIndex = 0;
    let shownCount = 0;
    const totalFiles = files.length;

    for (const file of files) {
      if (fileIndex++ < offset) continue;
      if (headLimit && shownCount >= headLimit) break;

      const count = /** @type {SearchMatch[]} */ (fileGroups[file]).length; // bounded: file from Object.keys(fileGroups)
      results += `${file}:${count}\n`;
      shownCount++;
    }

    if (headLimit && shownCount < totalFiles - offset) {
      results += `\n(Showing ${shownCount} of ${totalFiles} files. Use offset=${offset + shownCount} to see more.)`;
    }

    return results.trim();
  }

  if (outputMode === 'files_with_matches') {
    // Just show file paths (default mode - most compact)
    let shownCount = 0;
    const totalFiles = files.length;
    /** @type {string[]} */
    const outputFiles = [];

    for (const [i, file] of files.entries()) {
      if (i < offset) continue;
      if (headLimit && shownCount >= headLimit) break;

      outputFiles.push(file);
      shownCount++;
    }

    let results = outputFiles.join('\n');

    if (headLimit && shownCount < totalFiles - offset) {
      results += `\n\n(Showing ${shownCount} of ${totalFiles} files. Use offset=${offset + shownCount} to see more.)`;
    }

    return results;
  }

  // outputMode === 'content' - show full matching lines
  let results = '';
  let entryIndex = 0;
  let shownCount = 0;
  const totalMatches = matches.length;

  for (const [file, fileMatches] of Object.entries(fileGroups)) {
    /** @type {string[]} */
    const fileLines = [];

    for (const match of fileMatches) {
      if (entryIndex++ < offset) continue;
      if (headLimit && shownCount >= headLimit) break;

      const line = match.line || '?';
      const content = match.content || '';
      fileLines.push(`${line}: ${content}`);
      shownCount++;
    }

    if (fileLines.length > 0) {
      results += `${file}:\n${fileLines.join('\n')}\n\n`;
    }

    if (headLimit && shownCount >= headLimit) break;
  }

  if (headLimit && shownCount < totalMatches - offset) {
    results += `(Showing ${shownCount} of ${totalMatches} matches. Use offset=${offset + shownCount} to see more.)`;
  }

  return results.trim();
}

/**
 * Group matches by file
 * @param {SearchMatch[]} matches - Array of match objects
 * @returns {Record<string, SearchMatch[]>} Matches grouped by file
 */
function groupMatchesByFile(matches) {
  /** @type {Record<string, SearchMatch[]>} */
  const groups = {};

  for (const match of matches) {
    const file = match.file || 'unknown';
    if (!groups[file]) {
      groups[file] = [];
    }
    groups[file].push(match);
  }

  return groups;
}
