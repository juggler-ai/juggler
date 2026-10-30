//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * ShellOutputContextItem tests — the record of a command the user ran from the
 * composer (`! cmd` / `/shell cmd`).
 *
 * Backend-free: what the model reads for each way a run can end (exit 0,
 * non-zero, stopped, refused, spilled), what the tile shows, and that under
 * en-XA the UI text is translated while the model's text stays English.
 * @module unit-tests/shell-output-test
 */

import ShellOutputContextItem from '../context-items/shell-output-context-item.js';
import { initializeRegistries, assert } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for this plugin, standing in for its catalogue. */
const CORE_TEXT = [
  'Shell', 'Command', 'Output', 'No output', 'Stopped before it finished', 'Didn\'t run to completion',
  'Exit code {code}', 'Ran: {command}', 'Middle dropped — the complete output is in {file}'
];

/** The panel elements whose text is the run's own data, not UI text. */
const DATA = '.properties-panel-code, .properties-panel-result:not(.empty)';

/**
 * An item built from a finished run.
 * @param {Record<string, unknown>} params - The run, as `/shell` hands it over
 * @returns {Promise<ShellOutputContextItem>} The item
 */
async function itemFor(params) {
  const item = new ShellOutputContextItem(/** @type {any} */ (
    { id: 'SHELL_test', session: {}, conversation: {}, messageThread: {} }));
  await item.onToolCall('shell-output', params);
  return item;
}

/**
 * Run the shell-output test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await test('the model reads who ran it, the command, the output and the exit code', async () => {
    const item = await itemFor({ command: 'gh search repos --help', output: 'Search for repositories\n', exitCode: 0 });
    const text = await item.createContextText();
    assert(/user ran this shell command themselves/.test(text), `must say the user ran it:\n${text}`);
    assert(text.includes('$ gh search repos --help'), `missing the command line:\n${text}`);
    assert(text.includes('Search for repositories'), `missing the output:\n${text}`);
    assert(text.includes('exit code: 0'), `missing the exit code:\n${text}`);
  });

  await test('a non-zero exit is reported, and empty output says so', async () => {
    const item = await itemFor({ command: 'false', output: '', exitCode: 1 });
    const text = await item.createContextText();
    assert(text.includes('(no output)'), `empty output must be named:\n${text}`);
    assert(text.includes('exit code: 1'), `missing exit code 1:\n${text}`);
    const ui = /** @type {any} */ (item.getStatusUI());
    assert(ui.status === 'error', `non-zero exit is an error tile, got ${ui.status}`);
  });

  await test('a stopped run keeps its partial output and says it was stopped', async () => {
    const item = await itemFor({ command: 'npm test', output: 'partial\n', exitCode: null, cancelled: true });
    const text = await item.createContextText();
    assert(text.includes('partial'), `partial output lost:\n${text}`);
    assert(/stopped the command before it finished/.test(text), `must say it was stopped:\n${text}`);
    assert(!text.includes('exit code'), `a stopped run has no exit code:\n${text}`);
    assert(/** @type {any} */ (item.getStatusUI()).status === 'cancelled', 'stopped run is a cancelled tile');
  });

  await test('a run that never completed carries the server\'s reason', async () => {
    const item = await itemFor({ command: 'mkfs /dev/sda', output: '', exitCode: -1, error: 'Command blocked: mkfs' });
    const text = await item.createContextText();
    assert(text.includes('did not run to completion: Command blocked: mkfs'), `reason lost:\n${text}`);
    assert(!text.includes('exit code'), `an incomplete run reports its reason, not an exit code:\n${text}`);
  });

  await test('a spilled run names the file with the complete output', async () => {
    const item = await itemFor({
      command: 'cat big.log', output: 'head\n…\ntail\n', exitCode: 0,
      truncated: true, outputFile: '/p/.juggler/out/SHELL.txt'
    });
    const text = await item.createContextText();
    assert(text.includes('/p/.juggler/out/SHELL.txt'), `spill file not named:\n${text}`);
  });

  await test('the tile shows the command, and the exit code only when it is not 0', async () => {
    const ok = await itemFor({ command: 'echo hi', output: 'hi\n', exitCode: 0 });
    const okUI = /** @type {any} */ (ok.getStatusUI());
    assert(okUI.status === 'success', `exit 0 is a success tile, got ${okUI.status}`);
    const okSummary = /** @type {HTMLElement} */ (okUI.summary);
    assert(okSummary.textContent?.includes('echo hi'), `tile lost the command: ${okSummary.textContent}`);
    assert(!/exit code/i.test(okSummary.textContent || ''), `exit 0 needs no subtitle: ${okSummary.textContent}`);
    assert(okSummary.querySelector('[data-file-refs]') !== null, 'the command line should link the paths in it');

    const bad = await itemFor({ command: 'make lint', output: '', exitCode: 2 });
    const badSummary = /** @type {HTMLElement} */ (/** @type {any} */ (bad.getStatusUI()).summary);
    assert(badSummary.textContent?.includes('Exit code 2'), `tile lost the exit code: ${badSummary.textContent}`);
  });

  await test('onToolCall rejects a missing command', async () => {
    let threw = false;
    try {
      await itemFor({ output: 'x' });
    } catch {
      threw = true;
    }
    assert(threw, 'onToolCall must throw without a command');
  });

  await test('under en-XA the item\'s own words are translated and the model\'s text stays English', async () => {
    await underPseudoLocale('shell-output-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      const ok = await itemFor({ command: '1', output: '', exitCode: 0 });
      shown['type name'] = String(/** @type {any} */ (ok.getStatusUI()).typeName);
      shown['brief summary'] = ok.getBriefSummary();
      shownStrings(ok.createPropertiesPanelElement(), DATA).forEach((s, i) => { shown[`panel ${i}`] = s; });
      const failing = await itemFor({ command: '5', output: '', exitCode: 6 });
      const subtitle = /** @type {HTMLElement} */ (/** @type {any} */ (failing.getStatusUI()).summary)
        .querySelector('.summary-with-subtitle-sub');
      shown['tile subtitle'] = String(subtitle?.textContent);
      const stopped = await itemFor({ command: '2', output: '3', cancelled: true, truncated: true, outputFile: '4' });
      shownStrings(stopped.createPropertiesPanelElement(), DATA).forEach((s, i) => { shown[`stopped panel ${i}`] = s; });
      const refused = await itemFor({ command: '7', output: '', error: '8' });
      shownStrings(refused.createPropertiesPanelElement(), DATA).forEach((s, i) => { shown[`refused panel ${i}`] = s; });

      const text = await ok.createContextText();
      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      assert(raw.length === 0 && text.includes('exit code: 0') && text.includes('user ran'),
        `plain English under en-XA: ${JSON.stringify(raw)}; model text: ${JSON.stringify(text)}`);
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
