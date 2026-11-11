//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests: what a File Content item shows the user, under en-XA.
 *
 * The row and its type name, the title and brief summary, the add-file picker,
 * and the properties panel in each state — empty, loading, failed, a mention or
 * seeded file waiting for its snapshot, a snapshot the file has moved on from —
 * are UI text, so each is translated. The `<file>` text the model reads and the
 * error a bad tool call returns stay English. Paths are digits, so they read as
 * data inside a message. Every read is stubbed on the item, so nothing touches
 * the disk.
 * @module unit-tests/file-content-test
 */

import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import FileContentContextItem from '../context-items/file-content-context-item.js';

/** juggler-core's English for this plugin, standing in for its catalogue. */
const CORE_TEXT = [
  'File Content', 'Folder', 'No file', 'No file selected', 'Empty file content',
  'Directory listing: {path}', 'Loading…', 'Failed to load: {path}',
  'Add File Content', 'File path…', 'Add',
  'Added at the start of this conversation. It is frozen as it stands when the first message is sent.',
  'Mentioned in a message. It is frozen as it stands when that message is sent.',
  "Added at the start of this conversation and frozen when it began, so editing the file doesn't make the conversation read it again. Below is the frozen copy the conversation reads.",
  "Mentioned in a message and frozen when it was sent, so editing the file doesn't make the conversation read it again. Below is the frozen copy the conversation reads.",
  'The file has changed since. Updating re-reads the conversation once.',
  'Update', 'Update the frozen copy of this file',
  // lib/live-file.js draws the body of a missing file.
  'File not found: {path}',
];

/** The two kinds of frozen item: an `@`-mention and a seeded agents file. */
/** @type {Array<[string, Record<string, boolean>]>} */
const FROZEN_KINDS = [['mention', { frozen: true }], ['seeded', { seeded: true }]];

/**
 * @param {Record<string, any>} data - Item data
 * @returns {any} An item over `data`, with no conversation behind it
 */
function makeItem(data) {
  const session = { platform: 'darwin', home: '/1', projectPath: '/2' };
  const item = new FileContentContextItem(/** @type {any} */ ({
    id: 'f', session, conversation: { id: 'c', session },
    messageThread: { getAllowedPaths: () => ['/2'], getRulesFor: () => [], items: [] },
  }));
  Object.assign(item.data, data);
  return item;
}

/** Let promise callbacks queued by the code under test run. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * @param {Element|null|undefined} el - An element
 * @returns {string} Its trimmed text
 */
