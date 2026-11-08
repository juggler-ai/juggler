//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Message Type Guard Tests
 *
 * Verifies the message type guards whose answer is not a bare type comparison
 * (provider state, which is history but never rendered) or whose answer the
 * renderer depends on for messages that have an itemId (as assigned by
 * _insertEventAt).
 *
 * Key invariant: isErrorMessage must identify error messages regardless of itemId,
 * so they never fall through to a "context item" default branch.
 * @module unit-tests/message-type-guard-test
 */

import {
  isProviderStateMessage,
  isConversationalItemType,
  isErrorMessage,
  createUserMessage,
  createErrorMessage,
  MESSAGE_TYPES
} from '../../sdk/lib/message.js';

import { assert } from '../utilities/test-helpers.js';
import { positionElements } from '../../js/components/conversation-area-rendering.js';
import { dispatchItemRenderer } from '../../js/services/renderers/item-renderers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run message type guard tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => void} fn
   */
  function test(name, fn) {
    try {
      fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  // Create messages of every type, each with an itemId (simulating _insertEventAt)
  const userMsg = { ...createUserMessage('hello'), itemId: 'MSG_1' };
  const thinkingMsg = /** @type {any} */ ({ type: MESSAGE_TYPES.THINKING, content: 'hmm', itemId: 'MSG_3' });
  const providerStateMsg = /** @type {any} */ ({ type: MESSAGE_TYPES.PROVIDER_STATE, providerData: { secret: 'opaque' }, itemId: 'MSG_PROVIDER' });
  const errorMsg = { ...createErrorMessage({ message: 'something broke' }), itemId: 'MSG_5' };
  // A plugin marker (context item) — has itemId but no toolUseId and unknown type
  const pluginMarker = /** @type {any} */ ({ type: 'memory', itemId: 'MEM_1' });

  test('isProviderStateMessage identifies durable hidden provider state', () => {
    assert(isProviderStateMessage(providerStateMsg), 'should be true for provider-state message');
    assert(!isProviderStateMessage(thinkingMsg), 'should be false for thinking message');
    assert(isConversationalItemType(MESSAGE_TYPES.PROVIDER_STATE), 'provider-state should be conversation history');
  });

  test('provider-state is hidden from conversation and properties rendering', () => {
    const hidden = {
      get: (key) => providerStateMsg[key],
      toJSON: () => providerStateMsg,
    };
    const messageList = document.createElement('div');
    const footer = document.createElement('div');
    messageList.appendChild(footer);
    positionElements({}, messageList, footer, [hidden], new Map());
    assert(messageList.children.length === 1 && messageList.firstElementChild === footer,
      'provider-state should create no conversation element');

    const properties = document.createElement('div');
    dispatchItemRenderer(/** @type {any} */ ({}), properties, hidden);
    assert(properties.childElementCount === 0 && !properties.textContent?.includes('opaque'),
      'provider-state properties should expose nothing');
  });

  test('isErrorMessage identifies error messages with itemId — NOT treated as plugin markers', () => {
    assert(isErrorMessage(errorMsg), 'should be true for error message');
    assert(!isErrorMessage(userMsg), 'should be false for user message');
    assert(!isErrorMessage(pluginMarker), 'should be false for plugin marker');
  });

  return { passed, failed, errors };
}
