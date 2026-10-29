//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for the tool invoker (services/tool-invoker.js): how a program
 * tool's `tools.*` calls are admitted, decided, scheduled, cancelled and
 * recorded. The offered set, the decision, the execution and the cancel are
 * injected, so what is under test is the invoker's own rules.
 *
 * Contract under test:
 *   1. A tool the thread was not offered, or one that stays native, is refused
 *      with the worker's wording before anything runs, and the refusal is
 *      catchable.
 *   2. A call the gate would park or deny ends the program: ToolRefused, the
 *      onRefused callback, and every later call refused unrun — never put to
 *      the decision, so no hook of the user's runs for it.
 *   2a. A call made with the user's answer (`how.answer`) runs on it without
 *      being decided, an elicitation's answer folded into its input.
 *   2b. With waitForUser, a parked call waits for the user instead: it is held
 *      (`hold`) while the program lives on, and runs once they answer, or is
 *      decided again when the answer was not theirs to give. A held write
 *      holds back every later call; a held read lets reads by. Holds take
 *      turns, one card at a time. `beforeHold` sees each before it is shown,
 *      with its call's tag, and `afterHold` after. A hold that is refused
 *      ends the program, as does a `beforeHold` that throws; `end()` releases
 *      every hold and, if one was ever held, the item with them.
 *   3. A failed call is a catchable ToolError carrying the tool's own text.
 *   4. No more than `limit` calls run at once; the rest queue.
 *   5. Calls keep the program's order: reads overlap, anything else waits for
 *      every earlier call and holds back every later one.
 *   6. Abort cancels every running call and refuses every queued one.
 *   7. The record holds name, clipped args, status, duration, error and effect —
 *      never a result — is bounded, and gives up reads before effects. Only a
 *      call that ran keeps its effect.
 * @module unit-tests/tool-invoker-test
 */

import { assert, nextTask } from '../utilities/test-helpers.js';
import { createToolInvoker, ToolError, ToolRefused } from '../../js/services/tool-invoker.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

const OFFERED = [
  { name: 'read', category: 'read' },
  { name: 'ask', category: 'meta' },
  { name: 'grep', category: 'read' },
  { name: 'edit', category: 'write' },
  { name: 'bash', category: 'write' },
  { name: 'keep_notes', category: 'meta', composable: false },
  { name: 'other_program', category: 'write', programSdk: true },
];

/**
 * An invoker whose executions are held open until the test releases them.
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {number} [opts.maxRecords]
 * @param {(call: any) => any} [opts.decide] - Decision per call; approve by default
 * @param {boolean} [opts.waitForUser] - Hold a parked call instead of refusing it
 * @param {(request: any) => Promise<void>} [opts.beforeHold] - Run before each hold, after it is logged
 * @returns {any} The invoker plus its controls
 */
