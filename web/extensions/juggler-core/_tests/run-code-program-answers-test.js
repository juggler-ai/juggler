//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What answers a held call: a denial, a cancel, and a question's answer.
 * Contract item 7, with run-code-program-redecide-test, which has what does
 * not.
 *
 * One of the run_code program suites; what they share, and the contract they
 * cover between them, is in `run-code-program-helpers.js`.
 * @module _tests/run-code-program-answers-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import actionExecutor from '../../../js/services/action-executor.js';
import { runProgramSuite, ended, waitUntil } from './run-code-program-helpers.js';

/**
 * Run this suite's run_code program cases.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<import('./run-code-program-helpers.js').TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  return runProgramSuite(async ({ test, setup, rowsOf, heldCommand, assertParks, startAsAction, waitHeld, answerHeld, waitSnapshotGone, rowBrief, absent, readBack }) => {
    await test('denying the held call cancels the program, and the denial stands', async () => {
      const log = `rc-deny-held-${Date.now()}.txt`;
      const command = heldCommand(log);
      const code = `await tools.bash({ command: ${JSON.stringify(command)} }); await tools.bash({ command: "printf after >> ${log}" }); return "done";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      assert(mt.resolveApproval(id, 'no'), 'the denial is written');
      const done = await ended(finished);
      assert(done.state === 'cancelled' && done.result?.content === 'Action was cancelled.',
        `the denial is the item's result, not overwritten by the program's: ${done.state} ${JSON.stringify(done.result)}`);
      assert(await absent(log), 'neither the held call nor anything after it ran');
      await waitUntil(() => !actionExecutor.runningActionFor(id, conversation.id), 'the program to end');
      // The fence for "it stays so": the worker drops a settled program's
      // snapshot only after saving a document with the item settled
      // (sweepPrograms rides the save), so a write that overwrote the denial
      // would already be in the document by then.
      await waitSnapshotGone(item, 'the worker to drop the denied program\'s snapshot');
      const later = mt.getToolAction(id).toJSON();
      assert(later.state === 'cancelled' && later.result?.content === 'Action was cancelled.', `and it stays so: ${JSON.stringify(later.result)}`);
    });

    await test('cancelling a program while it holds a call ends it, unrun', async () => {
      const log = `rc-cancel-held-${Date.now()}.txt`;
      const command = heldCommand(log);
      const code = `await tools.bash({ command: ${JSON.stringify(command)} }); return "done";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      mt.transact(() => mt.updateToolActionState(id, 'cancelled'));
      const done = await ended(finished);
      assert(done.state === 'cancelled', `the cancel stands: ${done.state} ${JSON.stringify(done.result)}`);
      await waitUntil(() => !actionExecutor.runningActionFor(id, conversation.id), 'the program to end');
      assert(await absent(log), 'the held call never ran');
      assert(rowsOf(mt, id).every((/** @type {import('./run-code-program-helpers.js').NestedCall} */ r) => r.status !== 'ok'), `no call ran: ${rowBrief(mt, id)}`);
      await waitSnapshotGone(item, 'the worker to drop the cancelled program\'s snapshot');
    });

    await test('a question is held, and its answer is the call\'s result', async () => {
      const file = `rc-ask-${Date.now()}.txt`;
      const code = `
        await tools.bash({ command: "printf x >> ${file}" });
        const answer = await tools.AskUserQuestion({ questions: [{ question: "Which?", header: "Pick", multiSelect: false,
          options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] });
        return "answer: " + String(answer).trim();`;
      // Under YOLO: a question always reaches the user.
      const { conversation, mt, item } = await setup(code);
      const id = item.toolUseId;
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'AskUserQuestion');
      answerHeld(conversation, mt, id, 'B');
      const done = await ended(finished);
      assert(done.result?.content === 'answer: Pick: B', `the answer reaches the program: ${JSON.stringify(done.result)}`);
      const ran = await readBack(file);
      assert(String(ran.content) === 'x', `bash ran once: ${JSON.stringify(ran.content)}`);
    });
  });
}
