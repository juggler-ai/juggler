//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Auto-namer pure-helper tests. These pin the three decisions that gate an
 * auto-name so the feature can never (a) overwrite a user's own tab title, (b)
 * fire on a conversation with no opening exchange, or (c) hand the rename API a
 * name that violates the length cap.
 * @module unit-tests/auto-namer
 */

import { assert } from '../utilities/test-helpers.js';
import {
  isAutoConversationName,
  extractFirstExchange,
  cleanClientName
} from '../../js/services/auto-namer.js';
import { MAX_CONVERSATION_NAME_LENGTH } from '../../js/utils/constants.js';

/**
 * Minimal Yjs-item stand-in: a `.get(key)` map, matching what
 * MessageThread.getMessages() yields.
 * @param {Record<string, any>} fields
 * @returns {{ get: (k: string) => any }} A Yjs-item stand-in with a `.get` accessor
 */
function item(fields) {
  return { get: (k) => fields[k] };
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Count of assertions that passed.
 * @property {number} failed - Count of assertions that failed.
 * @property {string[]} errors - Messages from failed assertions.
 */

/**
 * Run all auto-namer helper tests.
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  const errors = [];
  const check = (name, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  };

  // ── isAutoConversationName ──────────────────────────────────────────────
  check('recognises the "Task N" placeholder as auto-named', () => {
    assert(isAutoConversationName('Task 1'), 'Task 1 should be auto');
    assert(isAutoConversationName('Task 42'), 'Task 42 should be auto');
    assert(isAutoConversationName('Untitled'), 'Untitled should be auto');
  });

  check('treats a user-typed title as NOT auto-named (never overwritten)', () => {
    assert(!isAutoConversationName('Fix the parser'), 'custom title is not auto');
    assert(!isAutoConversationName('Task'), 'bare "Task" is not the placeholder');
    assert(!isAutoConversationName('Task 1 revisited'), 'suffixed placeholder is not auto');
    assert(!isAutoConversationName('My Task 3'), 'prefixed placeholder is not auto');
    assert(!isAutoConversationName(''), 'empty is not auto');
    assert(!isAutoConversationName(/** @type {any} */ (null)), 'null is not auto');
  });

  // ── extractFirstExchange ───────────────────────────────────────────────
  check('extracts first user prompt and first assistant reply in order', () => {
    const thread = {
      getMessages: () => [
        item({ type: 'user', content: 'Help me fix the YAML parser' }),
        item({ type: 'assistant', content: 'Sure — here is the fix.' }),
        item({ type: 'assistant', content: 'A second reply we ignore.' })
      ]
    };
    const { prompt, response } = extractFirstExchange(thread);
    assert(prompt === 'Help me fix the YAML parser', `prompt was ${JSON.stringify(prompt)}`);
    assert(response === 'Sure — here is the fix.', `response was ${JSON.stringify(response)}`);
  });

  check('skips non-string content and yields empty response when no assistant reply', () => {
    const thread = {
      getMessages: () => [
        item({ type: 'context-item', content: { not: 'a string' } }),
        item({ type: 'user', content: 'Just a question' })
      ]
    };
    const { prompt, response } = extractFirstExchange(thread);
    assert(prompt === 'Just a question', `prompt was ${JSON.stringify(prompt)}`);
    assert(response === '', `response should be empty, was ${JSON.stringify(response)}`);
  });

  check('returns empty prompt for an empty / missing thread', () => {
    assert(extractFirstExchange(null).prompt === '', 'null thread → empty prompt');
    assert(extractFirstExchange({ getMessages: () => [] }).prompt === '', 'no messages → empty prompt');
  });

  // ── cleanClientName ────────────────────────────────────────────────────
  check('collapses whitespace and strips surrounding quotes', () => {
    assert(cleanClientName('  Refactor   Auth  ') === 'Refactor Auth', 'whitespace collapse');
    assert(cleanClientName('"Fix Login Bug"') === 'Fix Login Bug', 'double quotes stripped');
    assert(cleanClientName("'Fix Login Bug'") === 'Fix Login Bug', 'single quotes stripped');
    assert(cleanClientName('`Add Retry`') === 'Add Retry', 'backticks stripped');
  });

  check('truncates to the shared UI length cap so the rename is never rejected', () => {
    const long = 'x'.repeat(MAX_CONVERSATION_NAME_LENGTH + 40);
    const out = cleanClientName(long);
    assert(out.length === MAX_CONVERSATION_NAME_LENGTH,
      `expected length ${MAX_CONVERSATION_NAME_LENGTH}, got ${out.length}`);
  });

  check('handles non-string / empty input safely', () => {
    assert(cleanClientName(/** @type {any} */ (undefined)) === '', 'undefined → empty');
    assert(cleanClientName('') === '', 'empty → empty');
  });

  return { passed, failed, errors };
}
