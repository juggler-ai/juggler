//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Agent run tests for what a run reports and where it stops: one progress line
 * per tool call, saying what it does; `maxTurns`; the cap on runs going at
 * once; and a strategy's refusals, which go back to the model rather than
 * ending the run. The rest of `runAgent` is `run-agent-test`'s.
 * @module unit-tests/run-agent-limits-test
 */

import { stat } from '../../js/services/ops-api.js';
import { assert } from '../utilities/test-helpers.js';
import { MODEL, uniqueName, textReply, toolReply, run, runAgentRunSuite } from '../utilities/agent-run-harness.js';

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<import('../utilities/agent-run-harness.js').TestResult>} Test results
 */
export function runTests(_ctx) {
  return runAgentRunSuite('run-agent-limits-test', async ({ test, script }) => {
    await test('each tool call is one progress line saying what it does', async () => {
      const name = uniqueName('progress');
      await script(name, [
        toolReply([
          { id: 'call_p1', name: 'read', input: { file_path: 'README.md' } },
          { id: 'call_p2', name: 'glob', input: { pattern: '**/*.json' } }
        ], 'Looking.'),
        textReply('looked')
      ]);
      /** @type {Array<{toolUseId: string, toolName: string, summary: string}>} */
      const lines = [];
      const result = await run({ prompt: 'look', model: MODEL, name, onProgress: (p) => { lines.push(p); } });
      console.warn('[run-agent-limits-test] progress lines:', JSON.stringify(lines));
      assert(result.status === 'completed', `status was ${result.status} (${result.errorText})`);
      assert(lines.length === 2, `expected 2 progress lines, got ${lines.length}: ${JSON.stringify(lines)}`);
      assert(new Set(lines.map((l) => l.toolUseId)).size === 2, `the lines repeated a call: ${JSON.stringify(lines)}`);
      assert(lines.map((l) => l.toolName).sort().join(',') === 'glob,read', `tool names were ${JSON.stringify(lines.map((l) => l.toolName))}`);
      const read = lines.find((l) => l.toolName === 'read');
      const glob = lines.find((l) => l.toolName === 'glob');
      assert(!!read && read.summary.includes('README.md'), `the read line was ${JSON.stringify(read?.summary)}`);
      assert(!!glob && glob.summary.includes('**/*.json'), `the glob line was ${JSON.stringify(glob?.summary)}`);
      assert(result.turns === 2, `turns was ${result.turns}`);
    });

    await test('a run that needs more model responses than maxTurns fails as max-turns', async () => {
      const name = uniqueName('max turns');
      await script(name, [
        toolReply([{ id: 'call_m1', name: 'glob', input: { pattern: '*.md' } }]),
        toolReply([{ id: 'call_m2', name: 'glob', input: { pattern: '*.txt' } }]),
        textReply('too late')
      ]);
      const result = await run({ prompt: 'keep going', model: MODEL, name, maxTurns: 1 });
      assert(result.status === 'failed', `status was ${result.status}`);
      assert(result.errorKind === 'max-turns', `errorKind was ${JSON.stringify(result.errorKind)} (${result.errorText})`);
      assert(result.text !== 'too late', 'the run carried on past its limit');
    });

    await test('a fifth run while four are going is refused as busy', async () => {
      const held = [0, 1, 2, 3].map((i) => uniqueName(`held ${i}`));
      for (const name of held) await script(name, [textReply('held', { pause: true })]);
      const controllers = held.map(() => new AbortController());
      const running = held.map((name, i) => run({ prompt: 'hold', model: MODEL, name }, controllers[i]?.signal));
      try {
        const fifth = await run({ prompt: 'one too many', model: MODEL, name: uniqueName('fifth') });
        assert(fifth.status === 'failed', `the fifth run's status was ${fifth.status}`);
        assert(fifth.errorKind === 'busy', `the fifth run's errorKind was ${JSON.stringify(fifth.errorKind)} (${fifth.errorText})`);
      } finally {
        for (const c of controllers) c.abort();
      }
      const ended = await Promise.all(running);
      assert(ended.every((r) => r.status === 'cancelled'), `the held runs ended ${JSON.stringify(ended.map((r) => `${r.status} ${r.errorText}`))}`);
    });

    await test('the commit-message strategy refuses git push and the run still completes', async () => {
      const name = uniqueName('commit message');
      const marker = `agent-run-refused-${uniqueName('marker').split(' ').slice(-2).join('-')}`;
      await script(name, [
        toolReply([{ id: 'call_push', name: 'bash', input: { command: `git push; touch ${marker}`, description: 'Push' } }]),
        textReply('Added a thing')
      ]);
      const lines = /** @type {string[]} */ ([]);
      const result = await run({
        prompt: 'Write a commit message',
        strategy: 'subagent-commit-message',
        model: MODEL,
        name,
        onProgress: (p) => lines.push(p.summary)
      });
      assert(result.status === 'completed', `status was ${result.status} (${result.errorText})`);
      assert(result.text === 'Added a thing', `text was ${JSON.stringify(result.text)}`);
      // The model was asked again, so the refused call went back to it as a
      // tool result rather than parking the run.
      assert(result.turns === 2, `turns was ${result.turns}`);
      assert(lines.length === 1, `expected one progress line, got ${JSON.stringify(lines)}`);
      const trace = await stat({ path: marker });
      assert(!trace.exists, 'the refused command ran');
    });
  });
}
