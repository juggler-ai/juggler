//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What every run_code program suite is built out of.
 *
 * The program tests are split across several files because one file is one
 * suite, and a suite that runs for thirty seconds on an idle machine is past
 * the size at which suites are split (SUITE_SPLIT_MS, integration-test-executor.js).
 * The preamble, the teardown and the helpers that drive an item live here so
 * that splitting them costs no duplication.
 *
 * run_code programs run for real: the real sandbox, the real invoker, the real
 * approval decision under YOLO's real policy, the real executor, real files and
 * real shell commands. Only the model is absent — the item is driven directly,
 * so each case can stop it where it needs to (integration:run-code-* drive it
 * through the worker). What the model reads back is getSummary's
 * text followed by the change report the worker's projection builds from the
 * item's call record (programChangeReport), which is asserted here as it would
 * be sent.
 *
 * Contract under test:
 *   1. A program reads files with `fs` and edits one with `tools.edit`: the
 *      edit is admitted on the program's own live read, the file changes, the
 *      model is told the value and the change and nothing about the reads, and
 *      the item carries one row for the one call. The change comes from the
 *      record, never from the program's own summary.
 *   2. A tool the thread was not offered is refused in the worker's words, as
 *      an error the program may catch, and creates no item.
 *   3. A call a hook denies ends the program even when it tries to catch the
 *      refusal, and the model is still told what the program changed before
 *      it stopped.
 *   4. Cancelling the program while a sub-call runs stops the sandbox and the
 *      sub-call, promptly, and leaves nothing running. The record says the
 *      call was interrupted, and nothing writes to it once the program has
 *      ended.
 *   5. Writes keep the program's order even when it fires them together.
 *   6. A program resuming with a snapshot replays: each recorded call is
 *      answered from it and nothing recorded runs again. A replay that
 *      diverges ends the program unrun. A snapshot kept for another call than
 *      the one the item holds is not resumed from. A program that ends leaves
 *      no snapshot behind.
 *   7. A call the decision parks is held: the item is pending with that
 *      call's own approval and no result, its card drawn as the call's tool
 *      draws it, while the program lives on, waiting. Approving runs that call
 *      and the program goes on in the same run, each call once, saving any
 *      "don't ask again" rule for the sub-tool. A denial or a refusal settles
 *      the item and ends the program without overwriting it. Waiting is not
 *      counted against the program's time. A strategy switch, or an approval
 *      given on the program's own card, puts the held call to the decision
 *      again; a question's answer is its call's result.
 *   8. A program whose engine is lost while it waits (here: its run ended
 *      through the executor, the document untouched) resumes from the
 *      snapshot taken when the call was held, once the user answers; with no
 *      snapshot for that call — none kept, or the save for that hold failed —
 *      it fails and runs nothing again. A program whose snapshot cannot be
 *      kept still waits, and finishes once answered.
 * @module _tests/run-code-program-helpers
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert,
  withTimeout
} from '../../../js-tests/utilities/test-helpers.js';
import { budgetFor } from '../../../js-tests/utilities/test-deadline.js';
import { pollPatiently, whyGivingUp } from '../../../js-tests/utilities/test-patience.js';
import { createToolActionMessage } from '../../../sdk/lib/message.js';
import { readFile, loadProgramSnapshot } from '../../../js/services/ops-api.js';
import actionExecutor from '../../../js/services/action-executor.js';
import YoloStrategyType from '../strategies/yolo-strategy-type.js';
import RunCodeContextItem, { saveSnapshot } from '../context-items/run-code-context-item.js';
import { handOverToHeldCall } from '../../../js/services/worker-manager-protocols.js';
import { programChangeReport } from '../../../js/utils/program-changes.js';
import {
  decideToolCall,
  executeToolAction,
  claimRunning,
  saveAutoApprovalPermission
} from '../../../js/model/conversation-tool-actions.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

let seq = 0;

