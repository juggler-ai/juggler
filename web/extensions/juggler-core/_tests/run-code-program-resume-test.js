//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A program whose engine is lost while it waits resumes from the snapshot
 * its hold left, or fails and runs nothing; and calls fired together are held
 * in turn. Contract items 6-8, with run-code-program-snapshot-test.
 *
 * One of the run_code program suites; what they share, and the contract they
 * cover between them, is in `run-code-program-helpers.js`.
 * @module _tests/run-code-program-resume-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { writeFile, readFile, loadProgramSnapshot } from '../../../js/services/ops-api.js';
import { dropSnapshot } from '../context-items/run-code-context-item.js';
import { programChangeReport } from '../../../js/utils/program-changes.js';
import { runProgramSuite, ended } from './run-code-program-helpers.js';

/**
 * Run this suite's run_code program cases.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<import('./run-code-program-helpers.js').TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  return runProgramSuite(async ({ test, setup, displayOf, heldCommand, assertParks, runAsAction, startAsAction, waitHeld, answerHeld, loseEngine, snapshotOf, rowBrief, absent }) => {
    // A real run's snapshot, not one written by hand: concurrent reads and
    // searches, edits, then a call that waits. (Calls whose follow-ups depend
    // on which of them answered first may resume in another order, and then
    // diverge: program-journal-replay-helpers holds that to never making a change
    // twice.) Every call before the hold
    // is in it, answered, and the held call is pending at the step the
    // snapshot names; the edits ran once, before the hold, and are answered
    // from the snapshot after the engine is lost.
    await test('a real run with concurrent calls leaves a snapshot it resumes from after the engine is lost', async () => {
      const dir = `rc-real-${Date.now()}`;
      const names = ['a', 'b', 'c'];
      for (const [i, n] of names.entries()) await writeFile({ path: `${dir}/${n}.txt`, content: `hello ${i}\n` });
      const log = `${dir}/log.txt`;
      const command = heldCommand(log);
      const code = `
        const files = ${JSON.stringify(names.map((n) => `${dir}/${n}.txt`))};
        const texts = await Promise.all(files.map((f) => fs.readFile(f)));
        const [hits, listed] = await Promise.all([grep("hello", { cwd: "${dir}" }), glob("*.txt", { cwd: "${dir}" })]);
        await Promise.all(files.map((f) => fs.readFile(f)));
        for (const f of files) await tools.edit({ file_path: f, old_string: "hello", new_string: "there" });
        const r = await tools.bash({ command: ${JSON.stringify(command)} });
        const after = await Promise.all(files.map((f) => fs.readFile(f)));
        return JSON.stringify({ texts, hits: hits.length, listed: listed.length, r: String(r).trim(), after });`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      // Kept beside the conversation, not in the engine: the engine is what
      // is lost.
      const kept = /** @type {any} */ (await loadProgramSnapshot(conversation.id, id));
      assert(kept?.held?.name === 'bash' && kept.held.input?.command === command,
        `the snapshot is on disk, naming the held call: ${JSON.stringify(kept?.held)}`);
      const journal = /** @type {any[]} */ (kept.journal);
      const keys = Array.from(journal, (e) => e?.key ?? '<gap>');
      assert(JSON.stringify(keys.slice(0, 3)) === JSON.stringify(['fs.readFile', 'fs.readFile', 'fs.readFile'])
        && keys.at(-1) === 'tools.bash' && keys.length === 12 && !keys.includes('<gap>'),
      `every call before the hold is in the snapshot, the held one last: ${JSON.stringify(keys)}`);
      assert(journal.slice(0, -1).every((e) => !e.pending) && journal.at(-1).pending && kept.heldStep === 11,
        `every call before it answered, the held call pending at the step named: ${JSON.stringify(journal.map((e) => [e.key, e.pending]))} ${kept.heldStep}`);
      for (const n of names) {
        const now = await readFile({ path: `${dir}/${n}.txt` });
        assert(String(now.content).startsWith('there'), `${n} was edited before the hold: ${now.content}`);
      }

      await loseEngine(conversation, id, finished);
      assert(mt.getToolAction(id).toJSON().state === 'pending', 'the item still waits on the user');
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(done.state === 'completed' && !done.result?.isError, `the replay finishes: ${JSON.stringify(done.result)}`);
      const value = JSON.parse(String(done.result?.content));
      assert(JSON.stringify(value.texts) === JSON.stringify(['hello 0\n', 'hello 1\n', 'hello 2\n']), `it saw what it read before the hold: ${JSON.stringify(value.texts)}`);
      assert(value.hits === 3 && value.listed === 3 && value.r === 'ran', `and its searches and the command: ${JSON.stringify(value)}`);
      assert(JSON.stringify(value.after) === JSON.stringify(['there 0\n', 'there 1\n', 'there 2\n']), `each edit applied once: ${JSON.stringify(value.after)}`);
      assert(String((await readFile({ path: log })).content) === 'x', 'the command ran once');
      const rows = rowBrief(mt, id);
      assert(rows === 'edit:ok,edit:ok,edit:ok,bash:ok', `one row per call, across runs: ${rows}`);
    });

    // Two calls that wait, fired together: the item asks about one, then the
    // other, in one run. Each command runs once, whichever the invoker reached
    // first.
    await test('two waiting calls fired together are held in turn, and each runs once', async () => {
      const dir = `rc-twice-${Date.now()}`;
      await writeFile({ path: `${dir}/c.txt`, content: 'seed\n' });
      const commands = [1, 2].map((n) => heldCommand(`${dir}/log${n}.txt`));
      const code = `
        const startedAt = Date.now();
        const out = await Promise.all(${JSON.stringify(commands)}.map(async (command) => {
          await fs.readFile("${dir}/c.txt");
          return String(await tools.bash({ command })).trim();
        }));
        return out.join("|") + "|" + startedAt;`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      for (const c of commands) await assertParks(conversation, mt, c);
      const finished = startAsAction(conversation, mt, id);
      const first = await waitHeld(mt, id, 'bash');
      const answeredAt = Date.now();
      answerHeld(conversation, mt, id, 'yes');
      const second = await waitHeld(mt, id, 'bash', (/** @type {import('./run-code-program-helpers.js').HeldToolAction} */ t) => t.heldCall.input.command !== first.heldCall.input.command);
      answerHeld(conversation, mt, id, 'yes');
      const done = await ended(finished);
      const held = [first, second].map((p) => p.heldCall?.input?.command);
      assert(held.every((c) => commands.includes(c)) && held[0] !== held[1], `it asks once about each command: ${JSON.stringify(held)}`);
      const [a, b, startedAt] = String(done.result?.content).split('|');
      assert(done.state === 'completed' && a === 'ran' && b === 'ran', `it finishes: ${JSON.stringify(done.result)}`);
      assert(Number(startedAt) < answeredAt, 'in one run');
      for (const n of [1, 2]) {
        const ran = await readFile({ path: `${dir}/log${n}.txt` });
        assert(String(ran.content) === 'x', `command ${n} ran once: ${JSON.stringify(ran.content)}`);
      }
      const rows = rowBrief(mt, id);
      assert(rows === 'bash:ok,bash:ok', `one row per command: ${rows}`);
      assert(!(await snapshotOf(item)) && !done.heldCall, 'nothing left behind');
    });

    await test('a program lost with no snapshot fails and runs nothing', async () => {
      const dir = `rc-lost-${Date.now()}`;
      await writeFile({ path: `${dir}/c.txt`, content: 'hello world\n' });
      const log = `${dir}/log.txt`;
      const command = heldCommand(log);
      const code = `
        await fs.readFile("${dir}/c.txt");
        await tools.edit({ file_path: "${dir}/c.txt", old_string: "world", new_string: "there" });
        await tools.bash({ command: ${JSON.stringify(command)} });
        return "finished";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      // What a restart leaves: the item as it was, the snapshot gone with the engine.
      await loseEngine(conversation, id, finished);
      await dropSnapshot(item);
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(done.result?.isError, `it fails: ${JSON.stringify(done.result)}`);
      assert(String(done.result?.content).includes("Couldn't resume the program"), `and says why: ${done.result?.content}`);
      const report = programChangeReport(displayOf(mt, id));
      assert(report.includes(`- edit: ${dir}/c.txt`), `the change before the hold is still reported: ${JSON.stringify(report)}`);
      assert(await absent(log), 'nothing ran again');
      const content = await readFile({ path: `${dir}/c.txt` });
      assert(String(content.content) === 'hello there\n', `the edit is not redone: ${content.content}`);
    });

    // Two holds in turn, the engine lost at the second: the replay answers
    // the first call from the snapshot, runs the second once, and nothing
    // that ran between them runs again.
    await test('a program lost at its second hold resumes from it, each call once', async () => {
      const dir = `rc-second-${Date.now()}`;
      await writeFile({ path: `${dir}/seed.txt`, content: '' });
      const [first, second] = [1, 2].map((n) => heldCommand(`${dir}/log${n}.txt`));
      const code = `
        const a = await tools.bash({ command: ${JSON.stringify(first)} });
        await tools.bash({ command: "printf x >> ${dir}/between.txt" });
        const b = await tools.bash({ command: ${JSON.stringify(second)} });
        return String(a).trim() + "|" + String(b).trim();`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, first);
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      answerHeld(conversation, mt, id, 'yes');
      await waitHeld(mt, id, 'bash', (/** @type {import('./run-code-program-helpers.js').HeldToolAction} */ t) => t.heldCall.input.command === second);
      const kept = await snapshotOf(item);
      assert(kept?.held?.input?.command === second && kept.heldStep === 2 && kept.journal[2]?.pending
        && kept.journal[0]?.ok && kept.journal[1]?.ok, `the snapshot is the second hold's: ${JSON.stringify(kept)}`);
      await loseEngine(conversation, id, finished);
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(done.state === 'completed' && done.result?.content === 'ran|ran', `the replay finishes: ${JSON.stringify(done.result)}`);
      for (const f of ['log1', 'between', 'log2']) {
        const ran = await readFile({ path: `${dir}/${f}.txt` });
        assert(String(ran.content) === 'x', `${f} ran once: ${JSON.stringify(ran.content)}`);
      }
      assert(rowBrief(mt, id) === 'bash:ok,bash:ok,bash:ok', `one row per call, across runs: ${rowBrief(mt, id)}`);
      assert(!(await snapshotOf(item)), 'and the snapshot is dropped');
    });
  });
}
