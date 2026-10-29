//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests: what the Monitor tool shows the user, under en-XA.
 *
 * The approval message (with and without a description), the row's type name,
 * the properties panel's labels and the shared delivery control
 * (`sdk/lib/task-delivery-control.js`) in every status are UI text, so each is
 * translated. The model's result (`getSummary`) and validation errors stay
 * English. Commands, descriptions and task ids are digits, so they read as data
 * inside a message; the delivery label is the model's English and is skipped.
 * @module unit-tests/monitor-test
 */

import { underPseudoLocale, assertPseudoLocalized } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { renderTaskDeliveryControl } from '../../../sdk/lib/task-delivery-control.js';
import MonitorContextItem from '../context-items/monitor-context-item.js';

/** juggler-core's English for this plugin, standing in for its catalogue. */
const CORE_TEXT = [
  'Start monitor ({description}):\n\n{command}\n\nThis runs in the background; its output streams into the conversation.',
  'Start monitor:\n\n{command}\n\nThis runs in the background; its output streams into the conversation.',
  'Monitor', 'Command', 'Description',
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
  const item = new MonitorContextItem(/** @type {any} */ ({
    id: 'm', session, conversation: { id: 'c', session }, messageThread: { items: [] },
  }));

  try {
    await underPseudoLocale('monitor-test', async () => {
      /** @type {Record<string, string>} */
      const shown = {};

      const withDescription = await item.getApprovalConfig({ command: '3', description: '4' });
      shown['approval with description'] = String(withDescription?.message);
      const bare = await item.getApprovalConfig({ command: '3' });
      shown['approval without description'] = String(bare?.message);

      const input = { command: '3', description: '4' };
      for (const [name, status] of /** @type {Array<[string, any]>} */ ([
        ['running', null], ['success', { success: true }],
        ['failed', { success: false }], ['cancelled', { cancelled: true }],
      ])) {
        shown[`type name ${name}`] = String(/** @type {any} */ (item.getStatusUI(status, input))?.typeName);
      }

      // The panel's own labels; the values beside them are data. No task id
      // yet, so the live control and output section are not drawn.
      const helpers = {
        addSubsection: (/** @type {any} */ _w, /** @type {string} */ label) => { shown[`panel ${label}`] = label; },
        addLlmDescription: (/** @type {any} */ _w, /** @type {string} */ label) => { shown[`panel ${label}`] = label; },
      };
      item.renderToolActionDetails(document.createElement('div'), /** @type {any} */ ({
        input, helpers, toolAction: null, messageThread: {},
      }));
      if (Object.keys(shown).filter((k) => k.startsWith('panel ')).length !== 2) {
        throw new Error(`expected the Command and Description labels, got ${JSON.stringify(Object.keys(shown))}`);
      }

      const raw = Object.entries(shown).filter(([, s]) => !isPseudoLocalized(s));
      if (raw.length) throw new Error(`plain English under en-XA: ${JSON.stringify(raw)}`);

      // The delivery control in every status it can show, with and without a label.
      for (const status of /** @type {Array<'active'|'ended'|'stopped'|null>} */ (['active', 'ended', 'stopped', null])) {
        const wrapper = document.createElement('div');
        renderTaskDeliveryControl(wrapper, {
          // Only the task-delivery API the control reads.
          messageThread: /** @type {import('../../../js/model/message-thread.js').MessageThread} */ (/** @type {unknown} */ ({
            getTaskDeliveryStatus: () => status,
            observePendingRequests: () => () => {},
            cancelTaskOutputDelivery: () => false,
          })),
          taskId: '5',
          label: 'monitor: 4',
        });
        assertPseudoLocalized(wrapper, { skip: '.task-delivery-label', atLeast: 3, where: `control ${status}` });
      }

      // The model's result and errors are unchanged English under any UI language.
      const summary = item.getSummary(/** @type {any} */ ({
        success: true, prepared: { params: { command: '3' } }, result: { task_id: '5' },
      }));
      if (!String(summary.summary).startsWith('Monitor started (task 5).')) {
        throw new Error(`the model's result changed: ${JSON.stringify(summary.summary)}`);
      }
      const invalid = await item.validate({});
      if (invalid.error !== 'Missing required parameter: command') {
        throw new Error(`the model's error changed: ${JSON.stringify(invalid.error)}`);
      }
    }, { '@juggler/core': CORE_TEXT });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`en-XA: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
