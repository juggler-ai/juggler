//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The snapshot a hold leaves: one that cannot be kept leaves none from an
 * earlier hold and does not stop the program waiting, one taken for another
 * call is never resumed from, and a call fired beside a running write waits
 * for it, so the write is in the snapshot first. Contract items 6-8, with
 * run-code-program-resume-test.
 *
 * One of the run_code program suites; what they share, and the contract they
 * cover between them, is in `run-code-program-helpers.js`.
 * @module _tests/run-code-program-snapshot-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { writeFile, readFile } from '../../../js/services/ops-api.js';
import { programChangeReport } from '../../../js/utils/program-changes.js';
import { runProgramSuite, ended } from './run-code-program-helpers.js';

/**
 * Run this suite's run_code program cases.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<import('./run-code-program-helpers.js').TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  return runProgramSuite(async ({ test, setup, displayOf, run, heldCommand, assertParks, runAsAction, startAsAction, waitHeld, answerHeld, loseEngine, seedHeld, snapshotOf, seedSnapshot, waitSnapshotGone, failingSaves, rowBrief, absent }) => {
    // A save that fails at the second hold must not leave the first hold's
    // snapshot to be resumed from: that replay would ask about the first call
    // again, and make again everything that ran since.
    await test('a snapshot that cannot be kept at a later hold leaves none from an earlier one', async () => {
      const dir = `rc-failsave-${Date.now()}`;
      await writeFile({ path: `${dir}/seed.txt`, content: '' });
      const [first, second] = [1, 2].map((n) => heldCommand(`${dir}/log${n}.txt`));
      const code = `
        await tools.bash({ command: ${JSON.stringify(first)} });
        await tools.bash({ command: "printf x >> ${dir}/between.txt" });
        await tools.bash({ command: ${JSON.stringify(second)} });
        return "done";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, first);
      await failingSaves((n) => n === 2, 500, async () => {
        const finished = startAsAction(conversation, mt, id);
        await waitHeld(mt, id, 'bash');
        assert((await snapshotOf(item))?.held?.input?.command === first, 'the first hold has its snapshot');
        answerHeld(conversation, mt, id, 'yes');
        await waitHeld(mt, id, 'bash', (t) => t.heldCall.input.command === second);
        await waitSnapshotGone(item, 'the first hold\'s snapshot to go with the second\'s failed save');
        await loseEngine(conversation, id, finished);
      });
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(done.result?.isError && String(done.result?.content).includes("Couldn't resume the program"),
        `it cannot resume, and says so: ${JSON.stringify(done.result)}`);
      for (const f of ['log1', 'between']) {
        const ran = await readFile({ path: `${dir}/${f}.txt` });
        assert(String(ran.content) === 'x', `${f} ran once, not again: ${JSON.stringify(ran.content)}`);
      }
      assert(await absent(`${dir}/log2.txt`), 'the call it held never ran');
    });

    // The item names the call it holds, and a snapshot names the call it was
    // taken for; one kept for another call is from another hold.
    await test('a snapshot taken for another call is not resumed from', async () => {
      const file = `rc-mismatch-${Date.now()}.txt`;
      const code = `return await tools.bash({ command: "printf x > ${file}; printf ran" });`;
      const { mt, item } = await setup(code);
      const held = { name: 'bash', input: { command: `printf x > ${file}; printf ran` } };
      await seedSnapshot(item, {
        held: { name: 'bash', input: { command: 'printf other' } },
        heldStep: 0,
        journal: [{ key: 'tools.bash', args: JSON.stringify([held.input]), ok: false, pending: true }]
      });
      seedHeld(mt, item.toolUseId, held);
      const { out, text } = await run(item, code);
      assert(out?.success === false && text.includes("Couldn't resume the program"), `it does not resume: ${text}`);
      assert(await absent(file), 'and nothing runs');
      assert(!(await snapshotOf(item)), 'the stray snapshot is dropped');
    });

    await test('a program whose snapshot cannot be kept still waits, and finishes once answered', async () => {
      const log = `rc-nosave-${Date.now()}.txt`;
      const command = heldCommand(log);
      const code = `return String(await tools.bash({ command: ${JSON.stringify(command)} })).trim();`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const done = await failingSaves(() => true, 413, async () => {
        const finished = startAsAction(conversation, mt, id);
        await waitHeld(mt, id, 'bash');
        assert(!(await snapshotOf(item)), 'no snapshot was kept');
        answerHeld(conversation, mt, id, 'yes');
        return ended(finished);
      });
      assert(done.state === 'completed' && done.result?.content === 'ran', `it finishes: ${JSON.stringify(done.result)}`);
      assert(String((await readFile({ path: log })).content) === 'x', 'the call ran once');
    });

    // Nothing starts past a write still running — not even a read, as a
    // question is — so a call that waits on the user never waits beside a
    // write half-done: the write has finished, and is in the snapshot, first.
    await test('a call fired beside a running write waits for it before it is held', async () => {
      const file = `rc-alongside-${Date.now()}.txt`;
      const code = `
        const [, answer] = await Promise.all([
          tools.bash({ command: "printf start >> ${file}; sleep 1; printf end >> ${file}" }),
          tools.AskUserQuestion({ questions: [{ question: "Which?", header: "Pick", multiSelect: false,
            options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] }),
        ]);
        return "answer: " + String(answer).trim();`;
      // Under YOLO the bash runs unasked and the question always reaches the user.
      const { conversation, mt, item } = await setup(code);
      const id = item.toolUseId;
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'AskUserQuestion');
      const stopped = await readFile({ path: file });
      assert(String(stopped.content) === 'startend', `the write finished before the question was put: ${JSON.stringify(stopped.content)}`);
      const before = rowBrief(mt, id);
      assert(before === 'bash:ok,AskUserQuestion:held', `its row is kept as it ended: ${before}`);
      const kept = await snapshotOf(item);
      const journal = /** @type {any[]} */ (kept?.journal ?? []);
      assert(journal[0]?.key === 'tools.bash' && journal[0]?.ok && journal[1]?.pending && kept.heldStep === 1,
        `the write is in the snapshot, answered: ${JSON.stringify(kept)}`);
      answerHeld(conversation, mt, id, 'B');
      const done = await ended(finished);
      assert(done.result?.content === 'answer: Pick: B', `the program finishes: ${JSON.stringify(done.result)}`);
      const ran = await readFile({ path: file });
      assert(String(ran.content) === 'startend', `the write ran once: ${JSON.stringify(ran.content)}`);
      const report = programChangeReport(displayOf(mt, id));
      assert((report.match(/- bash: /g) || []).length === 1, `it is reported once: ${JSON.stringify(report)}`);
    });
  });
}
