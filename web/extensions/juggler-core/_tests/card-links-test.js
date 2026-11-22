//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests: the file links in card status rows (lib/card-links.js).
 *
 * What a glance at a card cannot tell: which file a link opens. A relative path
 * must resolve against the conversation's workspace, not the project, or the
 * link opens a different file of the same name; and a link must survive being
 * put inside a translated message.
 * @module unit-tests/card-links-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { cardFile } from '../lib/card-links.js';
import ReadFileContextItem from '../context-items/read-file-context-item.js';
import FileContentContextItem from '../context-items/file-content-context-item.js';

/** juggler-core's English for these rows, standing in for its catalogue. */
const CORE_TEXT = ['Read', 'unknown', '{filename} (lines {start}-{end} of {total})', 'File Content'];

/**
 * @param {unknown} summary - A row's summary.
 * @returns {Element[]} The file links in it.
 */
const linksIn = (summary) => (summary instanceof HTMLElement
  ? [summary, ...summary.querySelectorAll('*')].filter((el) => el.hasAttribute('data-file-path'))
  : []);

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const session = { platform: 'darwin', home: '/1', projectPath: '/2' };
  /**
   * @param {any} Cls
   * @param {Record<string, unknown>} [conversation] - Extra conversation fields
   * @param {Record<string, unknown>} [on] - The session
   * @returns {any} An item on a stub session and conversation.
   */
  const make = (Cls, conversation = {}, on = session) => new Cls({
    id: 'x', session: on, conversation: { id: 'c', session: on, ...conversation },
    messageThread: { getAllowedPaths: () => ['/2'], getRulesFor: () => [], items: [] },
  });

  await run('a relative path resolves against the workspace, not the project', () => {
    const item = make(ReadFileContextItem, { workspaceId: 'w', workspaceRoot: '/3/4' });
    const link = cardFile(item, '5/6.js').link();
    assert(link instanceof HTMLElement, 'expected a link');
    assert(/** @type {HTMLElement} */ (link).getAttribute('data-file-path') === '/3/4/5/6.js',
      `got ${/** @type {HTMLElement} */ (link).getAttribute('data-file-path')}`);
    assert(/** @type {HTMLElement} */ (link).textContent === '6.js', 'the link shows the name');
  });

  await run('with no workspace, a relative path resolves against the project', () => {
    const link = /** @type {HTMLElement} */ (cardFile(make(ReadFileContextItem), './5/../6.js').link());
    assert(link.getAttribute('data-file-path') === '/2/6.js', `got ${link.getAttribute('data-file-path')}`);
  });

  await run('with no root and a relative path, the name is plain text', () => {
    const item = make(ReadFileContextItem, {}, {});
    assert(cardFile(item, '5/6.js').link() === '6.js', 'expected the bare name');
    assert(cardFile(item, '').link() === '', 'no path is no link');
  });

  await run('a link survives inside a translated message', async () => {
    await underPseudoLocale('card-links-test', async () => {
      const ui = /** @type {any} */ (make(ReadFileContextItem).getStatusUI(
        { success: true, result: { lineOffset: 2, lineCount: 3, totalLines: 9 } }, { file_path: '/2/7.js' }));
      const links = linksIn(ui.summary);
      assert(links.length === 1 && links[0]?.getAttribute('data-file-path') === '/2/7.js',
        `expected one link to /2/7.js, got ${links.map((l) => l.getAttribute('data-file-path'))}`);
      assert(links[0]?.textContent === '7.js', 'the slot holds the name');
      assert(!/[\uE000\uE001]/.test(ui.summary.textContent), 'no slot marker is shown');
    }, { '@juggler/core': CORE_TEXT });
  });

  await run('a pinned file\'s card links its file', () => {
    const item = make(FileContentContextItem);
    Object.assign(item.data, { path: '/2/8.md' });
    const links = linksIn(item.getStatusUI().summary);
    assert(links.length === 1 && links[0]?.getAttribute('data-file-path') === '/2/8.md', 'expected a link to /2/8.md');
  });

  return { passed, failed, errors };
}