/**
 * Wait until `predicate` holds, within this test's budget. A patient wait: it
 * is listed while it runs, so a suite timeout names it, and a loaded machine
 * extends it.
 * @param {() => boolean} predicate - What to wait for
 * @param {string | (() => string)} what - Named in the failure; a function is read when the failure is
 * @param {number} [nominalMs] - Nominal timeout
 * @returns {Promise<void>}
 */
export async function waitUntil(predicate, what, nominalMs = 10000) {
  if (await pollPatiently(predicate, { nominalMs: budgetFor(nominalMs), intervalMs: 20, what })) return;
  throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what} — ${await whyGivingUp()}`);
}

/**
 * Wait for a program started with startAsAction to end, within this test's
 * budget. Its run is the executor's promise, and a program that never ends
 * (a cancel that missed it, a held call nobody answers) lives for a day.
 * @template T
 * @param {Promise<T>} finished - The run startAsAction returned
 * @param {string} [what] - Named in the failure
 * @returns {Promise<T>} What the run resolved with
 */
export function ended(finished, what = 'the program to end') {
  return withTimeout(finished, budgetFor(10000), what);
}

/**
 * Sub-calls of any program still registered as running in the executor.
 * @returns {string[]} Their tool-use ids
 */
export function runningSubCalls() {
  return [.../** @type {any} */ (actionExecutor)._runningActions.values()]
    .map((r) => r.toolUseId)
    .filter((id) => typeof id === 'string' && id.startsWith('code_'));
}


/**
 * The preamble and teardown every run_code program suite shares: registries,
 * a session, the engine flag a program needs to run in this page, and the
 * helpers that drive an item. The suite's cases run inside `defineCases`.
 * @param {(kit: any) => Promise<void>} defineCases - Runs the suite's cases.
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runProgramSuite(defineCases) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
  /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;

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

  /**
   * A conversation with a run_code tool-action in it, and the item that runs
   * as that action.
   * @param {string} code - The program
   * @param {{strategy?: 'yolo'|'default', toolUseId?: string, timeout?: number}} [opts] - The thread's policy (YOLO by default), the call's id, and the program's timeout
   * @returns {Promise<{conversation: any, mt: any, item: any, controller: AbortController}>} The setup
   */
  const setup = async (code, opts = {}) => {
    const strategy = opts.strategy ?? 'yolo';
    const conversation = await createApprovalTestConversation(session);
    const mt = conversation.rootMessageThread;
    // Under the default policy each tool's own rule decides: the helper's
    // conversation permits edits and leaves bash to ask.
    mt.strategy = strategy === 'yolo' ? { getApprovalPolicy: YoloStrategyType.prototype.getApprovalPolicy } : {};
    const toolUseId = opts.toolUseId ?? `rc${++seq}_${Date.now()}`;
    // Seeded pending: the conversation's worker is live and commands an
    // unevaluated or approved item into the engine, which would run this
    // program alongside the test. Pending is left to the user, so only the
    // test moves it (runAsAction).
    const toolInput = opts.timeout ? { code, timeout: opts.timeout } : { code };
    mt.addEvent(createToolActionMessage({ toolUseId, toolName: 'run_code', toolInput, state: 'pending' }));
    const controller = new AbortController();
    const item = new RunCodeContextItem({
      id: RunCodeContextItem.MANIFEST.id,
      session,
      conversation,
      messageThread: mt,
      toolUseId,
      signal: controller.signal
    });
    return { conversation, mt, item, controller };
  };

  /**
   * The item's displayData: its call record.
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @returns {any} The record, plain
   */
  const displayOf = (mt, toolUseId) => {
    const display = mt.getToolAction(toolUseId)?.get('displayData');
    return display?.toJSON ? display.toJSON() : display;
  };

  /**
   * Run a program to completion and return what the model would read.
   * @param {any} item - The run_code item
   * @param {string} code - The program
   * @returns {Promise<{out: any, text: string, wire: string}>} The raw result,
   *   the item's own summary, and the tool_result the model is sent (the
   *   summary plus the worker's change report)
   */
  const run = async (item, code) => {
    const out = await item.execute({ code });
    const outcome = out?.success === false
      ? { success: false, error: out.error, result: out }
      : { success: true, result: out };
    const summary = item.getSummary(outcome);
    const text = String(summary.summary);
    return { out, text, summary, wire: text + programChangeReport(displayOf(item.messageThread, item.toolUseId)) };
  };

  /**
   * What the item holds in the asset store, by id.
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @returns {string[]} Its heldAssets
   */
  const heldOf = (mt, toolUseId) => {
    const held = mt.getToolAction(toolUseId)?.get('heldAssets');
    return (held?.toJSON ? held.toJSON() : held) || [];
  };

  /**
   * The rows the item shows for its calls.
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @returns {any[]} Recorded calls
   */
  const rowsOf = (mt, toolUseId) => {
    const data = displayOf(mt, toolUseId);
    return Array.isArray(data?.nestedCalls) ? data.nestedCalls : [];
  };

  /**
   * Run `fn` with the sub-call decision overridden wherever `override` returns
   * a verdict; anything else goes to the real decision.
   * @template T
   * @param {(call: any) => {verdict: string, reason: string}|null} override - The override
   * @param {() => Promise<T>} fn - What to run under it
   * @returns {Promise<T>} fn's result
   */
  const withDecision = async (override, fn) => {
    const g = /** @type {any} */ (globalThis);
    const host = g.__hostToolInvoker;
    g.__hostToolInvoker = (/** @type {any} */ opts) => host({
      ...opts,
      deps: {
        decide: async (/** @type {any} */ call) => override(call)
          ?? decideToolCall({ messageThread: opts.messageThread, conversation: opts.conversation, ...call })
      }
    });
    try {
      return await fn();
    } finally {
      g.__hostToolInvoker = host;
    }
  };

  /**
   * A command that appends `x` to `log` and prints `ran`, wrapped in a shell
   * so the helper conversation's file-writing grant does not cover it.
   * @param {string} log - The file it appends to
   * @returns {string} The command
   */
  const heldCommand = (log) => `sh -c 'printf x >> ${log}'; printf ran`;

  /**
   * Fail unless the real decision parks `command` in this thread.
   * @param {any} conversation - Conversation
   * @param {any} mt - Thread
   * @param {string} command - The command
   * @returns {Promise<void>}
   */
  const assertParks = async (conversation, mt, command) => {
    const d = await decideToolCall({ messageThread: mt, conversation, toolName: 'bash', toolInput: { command }, toolUseId: `probe_${++seq}` });
    assert(d.verdict === 'park', `precondition: ${command} must park here, got ${d.verdict}`);
  };

  /**
   * Run the program as the engine runs an approved tool-action: claim it
   * (approved → running), then the execute path, whose exit writes the item.
   * `answer` (the user's answer, or a reset) is written in the same transaction
   * as the approval and the claim, so the live worker never sees the item
   * approved and unclaimed, which it would command into the engine.
   * @param {any} conversation - Conversation
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @param {() => void} [answer] - Written first, in the same transaction
   * @returns {Promise<any>} The tool-action, plain, once the run has ended
   */
  const runAsAction = async (conversation, mt, toolUseId, answer) => {
    const ymap = mt.getToolAction(toolUseId);
    let claimed = false;
    mt.transact(() => {
      answer?.();
      if ((ymap.get('state') ?? '') !== 'approved') mt.updateToolActionState(toolUseId, 'approved');
      if (ymap.get('approvalResponse') === 'yes-always') saveAutoApprovalPermission(conversation, ymap, mt);
      claimed = claimRunning(conversation, ymap);
    });
    assert(claimed, 'the claim must succeed');
    await ended(executeToolAction(mt, toolUseId, conversation), 'the program to run to its end');
    return mt.getToolAction(toolUseId).toJSON();
  };

  /**
   * Start the program as runAsAction does, without waiting for it to end: a
   * program holding a call for the user goes on running.
   * @param {any} conversation - Conversation
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @returns {Promise<any>} The tool-action, plain, once the program has ended
   */
  const startAsAction = (conversation, mt, toolUseId) => {
    const ymap = mt.getToolAction(toolUseId);
    let claimed = false;
    mt.transact(() => {
      if ((ymap.get('state') ?? '') !== 'approved') mt.updateToolActionState(toolUseId, 'approved');
      claimed = claimRunning(conversation, ymap);
    });
    assert(claimed, 'the claim must succeed');
    const finished = executeToolAction(mt, toolUseId, conversation).then(() => mt.getToolAction(toolUseId).toJSON());
    finished.catch(() => {});
    return finished;
  };

  /**
   * Wait until the program's item waits on the user for a call to `name`.
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @param {string} name - The held tool
   * @param {(t: any) => boolean} [also] - Anything else to wait for
   * @returns {Promise<any>} The tool-action, plain
   */
  const waitHeld = async (mt, toolUseId, name, also) => {
    // What the item is doing instead, for a failure: still running with the
    // call's row held means the snapshot save before the hold is slow; still
    // running without it, the path to the call; ended, the hold was refused
    // or never asked for.
    const seen = () => {
      const t = mt.getToolAction(toolUseId)?.toJSON();
      const content = typeof t?.result?.content === 'string' ? t.result.content.slice(0, 200) : t?.result?.content;
      return `state=${t?.state} heldCall=${t?.heldCall?.name ?? 'none'} rows=[${rowBrief(mt, toolUseId)}]`
        + (t?.result ? ` result=${JSON.stringify(content)}` : '');
    };
    /** @type {string|null} */
    let ended = null;
    await waitUntil(() => {
      const t = mt.getToolAction(toolUseId)?.toJSON();
      if (t?.state === 'completed' || t?.state === 'cancelled') {
        ended = seen();
        return true;
      }
      return t?.state === 'pending' && t.heldCall?.name === name && (!also || also(t));
    }, () => `the program to hold ${name} (${seen()})`);
    if (ended) throw new Error(`the program ended without holding ${name}: ${ended}`);
    return mt.getToolAction(toolUseId).toJSON();
  };

  /**
   * Answer the held call as the user and the engine do: the user's approval,
   * then the handover handleExecuteTool makes on the approved item
   * (handOverToHeldCall). One transaction, so the live worker never sees the
   * item approved and commands it into the engine itself.
   * @param {any} conversation - Conversation
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @param {string|undefined} response - The user's response; undefined approves the item with none
   * @param {{extra?: Record<string, unknown>, first?: () => void}} [how] - The approval's extras, and
   *   anything to write first in the same transaction
   */
  const answerHeld = (conversation, mt, toolUseId, response, how = {}) => {
    const ymap = mt.getToolAction(toolUseId);
    let delivered = false;
    mt.transact(() => {
      how.first?.();
      if (response === undefined) mt.updateToolActionState(toolUseId, 'approved');
      else assert(mt.resolveApproval(toolUseId, response, { source: 'user', ...(how.extra || {}) }), 'the approval is written');
      delivered = handOverToHeldCall(conversation, mt, ymap, toolUseId);
    });
    assert(delivered, 'the answer reaches the held call');
  };

  /**
   * Lose the engine a program runs in while it holds a call, as far as the
   * document can tell: the run ends through the executor, with no write, and
   * the item is left pending with the held call's card.
   * @param {any} conversation - Conversation
   * @param {string} toolUseId - The program's id
   * @param {Promise<any>} finished - Its run
   * @returns {Promise<void>}
   */
  const loseEngine = async (conversation, toolUseId, finished) => {
    const cancelled = actionExecutor.cancelByToolUseId(toolUseId, conversation.id);
    assert(cancelled === 'hit', `the program should be running to be lost, cancel said ${cancelled}`);
    await ended(finished, 'the program to end once its engine is lost');
  };

  /**
   * Leave the item as a lost program's would be: holding `call`, with the
   * user's response on its card.
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @param {{name: string, input: Record<string, unknown>}} call - The held call
   * @param {string} [response] - The user's response
   */
  const seedHeld = (mt, toolUseId, call, response = 'yes') => {
    const ymap = mt.getToolAction(toolUseId);
    mt.transact(() => {
      ymap.set('heldCall', call);
      ymap.set('approvalOptions', { held: true, options: [] });
      ymap.set('approvalResponse', response);
    });
  };

  /**
   * The snapshot kept for a program, as stored, or null.
   * @param {any} item - The run_code item
   * @returns {Promise<any>} The snapshot
   */
  const snapshotOf = (item) => loadProgramSnapshot(item.conversation.id, item.toolUseId).catch(() => null);

  /**
   * Keep a snapshot for a program, as a hold would have left it.
   * @param {any} item - The run_code item
   * @param {{held: {name: string, input: Record<string, unknown>}, heldStep: number, journal: any[], calls?: any[]}} saved - What it holds
   * @returns {Promise<void>}
   */
  const seedSnapshot = (item, saved) => saveSnapshot(item, {
    held: saved.held,
    heldStep: saved.heldStep,
    journal: saved.journal,
    record: { calls: saved.calls ?? [], omitted: 0, omittedEffects: 0 },
    images: new Map()
  }, new AbortController().signal);

  /**
   * Wait until a program's snapshot is gone, within this test's budget.
   * @param {any} item - The run_code item
   * @param {string} what - Named in the failure
   * @returns {Promise<void>}
   */
  const waitSnapshotGone = async (item, what) => {
    // Each probe is a fetch and the wait's probe is synchronous, so the probe
    // keeps one bounded read in flight and answers from the last to come back;
    // a read that fails fails the wait.
    /** @type {Promise<void>|null} */
    let reading = null;
    let gone = false;
    /** @type {unknown} */
    let failed = null;
    await waitUntil(() => {
      if (failed) throw failed;
      if (!gone && !reading) {
        reading = withTimeout(snapshotOf(item), budgetFor(5000), `a read of the snapshot, ${what}`)
          .then((snapshot) => { gone = !snapshot; }, (err) => { failed = err; })
          .finally(() => { reading = null; });
      }
      return gone;
    }, what, 10000);
  };

  /**
   * Fail every snapshot save made while `fn` runs, with `status`, as a server
   * that refuses it (too large) or cannot write it would.
   * @template T
   * @param {(n: number) => boolean} which - Which saves fail, by their 1-based count
   * @param {number} status - The HTTP status they fail with
   * @param {() => Promise<T>} fn - What to run
   * @returns {Promise<T>} fn's result
   */
  const failingSaves = async (which, status, fn) => {
    const real = globalThis.fetch;
    let n = 0;
    globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
      if (init?.method === 'PUT' && String(url).includes('/programs/') && which(++n)) {
        return new globalThis.Response(JSON.stringify({ error: 'refused' }), { status, headers: { 'Content-Type': 'application/json' } });
      }
      return real(url, init);
    });
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  };

  /**
   * The rows the item shows for its calls, in brief: `name:status` each.
   * @param {any} mt - Thread
   * @param {string} toolUseId - The program's id
   * @returns {string} The rows
   */
  const rowBrief = (mt, toolUseId) => rowsOf(mt, toolUseId).map((r) => `${r.name}:${r.status}`).join(',');

  /**
   * Whether a file is absent.
   * @param {string} path - The file
   * @returns {Promise<boolean>} It does not exist
   */
  const absent = async (path) => (await readFile({ path }).catch(() => null))?.exists !== true;

  try {
    await defineCases({
      test, session, setup, displayOf, run, heldOf, rowsOf, withDecision,
      heldCommand, assertParks, runAsAction, startAsAction, waitHeld, answerHeld,
      loseEngine, seedHeld, snapshotOf, seedSnapshot, waitSnapshotGone,
      failingSaves, rowBrief, absent
    });
  } finally {
    /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
  }

  return { passed, failed, errors };
}