const text = (el) => (el?.textContent || '').trim();

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /** @type {HTMLElement[]} */
  const mounted = [];
  try {
    await underPseudoLocale('file-content-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};

      // Rows, title and brief summary.
      const empty = makeItem({});
      const emptyRow = /** @type {any} */ (empty.getStatusUI());
      shown['row type name, empty'] = emptyRow.typeName;
      shown['row, empty'] = emptyRow.summary;
      shown['title, empty'] = empty.getTitle();
      shown['brief summary, empty'] = empty.getBriefSummary();
      shown['row type name, file'] = /** @type {any} */ (makeItem({ path: '/7/7' }).getStatusUI()).typeName;
      const folder = makeItem({ path: '/7/', isDirectory: true });
      shown['row type name, folder'] = /** @type {any} */ (folder.getStatusUI()).typeName;
      shown['brief summary, folder'] = folder.getBriefSummary();

      // The empty panel.
      const emptyPanel = empty.createPropertiesPanelElement();
      shown['panel path, empty'] = text(emptyPanel.querySelector('.properties-panel-filepath'));
      shown['panel, empty'] = text(emptyPanel.querySelector('.file-content-loading'));

      // A live panel: loading, then a missing file.
      const live = makeItem({ path: '/7/7' });
      /** @type {(r: any) => void} */
      let land = () => {};
      live._fetchLive = () => new Promise(resolve => { land = resolve; });
      const livePanel = live.createPropertiesPanelElement();
      shown['panel, loading'] = text(livePanel.querySelector('.file-content-loading'));
      land({ path: '/7/7', isDirectory: false, exists: false, content: '' });
      await settle();
      shown['panel, missing'] = text(livePanel.querySelector('.file-content-body'));

      // A live panel whose read fails outright.
      const failing = makeItem({ path: '/7/7' });
      failing._fetchLive = () => Promise.reject(new Error('7'));
      const originalError = console.error;
      console.error = () => {};
      /** @type {HTMLElement|undefined} */
      let failingPanel;
      try {
        failingPanel = failing.createPropertiesPanelElement();
        await settle();
      } finally {
        console.error = originalError;
      }
      shown['panel, failed'] = text(failingPanel?.querySelector('.file-content-not-found'));

      // A mention and a seeded file, each before its snapshot is taken.
      for (const [name, data] of FROZEN_KINDS) {
        const waiting = makeItem({ path: '/7/7', ...data });
        waiting._fetchLive = async () => ({ path: '/7/7', isDirectory: false, exists: false, content: '' });
        const panel = waiting.createPropertiesPanelElement();
        await settle();
        shown[`note, ${name} waiting`] = text(panel.querySelector('.file-content-seeded-line'));
      }

      // A mention and a seeded file whose snapshot the file has moved on from.
      for (const [name, data] of FROZEN_KINDS) {
        const stale = makeItem({ path: '/7/7', content: '7', ...data });
        stale._renderLive = async () => '8';
        const panel = stale.createPropertiesPanelElement();
        document.body.appendChild(panel);
        mounted.push(panel);
        await settle();
        shown[`note, ${name} frozen`] = text(panel.querySelector('.file-content-seeded-line'));
        shown[`note, ${name} changed`] = text(panel.querySelector('.file-content-seeded-changed'));
        const update = panel.querySelector('.file-content-seeded-update');
        shown[`update, ${name}`] = text(update);
        shown[`update label, ${name}`] = update?.getAttribute('aria-label') || '';
      }

      // The add-file picker. `localTree: false` keeps it off the OS chooser.
      const asked = FileContentContextItem.showAddDialog({ localTree: false });
      const overlay = document.querySelector('.project-picker-overlay');
      shown['picker title'] = text(overlay?.querySelector('.project-picker-title'));
      shown['picker placeholder'] = overlay?.querySelector('path-input')?.getAttribute('placeholder') || '';
      shown['picker confirm'] = text(overlay?.querySelector('.project-picker-btn-open'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      if ((await asked) !== null) throw new Error('the cancelled picker chose a file');

      const raw = Object.entries(shown).filter(([, s]) => !s || !isPseudoLocalized(s));
      if (raw.length) throw new Error(`plain English under en-XA: ${JSON.stringify(Object.fromEntries(raw))}`);

      // What the model reads is unchanged English under any UI language.
      const missing = makeItem({ path: '/7/7' });
      missing._fetchLive = async () => ({ path: '/7/7', isDirectory: false, exists: false, content: '' });
      const context = await missing.createContextText();
      if (context !== 'File does not exist: /7/7') throw new Error(`the model's text changed: ${JSON.stringify(context)}`);
      const thrown = await makeItem({}).onToolCall('file-content', {}).then(() => '', (/** @type {any} */ e) => e.message);
      if (thrown !== 'Missing required parameter: path') throw new Error(`the tool error changed: ${JSON.stringify(thrown)}`);
    }, { '@juggler/core': CORE_TEXT });
    passed++;
  } catch (/** @type {any} */ e) {
    failed++;
    errors.push(`en-XA: ${e?.message ?? String(e)}`);
  } finally {
    for (const el of mounted) el.remove();
  }

  try {
    // An item with no file names no file: the header carries no path for the
    // context menu to offer Open or Copy on.
    const empty = makeItem({});
    const panel = empty.createPropertiesPanelElement();
    const named = panel.querySelector('[data-file-path]');
    if (named) throw new Error(`an empty item names a file: ${JSON.stringify(named.getAttribute('data-file-path'))}`);
    if (!text(panel.querySelector('.properties-panel-filepath'))) throw new Error('the empty item shows no placeholder');
    passed++;
  } catch (/** @type {any} */ e) {
    failed++;
    errors.push(`no file: ${e?.message ?? String(e)}`);
  }

  return { passed, failed, errors };
}
