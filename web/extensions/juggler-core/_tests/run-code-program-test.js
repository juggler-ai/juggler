//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What a program may call and what the model is told: fs reads and
 * tools.edit, an un-offered tool, a hook's deny, cancelling mid-call,
 * replaying from a snapshot, tools.read, a tool's whole output, and the
 * order of writes fired together. Contract items 1-6.
 *
 * One of the run_code program suites; what they share, and the contract they
 * cover between them, is in `run-code-program-helpers.js`.
 * @module _tests/run-code-program-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { writeFile, readFile } from '../../../js/services/ops-api.js';
import { dropSnapshot } from '../context-items/run-code-context-item.js';
import { programChangeReport } from '../../../js/utils/program-changes.js';
import { runProgramSuite, waitUntil, runningSubCalls } from './run-code-program-helpers.js';

/**
 * Run this suite's run_code program cases.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<import('./run-code-program-helpers.js').TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  return runProgramSuite(async ({ test, setup, displayOf, run, rowsOf, withDecision, seedHeld, snapshotOf, seedSnapshot, rowBrief }) => {
    await test('fs reads then tools.edit: admitted, applied, reported', async () => {
      const dir = `rc-edit-${Date.now()}`;
      await writeFile({ path: `${dir}/a.txt`, content: 'alpha\n' });
      await writeFile({ path: `${dir}/b.txt`, content: 'beta\n' });
      await writeFile({ path: `${dir}/c.txt`, content: 'hello world\n' });
      const code = `
        const a = await fs.readFile("${dir}/a.txt");
        const b = await fs.readFile("${dir}/b.txt");
        const c = await fs.readFile("${dir}/c.txt");
        await tools.edit({ file_path: "${dir}/c.txt", old_string: "world", new_string: "there" });
        return a.length + b.length + c.length;`;
      const { mt, item } = await setup(code);
      const before = mt.items.length;
      const { out, text, wire } = await run(item, code);
      assert(out?.success !== false, `the program must succeed, got: ${text}`);
      const after = await readFile({ path: `${dir}/c.txt` });
      assert(String(after.content).includes('hello there'), `the edit must apply, file is: ${after.content}`);
      assert(wire.startsWith('23'), `the model reads the value first, got: ${wire}`);
      assert(wire.includes(`Changes the program made:\n- edit: ${dir}/c.txt`), `the change must be listed:\n${wire}`);
      assert(!wire.includes('a.txt') && !wire.includes('b.txt'), `reads are never listed:\n${wire}`);
      assert(!text.includes('Changes the program made'), `the list comes from the record, not the summary:\n${text}`);
      assert(!('effects' in out), `the result carries no change list of its own: ${JSON.stringify(out)}`);
      assert(mt.items.length === before, 'a sub-call creates no item');
      const rows = rowsOf(mt, item.toolUseId);
      assert(rows.length === 1 && rows[0].name === 'edit' && rows[0].status === 'ok', `rows: ${JSON.stringify(rows)}`);
      assert(!('result' in rows[0]), 'a row never holds a result');
      const display = displayOf(mt, item.toolUseId);
      assert(display.omittedEffects === 0, `the record counts the effects it gave up: ${JSON.stringify(display)}`);
    });

    await test('an un-offered tool is refused in the worker\'s words', async () => {
      const code = `
        try { await tools.create_thread({ goal: "x", prompt: "y" }); return "ran"; }
        catch (e) { return e.message; }`;
      const { mt, item } = await setup(code);
      const before = mt.items.length;
      const { text } = await run(item, code);
      assert(text.includes("Couldn't run create_thread: it wasn't available in this thread."), `got: ${text}`);
      assert(mt.items.length === before, 'no item is created');
      const rows = rowsOf(mt, item.toolUseId);
      assert(rows.length === 1 && rows[0].status === 'error', `rows: ${JSON.stringify(rows)}`);
    });

    // Models write Node out of habit: import or require fs, declare their own
    // `fs`, write through it. Each fails; the error must say what to use
    // instead, or the model retries the same mistake and falls back to native
    // tools (measured: 7 of Haiku's 8 programs, on exactly these).
    await test('Node habits are pointed at what is already in scope', async () => {
      const inScope = 'path, projectRoot, fs, grep, glob, tools, describeTool, image';
      const cases = [
        {
          code: 'const fs = await import("fs");\nreturn 1;',
          wants: ["Cannot declare a const variable twice: 'fs'. It is already in scope: use it directly rather than importing or requiring it.", `In scope: ${inScope}.`],
        },
        {
          code: 'return require("path");',
          wants: [`Couldn't require "path": this sandbox is not Node. Use what is already in scope instead: ${inScope}.`],
        },
        {
          code: 'const m = await import("node:fs");\nreturn 1;',
          wants: [`Couldn't import "node:fs": this sandbox is not Node. Use what is already in scope instead: ${inScope}.`],
        },
        {
          code: `await fs.writeFile("rc-erofs-${Date.now()}.txt", "x");\nreturn 1;`,
          wants: ['EROFS: read-only filesystem', 'change files with tools.write or tools.edit'],
        },
      ];
      for (const { code, wants } of cases) {
        const { item } = await setup(code);
        const { out, text } = await run(item, code);
        assert(out?.success === false, `must fail: ${code}\ngot: ${text}`);
        for (const want of wants) assert(text.includes(want), `for ${JSON.stringify(code)} the error must say:\n${want}\ngot:\n${text}`);
      }
    });

    // The SDK in run_code's description is an index; describeTool is where a
    // program gets the rest, over exactly what the thread may call.
    await test('describeTool describes what the program may call, and nothing else', async () => {
      const code = `
        const edit = await describeTool("edit");
        const all = await describeTool();
        let refused = "";
        try { await describeTool("create_thread"); } catch (e) { refused = e.message; }
        return { edit, all, refused };`;
      const { item } = await setup(code);
      const { out, text } = await run(item, code);
      assert(out?.success !== false, `must succeed, got: ${text}`);
      const value = /** @type {any} */ (out).result;
      assert(String(value.edit).includes('tools.edit(args)') && String(value.edit).includes('args.old_string'), `edit's whole entry:\n${value.edit}`);
      assert(Array.isArray(value.all) && value.all.includes('edit') && value.all.includes('bash'), `the callable names: ${JSON.stringify(value.all)}`);
      assert(!value.all.includes('create_thread'), 'a native-only tool is not callable from a program');
      assert(value.refused.includes('create_thread') && value.refused.includes("can't be called from a program"), `got: ${value.refused}`);
    });

    await test('a hook\'s deny ends the program, changes still reported', async () => {
      const file = `rc-deny-${Date.now()}.txt`;
      const code = `
        await tools.bash({ command: "printf done > ${file}" });
        try { await tools.bash({ command: "echo blocked" }); }
        catch (e) { return "caught: " + e.message; }
        return "unreachable";`;
      const { mt, item } = await setup(code);
      // A deny is the one verdict that still refuses: the user's own gate said
      // no, so there is nothing to wait for.
      const deny = (/** @type {any} */ call) => (call.toolInput?.command === 'echo blocked'
        ? { verdict: 'deny', reason: 'Blocked by hook "t"' } : null);
      const { out, text, wire } = await withDecision(deny, () => run(item, code));
      assert(out?.success === false, `a refusal must not be catchable, got: ${text}`);
      assert(text.includes('Couldn\'t run bash: Blocked by hook "t"'), `got: ${text}`);
      assert(wire.includes(`Changes the program made:\n- bash: printf done > ${file}`), `the earlier change must be reported:\n${wire}`);
      assert(!text.includes('Changes the program made'), `the list comes from the record, not the summary:\n${text}`);
      const rows = rowsOf(mt, item.toolUseId);
      assert(rows.some((r) => r.name === 'bash' && r.status === 'refused'), `rows: ${JSON.stringify(rows)}`);
    });

    await test('cancelling stops the sandbox and the running sub-call', async () => {
      const code = 'await tools.bash({ command: "sleep 30" }); return "finished";';
      const { mt, item, controller } = await setup(code);
      const execution = item.execute({ code });
      execution.catch(() => {});
      await waitUntil(() => runningSubCalls().length > 0, 'the sub-call to start');
      const started = Date.now();
      controller.abort();
      let threw = false;
      try {
        await execution;
      } catch {
        threw = true;
      }
      assert(threw, 'a cancelled program rejects');
      assert(Date.now() - started < 10000, `cancel must be prompt, took ${Date.now() - started}ms`);
      await waitUntil(() => runningSubCalls().length === 0, 'no sub-call left running');
      const rows = rowsOf(mt, item.toolUseId);
      assert(rows.length === 1 && rows[0].status === 'cancelled', `rows: ${JSON.stringify(rows)}`);
      const report = programChangeReport(displayOf(mt, item.toolUseId));
      assert(report === '\n\nChanges the program made:\n- bash: sleep 30 (interrupted)', `the cut-off call is reported: ${JSON.stringify(report)}`);
      // The record is final once the program has ended: the worker has already
      // written the cancelled state, and the model is sent this record. Rows
      // are written on a 250ms throttle timer, and timers fire in the order of
      // their deadlines, so a write still scheduled has landed by the time a
      // longer timer armed now has fired, however slow the core.
      const final = JSON.stringify(displayOf(mt, item.toolUseId));
      let fenced = false;
      setTimeout(() => { fenced = true; }, 600);
      await waitUntil(() => fenced, 'a timer armed after any pending row write to fire');
      const later = JSON.stringify(displayOf(mt, item.toolUseId));
      assert(later === final, `the record was written after the program ended:\n${final}\n→ ${later}`);
    });

    // A program whose engine was lost while it waited is run again from the
    // top; its snapshot is what makes that safe. These seed one directly, as a
    // hold would have left it.
    await test('a replay answers from the snapshot and runs nothing again', async () => {
      const file = `rc-replay-${Date.now()}.txt`;
      const code = `
        const a = await fs.readFile("never-read-${file}");
        const r = await tools.bash({ command: "printf x > ${file}" });
        const s = await tools.bash({ command: "printf y > held-${file}; printf held" });
        return a + "|" + r + "|" + s;`;
      const { mt, item } = await setup(code);
      const held = { name: 'bash', input: { command: `printf y > held-${file}; printf held` } };
      await seedSnapshot(item, {
        held,
        heldStep: 2,
        journal: [
          { key: 'fs.readFile', args: JSON.stringify([`never-read-${file}`]), ok: true, value: 'from the journal' },
          { key: 'tools.bash', args: JSON.stringify([{ command: `printf x > ${file}` }]), ok: true, value: 'ran before' },
          { key: 'tools.bash', args: JSON.stringify([held.input]), ok: false, pending: true },
        ],
        calls: [{ name: 'bash', args: { command: `printf x > ${file}` }, status: 'ok', durationMs: 5, effect: `bash: printf x > ${file}` }],
      });
      seedHeld(mt, item.toolUseId, held);
      const { out, text, wire } = await run(item, code);
      assert(out?.success !== false, `must succeed, got: ${text}`);
      assert(text === 'from the journal|ran before|held', `the program sees the snapshot's answers, and the held call's, got: ${text}`);
      // The earlier run's change still reaches the model: the record spans runs.
      assert(wire.includes(`Changes the program made:\n- bash: printf x > ${file}`), `the earlier run's change must be reported:\n${wire}`);
      const rows = rowBrief(mt, item.toolUseId);
      assert(rows === 'bash:ok,bash:ok', `one row per call, across runs: ${rows}`);
      const written = await readFile({ path: file }).catch(() => null);
      assert(written === null || written.exists === false, `bash must not run again, but ${file} exists`);
      assert(String((await readFile({ path: `held-${file}` })).content) === 'y', 'the held call ran');
      assert(!(await snapshotOf(item)), 'a completed program leaves no snapshot');
      const after = mt.getToolAction(item.toolUseId).toJSON();
      assert(!after.heldCall && !after.approvalOptions, `nor a held call: ${JSON.stringify(after)}`);
    });

    await test('a replay that diverges ends the program unrun', async () => {
      const file = `rc-diverge-${Date.now()}.txt`;
      const code = `
        try { await tools.bash({ command: "printf x > ${file}" }); }
        catch (e) { return "caught: " + e.message; }
        return "unreachable";`;
      const { mt, item } = await setup(code);
      const held = { name: 'bash', input: { command: 'printf y > elsewhere.txt' } };
      await seedSnapshot(item, {
        held, heldStep: 0, journal: [{ key: 'tools.bash', args: JSON.stringify([held.input]), ok: false, pending: true }]
      });
      seedHeld(mt, item.toolUseId, held);
      const { out, text } = await run(item, code);
      assert(out?.success === false, `a divergence must not be catchable, got: ${text}`);
      assert(text.includes("Couldn't resume the program") && text.includes('step 1'), `got: ${text}`);
      const written = await readFile({ path: file }).catch(() => null);
      assert(written === null || written.exists === false, `bash must not run, but ${file} exists`);
      assert(!(await snapshotOf(item)), 'an ended program leaves no snapshot');
    });

    // Tool-use ids are unique within a conversation, not across them: two
    // conversations' calls can share one, and the engine holds every
    // conversation's snapshots.
    await test('a snapshot belongs to its own conversation\'s program', async () => {
      const file = `rc-own-${Date.now()}.txt`;
      const code = `return await tools.bash({ command: "printf x > ${file}; printf ran" });`;
      const toolUseId = `rc-shared-${Date.now()}`;
      const other = await setup(code, { toolUseId });
      const { mt, item } = await setup(code, { toolUseId });
      const held = { name: 'bash', input: { command: `printf x > ${file}; printf ran` } };
      await seedSnapshot(other.item, {
        held, heldStep: 1, journal: [{ key: 'tools.bash', args: JSON.stringify([held.input]), ok: true, value: 'theirs' }]
      });
      seedHeld(mt, toolUseId, held);
      try {
        const { out, text } = await run(item, code);
        assert(out?.success === false && text.includes("Couldn't resume the program"),
          `it has no snapshot of its own, so it cannot resume, got: ${text}`);
        const written = await readFile({ path: file }).catch(() => null);
        assert(written === null || written.exists === false, 'nor does it run');
        assert(await snapshotOf(other.item), 'the other conversation\'s snapshot is untouched');
      } finally {
        await dropSnapshot(other.item);
      }
    });

    // Only an import() the program makes is routed through the sandbox's
    // resolver: text that merely says "import(" — code a program writes — is
    // the program's data, and must reach the tool as written.
    await test('"import(" inside a string is data, not an import', async () => {
      const file = `rc-import-text-${Date.now()}.js`;
      const text = 'const m = await import("./x.js"); /* import( */ `${1}import (y)`';
      const code = `
        await tools.write({ file_path: "${file}", content: ${JSON.stringify(text)} });
        return ${JSON.stringify(text)} + "|" + 'import(' + "|" + \`import(\`;`;
      const { item } = await setup(code);
      const { out, text: got } = await run(item, code);
      assert(out?.success !== false, `must succeed, got: ${got}`);
      assert(got === `${text}|import(|import(`, `the strings are returned as written, got: ${got}`);
      const written = await readFile({ path: file });
      assert(String(written.content) === text, `the file holds what the program wrote: ${written.content}`);
    });

    // A read through a tool is a read: the program saw the bytes in its result,
    // as it would through `fs`.
    await test('tools.read and tools.batch_read let the program edit what they read', async () => {
      const dir = `rc-toolread-${Date.now()}`;
      await writeFile({ path: `${dir}/a.txt`, content: 'hello world\n' });
      await writeFile({ path: `${dir}/b.txt`, content: 'hello world\n' });
      const code = `
        await tools.read({ file_path: "${dir}/a.txt" });
        await tools.edit({ file_path: "${dir}/a.txt", old_string: "world", new_string: "there" });
        await tools.batch_read({ files: [{ file_path: "${dir}/b.txt" }] });
        await tools.edit({ file_path: "${dir}/b.txt", old_string: "world", new_string: "there" });
        return "edited";`;
      const { item } = await setup(code);
      const { out, text } = await run(item, code);
      assert(out?.success !== false && text === 'edited', `both edits must be admitted, got: ${text}`);
      for (const f of ['a.txt', 'b.txt']) {
        const after = await readFile({ path: `${dir}/${f}` });
        assert(String(after.content) === 'hello there\n', `${f} must be edited: ${after.content}`);
      }
    });

    // The model's cut of a tool's output is sized for the model's context. A
    // program reads the output to work on it, and only what it returns
    // reaches the model, so it is handed the whole of it: 15000 lines is
    // ~79KB, past the model's budget here and inside the shell's own cap.
    // Past that cap the shell keeps a head and a tail and says where the rest
    // went, and a program sees that as plainly as the model would.
    await test('a tool call hands a program its whole output, not the model\'s cut of it', async () => {
      const code = `
        const out = await tools.bash({ command: "seq 1 15000" });
        const lines = out.split("\\n").filter((l) => /^\\d+$/.test(l));
        const huge = await tools.bash({ command: "seq 1 60000" });
        return { lines: lines.length, last: lines.at(-1), cut: /truncated/i.test(out), saved: huge.includes("FULL output saved to") };`;
      const { item } = await setup(code);
      const { out } = await run(item, code);
      const result = /** @type {any} */ (out)?.result;
      assert(result?.lines === 15000 && result.last === '15000' && result.cut === false,
        `the program must see every line: ${JSON.stringify(out)}`);
      assert(result.saved === true, `past the shell's cap, the program is told where the rest is: ${JSON.stringify(out)}`);
    });

    await test('writes fired together keep the program\'s order', async () => {
      const file = `rc-order-${Date.now()}.txt`;
      const code = `
        await Promise.all([1, 2, 3].map((n) =>
          tools.bash({ command: "sleep 0.$((4 - " + n + ")); echo " + n + " >> ${file}" })));
        return "ok";`;
      const { item } = await setup(code);
      const { text } = await run(item, code);
      assert(text.startsWith('ok'), `got: ${text}`);
      const content = await readFile({ path: file });
      assert(String(content.content) === '1\n2\n3\n', `writes ran out of order: ${JSON.stringify(content.content)}`);
    });
  });
}
