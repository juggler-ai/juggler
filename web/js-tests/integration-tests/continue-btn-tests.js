//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE█▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

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

// Export all tests
export const tests = [
  continueBtnTriggersLLM
];
