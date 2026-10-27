//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A call the decision parks is held: approving it runs it in the same run, a
 * refusal settles it, the wait is not counted against the program, and a
 * program that ends still holding a call leaves nothing waiting. Contract
 * item 7.
 *
 * One of the run_code program suites; what they share, and the contract they
 * cover between them, is in `run-code-program-helpers.js`.
 * @module _tests/run-code-program-hold-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { writeFile, readFile } from '../../../js/services/ops-api.js';
import actionExecutor from '../../../js/services/action-executor.js';
import contextItemRegistry from '../../../js/registries/context-item-registry.js';
import { programChangeReport } from '../../../js/utils/program-changes.js';
import { decideToolCall } from '../../../js/model/conversation-tool-actions.js';
import { handOverToHeldCall } from '../../../js/services/worker-manager-protocols.js';
import { runProgramSuite, ended } from './run-code-program-helpers.js';

/**
 * Run this suite's run_code program cases.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<import('./run-code-program-helpers.js').TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  return runProgramSuite(async ({ test, session, setup, displayOf, heldCommand, assertParks, startAsAction, waitHeld, answerHeld, snapshotOf, rowBrief, absent }) => {
    // Under a strategy that asks, a sub-call the decision would park is held:
    // the item goes back to pending carrying that call's own approval, while
    // the program waits on the call, and approving it runs the call in the
    // same run.
    await test('a parked call is held; approving it runs that call in the same run, each call once', async () => {
      const dir = `rc-hold-${Date.now()}`;
      await writeFile({ path: `${dir}/c.txt`, content: 'hello world\n' });
      const log = `${dir}/log.txt`;
      const command = heldCommand(log);
      const code = `
        const startedAt = Date.now();
        const c = await fs.readFile("${dir}/c.txt");
        await tools.edit({ file_path: "${dir}/c.txt", old_string: "world", new_string: "there" });
        const r = await tools.bash({ command: ${JSON.stringify(command)} });
        return c.trim() + "|" + String(r).trim() + "|" + startedAt;`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);

      const finished = startAsAction(conversation, mt, id);
      const parked = await waitHeld(mt, id, 'bash');
      assert(parked.result === undefined, `a held item has no result: ${JSON.stringify(parked.result)}`);
      assert(parked.heldCall?.input?.command === command, `with its input: ${JSON.stringify(parked.heldCall)}`);
      assert(actionExecutor.runningActionFor(id, conversation.id), 'the program is still running while it waits');
      const options = parked.approvalOptions?.options || [];
      assert(options.some((/** @type {any} */ o) => o.value === 'yes') && options.some((/** @type {any} */ o) => o.value === 'no'), `yes and no: ${JSON.stringify(options)}`);
      const always = options.filter((/** @type {any} */ o) => String(o.value).startsWith('yes-always'));
      assert(always.length > 0, `bash's own "don't ask again" buttons: ${JSON.stringify(options)}`);
      assert(always.every((/** @type {any} */ o) => o.rules && o.itemType && o.itemType !== 'run-code'), `each carries its rule, for the sub-tool: ${JSON.stringify(always)}`);
      const edited = await readFile({ path: `${dir}/c.txt` });
      assert(String(edited.content).includes('hello there'), 'the edit before the hold ran');
      assert(await absent(log), 'the held call did not run');
      const before = rowBrief(mt, id);
      assert(before === 'edit:ok,bash:held', `the rows show what ran and what waits: ${before}`);
      assert(programChangeReport(displayOf(mt, id)) === `\n\nChanges the program made:\n- edit: ${dir}/c.txt`,
        `the waiting call has changed nothing: ${JSON.stringify(programChangeReport(displayOf(mt, id)))}`);

      // The card is drawn by run_code's class; while it waits it shows the
      // held call as bash itself would, in the transcript and in the panel.
      const ui = item.getStatusUI({ pending: true, state: 'pending' }, { code }, { conversation, messageThread: mt, toolUseId: id });
      const bashUi = new (/** @type {any} */ (contextItemRegistry.getByToolName('bash')))({ id: 'execute', session, conversation, messageThread: mt })
        .getStatusUI({ pending: true, state: 'pending' }, { command }, { conversation, messageThread: mt, toolUseId: id });
      const textOf = (/** @type {any} */ s) => (typeof s === 'string' ? s : s?.textContent);
      assert(textOf(ui?.summary) === textOf(bashUi?.summary) && String(textOf(ui?.summary)).includes(log),
        `the status row is bash's: ${textOf(ui?.summary)} vs ${textOf(bashUi?.summary)}`);
      assert(String(ui?.typeName).startsWith('Program'), `and says it is the program's: ${JSON.stringify(ui)}`);
      /** @type {Array<[string, string]>} */
      const sections = [];
      const helpers = new Proxy({}, {
        get: (_t, name) => (/** @type {any} */ _w, /** @type {any} */ title, /** @type {any} */ body) => {
          sections.push([String(name), `${title}: ${typeof body === 'string' ? body : ''}`]);
        }
      });
      item.renderToolActionDetails(document.createElement('div'), /** @type {any} */ ({
        toolAction: mt.getToolAction(id), toolName: 'run_code', input: { code }, helpers,
        conversation, messageThread: mt, session, selectedItemId: null
      }));
      assert(sections.some(([, s]) => s.startsWith('Command:') && s.includes(log)), `the panel shows the held command: ${JSON.stringify(sections)}`);

      const button = always[0];
      const answeredAt = Date.now();
      answerHeld(conversation, mt, id, 'yes-always', { extra: { approvalRules: button.rules, approvalItemType: button.itemType } });
      const done = await ended(finished);
      assert(done.state === 'completed' && !done.result?.isError, `the program finishes: ${JSON.stringify(done.result)}`);
      const [seen, ran, startedAt] = String(done.result?.content).split('|');
      assert(seen === 'hello world' && ran === 'ran', `it saw its own read and the real run: ${done.result?.content}`);
      assert(Number(startedAt) < answeredAt, `one run, started before the answer — not run again after it: ${startedAt} vs ${answeredAt}`);
      const logged = await readFile({ path: log });
      assert(String(logged.content) === 'x', `bash ran exactly once: ${JSON.stringify(logged.content)}`);
      const after = rowBrief(mt, id);
      assert(after === 'edit:ok,bash:ok', `one row per call: ${after}`);
      assert(!(await snapshotOf(item)), 'a finished program leaves no snapshot');
      assert(!done.heldCall && !done.approvalOptions, 'nor a held call');
      const again = await decideToolCall({
        messageThread: mt, conversation, toolName: 'bash',
        toolInput: { command }, toolUseId: `${id}_again`
      });
      assert(again.verdict === 'approve', `"don't ask again" saved a bash rule: ${again.verdict}`);
    });

    // A rule saved from anywhere else — "don't ask again" on another pending
    // call of the same tool — re-checks every pending approval. A held call is
    // pending as its program's item, so it is checked as the call it holds.
    await test('a rule saved elsewhere that covers a held call approves it, and the call runs', async () => {
      const log = `rc-rule-held-${Date.now()}.txt`;
      const command = heldCommand(log);
      const code = `const r = await tools.bash({ command: ${JSON.stringify(command)} }); return String(r).trim();`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      const parked = await waitHeld(mt, id, 'bash');
      const button = (parked.approvalOptions?.options || [])
        .find((/** @type {any} */ o) => String(o.value).startsWith('yes-always') && o.rules && o.itemType);
      assert(button, `a "don't ask again" grant for bash: ${JSON.stringify(parked.approvalOptions)}`);
      const ymap = mt.getToolAction(id);
      let state = '';
      let delivered = false;
      mt.transact(() => {
        for (const r of button.rules) mt.addRule(button.itemType, { kind: r.kind, value: r.value, scope: r.scope });
        state = ymap.get('state');
        // The engine's handover of the approval, as handleExecuteTool makes it.
        delivered = handOverToHeldCall(conversation, mt, ymap, id);
      });
      if (!delivered) mt.refuseApproval(id, 'not approved by the rule');
      const done = await ended(finished);
      assert(state === 'approved' && delivered, `the saved rule approves the held call: ${state}`);
      assert(done.state === 'completed' && done.result?.content === 'ran', `and the program goes on: ${JSON.stringify(done.result)}`);
    });

    await test('a held call refused on the user\'s behalf ends the program with that refusal', async () => {
      const log = `rc-refuse-held-${Date.now()}.txt`;
      const command = heldCommand(log);
      const code = `await tools.bash({ command: ${JSON.stringify(command)} }); return "done";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      assert(mt.refuseApproval(id, 'Refused: nobody here to ask.'), 'the refusal is written');
      const done = await ended(finished);
      assert(done.state === 'completed' && done.result?.isError && done.result?.content === 'Refused: nobody here to ask.',
        `the refusal stands: ${done.state} ${JSON.stringify(done.result)}`);
      assert(await absent(log), 'the held call did not run');
    });

    await test('time spent waiting on the user is not counted against the program', async () => {
      const log = `rc-clock-${Date.now()}.txt`;
      const command = heldCommand(log);
      const programOf = (/** @type {string} */ cmd) => `await tools.bash({ command: ${JSON.stringify(cmd)} }); return "done";`;
      const code = programOf(command);
      // The program's timeout must hold everything it does except the wait, on
      // whatever core this is, and the wait must outlast it. So the program's
      // own work is measured here first: the same program under YOLO, where
      // nothing is held. A fixed timeout is a guess at this core's speed — 4s
      // was ample on a fast one and was spent before the hold on a slow one.
      const cal = await setup(programOf(heldCommand(`rc-clock-cal-${Date.now()}.txt`)));
      const calDone = await ended(startAsAction(cal.conversation, cal.mt, cal.item.toolUseId), 'the unheld program to end');
      assert(calDone.state === 'completed' && calDone.result?.content === 'done',
        `the same program, unheld, finishes: ${JSON.stringify(calDone.result)}`);
      const ownMs = Number(calDone.result?.fullResult?.durationMs);
      assert(ownMs > 0, `the unheld run reports its duration: ${JSON.stringify(calDone.result)}`);
      // Four times the measured cost: room for the held run's extra handover
      // and for a slow core's unevenness, and never below the 4s that is ample
      // on a fast one.
      const timeoutMs = Math.max(4000, Math.ceil(ownMs * 4));
      const { conversation, mt, item } = await setup(code, { strategy: 'default', timeout: timeoutMs });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const started = Date.now();
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      // The duration here is the subject, not a guess: the answer must come
      // after the program's own timeout would have fired had the hold been
      // counted. Measured from the start, so a slow run up to the hold already
      // counts towards it.
      const pastTimeoutMs = timeoutMs + 500 - (Date.now() - started);
      // eslint-disable-next-line juggler/no-private-test-wait -- the hold must outlast the program's own timeout; the duration is the subject
      if (pastTimeoutMs > 0) await new Promise((resolve) => setTimeout(resolve, pastTimeoutMs));
      answerHeld(conversation, mt, id, 'yes');
      const done = await ended(finished);
      assert(done.state === 'completed' && done.result?.content === 'done',
        `a program that waited past its timeout for the user still finishes: ${JSON.stringify(done.result)}`);
    });

    await test('a program that ends with a call still held completes, and leaves nothing waiting', async () => {
      const dir = `rc-left-${Date.now()}`;
      const log = `${dir}/log.txt`;
      const flag = `${dir}/flag.txt`;
      const command = heldCommand(log);
      // fs is not scheduled behind the held write, so the program can watch
      // for the test's word that the call is held, and then end without it.
      const code = `
        tools.bash({ command: ${JSON.stringify(command)} }).catch(() => {});
        for (;;) {
          try { await fs.readFile("${flag}"); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
        }
        return "left";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      await writeFile({ path: flag, content: 'go' });
      const done = await ended(finished);
      assert(done.state === 'completed' && done.result?.content === 'left', `it completes: ${done.state} ${JSON.stringify(done.result)}`);
      assert(!done.heldCall && !done.approvalOptions, `with no card left on it: ${JSON.stringify(done)}`);
      assert(await absent(log), 'the held call never ran');
      assert(!programChangeReport(displayOf(mt, id)).includes('bash'), `and is not reported as a change: ${programChangeReport(displayOf(mt, id))}`);
      assert(!(await snapshotOf(item)), 'and its snapshot is dropped');
    });
  });
}