function harness(opts = {}) {
  /**
   * The calls held for the user, each with the controls that answer it.
   * @type {Array<{request: any, answer: (a: any) => void, refuse: (e: Error) => void, signal: AbortSignal}>}
   */
  const holds = [];
  /** @type {string[]} */
  const events = [];
  let released = 0;
  /** @type {Array<{toolName: string, toolUseId: string, input: any, settle: (r: any) => void}>} */
  const started = [];
  /** @type {any[]} */
  const decided = [];
  /** @type {string[]} */
  const cancelled = [];
  /** @type {any[]} */
  const refusals = [];
  const controller = new AbortController();
  const invoker = createToolInvoker({
    parentToolUseId: 'parent-1',
    signal: controller.signal,
    onRefused: (/** @type {any} */ err) => refusals.push(err),
    waitForUser: opts.waitForUser,
    beforeHold: async (/** @type {any} */ request, /** @type {unknown} */ tag) => {
      events.push(`before:${request.name}:${String(tag)}`);
      await opts.beforeHold?.(request);
    },
    afterHold: () => { events.push('after'); },
    limit: opts.limit,
    maxRecords: opts.maxRecords,
    deps: {
      offeredTools: async () => OFFERED,
      decide: async (/** @type {any} */ call) => {
        decided.push(call);
        return opts.decide ? opts.decide(call) : { verdict: 'approve', reason: '' };
      },
      run: (/** @type {any} */ call) => new Promise((resolve) => {
        started.push({ ...call, settle: resolve });
      }),
      cancel: (/** @type {string} */ toolUseId) => {
        cancelled.push(toolUseId);
        const s = started.find((c) => c.toolUseId === toolUseId);
        s?.settle({ success: false, cancelled: true, content: 'Action was cancelled.' });
      },
      holdRequest: async (/** @type {any} */ call, /** @type {any} */ decision) => ({
        name: call.name, input: call.args, reason: decision.reason, approvalOptions: { options: [] }
      }),
      hold: (/** @type {any} */ request, /** @type {AbortSignal} */ signal) => new Promise((resolve, reject) => {
        events.push(`hold:${request.name}`);
        const entry = { request, answer: resolve, refuse: reject, signal };
        holds.push(entry);
        signal.addEventListener('abort', () => reject(new ToolRefused('The program ended.')), { once: true });
      }),
      release: () => { released++; },
      answer: (/** @type {string} */ name, /** @type {any} */ input, /** @type {string} */ response) => (
        name === 'ask' ? { ...input, answer: response } : input),
    },
  });
  /** @returns {string[]} The names of the calls started so far, in order */
  const startedNames = () => started.map((c) => c.toolName);
  /**
   * @param {string} toolName
   * @param {any} [result]
   */
  const finish = (toolName, result = { success: true, content: `${toolName} done` }) => {
    const s = started.find((c) => c.toolName === toolName && !(/** @type {any} */ (c)).done);
    assert(s, `${toolName} should have started`);
    /** @type {any} */ (s).done = true;
    /** @type {any} */ (s).settle(result);
  };
  return {
    invoker, started, decided, startedNames, finish, cancelled, refusals, controller, holds, events,
    released: () => released
  };
}

/**
 * Await a promise expected to reject, and return what it rejected with.
 * @param {Promise<any>} p
 * @returns {Promise<any>} The rejection
 */
