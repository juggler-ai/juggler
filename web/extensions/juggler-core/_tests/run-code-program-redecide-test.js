//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What is no answer to a held call: a strategy switch, an approval given on
 * the program's own card, and an approval of the call the user was shown
 * when a different call is made in its place. Each puts the call to the
 * decision again rather than running it. Contract item 7, with
 * run-code-program-answers-test.
 *
 * One of the run_code program suites; what they share, and the contract they
 * cover between them, is in `run-code-program-helpers.js`.
 * @module _tests/run-code-program-redecide-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import YoloStrategyType from '../strategies/yolo-strategy-type.js';
import { runProgramSuite, ended } from './run-code-program-helpers.js';

/**
 * Run this suite's run_code program cases.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<import('./run-code-program-helpers.js').TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  return runProgramSuite(async ({ test, setup, rowsOf, heldCommand, assertParks, runAsAction, startAsAction, waitHeld, answerHeld, loseEngine, snapshotOf, absent, readBack }) => {
    // The worker resets a parked item to "" when its thread's strategy
    // changes, clearing its card, and the new strategy then approves the item
    // itself. That is no answer to the held call, which is decided again
    // under the new strategy.
    await test('a strategy switch re-decides the held call', async () => {
      const log = `rc-switch-${Date.now()}.txt`;
      const command = heldCommand(log);
      const code = `await tools.bash({ command: ${JSON.stringify(command)} }); return "done";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      mt.strategy = { getApprovalPolicy: YoloStrategyType.prototype.getApprovalPolicy };
      const ymap = mt.getToolAction(id);
      answerHeld(conversation, mt, id, undefined, {
        first: () => {
          ymap.set('state', '');
          for (const field of ['approvalResponse', 'approvalOptions', 'displayData', 'hooks']) ymap.delete(field);
        }
      });
      const done = await ended(finished);
      assert(done.state === 'completed' && done.result?.content === 'done', `it runs under the new strategy: ${JSON.stringify(done.result)}`);
      const ran = await readBack(log);
      assert(String(ran.content) === 'x', `once: ${JSON.stringify(ran.content)}`);
    });

    // The item reset and parked on its own account asks about the program,
    // not the held call: approving it is no answer to that call, which is put
    // to the decision again — and here waits on the user again.
    await test('an approval of the program itself never passes to the held call', async () => {
      const log = `rc-own-card-${Date.now()}.txt`;
      const command = heldCommand(log);
      const code = `await tools.bash({ command: ${JSON.stringify(command)} }); return "done";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      const ymap = mt.getToolAction(id);
      mt.transact(() => {
        for (const field of ['approvalResponse', 'approvalOptions', 'displayData', 'hooks']) ymap.delete(field);
        ymap.set('approvalOptions', { options: [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }] });
      });
      answerHeld(conversation, mt, id, 'yes');
      const again = await waitHeld(mt, id, 'bash', (/** @type {import('./run-code-program-helpers.js').HeldToolAction} */ t) => t.approvalOptions?.held === true);
      assert(again.heldCall.input.command === command, `the same call waits again: ${JSON.stringify(again.heldCall)}`);
      assert(await absent(log), 'it did not run on the program\'s approval');
      assert(mt.resolveApproval(id, 'no'), 'the denial is written');
      const done = await ended(finished);
      assert(done.state === 'cancelled', `denied, it ends: ${done.state}`);
      assert(await absent(log), 'and never ran');
    });

    // The user approves the call they were shown. A program resuming after
    // its engine was lost that makes another call at that step — here a
    // command built from Math.random — must not be handed the approval: it
    // diverges, and neither command runs.
    await test('an approval never passes to a different call made in the held one\'s place', async () => {
      const dir = `rc-transfer-${Date.now()}`;
      const log = `${dir}/log.txt`;
      const prefix = `sh -c 'printf x >> ${log}'; printf `;
      const code = `await tools.bash({ command: ${JSON.stringify(prefix)} + Math.random() }); return "ran";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, `${prefix}0.5`);
      const finished = startAsAction(conversation, mt, id);
      const parked = await waitHeld(mt, id, 'bash');
      const shown = parked.heldCall?.input?.command;
      assert(String(shown).startsWith(prefix), `held on the command: ${JSON.stringify(parked.heldCall)}`);
      await loseEngine(conversation, id, finished);
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      const text = String(done.result?.content);
      assert(done.result?.isError, `the replay must fail: ${JSON.stringify(done.result)}`);
      assert(text.includes("Couldn't resume the program") && text.includes('step 1') && text.includes(String(shown).slice(prefix.length)),
        `it says the call differed from the one approved: ${text}`);
      assert(await absent(log), 'neither command ran');
      assert(rowsOf(mt, id).every((/** @type {import('./run-code-program-helpers.js').NestedCall} */ r) => r.status !== 'ok'), `no call ran: ${JSON.stringify(rowsOf(mt, id))}`);
      assert(!(await snapshotOf(item)) && !done.heldCall, 'the program is over: no snapshot, no held call');
    });
  });
}
