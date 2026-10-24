//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A held call offered to the strategy's reviewer, and images: tools.read
 * handles, image(path), an image held across a wait, one replayed after a
 * lost engine, and query_code's. Contract items 7-8.
 *
 * One of the run_code program suites; what they share, and the contract they
 * cover between them, is in `run-code-program-helpers.js`.
 * @module _tests/run-code-program-images-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { writeFile } from '../../../js/services/ops-api.js';
import QueryCodeContextItem from '../context-items/query-code-context-item.js';
import { runProgramSuite, ended, waitUntil } from './run-code-program-helpers.js';

/**
 * Run this suite's run_code program cases.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<import('./run-code-program-helpers.js').TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  return runProgramSuite(async ({ test, session, setup, run, heldOf, heldCommand, assertParks, runAsAction, startAsAction, waitHeld, answerHeld, loseEngine }) => {
    // A strategy with a reviewer is handed a parked call before the user is;
    // a call held inside a program is no different.
    await test('a held call is offered to the strategy\'s reviewer', async () => {
      const log = `rc-review-${Date.now()}.txt`;
      const command = heldCommand(log);
      const code = `await tools.bash({ command: ${JSON.stringify(command)} }); return "done";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      /** @type {any[]} */
      const offered = [];
      /** @type {(v: any) => void} */
      let finishReview = () => {};
      // The default policy (each tool's own rule), with a reviewer.
      mt.strategy = {
        onToolPending: (/** @type {any} */ call) => {
          offered.push(call);
          return new Promise((resolve) => { finishReview = resolve; });
        }
      };
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      const parked = await waitHeld(mt, id, 'bash');
      await waitUntil(() => offered.length > 0, 'the reviewer to be offered the call');
      assert(offered.length === 1, `the reviewer is offered the held call once, got ${offered.length}`);
      const call = offered[0];
      assert(call.toolUseId === id, `under the program's id, which is what it resolves: ${call.toolUseId}`);
      assert(call.toolName === 'bash' && call.toolInput?.command === command, `as the held call: ${JSON.stringify(call)}`);
      assert(call.category === 'write' && call.autoApprovable === true, `with its category and autoApprovable: ${JSON.stringify(call)}`);
      assert(parked.reviewStatus?.busy === true, `parked already under review, so no alert fires yet: ${JSON.stringify(parked.reviewStatus)}`);
      finishReview({ note: 'declined: writes outside the project' });
      await waitUntil(() => mt.getToolAction(id)?.toJSON().reviewStatus?.busy === false, 'the review to close');
      assert(mt.getToolAction(id).toJSON().reviewStatus.label === 'declined: writes outside the project', 'its note stays in the card');
      answerHeld(conversation, mt, id, 'yes');
      const done = await ended(finished);
      assert(done.state === 'completed' && done.result?.content === 'done', `approving finishes it: ${JSON.stringify(done.result)}`);
    });

    // A program's result is text; an image reaches the model only as an
    // attachment on it. A call that produced images gives the program handles,
    // and image() is how it attaches one.
    await test('tools.read on an image gives a handle, and image() attaches it', async () => {
      const dir = `rc-image-${Date.now()}`;
      await writeFile({ path: `${dir}/shot.png`, content: 'not really a png' });
      const code = `
        const r = await tools.read({ file_path: "${dir}/shot.png" });
        await image(r.images[0]);
        return { text: r.text, handle: r.images[0] };`;
      const { mt, item } = await setup(code);
      const { out, text, summary } = await run(item, code);
      assert(out?.success !== false, `must succeed, got: ${text}`);
      const attached = /** @type {any[]} */ (out.attachments || []);
      assert(attached.length === 1 && /^[0-9a-f]{64}$/.test(attached[0].id) && attached[0].mime === 'image/png',
        `the result carries the image: ${JSON.stringify(out.attachments)}`);
      const value = /** @type {any} */ (out).result;
      assert(value.handle?.image === attached[0].id && value.handle.label === `${dir}/shot.png`,
        `the handle names the image and where it came from: ${JSON.stringify(value.handle)}`);
      assert(String(value.text).includes('shot.png'), `the call's text comes with it: ${value.text}`);
      assert(Array.isArray(summary.attachments) && summary.attachments[0]?.id === attached[0].id,
        `the summary attaches it for the model: ${JSON.stringify(summary.attachments)}`);
      assert(text.includes(`Images attached below:\n- ${dir}/shot.png`), `the text says what is attached:\n${text}`);
      assert(JSON.stringify(heldOf(mt, item.toolUseId)) === JSON.stringify([attached[0].id]),
        `the item holds only what it attached once it ends: ${JSON.stringify(heldOf(mt, item.toolUseId))}`);
    });

    await test('image(path) attaches what fs found; anything else is refused', async () => {
      const dir = `rc-image-path-${Date.now()}`;
      await writeFile({ path: `${dir}/found.png`, content: 'also not a png' });
      await writeFile({ path: `${dir}/notes.txt`, content: 'text\n' });
      const code = `
        const [found] = await glob("*.png", { cwd: "${dir}" });
        await image("${dir}/" + found);
        const errs = {};
        try { await image("${dir}/notes.txt"); } catch (e) { errs.text = e.message; }
        try { await image({ image: "${'f'.repeat(64)}", mime: "image/png", bytes: 1 }); } catch (e) { errs.forged = e.message; }
        try { await fs.readFile("${dir}/found.png"); } catch (e) { errs.read = e.message; }
        return errs;`;
      const { item } = await setup(code);
      const { out, text } = await run(item, code);
      assert(out?.success !== false, `must succeed, got: ${text}`);
      assert(/** @type {any[]} */ (out.attachments || []).length === 1, `one image attached: ${JSON.stringify(out.attachments)}`);
      const errs = /** @type {any} */ (out).result;
      assert(String(errs.text).includes('is not an image'), `a text file is refused: ${errs.text}`);
      assert(String(errs.forged).includes("Couldn't attach that image"), `a handle it was never given is refused: ${errs.forged}`);
      assert(String(errs.read).includes('is an image') && String(errs.read).includes('image('),
        `fs.readFile on an image says so, and points at image(): ${errs.read}`);
    });

    await test('an image the program holds while it waits is attached once approved', async () => {
      const dir = `rc-image-held-${Date.now()}`;
      await writeFile({ path: `${dir}/shot.png`, content: 'held png' });
      const log = `${dir}/log.txt`;
      const command = heldCommand(log);
      const code = `
        const r = await tools.read({ file_path: "${dir}/shot.png" });
        await tools.bash({ command: ${JSON.stringify(command)} });
        await image(r.images[0]);
        return "shown";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      const held = heldOf(mt, id);
      assert(held.length === 1 && /^[0-9a-f]{64}$/.test(held[0]), `while it waits, the item holds the image: ${JSON.stringify(held)}`);
      answerHeld(conversation, mt, id, 'yes');
      const done = await ended(finished);
      assert(done.state === 'completed' && done.result?.content?.startsWith('shown'), `it finishes: ${JSON.stringify(done.result)}`);
      const attachments = mt.getToolAction(id).get('attachments');
      const refs = attachments?.toJSON ? attachments.toJSON() : attachments;
      assert(Array.isArray(refs) && refs.length === 1 && refs[0].id === held[0],
        `the image from before the stop is attached: ${JSON.stringify(refs)}`);
    });

    // image(path) reads a file, so it is journalled like fs: a program
    // resuming after its engine was lost attaches what it saw before the stop,
    // not what the file holds by the time the user answers.
    await test('image(path) before a lost engine is replayed, not read again', async () => {
      const dir = `rc-image-replay-${Date.now()}`;
      await writeFile({ path: `${dir}/shot.png`, content: 'before the stop' });
      const log = `${dir}/log.txt`;
      const command = heldCommand(log);
      const code = `
        await image("${dir}/shot.png");
        await tools.bash({ command: ${JSON.stringify(command)} });
        return "shown";`;
      const { conversation, mt, item } = await setup(code, { strategy: 'default' });
      const id = item.toolUseId;
      await assertParks(conversation, mt, command);
      const finished = startAsAction(conversation, mt, id);
      await waitHeld(mt, id, 'bash');
      const held = heldOf(mt, id);
      assert(held.length === 1, `while it waits, the item holds the image: ${JSON.stringify(held)}`);
      await loseEngine(conversation, id, finished);
      await writeFile({ path: `${dir}/shot.png`, content: 'changed while it waited' });
      const done = await runAsAction(conversation, mt, id, () => mt.resolveApproval(id, 'yes', { source: 'user' }));
      assert(done.state === 'completed', `it finishes: ${JSON.stringify(done.result)}`);
      const attachments = mt.getToolAction(id).get('attachments');
      const refs = attachments?.toJSON ? attachments.toJSON() : attachments;
      assert(Array.isArray(refs) && refs.length === 1 && refs[0].id === held[0],
        `the image the program saw is attached, not the file as it is now: ${JSON.stringify(refs)} vs ${JSON.stringify(held)}`);
    });

    await test('query_code attaches an image by path', async () => {
      const dir = `qc-image-${Date.now()}`;
      await writeFile({ path: `${dir}/chart.png`, content: 'a chart' });
      const code = `await image("${dir}/chart.png"); return "see it";`;
      const { conversation, mt } = await setup(code);
      const qc = new QueryCodeContextItem({ id: QueryCodeContextItem.MANIFEST.id, session, conversation, messageThread: mt });
      const out = await qc.execute({ code });
      const summary = qc.getSummary({ success: true, result: out });
      assert(/** @type {any[]} */ (out.attachments || []).length === 1, `the result carries the image: ${JSON.stringify(out)}`);
      assert(summary.attachments?.length === 1 && String(summary.summary).includes(`${dir}/chart.png`),
        `and the model is told and shown: ${JSON.stringify(summary)}`);
    });
  });
}
