//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests: the fixed properties-panel labels, result-section labels and
 * shown `unknown` fallbacks of juggler-core plugins, under en-XA.
 *
 * `addSubsection` and its siblings show a label as given, so each caller must
 * pass translated text. Inputs are digits, so they read as data.
 * @module unit-tests/subsection-labels-test
 */

import { underPseudoLocale, summaryText } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import '../../../js/components/file-view.js';
import BatchContextItem from '../context-items/batch-context-item.js';
import GlobContextItem from '../context-items/glob-context-item.js';
import QueryCodeContextItem from '../context-items/query-code-context-item.js';
import RunCodeContextItem from '../context-items/run-code-context-item.js';
import ReadFileContextItem from '../context-items/read-file-context-item.js';
import ReplaceTextContextItem from '../context-items/replace-text-context-item.js';
import SearchContextItem from '../context-items/search-context-item.js';
import TaskOutputContextItem from '../context-items/task-output-context-item.js';
import TaskStopContextItem from '../context-items/task-stop-context-item.js';
import WebFetchContextItem from '../context-items/web-fetch-context-item.js';
import WebSearchContextItem from '../context-items/web-search-context-item.js';
import WriteFileContextItem from '../context-items/write-file-context-item.js';
import NewConversationContextItem from '../context-items/new-conversation-context-item.js';
import ExploreAgentContextItem from '../context-items/explore-agent-context-item.js';

/** juggler-core's English for these labels, standing in for its catalogue. */
const CORE_TEXT = [
  'URL', 'Prompt', 'Query', 'Pattern', 'Searched in', 'Path', 'Code', 'Description', 'Tool calls',
  '…{count} more not shown', 'Task', 'Thoroughness', 'Name', 'Untitled conversation', 'Autostart',
  'On — the new conversation started working on the prompt immediately.',
  'Off — the prompt is parked in the new conversation, waiting for the user to press Send.',
  '{count, plural, =1 {Search} other {Searches ({count})}}', '{count, plural, =1 {File} other {Files ({count})}}',
  'Content', 'Results', 'Matches', 'Output', 'Result', 'unknown', '{count, plural, one {{count} line} other {{count} lines}}', 'No file',
  'Fetching {url}...', '{count, plural, one {{count} file matching {pattern}} other {{count} files matching {pattern}}}',
  'cancelled: {file}', '{prefix}: {error}', 'Searching for "{query}"...',
];

/**
 * Whether `s` shows nothing but pseudo-localised messages, data digits and
 * punctuation: every `[…]` segment is pseudo-localised and no ASCII letter
 * stands outside one. A row may keep punctuation (`...`, quotes) outside its
 * message, which `isPseudoLocalized` alone would reject.
 * @param {string} s
 * @returns {boolean} True when nothing shown is plain English.
 */
