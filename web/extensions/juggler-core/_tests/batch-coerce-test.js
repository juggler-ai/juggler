//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * BatchContextItem argument-coercion unit tests.
 *
 * Some models double-encode array arguments as a JSON string — e.g. they emit
 *   { searches: "[{\"pattern\": \"foo\"}]" }
 * instead of the array literal the schema asks for. Before the coercion fix
 * this produced two visible failures:
 *
 *   1. validate() rejected the call with "searches must be a non-empty array"
 *      even though the content was fully present (just string-wrapped).
 *   2. getStatusUI() read the raw string and reported `string.length` as the
 *      item count, rendering a "huge list" of bogus boxes (one per character).
 *
 * BatchContextItem._coerceArray parses a JSON-string-of-an-array back into the
 * array so both paths behave. Anything that is genuinely malformed (a plain
 * string, a non-array JSON value) is left untouched so the real validation
 * error still surfaces.
 * @module unit-tests/batch-coerce-test
 */

import { addFilePath, labeledSubsection } from 'juggler/ui';
import { assert } from '../../../js-tests/utilities/test-helpers.js';
import BatchContextItem from '../context-items/batch-context-item.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => (void | Promise<void>)} fn
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

  // validate()/getStatusUI()/_coerceArray() use no instance state; the base
  // ContextItem constructor only requires these fields to be truthy.
  const item = new BatchContextItem({
    id: 'test-batch',
    session: /** @type {import('../../../js/model/session.js').default} */ ({}),
    conversation: /** @type {import('../../../js/model/conversation.js').default} */ ({}),
    messageThread: /** @type {import('../../../js/model/message-thread.js').MessageThread} */ ({})
  });

  /** @type {import('../../../js/services/action-executor.js').ActionStatus} */
  const pending = { actionId: 'batch', pending: true, success: false, error: '' };

  const stringifiedSearches = JSON.stringify([
    { pattern: 'window/control', glob: 'cmd/juggler/server/*.go', output_mode: 'content' },
    { pattern: 'instance.json|Addr|port', glob: 'cmd/juggler/core/*.go', output_mode: 'content' }
  ]);

  await run('_coerceArray parses a JSON-string-of-an-array', () => {
    const out = BatchContextItem.__coerceArrayForTests(stringifiedSearches);
    if (!Array.isArray(out)) throw new Error(`expected an array, got ${JSON.stringify(out)}`);
    assert(out.length === 2,
      `expected 2-element array, got ${JSON.stringify(out)}`);
    assert(out[0]?.pattern === 'window/control',
      `expected first pattern preserved, got ${out[0]?.pattern}`);
  });

  await run('_coerceArray passes a real array through unchanged', () => {
    const arr = [{ pattern: 'x' }];
    assert(BatchContextItem.__coerceArrayForTests(arr) === arr, 'array identity should be preserved');
  });

  await run('_coerceArray leaves a non-JSON string untouched', () => {
    assert(BatchContextItem.__coerceArrayForTests('not json') === 'not json',
      'unparseable string should be returned as-is');
  });

  await run('_coerceArray leaves a JSON non-array untouched', () => {
    // `{"pattern":"x"}` parses but isn't an array — return original so the
    // caller's array check still reports the real shape error.
    const obj = '{"pattern":"x"}';
    assert(BatchContextItem.__coerceArrayForTests(obj) === obj,
      'JSON object string should not be unwrapped to an object');
  });

  await run('validate accepts a stringified searches array (batch_grep)', async () => {
    const result = await item.validate({ searches: stringifiedSearches });
    assert(result.valid === true, `expected valid, got error: ${result.error}`);
    assert(result.params?._batchType === 'grep', `expected grep, got ${result.params?._batchType}`);
    assert(Array.isArray(result.params?.searches) && result.params.searches.length === 2,
      'validated searches must be a 2-element array');
  });

  await run('validate accepts a stringified files array (batch_read)', async () => {
    const files = JSON.stringify([{ file_path: '/a.txt' }, { file_path: '/b.txt' }]);
    const result = await item.validate({ files });
    assert(result.valid === true, `expected valid, got error: ${result.error}`);
    assert(result.params?._batchType === 'read', `expected read, got ${result.params?._batchType}`);
    assert(Array.isArray(result.params?.files) && result.params.files.length === 2,
      'validated files must be a 2-element array');
  });

  await run('validate still rejects a genuinely empty array', async () => {
    const result = await item.validate({ searches: '[]' });
    assert(result.valid === false, 'empty array must remain invalid');
    assert(result.error === 'searches must be a non-empty array',
      `expected non-empty-array error, got ${result.error}`);
  });

  await run('validate still rejects a malformed (non-array) searches string', async () => {
    const result = await item.validate({ searches: 'totally bogus' });
    assert(result.valid === false, 'malformed searches must remain invalid');
    assert(result.error === 'searches must be a non-empty array',
      `expected non-empty-array error, got ${result.error}`);
  });

  await run('getStatusUI counts coerced searches, not string length', () => {
    const ui = item.getStatusUI(pending, { searches: stringifiedSearches });
    if (!ui) throw new Error('expected a status UI for a pending call');
    assert(ui.typeName === 'BatchGrep', `expected BatchGrep, got ${ui?.typeName}`);
    assert(ui.summary === '2 searches...', `expected "2 searches...", got "${ui?.summary}"`);
  });

  await run('getStatusUI counts coerced files, not string length', () => {
    const files = JSON.stringify([{ file_path: '/a.txt' }, { file_path: '/b.txt' }]);
    const ui = item.getStatusUI(pending, { files });
    if (!ui) throw new Error('expected a status UI for a pending call');
    assert(ui.typeName === 'BatchRead', `expected BatchRead, got ${ui?.typeName}`);
    assert(ui.summary === '2 files...', `expected "2 files...", got "${ui?.summary}"`);
  });

  /**
   * A render context carrying only what the batch details view reads: no tool
   * action (so no outcomes), no session, and just the two helpers it calls.
   * @param {string} toolName - 'batch_grep' or 'batch_read'
   * @param {Record<string, unknown>} input - Tool input
   * @returns {import('juggler/context-item').ToolActionRenderContext} Partial render context
   */
  const renderCtx = (toolName, input) => /** @type {import('juggler/context-item').ToolActionRenderContext} */ ({
    toolName,
    input,
    helpers: /** @type {import('juggler/context-item').ToolActionRenderHelpers} */ ({ labeledSubsection, addFilePath })
  });

  // The properties-panel render path must coerce too — otherwise a stringified
  // `searches` is iterated character-by-character, emitting one list entry per
  // character (the "huge list of empty boxes" bug).

  /**
   * Render the details view for a batch call and read back what it produced:
   * the subsection heading and the entries of its numbered list.
   * @param {string} toolName - 'batch_grep' or 'batch_read'
   * @param {Record<string, unknown>} input - Tool input, exactly as the model emitted it
   * @returns {{heading: string, entries: string[]}} Heading text and list entries
   */
  const renderDetails = (toolName, input) => {
    const wrapper = document.createElement('div');
    item.renderToolActionDetails(wrapper, renderCtx(toolName, input));
    // Searches are a markdown list; files are the shared file-path rows.
    const entrySelector = toolName === 'batch_read' ? '.properties-panel-filepath-row' : '.markdown li';
    return {
      heading: wrapper.querySelector('.properties-panel-subtitle')?.textContent ?? '',
      entries: Array.from(wrapper.querySelectorAll(entrySelector)).map((li) => li.textContent.trim())
    };
  };

  await run('renderToolActionDetails coerces a stringified searches array', () => {
    const { heading, entries } = renderDetails('batch_grep', { searches: stringifiedSearches });
    assert(heading === 'Searches (2)', `expected a "Searches (2)" heading, got "${heading}"`);
    assert(entries.length === 2, `expected 2 listed searches, got ${entries.length}`);
    assert((entries[0] ?? '').includes('window/control'),
      `expected the first pattern listed, got "${entries[0]}"`);
  });

  await run('renderToolActionDetails coerces a stringified files array', () => {
    const files = JSON.stringify([{ file_path: '/a.txt' }, { file_path: '/b.txt' }]);
    const { heading, entries } = renderDetails('batch_read', { files });
    assert(heading === 'Files (2)', `expected a "Files (2)" heading, got "${heading}"`);
    assert(entries.length === 2, `expected 2 listed files, got ${entries.length}`);
    assert((entries[1] ?? '').includes('/b.txt'), `expected the second path listed, got "${entries[1]}"`);
  });

  // Each file is the shared path row, so it carries the same controls and
  // right-click menu as a path anywhere else, rather than plain text.
  await run('renderToolActionDetails shows each file as a file-path row with actions', () => {
    const wrapper = document.createElement('div');
    const input = { files: [{ file_path: '/a.txt' }, { file_path: '/b.txt', offset: 10, limit: 5 }] };
    item.renderToolActionDetails(wrapper, renderCtx('batch_read', input));
    const paths = Array.from(wrapper.querySelectorAll('.properties-panel-filepath'))
      .map((el) => /** @type {HTMLElement} */ (el).dataset.filePath);
    assert(paths.join(',') === '/a.txt,/b.txt', `expected both paths as file-path rows, got "${paths.join(',')}"`);
    const actionRows = wrapper.querySelectorAll('.properties-panel-filepath-row .properties-panel-filepath-actions');
    assert(actionRows.length === 2, `expected file actions on both rows, got ${actionRows.length}`);
    const infos = Array.from(wrapper.querySelectorAll('.properties-panel-filepath-info')).map((el) => el.textContent);
    assert(infos.length === 1 && infos[0] === 'lines 10–14',
      `expected only the ranged read annotated "lines 10–14", got ${JSON.stringify(infos)}`);
  });

  return { passed, failed, errors };
}
