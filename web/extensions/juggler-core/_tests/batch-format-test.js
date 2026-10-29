//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * BatchContextItem LLM-output tests.
 *
 * batch_read and batch_grep used to render their results from private copies of
 * the read and grep formatters, and the copies had drifted from the originals —
 * a file read through batch_read came back in a different shape from the same
 * file read through read_file, which is a difference the model has to absorb
 * for no reason. Both now call the shared renderers, and these cases pin that:
 * the file body is the SDK's `<file path=…>` block, and a grep result is
 * byte-identical to what the search tool would have produced.
 *
 * Nothing pinned this output before, which is how the drift went unnoticed.
 * @module unit-tests/batch-format-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import BatchContextItem from '../context-items/batch-context-item.js';
import { formatGrepResults } from '../context-items/search/grep-format.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Case name
   * @param {() => (void | Promise<void>)} fn - Case body
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const item = new BatchContextItem({
    id: 'test-batch-format',
    session: /** @type {import('../../../js/model/session.js').default} */ ({}),
    conversation: /** @type {import('../../../js/model/conversation.js').default} */ ({}),
    messageThread: /** @type {import('../../../js/model/message-thread.js').MessageThread} */ ({})
  });

  /**
   * The LLM-facing text of a finished batch call, through the public getSummary.
   * @param {'read'|'grep'} batchType - Which batch tool produced the results
   * @param {Record<string, unknown>[]} results - Per-file or per-search results, as execute() returns them
   * @returns {string} The summary the model receives
   */
  const summarise = (batchType, results) =>
    item.getSummary({ success: true, result: { _batchType: batchType, results } }).summary;

  // ---- batch_read ---------------------------------------------------------

  await run('batch_read renders file bodies in the shared <file> block', () => {
    const out = summarise('read', [
      { file: '/a.txt', success: true, result: { content: 'alpha\nbeta', lineOffset: 1, totalLines: 2 } }
    ]);
    assert(out.includes('<file path="/a.txt">'), `expected the shared wrapper, got:\n${out}`);
    assert(out.includes('</file>'), `expected a closing tag, got:\n${out}`);
    // Tab gutter, as read_file emits — not the two spaces the old copy used.
    assert(out.includes('1\talpha'), `expected a tab line gutter, got:\n${JSON.stringify(out)}`);
    assert(out.includes('(2 lines total)'), `expected the totals footer, got:\n${out}`);
  });

  await run('batch_read reports a missing file the way read_file does', () => {
    const out = summarise('read', [
      { file: '/gone.txt', success: true, result: { exists: false } }
    ]);
    assert(out.includes('File does not exist: /gone.txt'),
      `expected the path named, got:\n${out}`);
    assert(out.includes('Do not attempt to read it again.'),
      `expected the re-read instruction, got:\n${out}`);
  });

  await run('batch_read surfaces a per-file error without losing the others', () => {
    const out = summarise('read', [
      { file: '/bad.txt', success: false, error: 'permission denied' },
      { file: '/ok.txt', success: true, result: { content: 'fine', lineOffset: 1, totalLines: 1 } }
    ]);
    assert(out.includes('=== file: /bad.txt ==='), `expected the failing file headed, got:\n${out}`);
    assert(out.includes('Error: permission denied'), `expected the reason kept, got:\n${out}`);
    assert(out.includes('<file path="/ok.txt">'), `expected the good file still rendered, got:\n${out}`);
  });

  await run('batch_read prefers extracted text when the op supplies it', () => {
    const out = summarise('read', [
      { file: '/doc.pdf', success: true, result: { content: '', extracted: { text: 'page one' }, lineOffset: 1 } }
    ]);
    assert(out.includes('page one'), `expected extracted text used, got:\n${out}`);
  });

  // ---- batch_grep ---------------------------------------------------------

  /** @type {import('../context-items/search-context-item.js').SearchResult} */
  const grepResult = {
    matches: [
      { file: 'a.go', line: 3, content: 'func A() {' },
      { file: 'a.go', line: 9, content: 'func B() {' },
      { file: 'b.go', line: 1, content: 'package main' }
    ],
    matchCount: 3,
    fileCount: 2
  };

  for (const mode of ['files_with_matches', 'count', 'content']) {
    await run(`batch_grep ${mode} matches the search tool byte for byte`, () => {
      const out = summarise('grep', [
        { pattern: 'func', success: true, outputMode: mode, result: grepResult }
      ]);
      const expected = formatGrepResults(grepResult, { pattern: 'func', output_mode: mode });
      assert(out.includes(expected),
        `batch ${mode} output diverged from search.\nbatch:\n${out}\n\nsearch:\n${expected}`);
      assert(out.startsWith('=== grep: func ==='),
        `expected the per-search header retained, got:\n${out}`);
    });
  }

  await run('batch_grep names the pattern when a search finds nothing', () => {
    const out = summarise('grep', [
      { pattern: 'nope', success: true, outputMode: 'content', result: { matches: [] } }
    ]);
    // Batch runs several patterns at once, so an unqualified "No matches found"
    // does not say which one came back empty.
    assert(out.includes('No matches found for pattern: nope'),
      `expected the pattern named, got:\n${out}`);
  });

  await run('batch_grep keeps each search separate', () => {
    const out = summarise('grep', [
      { pattern: 'first', success: true, outputMode: 'files_with_matches', result: grepResult },
      { pattern: 'second', success: false, error: 'bad regex' }
    ]);
    assert(out.includes('=== grep: first ===') && out.includes('=== grep: second ==='),
      `expected both searches headed, got:\n${out}`);
    assert(out.includes('Error: bad regex'), `expected the failure reason kept, got:\n${out}`);
  });

  // ---- the batch_grep detail lines (UI) -------------------------------------

  /** @type {Array<[string, {pattern: string, path?: string, glob?: string}, string]>} */
  const GREP_LINES = [
    ['both', { pattern: '1', path: '2', glob: '3' }, '`1` — in `2`, matching `3`'],
    ['path', { pattern: '1', path: '2' }, '`1` — in `2`'],
    ['glob', { pattern: '1', glob: '3' }, '`1` — matching `3`'],
    ['bare', { pattern: '1' }, '`1`'],
  ];
  await run('batch_grep detail lines read as they always have in English', () => {
    for (const [what, search, want] of GREP_LINES) {
      const got = BatchContextItem.__grepLineForTests(search);
      assert(got === want, `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  });
  await run('batch_grep detail lines are whole messages under en-XA', async () => {
    await underPseudoLocale('batch-format-test', () => {
      for (const [what, search] of GREP_LINES.slice(0, 3)) {
        const got = BatchContextItem.__grepLineForTests(search);
        assert(isPseudoLocalized(got), `${what}: ${JSON.stringify(got)}`);
      }
    }, { '@juggler/core': ['{pattern} — in {path}, matching {glob}', '{pattern} — in {path}', '{pattern} — matching {glob}'] });
  });

  return { passed, failed, errors };
}