function localized(s) {
  if (isPseudoLocalized(s)) return true;
  const segments = s.match(/\[[^\]]*\]/g) || [];
  return segments.length > 0 && segments.every(isPseudoLocalized) && !/[A-Za-z]/.test(s.replace(/\[[^\]]*\]/g, ''));
}

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
  /**
   * @param {any} Cls
   * @returns {any} A plugin instance on stub session/conversation/thread.
   */
  const make = (Cls) => new Cls({ id: 'x', session, conversation: { id: 'c', session }, messageThread });

  try {
    await underPseudoLocale('subsection-labels-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      let plugin = '';
      let n = 0;
      const label = (/** @type {string} */ l) => { shown[`${plugin} label ${n++}`] = String(l); };
      const helpers = {
        addSubsection: (/** @type {any} */ _w, /** @type {string} */ l, /** @type {string} */ value) => {
          label(l);
          shown[`${plugin} value ${n}`] = String(value).split('\n').pop() || '';
        },
        addLlmDescription: (/** @type {any} */ _w, /** @type {string} */ l) => label(l),
        labeledSubsection: (/** @type {string} */ l) => { label(l); return document.createElement('div'); },
        addFilePath: () => {},
      };
      /**
       * Draw one plugin's panel and record what it labels.
       * @param {string} name
       * @param {any} item
       * @param {any} ctx
       * @param {number} expected - Labels it must draw
       * @param {string[]} [dataValues] - Value keys that are data, dropped after
       */
      const panel = (name, item, ctx, expected, dataValues = []) => {
        plugin = name;
        n = 0;
        const before = Object.keys(shown).length;
        item.renderToolActionDetails(document.createElement('div'), { helpers, session, messageThread, toolAction: null, ...ctx });
        for (const v of dataValues) delete shown[`${name} value ${v}`];
        const labels = Object.keys(shown).filter((k) => k.startsWith(`${name} label`)).length;
        if (labels !== expected) throw new Error(`${name}: expected ${expected} labels, got ${labels} (${Object.keys(shown).length - before} recorded)`);
      };
      /** Value keys are 1-based positions; these hold data, so they are dropped. */
      const all = ['1', '2', '3', '4', '5'];

      panel('web fetch', make(WebFetchContextItem), { input: { url: '1', prompt: '2' } }, 2, all);
      panel('web search', make(WebSearchContextItem), { input: { query: '3' } }, 1, all);
      panel('search with path', make(SearchContextItem), { input: { pattern: '4', path: '/5' } }, 2, all);
      panel('search allowed roots', make(SearchContextItem), { input: { pattern: '4' } }, 2, all);
      panel('glob', make(GlobContextItem), { input: { pattern: '4', path: '/5' } }, 2, all);
      panel('query code', make(QueryCodeContextItem), { input: { code: '6', description: '7' } }, 2, all);
      const display = { nestedCalls: [{ name: '8', status: 'ok', args: {} }], omitted: 2 };
      panel('run code', make(RunCodeContextItem), {
        input: { code: '6' }, toolAction: { get: (/** @type {string} */ k) => (k === 'displayData' ? display : undefined) },
      }, 2, ['1']);
      panel('task output', make(TaskOutputContextItem), { input: { task_id: '8' } }, 1, all);
      panel('task stop', make(TaskStopContextItem), { input: { task_id: '8' } }, 1, all);
      panel('explore', make(ExploreAgentContextItem), { input: { task: '9', thoroughness: '9' } }, 2, all);
      panel('new conversation on', make(NewConversationContextItem), { input: { message: '1' } }, 3, ['2']);
      panel('new conversation off', make(NewConversationContextItem), { input: { message: '1', autostart: false } }, 3, ['2']);
      const batch = make(BatchContextItem);
      for (const [toolName, input] of /** @type {Array<[string, any]>} */ ([
        ['batch_grep', { searches: [{ pattern: '4' }] }], ['batch_grep', { searches: [{ pattern: '4' }, { pattern: '5' }] }],
        ['batch_read', { files: [{ file_path: '/1' }] }], ['batch_read', { files: [{ file_path: '/1' }, { file_path: '/2' }] }],
      ])) {
        panel(`${toolName} ${Object.values(input)[0].length}`, batch, { toolName, input }, 1);
      }

      // Result-section labels.
      for (const [name, Cls, tool] of /** @type {Array<[string, any, string]>} */ ([
        ['web fetch', WebFetchContextItem, ''], ['web search', WebSearchContextItem, ''], ['search', SearchContextItem, ''],
        ['glob', GlobContextItem, ''], ['query code', QueryCodeContextItem, ''], ['read file', ReadFileContextItem, ''],
        ['task output', TaskOutputContextItem, ''], ['batch grep', BatchContextItem, 'batch_grep'],
        ['batch read', BatchContextItem, 'batch_read'], ['batch other', BatchContextItem, '1'],
      ])) {
        shown[`${name} result label`] = Cls.getResultSectionLabel(tool);
      }

      // Rows drawn with no input show the `unknown` fallback.
      const pending = { pending: true };
      /**
       * @param {string} name
       * @param {any} ui
       */
      const row = (name, ui) => { shown[`${name} row`] = summaryText(ui?.summary); };
      row('web fetch pending', make(WebFetchContextItem).getStatusUI(pending, {}));
      row('web fetch done', make(WebFetchContextItem).getStatusUI({ success: true, result: {} }, {}));
      row('search pending', make(SearchContextItem).getStatusUI(pending, {}));
      row('search done', make(SearchContextItem).getStatusUI({ success: true }, {}));
      row('glob pending', make(GlobContextItem).getStatusUI(pending, {}));
      row('glob done', make(GlobContextItem).getStatusUI({ success: true, result: { count: 1 } }, {}));
      row('write file pending', make(WriteFileContextItem).getStatusUI(pending, {}));
      row('replace text pending', make(ReplaceTextContextItem).getStatusUI(pending, {}));
      row('replace text cancelled', make(ReplaceTextContextItem).getStatusUI({ cancelled: true }, {}));
      row('read file pending', make(ReadFileContextItem).getStatusUI(pending, {}));
      row('web search pending', make(WebSearchContextItem).getStatusUI(pending, {}));

      // read-file's own panel: no path, and a size and line count.
      const reader = make(ReadFileContextItem);
      reader.data = { path: '', size: 5, totalLines: 3, exists: true, content: '1\n2\n3', lineOffset: 1, lineCount: 3 };
      const el = reader.createPropertiesPanelElement();
      shown['read file no path'] = String(el.querySelector('.properties-panel-filepath')?.textContent);
      shown['read file lines'] = String(el.querySelector('.properties-panel-filepath-info')?.textContent).split(' | ').pop() || '';

      const raw = Object.entries(shown).filter(([, s]) => !localized(s));
      if (raw.length) throw new Error(`plain English under en-XA: ${JSON.stringify(Object.fromEntries(raw))}`);
    }, { '@juggler/core': CORE_TEXT });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`);
  }

  return { passed, failed, errors };
}