async function rejection(p) {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

/**
 * Run all tool-invoker tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
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

  await test('an un-offered tool is refused with the worker wording', async () => {
    const h = harness();
    const err = await rejection(h.invoker.invoke('WebSearch', { query: 'x' }));
    assert(err instanceof ToolError, `expected ToolError, got ${err?.name}`);
    assert(err.message === "Couldn't run WebSearch: it wasn't available in this thread.", `wording: ${err.message}`);
    assert(h.started.length === 0, 'nothing may run');
    assert(h.refusals.length === 0, 'an unavailable tool does not end the program');
    const rec = h.invoker.record.calls[0];
    assert(rec?.name === 'WebSearch' && rec.status === 'error', `recorded: ${JSON.stringify(rec)}`);
  });

  await test('a tool that stays native is refused the same way', async () => {
    const h = harness();
    // Declared not composable, and a program tool: neither is callable from a program.
    for (const name of ['keep_notes', 'other_program']) {
      const err = await rejection(h.invoker.invoke(name, {}));
      assert(err instanceof ToolError && err.message === `Couldn't run ${name}: it wasn't available in this thread.`, `got ${err?.message}`);
    }
    assert(h.started.length === 0, 'nothing may run');
  });

  // A program is told to call the tools in the model's tool list, and some
  // providers list them under a prefix (Claude Code's `mcp__juggler__`). Either
  // spelling is the tool, recorded by its own name; the prefix admits nothing
  // the bare name would not.
  await test('a tool named as a provider lists it is the tool itself', async () => {
    const h = harness();
    const call = h.invoker.invoke('mcp__juggler__read', { file_path: 'a' });
    await nextTask();
    assert(h.startedNames().join(',') === 'read', `the prefixed name runs read: ${h.startedNames()}`);
    h.finish('read');
    assert(await call === 'read done', 'and answers as read');
    assert(h.invoker.record.calls[0]?.name === 'read', `recorded by its own name: ${JSON.stringify(h.invoker.record.calls[0])}`);
    const err = await rejection(h.invoker.invoke('mcp__juggler__keep_notes', {}));
    assert(err instanceof ToolError && err.message === "Couldn't run mcp__juggler__keep_notes: it wasn't available in this thread.",
      `a prefix does not admit a native tool: ${err?.message}`);
  });

  await test('without waitForUser, a parked call ends the program', async () => {
    const h = harness({ decide: () => ({ verdict: 'park', reason: 'it needs your approval' }) });
    const err = await rejection(h.invoker.invoke('bash', { command: 'rm x' }));
    assert(err instanceof ToolRefused, `expected ToolRefused, got ${err?.name}`);
    assert(err.message === "Couldn't run bash: it needs your approval, so call it directly.", `wording: ${err.message}`);
    assert(h.refusals.length === 1, 'onRefused fires once');
    assert(h.invoker.record.calls[0].status === 'refused', 'recorded as refused');
    const later = await rejection(h.invoker.invoke('read', { file_path: 'a' }));
    assert(later instanceof ToolRefused, 'a call after a refusal is refused');
    assert(h.started.length === 0, 'nothing runs after a refusal');
  });

  await test('a denied call ends the program with the hook reason', async () => {
    const h = harness({ decide: () => ({ verdict: 'deny', reason: 'Blocked by hook "g": no' }) });
    const err = await rejection(h.invoker.invoke('bash', { command: 'x' }));
    assert(err instanceof ToolRefused && err.message === 'Couldn\'t run bash: Blocked by hook "g": no', `got ${err?.message}`);
  });

  await test('a denied call releases nothing queued behind it', async () => {
    const h = harness({
      decide: (/** @type {any} */ call) => (call.toolName === 'bash'
        ? { verdict: 'deny', reason: 'Blocked by hook "g": no' } : { verdict: 'approve', reason: '' })
    });
    const denied = h.invoker.invoke('bash', { command: 'x' });
    const behind = h.invoker.invoke('edit', { file_path: 'a' });
    const errs = await Promise.all([rejection(denied), rejection(behind)]);
    await nextTask();
    assert(errs.every((e) => e instanceof ToolRefused), `both refused: ${errs.map((e) => e?.name)}`);
    assert(h.decided.length === 1 && h.decided[0].toolName === 'bash',
      `the call behind a denial is never put to the decision (its hooks would run): ${h.decided.map((/** @type {any} */ c) => c.toolName)}`);
    const edit = h.invoker.record.calls.find((/** @type {any} */ c) => c.name === 'edit');
    assert(edit?.status === 'refused' && edit.effect === undefined, `it never ran, so it changed nothing: ${JSON.stringify(edit)}`);
  });

  await test('a write interrupted while it is being decided changed nothing', async () => {
    /** @type {(v: any) => void} */
    let release = () => {};
    const h = harness({ decide: () => new Promise((resolve) => { release = resolve; }) });
    const p = h.invoker.invoke('bash', { command: 'rm x' });
    await nextTask();
    h.controller.abort();
    release({ verdict: 'approve', reason: '' });
    const err = await rejection(p);
    assert(err instanceof ToolRefused, `refused: ${err?.name}`);
    assert(h.started.length === 0, 'it never ran');
    const rec = h.invoker.record.calls[0];
    assert(rec.status === 'cancelled' && rec.effect === undefined, `no effect for a call that never ran: ${JSON.stringify(rec)}`);
  });

  await test('a call made with the user\'s answer runs on it, undecided', async () => {
    const h = harness({ decide: () => ({ verdict: 'park', reason: 'it needs your approval' }) });
    const p = h.invoker.invoke('bash', { command: 'rm a' }, { answer: 'yes' });
    await nextTask();
    assert(h.decided.length === 0, `it is not put to the decision: ${h.decided.length}`);
    h.finish('bash');
    assert(await p === 'bash done', 'and runs');
    const other = await rejection(h.invoker.invoke('bash', { command: 'rm b' }));
    assert(other instanceof ToolRefused, `a call made without one is decided, and parks: ${other?.name}`);

    const q = harness({ decide: () => ({ verdict: 'park', reason: 'it needs your answer' }) });
    const asked = q.invoker.invoke('ask', { question: 'which?' }, { answer: 'B' });
    await nextTask();
    assert(q.started[0]?.input?.answer === 'B', `an elicitation's answer is folded in: ${JSON.stringify(q.started[0]?.input)}`);
    q.finish('ask');
    await asked;
  });

  /**
   * A decision that parks the named tools until told otherwise, and approves
   * everything else.
   * @param {string[]} parked - Tools that park
   * @returns {(call: any) => {verdict: string, reason: string}} The decision
   */
  const parks = (parked) => (call) => (parked.includes(call.toolName)
    ? { verdict: 'park', reason: 'it needs your approval' } : { verdict: 'approve', reason: '' });

  await test('a parked call waits for the user, and runs once they answer', async () => {
    const h = harness({ waitForUser: true, decide: parks(['bash']) });
    const p = h.invoker.invoke('bash', { command: 'rm x' }, { tag: 7 });
    await nextTask();
    assert(h.holds.length === 1 && h.holds[0].request.name === 'bash', `held: ${h.holds.length}`);
    assert(h.started.length === 0, 'it does not run while held');
    assert(h.refusals.length === 0, 'and the program is not ended');
    const rec = h.invoker.record.calls[0];
    assert(rec.status === 'held' && rec.effect === undefined,
      `recorded as waiting, with no effect until it runs: ${JSON.stringify(rec)}`);
    assert(h.events.join(',') === 'before:bash:7,hold:bash', `beforeHold first, with the call's tag: ${h.events}`);
    h.holds[0].answer({ response: 'yes' });
    await nextTask();
    assert(h.startedNames().join(',') === 'bash', `it runs once answered: ${h.startedNames()}`);
    assert(h.events.at(-1) === 'after', `afterHold once answered: ${h.events}`);
    h.finish('bash');
    assert(await p === 'bash done', 'and answers the program');
    assert(h.invoker.record.calls[0].status === 'ok' && h.invoker.record.calls[0].effect === 'bash: rm x',
      `its effect is back once it ran: ${JSON.stringify(h.invoker.record.calls[0])}`);
    assert(h.decided.length === 1, 'it is decided once');
  });

  await test('a held write holds back every later call; a held read lets reads by', async () => {
    const w = harness({ waitForUser: true, decide: parks(['edit']) });
    const edit = w.invoker.invoke('edit', { file_path: 'a' });
    const read = w.invoker.invoke('read', { file_path: 'b' });
    await nextTask();
    assert(w.startedNames().length === 0, `nothing starts past a held write: ${w.startedNames()}`);
    w.holds[0].answer({ response: 'yes' });
    await nextTask();
    w.finish('edit');
    await nextTask();
    assert(w.startedNames().join(',') === 'edit,read', `the read follows it: ${w.startedNames()}`);
    w.finish('read');
    await Promise.all([edit, read]);

    const r = harness({ waitForUser: true, decide: parks(['ask']) });
    const ask = r.invoker.invoke('ask', {});
    const next = r.invoker.invoke('read', { file_path: 'b' });
    const write = r.invoker.invoke('edit', { file_path: 'c' });
    await nextTask();
    assert(r.startedNames().join(',') === 'read', `a read passes a held question, a write does not: ${r.startedNames()}`);
    r.finish('read');
    assert(await next === 'read done', 'the read answers while the question waits');
    r.holds[0].answer({ response: 'B' });
    await nextTask();
    assert(r.started.find((c) => c.toolName === 'ask')?.input?.answer === 'B', 'the answer is folded into the question');
    r.finish('ask');
    await nextTask();
    r.finish('edit');
    await Promise.all([ask, write]);
  });

  await test('a hold answered with redecide puts the call to the decision again', async () => {
    let parked = true;
    const h = harness({ waitForUser: true, decide: (/** @type {any} */ call) => (parked && call.toolName === 'bash'
      ? { verdict: 'park', reason: 'it needs your approval' } : { verdict: 'approve', reason: '' }) });
    const p = h.invoker.invoke('bash', { command: 'x' });
    await nextTask();
    parked = false;
    h.holds[0].answer({ redecide: true });
    await nextTask();
    assert(h.decided.length === 2, `decided again: ${h.decided.length}`);
    assert(h.startedNames().join(',') === 'bash', 'and run on the new verdict');
    h.finish('bash');
    await p;

    const again = harness({ waitForUser: true, decide: parks(['bash']) });
    const q = again.invoker.invoke('bash', { command: 'x' });
    await nextTask();
    again.holds[0].answer({ redecide: true });
    await nextTask();
    assert(again.holds.length === 2 && again.started.length === 0, 'a call that parks again is held again, unrun');
    again.holds[1].answer({ response: 'yes' });
    await nextTask();
    again.finish('bash');
    await q;
  });

  await test('a refused hold ends the program', async () => {
    const h = harness({ waitForUser: true, decide: parks(['bash']) });
    const p = h.invoker.invoke('bash', { command: 'x' });
    const behind = h.invoker.invoke('edit', { file_path: 'a' });
    await nextTask();
    h.holds[0].refuse(new ToolRefused('Couldn\'t run bash: you declined it.'));
    const errs = await Promise.all([rejection(p), rejection(behind)]);
    assert(errs.every((e) => e instanceof ToolRefused), `both refused: ${errs.map((e) => e?.name)}`);
    assert(h.refusals.length === 1 && h.refusals[0].message === 'Couldn\'t run bash: you declined it.', `onRefused once: ${h.refusals.map((/** @type {any} */ e) => e.message)}`);
    assert(h.started.length === 0, 'nothing ran');
    const rec = h.invoker.record.calls.map((/** @type {any} */ c) => `${c.name}:${c.status}:${c.effect ?? '-'}`).join(',');
    assert(rec === 'bash:refused:-,edit:refused:-', `neither changed anything: ${rec}`);
  });

  await test('holds take turns', async () => {
    const h = harness({ waitForUser: true, decide: parks(['read']) });
    const a = h.invoker.invoke('read', { file_path: 'a' });
    const b = h.invoker.invoke('read', { file_path: 'b' });
    await nextTask();
    assert(h.holds.length === 1, `one card at a time: ${h.holds.length}`);
    h.holds[0].answer({ response: 'yes' });
    await nextTask();
    assert(h.holds.length === 2 && h.holds[1].request.input.file_path !== h.holds[0].request.input.file_path,
      'the other is held once the first is answered');
    h.holds[1].answer({ response: 'yes' });
    await nextTask();
    h.finish('read');
    h.finish('read');
    await Promise.all([a, b]);
    assert(h.events.filter((e) => e === 'after').length === 2, `afterHold for each: ${h.events}`);
  });

  await test('end() releases every hold and the item', async () => {
    const h = harness({ waitForUser: true, decide: parks(['bash']) });
    const p = h.invoker.invoke('bash', { command: 'x' });
    await nextTask();
    h.invoker.end();
    const err = await rejection(p);
    assert(err instanceof ToolRefused, `the held call is refused: ${err?.name}`);
    assert(h.started.length === 0, 'and never runs');
    assert(h.released() === 1, `the item is released: ${h.released()}`);
  });

  await test('a beforeHold that throws ends the program, and nothing is held or run', async () => {
    const h = harness({
      waitForUser: true, decide: parks(['bash']),
      beforeHold: async () => { throw new Error('snapshot failed'); }
    });
    const p = h.invoker.invoke('bash', { command: 'x' });
    const err = await rejection(p);
    assert(err instanceof ToolRefused && err.message === 'snapshot failed', `refused with its reason: ${err?.name} ${err?.message}`);
    assert(h.holds.length === 0 && h.started.length === 0, 'never held, never run');
    assert(h.refusals.length === 1, 'onRefused once');
    assert(h.events.at(-1) === 'after', `afterHold still told: ${h.events}`);
  });

  await test('an abort refuses a hold still waiting its turn, which is never shown', async () => {
    const h = harness({ waitForUser: true, decide: parks(['read']) });
    const a = h.invoker.invoke('read', { file_path: 'a' });
    const b = h.invoker.invoke('read', { file_path: 'b' });
    await nextTask();
    assert(h.holds.length === 1, `one shown: ${h.holds.length}`);
    h.controller.abort();
    const errs = await Promise.all([rejection(a), rejection(b)]);
    await nextTask();
    assert(errs.every((e) => e instanceof ToolRefused), `both refused: ${errs.map((e) => e?.name)}`);
    assert(h.holds.length === 1 && h.started.length === 0, `the waiting one never shown, neither run: ${h.holds.length}`);
  });

  await test('end() with nothing ever held releases nothing', async () => {
    const h = harness({ waitForUser: true });
    const p = h.invoker.invoke('read', { file_path: 'a' });
    await nextTask();
    h.finish('read');
    await p;
    h.invoker.end();
    assert(h.released() === 0, `the item was never held, so is not touched: ${h.released()}`);
  });

  await test('an abort refuses a held call', async () => {
    const h = harness({ waitForUser: true, decide: parks(['bash']) });
    const p = h.invoker.invoke('bash', { command: 'x' });
    await nextTask();
    h.controller.abort();
    const err = await rejection(p);
    assert(err instanceof ToolRefused && h.started.length === 0, `refused unrun: ${err?.name}`);
    assert(h.invoker.record.calls[0].status === 'cancelled', `recorded as cancelled: ${JSON.stringify(h.invoker.record.calls[0])}`);
  });

  await test('an invalid call is a catchable ToolError', async () => {
    const h = harness({ decide: () => ({ verdict: 'invalid', reason: 'Missing required parameter: file_path' }) });
    const err = await rejection(h.invoker.invoke('read', {}));
    assert(err instanceof ToolError && err.message === "Couldn't run read: Missing required parameter: file_path", `got ${err?.message}`);
    assert(h.refusals.length === 0, 'an invalid call does not end the program');
  });

  await test('a failed call is a catchable ToolError with the tool text', async () => {
    const h = harness();
    const p = h.invoker.invoke('bash', { command: 'false' });
    await nextTask();
    h.finish('bash', { success: false, content: 'exit 1' });
    const err = await rejection(p);
    assert(err instanceof ToolError && err.message === 'exit 1', `got ${err?.name} ${err?.message}`);
    assert(h.invoker.record.calls[0].status === 'error' && h.invoker.record.calls[0].error === 'exit 1', 'recorded as error');
  });

  await test('a successful call resolves to its content', async () => {
    const h = harness();
    const p = h.invoker.invoke('read', { file_path: 'a.js' });
    await nextTask();
    h.finish('read', { success: true, content: 'file text' });
    assert(await p === 'file text', 'resolves to the content');
    const rec = h.invoker.record.calls[0];
    assert(rec.status === 'ok' && typeof rec.durationMs === 'number', `record: ${JSON.stringify(rec)}`);
    assert(!('result' in rec) && !('content' in rec), 'the record never holds a result');
  });

  await test('a call\'s attachments are handed over only when asked for', async () => {
    const h = harness();
    const ref = { id: 'abc123', mime: 'image/png', bytes: 10, width: 2, height: 3 };
    const plain = h.invoker.invoke('read', { file_path: 'a.png' });
    const detailed = h.invoker.invoke('read', { file_path: 'a.png' }, { withAttachments: true });
    const none = h.invoker.invoke('read', { file_path: 'b.txt' }, { withAttachments: true });
    await nextTask();
    h.finish('read', { success: true, content: 'Read image a.png', attachments: [ref] });
    h.finish('read', { success: true, content: 'Read image a.png', attachments: [ref] });
    h.finish('read', { success: true, content: 'text' });
    assert(await plain === 'Read image a.png', 'without asking, a call still resolves to its content');
    const got = await detailed;
    assert(got?.content === 'Read image a.png' && got.attachments?.length === 1 && got.attachments[0].id === 'abc123',
      `asked for, the attachments come with the content: ${JSON.stringify(got)}`);
    const bare = await none;
    assert(bare?.content === 'text' && Array.isArray(bare.attachments) && bare.attachments.length === 0,
      `a call with none resolves an empty list: ${JSON.stringify(bare)}`);
    assert(h.invoker.record.calls.every((/** @type {any} */ c) => !('attachments' in c)), 'the record never holds attachments');
  });

  await test('at most `limit` calls run at once', async () => {
    const h = harness({ limit: 4 });
    const ps = [1, 2, 3, 4, 5].map((n) => h.invoker.invoke('read', { file_path: `f${n}` }));
    await nextTask();
    assert(h.started.length === 4, `4 should start, got ${h.started.length}`);
    h.finish('read');
    await nextTask();
    assert(h.started.length === 5, 'the fifth starts when one finishes');
    for (let i = 0; i < 4; i++) h.finish('read');
    await Promise.all(ps);
  });

  await test('a write waits for earlier calls and holds later ones', async () => {
    const h = harness();
    const r1 = h.invoker.invoke('read', { file_path: 'a' });
    const r2 = h.invoker.invoke('grep', { pattern: 'x' });
    const w = h.invoker.invoke('edit', { file_path: 'a' });
    const r3 = h.invoker.invoke('read', { file_path: 'a' });
    await nextTask();
    assert(h.startedNames().join() === 'read,grep', `wave 1: ${h.startedNames()}`);
    h.finish('read');
    await nextTask();
    assert(h.startedNames().join() === 'read,grep', 'the write waits for every earlier call');
    h.finish('grep');
    await nextTask();
    assert(h.startedNames().join() === 'read,grep,edit', `wave 2: ${h.startedNames()}`);
    h.finish('edit');
    await nextTask();
    assert(h.startedNames().join() === 'read,grep,edit,read', `wave 3: ${h.startedNames()}`);
    h.finish('read');
    await Promise.all([r1, r2, w, r3]);
  });

  await test('abort cancels running calls and refuses queued ones', async () => {
    const h = harness({ limit: 2 });
    const ps = [1, 2, 3].map((n) => h.invoker.invoke('read', { file_path: `f${n}` }));
    await nextTask();
    assert(h.started.length === 2, 'two running');
    h.controller.abort();
    const errs = await Promise.all(ps.map(rejection));
    assert(h.cancelled.length === 2, `both running calls cancelled, got ${h.cancelled}`);
    assert(h.started.length === 2, 'the queued call never starts');
    assert(errs.every((e) => e instanceof ToolRefused), `all refused: ${errs.map((e) => e?.name)}`);
    assert(h.invoker.record.calls.every((/** @type {any} */ c) => c.status === 'cancelled'), 'all recorded as cancelled');
  });

  await test('args are clipped and effects named', async () => {
    const h = harness();
    const p1 = h.invoker.invoke('bash', { command: 'npm test', note: 'x'.repeat(1000) });
    await nextTask();
    h.finish('bash');
    await p1;
    const p2 = h.invoker.invoke('read', { file_path: 'src/a.js' });
    await nextTask();
    h.finish('read');
    await p2;
    const [bash, read] = h.invoker.record.calls;
    assert(bash.args.note.length <= 501, `clipped to 500 + ellipsis, got ${bash.args.note.length}`);
    assert(bash.effect === 'bash: npm test', `effect: ${bash.effect}`);
    assert(read.effect === undefined, 'a read has no effect');
  });

  await test('the record is bounded and keeps effects over reads', async () => {
    const h = harness({ maxRecords: 3 });
    for (const [name, args] of /** @type {Array<[string, any]>} */ ([
      ['read', { file_path: 'a' }], ['read', { file_path: 'b' }],
      ['edit', { file_path: 'a' }], ['edit', { file_path: 'b' }], ['edit', { file_path: 'c' }],
    ])) {
      const p = h.invoker.invoke(name, args);
      await nextTask();
      h.finish(name);
      await p;
    }
    const rec = h.invoker.record;
    assert(rec.calls.length === 3, `bounded to 3, got ${rec.calls.length}`);
    assert(rec.calls.every((/** @type {any} */ c) => c.name === 'edit'), `effects kept: ${rec.calls.map((/** @type {any} */ c) => c.name)}`);
    assert(rec.omitted === 2 && rec.omittedEffects === 0, `omitted ${rec.omitted}/${rec.omittedEffects}`);
  });

  return { passed, failed, errors };
}
