//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Agent run tests: `runAgent` end to end, against the real server and engine.
 *
 * A run is a conversation nobody sees, carried out by the engine, kept by the
 * server and answered to this realm. What a caller cannot check for itself is
 * guarded here: that each run hears its own answer and nobody else's, that a
 * cancel ends it and leaves nothing behind, and that the session's list and
 * order never learn of it. Its progress lines and its limits are
 * `run-agent-limits-test`'s, so neither suite outgrows one test's time on a
 * slow core.
 * @module unit-tests/run-agent-test
 */

import apiService from '../../js/services/api.js';
import { apiUrl } from '../../js/utils/api-url.js';
import { assert } from '../utilities/test-helpers.js';
import { MODEL, uniqueName, textReply, toolReply, run, runAgentRunSuite } from '../utilities/agent-run-harness.js';

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<import('../utilities/agent-run-harness.js').TestResult>} Test results
 */
export function runTests(_ctx) {
  return runAgentRunSuite('run-agent-test', async ({ test, script, session }) => {
    await test('a run returns its answer', async () => {
      const name = uniqueName('answer');
      await script(name, [textReply('The answer is 42.')]);
      const result = await run({ prompt: 'What is the answer?', model: MODEL, name });
      assert(result.status === 'completed', `status was ${result.status} (${result.errorText})`);
      assert(result.text === 'The answer is 42.', `text was ${JSON.stringify(result.text)}`);
      assert(result.turns === 1, `turns was ${result.turns}`);
      assert(!!result.conversationId, 'the result named no conversation');
    });

    await test('two concurrent runs each hear their own answer', async () => {
      const first = uniqueName('first');
      const second = uniqueName('second');
      await script(first, [textReply('first answer')]);
      await script(second, [textReply('second answer')]);
      const [a, b] = await Promise.all([
        run({ prompt: 'one', model: MODEL, name: first }),
        run({ prompt: 'two', model: MODEL, name: second })
      ]);
      assert(a.status === 'completed' && b.status === 'completed', `statuses were ${a.status} (${a.errorText}), ${b.status} (${b.errorText})`);
      assert(a.text === 'first answer', `the first run heard ${JSON.stringify(a.text)}`);
      assert(b.text === 'second answer', `the second run heard ${JSON.stringify(b.text)}`);
      assert(a.conversationId !== b.conversationId, 'two runs shared a conversation');
    });

    await test('a run cancelled mid-turn ends cancelled and leaves no conversation behind', async () => {
      const name = uniqueName('cancel');
      await script(name, [
        toolReply([{ id: 'call_read', name: 'read', input: { file_path: 'README.md' } }]),
        textReply('never delivered', { pause: true })
      ]);
      const controller = new AbortController();
      const result = await run({
        prompt: 'read and wait',
        model: MODEL,
        name,
        onProgress: () => controller.abort()
      }, controller.signal);
      assert(controller.signal.aborted, `the run ended ${result.status} (${result.errorText}) before it was cancelled`);
      assert(result.status === 'cancelled', `status was ${result.status} (${result.errorText})`);
      assert(!!result.conversationId, 'the result named no conversation');
      const response = await fetch(apiUrl(`/session/conversations/${encodeURIComponent(result.conversationId)}`));
      assert(response.status === 404, `the run's conversation answered ${response.status} after the run ended`);
    });

    await test('the session list and order never learn of a run', async () => {
      const name = uniqueName('invisible');
      await script(name, [
        toolReply([{ id: 'call_glob', name: 'glob', input: { pattern: '*.md' } }]),
        textReply('done looking')
      ]);
      /** @type {Promise<any>|null} */
      let during = null;
      const result = await run({
        prompt: 'look around',
        model: MODEL,
        name,
        onProgress: () => { during ??= apiService.getSession(); }
      });
      assert(result.status === 'completed', `status was ${result.status} (${result.errorText})`);
      assert(during !== null, 'the run reported no tool call to look during');
      const mid = /** @type {any} */ (await during);
      const names = Object.values(mid.conversationNames || {});
      assert(!names.includes(name), 'the session listed the run\'s conversation while it ran');
      assert(!(mid.conversationOrder || []).includes(result.conversationId), 'the run\'s conversation was in the order while it ran');
      const after = /** @type {any} */ (await apiService.getSession());
      assert(!(after.conversationOrder || []).includes(result.conversationId), 'the run\'s conversation is in the order');
      assert(!Object.keys(after.conversationNames || {}).includes(result.conversationId), 'the run\'s conversation is in the names');
      assert(!session.conversations.has(result.conversationId), 'this realm\'s session holds the run\'s conversation');
    });
  });
}
