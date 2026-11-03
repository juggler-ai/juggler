//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Continue Button
 *
 * Regression test: clicking the Continue button should trigger a new LLM
 * turn (no user message inserted). This broke silently when the worker's
 * send-message handler dropped empty-text messages that were not flagged
 * as isContinuation.
 * @module integration-tests/continue-btn-tests
 */

import { textResponse } from '../utilities/integration-test-runner.js';
import { tabFor } from '../utilities/conversation-tab-lookup.js';

/**
 * Clicking the Continue button after the LLM has responded should trigger
 * a new LLM turn and produce a second assistant message with no user
 * message in between.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const continueBtnTriggersLLM = {
  name: 'continue-btn-triggers-llm',
  description: 'Continue button sends isContinuation=true and produces a second assistant message',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('First response.'),
    textResponse('Continued response.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'continue' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'First response.' },
      { type: 'assistant', content: 'Continued response.' }
    ]
  }
};

/**
 * A /thread the user opens and never sends anything into is not work in
 * flight, so it must not take the root column's Continue away. The root has
 * come to rest on the assistant's reply; the empty thread holds no run to wait
 * for.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const continueBtnVisibleBesideEmptyThread = {
  name: 'continue-btn-visible-beside-empty-thread',
  description: 'An untouched /thread leaves the root column idle with Continue visible',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi there.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Side question' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi there.' },
      { type: 'thread', itemId: '$ITEM_4' }
    ]
  },

  customAssertions(conversation) {
    if (conversation.rootMessageThread.hasBusyItems()) {
      throw new Error('root hasBusyItems() is true with only an untouched /thread beside a settled turn — Continue is withheld');
    }
    const tab = tabFor(conversation);
    if (!tab) return; // Non-UI mode — the model assertion above is the test
    const rootCol = tab.querySelector('conversation-area:not(.thread-column)');
    if (!rootCol) throw new Error('No root conversation-area in the tab');
    const idle = rootCol.querySelector('footer-idle');
    if (!idle || idle.classList.contains('hidden')) {
      throw new Error('Root footer is not idle after the turn settled');
    }
    const continueBtn = rootCol.querySelector('.continue-btn');
    if (!continueBtn) throw new Error('No .continue-btn in the root column');
    if (continueBtn.classList.contains('hidden')) {
      throw new Error('Root .continue-btn is hidden beside an untouched /thread');
    }
  }
};

// Export all tests
export const tests = [
  continueBtnTriggersLLM,
  continueBtnVisibleBesideEmptyThread
];
