//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for run_code's pure parts: the SDK text a program is described with,
 * and the text the model reads back.
 *
 * Contract under test:
 *   1. The SDK in run_code's description is one rule — call any tool in the
 *      tool list by name — and the offered tools it does not cover, so the
 *      description stays short whatever the thread offers. describeTool gives
 *      a program one tool whole, as JSDoc, with required and optional
 *      arguments told apart.
 *   2. A successful program's text is its return value, then its console.
 *   3. A failed program's text is the error, then its console.
 *      Neither lists the changes the program made: the worker appends those
 *      from the item's call record, however the program ended.
 *   4. The tool ships under its own plugin id, as a write, flagged to carry
 *      the SDK and not to be offered only where writes are auto-approved.
 *   5. The journal records every capability call in order. A replay answers
 *      each recorded call from it without calling through — values, errors
 *      and read credit alike — and calls through past its end or a gap. A
 *      call that differs from the record at its step is a divergence: it is
 *      reported, and nothing is called. A refusal or a cancel is never
 *      recorded, so a replay asks again.
 * @module unit-tests/run-code-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert,
  waitFor
} from '../../../js-tests/utilities/test-helpers.js';
import RunCodeContextItem, { pausableTimer } from '../context-items/run-code-context-item.js';
import { renderProgramSdk, describeProgramTool } from '../context-items/code/render-sdk.js';
import { journalCapabilities, ProgramDiverged } from '../context-items/code/program-journal.js';
import { createProgramImages, attachedImagesNote } from '../context-items/code/program-images.js';
import { generateToolDefinitions } from '../../../js/services/tool-generator.js';
import { composableTools } from '../../../js/services/tool-invoker.js';
import { MAX_EXEC_TIMEOUT_MS } from 'juggler/ops';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run the run_code tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  const item = new RunCodeContextItem({
    id: RunCodeContextItem.MANIFEST.id,
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });

  const readDef = {
    name: 'read',
    description: 'Read a file from disk.\n\nLonger explanation that follows.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path' },
        limit: { type: 'number', description: 'Lines to read' },
      },
      required: ['file_path'],
    },
  };
  const editDef = {
    name: 'edit',
    description: 'Edit a file.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
      required: ['file_path', 'old_string', 'new_string'],
    },
  };
  /**
   * @param {string} name - Tool name
   * @returns {any} A tool with a few arguments
   */
  const filler = (name) => ({
    name,
    description: `${name} does something.`,
    input_schema: { type: 'object', properties: { alpha: { type: 'string' }, beta: { type: 'number' } }, required: ['alpha'] },
  });

  await test('describeProgramTool renders one tool whole: summary and every argument', () => {
    const text = describeProgramTool(readDef);
    assert(text.includes('tools.read(args)'), `read entry missing:\n${text}`);
    assert(text.includes('Read a file from disk.') && text.includes('Longer explanation that follows.'), `the whole description:\n${text}`);
    assert(text.includes('@param {string} args.file_path - Absolute path'), `required arg missing:\n${text}`);
    assert(text.includes('@param {number} [args.limit] - Lines to read'), `optional arg missing:\n${text}`);
  });

  // Every tool a program may call is already in the model's tool list, schema
  // and all, so the SDK describes none of them: it is one rule — call them by
  // name, with the same arguments — and the short list of offered tools the
  // rule does not cover. Which tools are callable never changes its text.
  await test('the SDK is a rule, not an index of the callable tools', () => {
    const many = Array.from({ length: 40 }, (_, i) => filler(`tool_number_${i}`));
    const excluded = [{ name: 'query_code' }, { name: 'plan' }];
    const text = renderProgramSdk([readDef, editDef, ...many], excluded);
    assert(text.includes('tools.<name>('), `the rule:\n${text}`);
    assert(!text.includes('tools.read') && !text.includes('tool_number_'), `no callable tool is listed:\n${text}`);
    assert(text.includes('query_code') && text.includes('plan'), `the tools a program cannot call are named:\n${text}`);
    assert(text.includes('describeTool('), `it says how to get a tool's detail at run time:\n${text}`);
    assert(text === renderProgramSdk([readDef], excluded), 'the callable set does not change the text');
  });

  // The description rides in every request, so it is kept short: what is
  // already in the model's tool list, or in query_code's beside it, is not
  // said again. Measured over every tool this build registers.
  await test('run_code\'s description is short with every tool this build registers', async () => {
    const all = await generateToolDefinitions();
    const callable = composableTools(all);
    assert(callable.length >= 10, `expected the real tool set, got ${callable.length} tools`);
    const names = new Set(callable.map((t) => t.name));
    const excluded = all.filter((t) => !names.has(t.name) && t.name !== 'run_code');
    const [def] = /** @type {any[]} */ (RunCodeContextItem.getToolDefinitions());
    const full = `${def.description}\n\n${RunCodeContextItem.renderProgramSdk(callable, excluded)}`;
    const bytes = new TextEncoder().encode(full).length;
    assert(bytes <= 1000, `run_code's description is ${bytes} bytes, over 1000:\n${full}`);
    const code = new TextEncoder().encode(def.input_schema.properties.code.description).length;
    assert(code <= 450, `the code parameter's description is ${code} bytes, over 450`);
  });

  await test('the tools a program must not call are kept out of its SDK', async () => {
    const all = await generateToolDefinitions();
    const callable = new Set(composableTools(all).map((t) => t.name));
    // Itself and query_code (no recursion), drop_context_items (a worker meta
    // tool), create_thread (delegation is decided by the worker), plan and todo
    // (bookkeeping the model does in the open).
    const native = ['run_code', 'query_code', 'drop_context_items', 'create_thread', 'plan', 'todo'];
    const present = native.filter((name) => all.some((t) => t.name === name));
    assert(present.length === native.length, `expected all of ${native} registered, got ${present}`);
    const leaked = native.filter((name) => callable.has(name));
    assert(leaked.length === 0, `callable from a program: ${leaked}`);
    assert(callable.has('bash') && callable.has('edit'), 'the ordinary tools stay callable');
  });

  await test('the SDK of nothing says so', () => {
    const text = renderProgramSdk([]);
    assert(/no tools/i.test(text), `expected a no-tools note, got: ${text}`);
  });

  // The changes a program made are appended by the worker's projection, from
  // the call record on the item (programChangeReport), whatever ended the
  // program. The summary never lists them, even given a result that carries
  // some, or the model would read them twice.
  await test('success: result, then console, and no change list', () => {
    const s = item.getSummary({
      success: true,
      result: { result: { ok: 3 }, console: ['hello'], effects: ['edit: src/a.js'] }
    });
    const text = String(s.summary);
    const iResult = text.indexOf('"ok": 3');
    const iConsole = text.indexOf('hello');
    assert(iResult >= 0 && iConsole > iResult, `order wrong:\n${text}`);
    assert(!text.includes('Changes the program made'), `the summary must not list changes:\n${text}`);
  });

  await test('success with only a value is the value', () => {
    const s = item.getSummary({ success: true, result: { result: 'done' } });
    assert(String(s.summary) === 'done', `got: ${s.summary}`);
  });

  await test('failure: the error and console, and no change list', () => {
    const s = item.getSummary({
      success: false,
      error: "Couldn't run bash: you declined it.",
      result: { errorCode: 'program-failed', console: ['step 1'], effects: ['edit: a.js'] }
    });
    const text = String(s.summary);
    assert(text.includes("Couldn't run bash: you declined it."), `error missing:\n${text}`);
    assert(text.includes('step 1'), `console missing:\n${text}`);
    assert(!text.includes('Changes the program made'), `the summary must not list changes:\n${text}`);
  });

  /**
   * Capabilities that count their calls: an `fs` that credits each read in a
   * ledger, a `grep` function, and a `tools` namespace.
   * @param {Map<string, string>} ledger - Read credit, path → hash
   * @returns {{caps: Record<string, any>, calls: string[]}} The capabilities and the calls that reached them
   */
  const counting = (ledger) => {
    /** @type {string[]} */
    const calls = [];
    const caps = {
      fs: {
        readFile: async (/** @type {string} */ p) => {
          calls.push(`fs.readFile ${p}`);
          if (p === 'missing') throw new Error('ENOENT: missing');
          ledger.set(p, `hash-${p}`);
          return `content of ${p}`;
        },
      },
      grep: async (/** @type {string} */ pattern) => {
        calls.push(`grep ${pattern}`);
        return [{ file: 'a', line: 1, content: pattern }];
      },
      tools: new Proxy({}, {
        get: (_t, name) => async (/** @type {any} */ args) => {
          calls.push(`tools.${String(name)} ${JSON.stringify(args)}`);
          if (name === 'refused') {
            const err = new Error('it needs your approval');
            err.name = 'ToolRefused';
            throw err;
          }
          if (name === 'failing') {
            const err = new Error('exit 1');
            err.name = 'ToolError';
            throw err;
          }
          return `${String(name)} done`;
        },
      }),
    };
    return { caps, calls };
  };

  /**
   * One program's calls, made the same way every time it runs.
   * @param {Record<string, any>} c - The (wrapped) capabilities
   * @returns {Promise<unknown[]>} What each call gave back
   */
  const program = async (c) => {
    const out = [];
    out.push(await c.fs.readFile('a.txt'));
    out.push(await c.grep('needle'));
    try { await c.fs.readFile('missing'); } catch (e) { out.push(`caught ${/** @type {Error} */ (e).message}`); }
    try { await c.tools.failing({}); } catch (e) { out.push(`caught ${/** @type {Error} */ (e).message}`); }
    out.push(await c.tools.bash({ command: 'echo hi' }));
    return out;
  };

  await test('a replay answers every recorded call from the journal and calls none', async () => {
    /** @type {any[]} */
    const journal = [];
    const firstLedger = new Map();
    const first = counting(firstLedger);
    const firstOut = await program(journalCapabilities(first.caps, { journal, ledger: firstLedger, onDiverge: () => {} }));
    assert(first.calls.length === 5, `the first run calls through: ${JSON.stringify(first.calls)}`);
    assert(journal.length === 5, `every call is recorded: ${journal.length}`);

    const ledger = new Map();
    const second = counting(ledger);
    /** @type {any[]} */
    const diverged = [];
    const secondOut = await program(journalCapabilities(second.caps, { journal, ledger, onDiverge: (e) => diverged.push(e) }));
    assert(second.calls.length === 0, `a replay calls nothing: ${JSON.stringify(second.calls)}`);
    assert(JSON.stringify(secondOut) === JSON.stringify(firstOut), `a replay sees what the first run saw:\n${JSON.stringify(firstOut)}\n${JSON.stringify(secondOut)}`);
    assert(ledger.get('a.txt') === 'hash-a.txt', `a replayed read still earns its credit: ${JSON.stringify([...ledger])}`);
    assert(diverged.length === 0, 'the same calls do not diverge');
  });

  await test('a replay calls through past the end of the journal', async () => {
    /** @type {any[]} */
    const journal = [];
    const ledger = new Map();
    const first = counting(ledger);
    const wrapped = journalCapabilities(first.caps, { journal, ledger, onDiverge: () => {} });
    await wrapped.fs.readFile('a.txt');
    const second = counting(ledger);
    const replay = journalCapabilities(second.caps, { journal, ledger, onDiverge: () => {} });
    await replay.fs.readFile('a.txt');
    assert(await replay.tools.edit({ file_path: 'a.txt' }) === 'edit done', 'the new call runs');
    assert(JSON.stringify(second.calls) === JSON.stringify(['tools.edit {"file_path":"a.txt"}']), `only the new call reached through: ${JSON.stringify(second.calls)}`);
    assert(journal.length === 2, `the new call is recorded too: ${journal.length}`);
  });

  await test('a call that differs from the record at its step diverges and calls nothing', async () => {
    /** @type {any[]} */
    const journal = [];
    const ledger = new Map();
    const first = counting(ledger);
    const wrapped = journalCapabilities(first.caps, { journal, ledger, onDiverge: () => {} });
    await wrapped.tools.bash({ command: 'echo 1' });
    const cases = [
      (/** @type {any} */ c) => c.tools.bash({ command: 'echo 2' }),
      (/** @type {any} */ c) => c.tools.edit({ command: 'echo 1' }),
      (/** @type {any} */ c) => c.fs.readFile('a.txt'),
    ];
    for (const make of cases) {
      const second = counting(ledger);
      /** @type {any[]} */
      const diverged = [];
      const replay = journalCapabilities(second.caps, { journal, ledger, onDiverge: (e) => diverged.push(e) });
      let thrown = null;
      try { await make(replay); } catch (e) { thrown = e; }
      assert(thrown instanceof ProgramDiverged, `expected ProgramDiverged, got ${/** @type {any} */ (thrown)?.name}`);
      assert(diverged.length === 1 && diverged[0] === thrown, 'the divergence is reported once');
      assert(/step 1/.test(String(/** @type {any} */ (thrown).message)), `the message names the step: ${/** @type {any} */ (thrown).message}`);
      assert(second.calls.length === 0, `nothing is called: ${JSON.stringify(second.calls)}`);
    }
  });

  await test('a refusal is not recorded, so a replay asks again', async () => {
    /** @type {any[]} */
    const journal = [];
    const ledger = new Map();
    const first = counting(ledger);
    const wrapped = journalCapabilities(first.caps, { journal, ledger, onDiverge: () => {} });
    await wrapped.fs.readFile('a.txt');
    try { await wrapped.tools.refused({}); } catch { /* the program ends here */ }
    assert(journal.length === 1, `only the completed call is recorded: ${journal.length}`);
    const second = counting(ledger);
    const replay = journalCapabilities(second.caps, { journal, ledger, onDiverge: () => {} });
    await replay.fs.readFile('a.txt');
    try { await replay.tools.refused({}); } catch { /* refused again */ }
    assert(JSON.stringify(second.calls) === JSON.stringify(['tools.refused {}']), `the refused call is asked again: ${JSON.stringify(second.calls)}`);
  });

  await test('a step with no answer recorded is called through by a replay', async () => {
    const journal = [{ key: 'fs.readFile', args: '["a.txt"]', ok: true, value: 'content of a.txt' }];
    journal[2] = { key: 'tools.bash', args: '[{"command":"x"}]', ok: true, value: 'bash done' };
    const ledger = new Map();
    const second = counting(ledger);
    const replay = journalCapabilities(second.caps, { journal, ledger, onDiverge: () => {} });
    const [a, b] = await Promise.all([replay.fs.readFile('a.txt'), replay.grep('needle')]);
    assert(a === 'content of a.txt' && Array.isArray(b), 'both answer');
    assert(await replay.tools.bash({ command: 'x' }) === 'bash done', 'the recorded call after the gap is answered');
    assert(JSON.stringify(second.calls) === JSON.stringify(['grep needle']), `only the gap called through: ${JSON.stringify(second.calls)}`);
  });

  await test('a replay checks a pending step, calls it through, and records its answer', async () => {
    /** @type {any[]} */
    const journal = [
      { key: 'fs.readFile', args: '["a.txt"]', ok: true, value: 'content of a.txt' },
      { key: 'tools.edit', args: '[{"file_path":"a.txt"}]', ok: false, pending: true }
    ];
    const second = counting(new Map());
    const replay = journalCapabilities(second.caps, { journal, ledger: new Map(), onDiverge: () => {} });
    await replay.fs.readFile('a.txt');
    assert(await replay.tools.edit({ file_path: 'a.txt' }) === 'edit done', 'the held call runs');
    assert(JSON.stringify(second.calls) === JSON.stringify(['tools.edit {"file_path":"a.txt"}']), `only it calls through: ${JSON.stringify(second.calls)}`);
    assert(journal[1].ok && !journal[1].pending && journal[1].value === 'edit done', `recorded: ${JSON.stringify(journal[1])}`);
    let thrown = null;
    const other = journalCapabilities(counting(new Map()).caps, {
      journal: [{ key: 'tools.edit', args: '[{"file_path":"a.txt"}]', ok: false, pending: true }], ledger: new Map(), onDiverge: () => {}
    });
    try { await other.tools.write({ file_path: 'a.txt' }); } catch (e) { thrown = e; }
    assert(thrown instanceof ProgramDiverged, `another call at a pending step diverges: ${/** @type {any} */ (thrown)?.name}`);
  });

  /**
   * Reads whose answers the test releases, in the order it chooses.
   * @returns {{caps: Record<string, any>, release: (p: string) => void, made: string[]}} The capabilities
   */
  const releasedReads = () => {
    /** @type {Map<string, (v: string) => void>} */
    const waiting = new Map();
    /** @type {string[]} */
    const made = [];
    const caps = {
      fs: { readFile: (/** @type {string} */ p) => new Promise((resolve) => waiting.set(p, resolve)) },
      tools: new Proxy({}, {
        get: (_t, name) => async (/** @type {any} */ args) => {
          made.push(`tools.${String(name)} ${JSON.stringify(args)}`);
          return new Promise(() => {});
        }
      }),
    };
    return { caps, release: (p) => waiting.get(p)?.(`content of ${p}`), made };
  };

  /**
   * Each file read, then edited, all at once.
   * @param {Record<string, any>} c - The (wrapped) capabilities
   * @returns {Promise<unknown>} Every edit's outcome
   */
  const readThenEditEach = (c) => Promise.allSettled(['a.txt', 'b.txt'].map(async (f) => {
    await c.fs.readFile(f);
    return c.tools.edit({ file_path: f });
  }));

  // Concurrent calls take their steps in the order the answers before them
  // arrive. A replay gives recorded answers as they are asked for, not in the
  // order they first came, so a program whose next call depends on that order
  // can take its steps in another order: it diverges, and nothing from that
  // step on runs, rather than a call being made twice.
  await test('a replay whose concurrent calls come in another order diverges, and runs nothing', async () => {
    const first = releasedReads();
    /** @type {any[]} */
    const journal = [];
    const wrapped = journalCapabilities(first.caps, { journal, ledger: new Map(), onDiverge: () => {} });
    void readThenEditEach(wrapped);
    await Promise.resolve();
    first.release('b.txt');
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.release('a.txt');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(JSON.stringify(first.made) === JSON.stringify(['tools.edit {"file_path":"b.txt"}', 'tools.edit {"file_path":"a.txt"}']),
      `b.txt answered first, so its edit came first: ${JSON.stringify(first.made)}`);
    const snap = wrapped.snapshot();
    assert(snap[2]?.pending && snap[2].args === '[{"file_path":"b.txt"}]' && snap[3]?.pending,
      `both edits wait, b.txt's first: ${JSON.stringify(snap)}`);

    const second = counting(new Map());
    /** @type {any[]} */
    const diverged = [];
    const replay = journalCapabilities(second.caps, { journal: snap, ledger: new Map(), onDiverge: (e) => diverged.push(e) });
    await readThenEditEach(replay);
    assert(diverged.length >= 1 && /step 3/.test(diverged[0].message), `it diverges at the held step: ${diverged.map((e) => e.message)}`);
    assert(second.calls.length === 0, `and calls nothing: ${JSON.stringify(second.calls)}`);
  });

  await test('stepNow names the step of the call being made, while it is made', async () => {
    /** @type {any} */
    let wrapped = null;
    /** @type {Array<number|null>} */
    const seen = [];
    const caps = {
      fs: { readFile: async () => 'x' },
      tools: new Proxy({}, { get: () => async () => { seen.push(wrapped.stepNow()); return 'done'; } }),
    };
    wrapped = journalCapabilities(caps, { journal: [], ledger: new Map(), onDiverge: () => {} });
    await wrapped.fs.readFile('a');
    await Promise.all([wrapped.tools.edit({}), wrapped.tools.bash({})]);
    assert(JSON.stringify(seen) === '[1,2]', `each call sees its own step: ${JSON.stringify(seen)}`);
    assert(wrapped.stepNow() === null, 'and none outside a call');
    assert(!Object.keys(wrapped).includes('stepNow') && !Object.keys(wrapped).includes('snapshot'), 'the program sees neither');
  });

  await test('a snapshot keeps what answered and marks what has not as pending', async () => {
    const reads = releasedReads();
    /** @type {any[]} */
    const journal = [];
    const wrapped = journalCapabilities({ ...reads.caps, grep: async () => [] }, { journal, ledger: new Map(), onDiverge: () => {} });
    await wrapped.grep('x');
    void wrapped.fs.readFile('still-running');
    void wrapped.tools.edit({ file_path: 'held' });
    const snap = wrapped.snapshot();
    assert(snap[0]?.key === 'grep' && snap[0].ok && !snap[0].pending, `what answered is kept: ${JSON.stringify(snap[0])}`);
    assert(snap[1]?.key === 'fs.readFile' && snap[1].pending, `a read still running is pending: ${JSON.stringify(snap[1])}`);
    assert(snap[2]?.key === 'tools.edit' && snap[2].pending, `the held call is pending: ${JSON.stringify(snap[2])}`);
    assert(journal.length === 1, 'the journal itself is not changed');
    reads.release('still-running');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(wrapped.snapshot()[1]?.ok, 'once answered, the read is kept as done');
  });

  // A replay whose calls come in another order must not make a call that ran
  // before the snapshot at a step it did not take: the pending steps are
  // checked too, so it diverges instead.
  await test('a write that ran cannot be made again at a pending read\'s step', async () => {
    const journal = [
      { key: 'fs.readFile', args: '["r"]', ok: false, pending: true },
      { key: 'tools.write', args: '[{"path":"w"}]', ok: true, value: 'write done' },
    ];
    const second = counting(new Map());
    /** @type {any[]} */
    const diverged = [];
    const replay = journalCapabilities(second.caps, { journal, ledger: new Map(), onDiverge: (e) => diverged.push(e) });
    await replay.tools.write({ path: 'w' }).catch(() => {});
    await replay.fs.readFile('r').catch(() => {});
    assert(diverged.length === 1, `it diverges: ${diverged.length}`);
    assert(second.calls.length === 0, `and the write is not made again: ${JSON.stringify(second.calls)}`);
  });

  // The program's clock stops while a call waits on the user. What must not
  // happen is fenced by a longer timer armed after the one under test: timers
  // fire in the order of their deadlines, so had the paused or stopped timer
  // still been armed it would have fired first, however slow the core. What
  // must happen is waited for, so a busy machine only makes it slower.
  /**
   * Wait for a timer of `ms`, armed now, to fire.
   * @param {number} ms - Longer than any timer it fences
   * @param {string} what - Named in the failure
   * @returns {Promise<void>}
   */
  const timerFence = async (ms, what) => {
    let fenced = false;
    setTimeout(() => { fenced = true; }, ms);
    await waitFor(() => fenced, what);
  };

  await test('a pausable timer counts only the time it runs', async () => {
    let fired = 0;
    const timer = pausableTimer(150, () => { fired++; });
    timer.pause();
    timer.pause();
    await timerFence(400, 'a timer outlasting the paused one to fire');
    assert(fired === 0, 'it does not fire while paused, however long');
    timer.resume();
    timer.resume();
    await waitFor(() => fired > 0, 'the resumed timer to fire', 10000);
    assert(fired === 1, `it fires once resumed, once: ${fired}`);

    let stoppedFired = 0;
    const stopped = pausableTimer(50, () => { stoppedFired++; });
    stopped.pause();
    stopped.stop();
    stopped.resume();
    await timerFence(200, 'a timer outlasting the stopped one to fire');
    assert(stoppedFired === 0, 'a stopped timer never fires, even resumed');
  });

  await test('the tool declares its gates', () => {
    assert(RunCodeContextItem.MANIFEST.id === 'run-code', `id: ${RunCodeContextItem.MANIFEST.id}`);
    const [def] = /** @type {any[]} */ (RunCodeContextItem.getToolDefinitions());
    assert(def.name === 'run_code' && def.category === 'write', `def: ${def.name} ${def.category}`);
    assert(!/refused/.test(def.description), `must not promise a refusal for a call that asks: ${def.description}`);
    const sdk = `${def.description}\n\n${RunCodeContextItem.renderProgramSdk([{ name: 'bash', category: 'write', description: 'Run a command', input_schema: { type: 'object', properties: {} } }], [])}`;
    assert(!/refused/.test(sdk) && /approv/.test(sdk), `the description says a call that asks waits for the user: ${sdk}`);
    assert(def.programSdk === true, 'must carry the generated SDK');
    assert(!/experimental/i.test(RunCodeContextItem.MANIFEST.description), `the catalog line: ${RunCodeContextItem.MANIFEST.description}`);
    assert(/image\(/.test(def.input_schema.properties.code.description), 'the code parameter names image()');
  });

  // A program's time includes its tool calls, so it may run as long as one
  // bash call may, or it would cut short a command it was allowed to run.
  await test('a program\'s timeout goes as high as bash\'s', async () => {
    const atMax = await item.validate({ code: 'return 1', timeout: MAX_EXEC_TIMEOUT_MS });
    assert(atMax.valid === true, `bash's longest timeout is a program's too: ${JSON.stringify(atMax)}`);
    const over = await item.validate({ code: 'return 1', timeout: MAX_EXEC_TIMEOUT_MS + 1 });
    assert(over.valid === false && String(over.error).includes(String(MAX_EXEC_TIMEOUT_MS)), `and no higher: ${JSON.stringify(over)}`);
    const [def] = /** @type {any[]} */ (RunCodeContextItem.getToolDefinitions());
    assert(def.input_schema.properties.timeout.description.includes(String(MAX_EXEC_TIMEOUT_MS)), 'the schema says so');
  });

  await test('a program\'s images: handles, checked, capped, carried into a replay', async () => {
    const ref = (/** @type {string} */ id) => ({ id: id.repeat(64).slice(0, 64), mime: 'image/png', bytes: 3, width: 4, height: 5 });
    /** @type {string[][]} */
    const heldCalls = [];
    const images = createProgramImages({ max: 2, onHeld: (ids) => heldCalls.push(ids) });
    const [h] = images.receive([ref('a')], 'shot.png');
    assert(h.image === ref('a').id && h.width === 4 && h.label === 'shot.png' && !('id' in h), `a handle: ${JSON.stringify(h)}`);
    assert(JSON.stringify(heldCalls.at(-1)) === JSON.stringify([ref('a').id]), 'what it was given is held at once');
    await images.show(h);
    await images.show({ ...h });
    assert(images.shown().length === 1, 'the same image attaches once');
    let forged = '';
    try { await images.show({ image: ref('z').id }); } catch (e) { forged = /** @type {Error} */ (e).message; }
    assert(forged.includes("Couldn't attach that image"), `a handle it was never given: ${forged}`);
    let noPath = '';
    try { await images.show('x.png'); } catch (e) { noPath = /** @type {Error} */ (e).message; }
    assert(noPath.includes('takes a handle'), `without a loader, no paths: ${noPath}`);
    const [b, c] = images.receive([ref('b'), ref('c')]);
    await images.show(b);
    let capped = '';
    try { await images.show(c); } catch (e) { capped = /** @type {Error} */ (e).message; }
    assert(capped.includes('at most 2 images'), `capped: ${capped}`);
    // A replay starts from what the run before it was given: a replayed call's
    // handle comes back from the journal, not from the call.
    const next = createProgramImages({ received: images.received });
    await next.show(h);
    assert(next.shown()[0]?.id === ref('a').id, 'a handle from the run before still attaches');
    assert(attachedImagesNote(next.shown(), next.labelOf) === '\n\nImages attached below:\n- shot.png (4×5)', `the note: ${attachedImagesNote(next.shown(), next.labelOf)}`);
    assert(attachedImagesNote([]) === '', 'no images, no note');
  });

  return { passed, failed, errors };
}
