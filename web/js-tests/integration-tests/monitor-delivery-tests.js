//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration tests: Monitor tool output delivery (turn-boundary, auto-wake).
 *
 * The Monitor tool starts a background command and binds its output to the
 * conversation via the generic `deliverTaskOutput` pendingRequests kind. The
 * worker's delivery pump polls the task and injects each new stdout line into
 * the conversation as a turn-boundary message — auto-waking the (idle)
 * conversation so a fresh turn reacts. Events arrive on their own schedule;
 * they are not replies from the user.
 *
 * This test drives the whole path end-to-end against a REAL background process:
 * the LLM calls Monitor with `echo MON_OUT_7F3`; the worker runs it, the pump captures
 * the output line and injects it; the idle conversation auto-wakes and the next
 * turn runs. We fence on that state with `settleUntil` (re-evaluated on each doc
 * change — no fixed sleep) and then assert the injected message + the wake turn.
 * @module integration-tests/monitor-delivery-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

/**
 * Does the root thread contain a user message carrying the monitored output?
 * @param {any} conversation - The conversation under test.
 * @returns {number} Index of the injected message, or -1.
 */
function injectedOutputIndex(conversation) {
  const items = conversation.rootMessageThread.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it.get !== 'function') continue;
    if (it.get('type') !== 'user') continue;
    const content = it.get('content');
    if (typeof content === 'string' && content.includes('MON_OUT_7F3')) return i;
  }
  return -1;
}

/**
 * Monitor a command that prints one line and exits; the line must surface as an
 * injected message and the idle conversation must auto-wake to react to it.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const monitorOutputDeliveredAndAutoWakesTest = {
  name: 'monitor-output-delivered-and-auto-wakes',
  description: 'Monitor output surfaces as a turn-boundary message that auto-wakes the conversation',
  fixture: 'unit-test-fixture',

  // 1 Monitor tool-use, then ample text turns: one after the tool returns, plus
  // the auto-wake turns the injected line + terminal note each drive. Leftover
  // responses are harmless (the mock only errors when a turn finds none).
  llmResponses: [
    toolUseResponse('call_1', 'Monitor', { command: 'echo MON_OUT_7F3', description: 'say hello' }, 'Starting the monitor.'),
    textResponse('Monitor is running.'),
    textResponse('Reacting to a monitor event.'),
    textResponse('Reacting to another monitor event.'),
    textResponse('Nothing more to do.'),
    textResponse('Idle.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'begin monitoring' }
  ],

  // Deterministic fence (polled on every doc change, no sleep): wait until the
  // monitored "HELLO" line has been injected AND a later assistant turn ran —
  // i.e. the auto-wake fired.
  settleUntil: (conversation) => {
    const idx = injectedOutputIndex(conversation);
    if (idx < 0) return false;
    const items = conversation.rootMessageThread.items;
    for (let i = idx + 1; i < items.length; i++) {
      if (items[i]?.get?.('type') === 'assistant') return true;
    }
    return false;
  },

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;

    const monitorAction = items.find(it => it?.get?.('type') === 'tool-action' && it.get('toolName') === 'Monitor');
    if (!monitorAction) throw new Error('Monitor tool-action is missing');

    const idx = injectedOutputIndex(conversation);
    if (idx < 0) throw new Error('monitored output (MON_OUT_7F3) was never injected into the conversation');

    const content = items[idx].get('content');
    if (!content.includes('monitor')) {
      throw new Error(`injected message should carry the monitor label, got: ${JSON.stringify(content)}`);
    }

    const woke = items.slice(idx + 1).some(it => it?.get?.('type') === 'assistant');
    if (!woke) throw new Error('the conversation did not auto-wake to react to the monitor event');
  }
};

// Export all tests
export const tests = [
  monitorOutputDeliveredAndAutoWakesTest
];
