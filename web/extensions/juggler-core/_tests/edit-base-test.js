//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests: what the edit tools' shared base and the Replace tool show the
 * user, under en-XA.
 *
 * The out-of-project approval warning, every "don't ask again" label the base
 * offers, the Replace row in each state with its type name, and the Replace
 * details panel are UI text, so each is translated. The model's result
 * (`getSummary`) stays English. Paths are digits, so they read as data inside
 * a message.
 * @module unit-tests/edit-base-test
 */

import { underPseudoLocale, assertPseudoLocalized } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { addSubsection } from '../../../js/utils/properties-panel-helpers.js';
import ReplaceTextContextItem from '../context-items/replace-text-context-item.js';

/** juggler-core's English for these plugins, standing in for its catalogue. */
const CORE_TEXT = [
  '⚠ Write outside the project folder: {path}',
  'file edits', 'file edits + allow {folder}', 'file edits (writes outside the project still prompt)',
  // Context-keyed messages, as messageKey() writes them.
  'tool name\u0004Replace', 'replacement text label\u0004Replace', 'cancelled: {file}', 'failed in {file}', 'failed',
  'Search', 'Edit failed',
];

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const session = { platform: 'darwin', home: '/1', projectPath: '/2' };
  const messageThread = { getAllowedPaths: () => ['/2'], getRulesFor: () => [], items: [] };
  const item = new ReplaceTextContextItem(/** @type {any} */ ({
    id: 'r', session, conversation: { id: 'c', session }, messageThread,
  }));

  try {
    await underPseudoLocale('edit-base-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};

      const approval = /** @type {any} */ (item)._buildApprovalConfig('/3/4/5', { oldContent: '6', newContent: '7' });
      shown['approval, outside the project'] = String(approval?.message);

      // In the project with the toggle off, outside it with a grantable folder
      // (two tiers), and with no path at all.
      /** @type {Array<[string, Record<string, unknown>, number]>} */
      const asks = [['inside', { path: '/2/6' }, 1], ['outside', { path: '/3/4/5' }, 2], ['no path', {}, 1]];
      for (const [name, input, count] of asks) {
        const suggestions = item.getApprovalSuggestions(input);
        if (suggestions.length !== count) throw new Error(`${name}: expected ${count} suggestions, got ${suggestions.length}`);
        suggestions.forEach((s, i) => { shown[`suggestion ${name} ${i}`] = String(s.label); });
      }

      const input = { file_path: '/2/6', old_string: '8', new_string: '9' };
      /** @type {Array<[string, any, Record<string, unknown>]>} */
      const states = [
        ['cancelled', { success: false, cancelled: true }, input],
        ['failed', { success: false, result: { path: '/2/6' } }, input],
        ['failed, no path', { success: false }, {}],
      ];
      for (const [name, status, toolInput] of states) {
        const ui = /** @type {any} */ (item.getStatusUI(status, toolInput));
        shown[`row ${name}`] = String(ui?.summary);
        shown[`type name ${name}`] = String(ui?.typeName);
      }

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      if (raw.length) throw new Error(`plain English under en-XA: ${JSON.stringify(raw)}`);

      // The details panel: the failed edit (search, replacement, the fallback
      // error) and the one with no diff to show (search and replacement).
      for (const [name, result] of [['failed', { isError: true, fullResult: {} }], ['no diff', { isError: false }]]) {
        const wrapper = document.createElement('div');
        item.renderToolActionDetails(wrapper, /** @type {any} */ ({
          toolAction: { get: (/** @type {string} */ k) => (k === 'result' ? result : undefined) },
          input,
          session,
          helpers: { addFilePath: () => {}, addSubsection, addDiffViewer: () => false },
        }));
        assertPseudoLocalized(wrapper, { skip: '.properties-panel-code', atLeast: 2, where: `panel ${name}` });
      }

      // The model's result is unchanged English under any UI language.
      const summary = item.getSummary(/** @type {any} */ ({ success: true, result: { path: '/2/6', method: 'edit' } }));
      if (summary.summary !== 'Edited file: /2/6') throw new Error(`the model's result changed: ${JSON.stringify(summary.summary)}`);
    }, { '@juggler/core': CORE_TEXT });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Storing a diff's sides is an optimisation: when the store refuses them (here
  // the server knows no conversation 'c'), the diff keeps both sides inline and
  // the edit goes on.
  try {
    const diff = await /** @type {any} */ (item)._storeDiffSnapshot('/2/6', 'a\n', 'b\n');
    if (diff.oldContent !== 'a\n' || diff.newContent !== 'b\n' || 'oldRef' in diff || 'newRef' in diff) {
      throw new Error(`a failed upload should keep the sides inline, got ${JSON.stringify(diff)}`);
    }
    passed++;
  } catch (e) {
    failed++;
    errors.push(`diff upload fallback: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
