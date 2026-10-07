//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Framework tests for cancelling in-flight tool executions (built-in read
 * tools and the streaming shell).
 *
 * Regression target: a long-running grep (or any built-in read tool) used to
 * be uncancellable — pressing Escape did nothing because the engine never
 * aborted the in-flight op fetch, so the fetch ran to completion and the
 * strategy loop continued as if no cancel happened. The fix threads an
 * AbortSignal from each read tool's execute() down to the op fetch, and adds
 * ActionExecutor.cancelByToolUseId so the engine can abort the matching action
 * when the worker writes state='cancelled'.
 *
 * This test exercises the REAL path — ActionExecutor.execute → grep plugin
 * execute() → ops-api callOp → fetch({signal}) — and stubs only the network
 * boundary (window.fetch) with an op that stays in flight until its signal is
 * aborted, exactly how a big grep behaves when Escape fires.
 * @module unit-tests/tool-cancellation
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import actionExecutor from '../../js/services/action-executor.js';
import { claimRunning } from '../../js/model/conversation-tool-actions.js';
import { createToolActionMessage, TOOL_STATES } from '../../sdk/lib/message.js';
import {
  handleExecuteTool,
  sendToolExecutionReports,
  __resetToolExecutionReporterForTest
} from '../../js/services/worker-manager-protocols.js';

/** The op boundary every read tool's execute() ends up at (see services/ops-api.js). */
const OP_ENDPOINT = '/api/ops/call';

/**
 * Stub the op boundary — and nothing else — with a request that stays in flight
 * until its signal aborts, exactly how a big grep behaves when Escape fires.
 *
 * `window.fetch` belongs to the whole page, not to the action under test: the
 * app issues its own requests (a plugin-watcher refresh, a settings read), and
 * a stub that counts the first request of ANY kind as "the op is in flight"
 * releases the test before the action has registered, leaving it to assert
 * against an executor that is still empty. The endpoint alone is not enough of a
 * filter either — the page calls it too, to read a file a pin is watching or to
 * complete a path — so the tool the request names has to match as well. Anything
 * else goes through to the real fetch untouched, so `started` means this
 * action's op and nothing else's.
 * @param {{honourSignal?: boolean, toolId?: string}} [opts] - honourSignal false
 *   ignores the abort signal entirely: a non-cooperative tool whose op cannot be
 *   interrupted, which the executor must still settle. toolId is the tool whose
 *   ops are held (every case here runs grep, and batch_grep fans out to it).
 * @returns {{started: Promise<void>, restore: () => void}} A promise that resolves
 *   once an op fetch is in flight, and the call that puts the real fetch back.
 */
function stubOpFetch({ honourSignal = true, toolId = 'grep' } = {}) {
  const realFetch = window.fetch;
  /** @type {() => void} */
  let resolveStarted;
  const started = /** @type {Promise<void>} */ (new Promise((r) => { resolveStarted = r; }));
  window.fetch = (/** @type {any} */ url, /** @type {any} */ opts = {}) => {
    if (String(url) !== OP_ENDPOINT || opRequestToolId(opts) !== toolId) return realFetch.call(window, url, opts);
    return new Promise((_resolve, reject) => {
      resolveStarted();
      const signal = honourSignal ? opts.signal : null;
      if (!signal) return; // no signal threaded → hang (the regression)
      const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort);
    });
  };
  return { started, restore: () => { window.fetch = realFetch; } };
}

/**
 * Which tool an op request belongs to, read from the body ops-api sends
 * (`{toolId, operation, params}`). A request with no readable body belongs to
 * nobody here and is left alone.
 * @param {any} opts - The fetch init the caller passed.
 * @returns {string} The tool id, or '' when there is none to read.
 */
function opRequestToolId(opts) {
  try {
    return JSON.parse(String(opts?.body || '{}')).toolId || '';
  } catch {
    return '';
  }
}

/**
 * Fail the test if the op fetch never starts, rather than hanging the lane.
 * @param {Promise<void>} started - The {@link stubOpFetch} in-flight promise.
 * @param {string} [what='op fetch never started'] - Message for the timeout.
 * @returns {Promise<void>} Resolves once the op is in flight.
 */
function awaitOpStarted(started, what = 'op fetch never started') {
  return Promise.race([
    started,
    new Promise((_r, rej) => setTimeout(() => rej(new Error(what)), 4000))
  ]).then(() => undefined);
}

/**
 * Leave the shared executor empty for the next case.
 *
 * Every case below parks a deliberately hung op in the one process-wide
 * ActionExecutor, so a case that fails an assertion mid-flight hands its still
 * running action to every case after it: the report then names four failures
 * for one bug, and the three innocent ones are the loudest. Each case's own
 * "running actions should be cleared" assertion runs before this, so draining
 * here can't hide a leak the case was meant to catch.
 * @returns {Promise<void>} Resolves once the executor has drained (or gave up).
 */
async function drainExecutor() {
  if (!actionExecutor.hasRunningActions()) return;
  actionExecutor.cancelAllActions();
  for (let i = 0; i < 100 && actionExecutor.hasRunningActions(); i++) {
    await new Promise((r) => { setTimeout(r, 10); });
  }
}

/**
 * Start a hung-fetch grep action in a conversation and resolve once its op is in
 * flight, so the executor holds a live running action for it. Returns the exec
 * promise (settle it by cancelling) — the caller controls the fetch stub.
 * @param {any} session
 * @param {any} conversation
 * @param {string} toolUseId
 * @param {number} runningEpoch
 * @returns {Promise<{execPromise: Promise<any>}>} The in-flight execution promise.
 */
async function startHungGrep(session, conversation, toolUseId, runningEpoch) {
  const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;
  const actionId = /** @type {any} */ (contextItemRegistry.getByToolName('grep'))?.MANIFEST?.id;
  const { started, restore } = stubOpFetch();
  const execPromise = actionExecutor.execute(
    actionId, { pattern: 'x' },
    { session, conversation, messageThread: conversation.rootMessageThread, toolUseId, runningEpoch, _approvalHandled: true }
  );
  await awaitOpStarted(started);
  restore();
  return { execPromise };
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all tool-cancellation tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // Test 1: cancelByToolUseId aborts an in-flight read tool's op fetch and
  // produces a cancelled result; the loop-driving result is success:false.
  {
    const originalFetch = window.fetch;
    try {
      const conversation = await createTestConversation(session);
      const messageThread = conversation.rootMessageThread;

      // A request that never resolves on its own but rejects with an AbortError
      // the instant its signal aborts. If the caller failed to thread a signal
      // (the bug), the request hangs forever — the abort below would do nothing
      // and the test would time out, which is the failure we want to catch.
      const { started: fetchStarted } = stubOpFetch();

      // ActionExecutor keys on the plugin's MANIFEST id ('search'), not the
      // LLM-facing tool name ('grep'). Resolve it the same way the framework
      // does so the test stays correct if the mapping changes.
      const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;
      const ActionClass = contextItemRegistry.getByToolName('grep');
      const actionId = /** @type {any} */ (ActionClass)?.MANIFEST?.id;
      assert(!!actionId, "grep tool should resolve to a registered action id");

      const toolUseId = 'tc-cancel-1';
      const execPromise = actionExecutor.execute(
        actionId,
        { pattern: 'anything' },
        { session, conversation, messageThread, toolUseId, _approvalHandled: true }
      );

      // Wait until the op fetch is actually in flight before cancelling.
      await awaitOpStarted(fetchStarted);

      assert(actionExecutor.hasRunningActions(), 'grep action should be running while the op is in flight');

      // Wrong-conversation cancel must NOT abort the action: tool-use ids
      // recur across conversations (every mock test uses call_1; OpenAI
      // reuses call_N), so the match is scoped by conversation.
      const foundElsewhere = actionExecutor.cancelByToolUseId(toolUseId, 'some-other-conversation');
      assert(foundElsewhere === 'miss', 'cancelByToolUseId must not match the same toolUseId in a different conversation');
      assert(actionExecutor.hasRunningActions(), 'action must still be running after a wrong-conversation cancel');

      const found = actionExecutor.cancelByToolUseId(toolUseId, conversation.id);
      assert(found === 'hit', 'cancelByToolUseId should find and abort the running action');

      const result = await execPromise;
      assert(result.cancelled === true, `expected cancelled result, got ${JSON.stringify({ cancelled: result.cancelled, success: result.success, error: result.error })}`);
      assert(result.success === false, 'cancelled action must report success:false');
      assert(!actionExecutor.hasRunningActions(), 'running actions should be cleared after cancellation');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`cancel in-flight grep: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = originalFetch;
      await drainExecutor();
    }
  }

  // Test 2: cancelByToolUseId is a no-op (returns 'miss') when no running
  // action matches the id — idempotent and safe to call on any cancel.
  {
    try {
      const found = actionExecutor.cancelByToolUseId('no-such-tool-use-id', 'no-such-conversation');
      assert(found === 'miss', "cancelByToolUseId should return 'miss' when no action matches");
      passed++;
    } catch (e) {
      failed++;
      errors.push(`cancel unknown id: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Test 3: a batch_grep (which fans out N inner ops) must be cancellable the
  // same way a single grep is — its inner ops must receive the action's
  // signal so an abort unwinds the in-flight fetch. Regression target: batch
  // called grep()/readFile() WITHOUT this.signal, so abort couldn't reach the
  // fetch; the op ran on, the action never settled, its _runningActions entry
  // never cleared, and the turn's read-tool Promise.all hung forever — every
  // later tool in the conversation wedged behind it.
  {
    const originalFetch = window.fetch;
    try {
      const conversation = await createTestConversation(session);
      const messageThread = conversation.rootMessageThread;

      // Honour the signal if threaded; hang forever otherwise (the bug).
      const { started: fetchStarted } = stubOpFetch();

      const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;
      const ActionClass = contextItemRegistry.getByToolName('batch_grep');
      const actionId = /** @type {any} */ (ActionClass)?.MANIFEST?.id;
      assert(!!actionId, 'batch_grep tool should resolve to a registered action id');

      const toolUseId = 'tc-batch-1';
      const execPromise = actionExecutor.execute(
        actionId,
        { searches: [{ pattern: 'anything' }, { pattern: 'another' }] },
        { session, conversation, messageThread, toolUseId, _approvalHandled: true }
      );

      await awaitOpStarted(fetchStarted, 'batch op fetch never started');
      assert(actionExecutor.hasRunningActions(), 'batch_grep action should be running while its ops are in flight');

      const found = actionExecutor.cancelByToolUseId(toolUseId, conversation.id);
      assert(found === 'hit', 'cancelByToolUseId should find and abort the running batch action');

      const result = await Promise.race([
        execPromise,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('cancelled batch never settled — abort did not unwind the inner ops')), 4000))
      ]);
      assert(result.cancelled === true, `expected cancelled batch result, got ${JSON.stringify({ cancelled: result.cancelled, success: result.success, error: result.error })}`);
      assert(result.success === false, 'cancelled batch must report success:false');
      assert(!actionExecutor.hasRunningActions(), 'running actions should be cleared after batch cancellation');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`cancel in-flight batch_grep: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = originalFetch;
      await drainExecutor();
    }
  }

  // Test 4: robustness backstop — a tool whose op IGNORES the abort signal
  // (a non-cooperative tool, or a backend that genuinely can't be interrupted)
  // must STILL settle as cancelled the moment the controller aborts. The
  // executor races execute() against the signal and detaches the orphaned op,
  // so no tool — however badly behaved — can leave the turn wedged.
  {
    const originalFetch = window.fetch;
    try {
      const conversation = await createTestConversation(session);
      const messageThread = conversation.rootMessageThread;

      // Deliberately ignore the signal entirely: hang forever no matter what.
      const { started: fetchStarted } = stubOpFetch({ honourSignal: false });

      const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;
      const ActionClass = contextItemRegistry.getByToolName('grep');
      const actionId = /** @type {any} */ (ActionClass)?.MANIFEST?.id;
      assert(!!actionId, 'grep tool should resolve to a registered action id');

      const toolUseId = 'tc-backstop-1';
      const execPromise = actionExecutor.execute(
        actionId,
        { pattern: 'anything' },
        { session, conversation, messageThread, toolUseId, _approvalHandled: true }
      );

      await awaitOpStarted(fetchStarted);
      assert(actionExecutor.hasRunningActions(), 'action should be running while the un-cancellable op is in flight');

      const found = actionExecutor.cancelByToolUseId(toolUseId, conversation.id);
      assert(found === 'hit', 'cancelByToolUseId should find and abort the running action');

      const result = await Promise.race([
        execPromise,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('executor did not settle a non-cooperative tool on abort — wedge persists')), 4000))
      ]);
      assert(result.cancelled === true, `expected cancelled result from backstop, got ${JSON.stringify({ cancelled: result.cancelled, success: result.success, error: result.error })}`);
      assert(result.success === false, 'cancelled action must report success:false');
      assert(!actionExecutor.hasRunningActions(), 'running actions should be cleared even when the op ignores the signal');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`backstop cancel of non-cooperative tool: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = originalFetch;
      await drainExecutor();
    }
  }

  // Test 5: aborting an in-flight streaming shell must SEND shell-cancel to
  // the server, not just settle locally. Regression target: shellCancelStreaming
  // read the never-assigned `window.wsService` and silently no-opped, so an
  // interrupted bash resolved cancelled:true in the engine while the server-side
  // process ran on until its timeout reaped it (up to 20 minutes). This drives
  // the REAL shellExecuteStreaming and stubs only the WS boundary on the same
  // websocket.js singleton it uses.
  {
    const wsService = (await import('../../js/services/websocket.js')).default;
    const originalSendStart = wsService.sendShellStart;
    const originalSendCancel = wsService.sendShellCancel;
    try {
      const { shellExecuteStreaming } = await import('../../js/services/shell-streaming.js');

      /** @type {string|null} */
      let startedShellId = null;
      /** @type {string|null} */
      let cancelledShellId = null;

      // Swallow the outbound frames: the "server" never replies, exactly like a
      // long-running command that has produced no done chunk when Escape fires.
      wsService.sendShellStart = (/** @type {string} */ shellId) => {
        startedShellId = shellId;
        return true;
      };
      wsService.sendShellCancel = (/** @type {string} */ shellId) => {
        cancelledShellId = shellId;
        return true;
      };

      const controller = new AbortController();
      const resultPromise = shellExecuteStreaming(
        { command: 'sleep 999' },
        () => {},
        controller.signal
      );

      // shell-start is sent synchronously inside the promise executor; give it a
      // microtask-safe beat rather than assuming the ordering.
      await Promise.race([
        (async () => { while (startedShellId === null) await new Promise((r) => setTimeout(r, 10)); })(),
        new Promise((_r, rej) => setTimeout(() => rej(new Error('shell-start was never sent')), 4000))
      ]);

      controller.abort();

      const result = await Promise.race([
        resultPromise,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('aborted shell stream never settled')), 4000))
      ]);
      assert(result.cancelled === true, `expected cancelled shell result, got ${JSON.stringify({ cancelled: result.cancelled, success: result.success, error: result.error })}`);
      assert(cancelledShellId !== null, 'abort must send shell-cancel to the server — a local-only cancel orphans the server-side process');
      assert(cancelledShellId === startedShellId, `shell-cancel must target the started shell (started ${startedShellId}, cancelled ${cancelledShellId})`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`abort sends shell-cancel: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      wsService.sendShellStart = originalSendStart;
      wsService.sendShellCancel = originalSendCancel;
    }
  }

  // Test 7: generation-scoped cancel. A cancel carrying a DIFFERENT execution
  // generation than the running action must NOT abort it (a stale cancel meant
  // for a prior run of the same toolUseId) — it returns 'epoch-mismatch' and the
  // action keeps running. A cancel carrying the MATCHING generation aborts it.
  // This is the fix that stops a re-run being spuriously killed by the previous
  // execution's cancel signal.
  {
    const originalFetch = window.fetch;
    try {
      const conversation = await createTestConversation(session);
      const messageThread = conversation.rootMessageThread;

      const { started: fetchStarted } = stubOpFetch();

      const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;
      const ActionClass = contextItemRegistry.getByToolName('grep');
      const actionId = /** @type {any} */ (ActionClass)?.MANIFEST?.id;
      assert(!!actionId, 'grep tool should resolve to a registered action id');

      const toolUseId = 'tc-epoch-scope-1';
      // Register the running action under generation 2 (the value claimRunning
      // would have stamped). The context.runningEpoch is what _createTrackedAction
      // records on the running-action entry.
      const execPromise = actionExecutor.execute(
        actionId,
        { pattern: 'anything' },
        { session, conversation, messageThread, toolUseId, runningEpoch: 2, _approvalHandled: true }
      );

      await awaitOpStarted(fetchStarted);
      assert(actionExecutor.hasRunningActions(), 'action should be running while the op is in flight');

      // Stale cancel (generation 1) — must NOT abort generation 2.
      const stale = actionExecutor.cancelByToolUseId(toolUseId, conversation.id, 1);
      assert(stale === 'epoch-mismatch', `stale-epoch cancel must report 'epoch-mismatch', got ${stale}`);
      assert(actionExecutor.hasRunningActions(), 'a stale-epoch cancel must leave the running action untouched');

      // Matching cancel (generation 2) — aborts it.
      const match = actionExecutor.cancelByToolUseId(toolUseId, conversation.id, 2);
      assert(match === 'hit', `matching-epoch cancel must report 'hit', got ${match}`);

      const result = await execPromise;
      assert(result.cancelled === true, `expected cancelled result after matching-epoch cancel, got ${JSON.stringify({ cancelled: result.cancelled })}`);
      assert(!actionExecutor.hasRunningActions(), 'running actions should be cleared after the matching-epoch cancel');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`generation-scoped cancel: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = originalFetch;
      await drainExecutor();
    }
  }

  // Test 8: unscoped fallback. When the caller supplies NO epoch, or the running
  // action carries no epoch (an execution predating generation tracking), the
  // guard is disabled and the abort falls back to the id+conversation match —
  // the pre-generation behaviour, so nothing regresses.
  {
    const originalFetch = window.fetch;
    try {
      const conversation = await createTestConversation(session);
      const messageThread = conversation.rootMessageThread;

      const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;
      const actionId = /** @type {any} */ (contextItemRegistry.getByToolName('grep'))?.MANIFEST?.id;

      // (a) entry HAS an epoch, caller supplies none → unscoped abort.
      {
        const { started } = stubOpFetch();
        const toolUseId = 'tc-epoch-unscoped-a';
        const execPromise = actionExecutor.execute(
          actionId, { pattern: 'x' },
          { session, conversation, messageThread, toolUseId, runningEpoch: 5, _approvalHandled: true }
        );
        await awaitOpStarted(started, 'op never started');
        const outcome = actionExecutor.cancelByToolUseId(toolUseId, conversation.id);
        assert(outcome === 'hit', `absent caller epoch must abort unscoped ('hit'), got ${outcome}`);
        const result = await execPromise;
        assert(result.cancelled === true, 'unscoped cancel (no caller epoch) must abort the action');
      }

      // (b) entry has NO epoch, caller supplies one → unscoped abort.
      {
        const { started } = stubOpFetch();
        const toolUseId = 'tc-epoch-unscoped-b';
        const execPromise = actionExecutor.execute(
          actionId, { pattern: 'x' },
          { session, conversation, messageThread, toolUseId, _approvalHandled: true }
        );
        await awaitOpStarted(started, 'op never started');
        const outcome = actionExecutor.cancelByToolUseId(toolUseId, conversation.id, 9);
        assert(outcome === 'hit', `epoch-less running action must abort unscoped ('hit'), got ${outcome}`);
        const result = await execPromise;
        assert(result.cancelled === true, 'unscoped cancel (no entry epoch) must abort the action');
      }

      passed++;
    } catch (e) {
      failed++;
      errors.push(`unscoped-epoch fallback: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = originalFetch;
      await drainExecutor();
    }
  }

  // Test 9: claimRunning stamps a monotonic runningEpoch that increments across
  // claim → reattach-reset → re-claim and SURVIVES the reset — the property that
  // makes the epoch a true per-incarnation generation identity (unlike
  // runningStartedAt, which the reset clears). A re-run therefore always claims a
  // strictly higher generation, so a stale cancel can never match it.
  {
    try {
      const conversation = await createTestConversation(session);
      const mt = conversation.rootMessageThread;
      const toolUseId = 'tc-epoch-increment-1';
      mt.addEvent(createToolActionMessage({ toolUseId, toolName: 'grep', toolInput: { pattern: 'x' } }));
      mt.updateToolActionState(toolUseId, TOOL_STATES.APPROVED);
      const ymap = mt.getToolAction(toolUseId);
      assert(!!ymap, 'tool-action ymap should exist');
      assert(ymap.get('runningEpoch') === undefined, 'no runningEpoch before the first claim');

      // First claim: approved → running, epoch 1.
      const claimed1 = claimRunning(conversation, ymap);
      assert(claimed1 === true, 'first claimRunning should win the CAS');
      assert(ymap.get('state') === TOOL_STATES.RUNNING, 'state should be running after claim');
      assert(ymap.get('runningEpoch') === 1, `first claim should set runningEpoch=1, got ${ymap.get('runningEpoch')}`);

      // Simulate the worker's reattach reset: back to approved, runningStartedAt
      // cleared, but runningEpoch deliberately preserved (the worker's reset
      // paths never touch it).
      conversation._doc.doc.transact(() => {
        ymap.set('state', TOOL_STATES.APPROVED);
        ymap.set('runningStartedAt', null);
      });
      assert(ymap.get('runningEpoch') === 1, 'the reset must preserve runningEpoch');

      // Re-claim: epoch increments past the reset, proving monotonicity.
      const claimed2 = claimRunning(conversation, ymap);
      assert(claimed2 === true, 're-claim after reset should win the CAS');
      assert(ymap.get('runningEpoch') === 2, `re-claim should increment runningEpoch to 2, got ${ymap.get('runningEpoch')}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`runningEpoch increments across claim/reset/re-claim: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Test 10: the tool-execution reporter emits one report per conversation that has
  // running work, tagged with the executing set (toolUseId + runningEpoch), and each
  // report carries a strictly increasing seq. Guarded by isEngine — a viewer emits
  // nothing. This is the level-based liveness signal the worker's finalize rule consumes.
  {
    const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
    const originalFetch = window.fetch;
    try {
      assert(!actionExecutor.hasRunningActions(), 'precondition: no leftover running actions before the reporter test');
      __resetToolExecutionReporterForTest();

      const convA = await createTestConversation(session);
      const convB = await createTestConversation(session);
      const a = await startHungGrep(session, convA, 'rep-a', 11);
      const b = await startHungGrep(session, convB, 'rep-b', 22);

      /** @type {Array<{conversationId: string, message: any}>} */
      const sent = [];
      const spyWm = { sendToWorker: (/** @type {string} */ conversationId, /** @type {any} */ message) => { sent.push({ conversationId, message }); } };

      // Viewer: the isEngine guard suppresses all reports.
      /** @type {any} */ (globalThis).JUGGLER_ENGINE = false;
      sendToolExecutionReports(spyWm);
      assert(sent.length === 0, 'a viewer must emit no tool-execution reports (isEngine guard)');

      // Engine: one report per conversation with running work.
      /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;
      sendToolExecutionReports(spyWm);
      assert(sent.length === 2, `expected one report per conversation with work, got ${sent.length}`);
      const byConv = new Map(sent.map((s) => [s.conversationId, s.message]));
      const ra = byConv.get(convA.id);
      const rb = byConv.get(convB.id);
      assert(!!ra && !!rb, 'both conversations must get a report');
      assert(ra.type === 'tool-execution-report', 'report must carry the tool-execution-report type');
      assert(ra.executing.length === 1 && ra.executing[0].toolUseId === 'rep-a', 'convA report must list its own executing tool');
      assert(ra.executing[0].runningEpoch === 11, `convA report must carry the runningEpoch, got ${ra.executing[0].runningEpoch}`);
      assert(rb.executing[0].toolUseId === 'rep-b' && rb.executing[0].runningEpoch === 22, 'convB report must list its own executing tool + epoch');
      assert(typeof ra.seq === 'number' && typeof rb.seq === 'number' && ra.seq !== rb.seq, 'each report must carry a distinct seq');

      // Settle both actions and drain them from the executor.
      actionExecutor.cancelByToolUseId('rep-a', convA.id);
      actionExecutor.cancelByToolUseId('rep-b', convB.id);
      await Promise.all([a.execPromise, b.execPromise]);
      assert(!actionExecutor.hasRunningActions(), 'both actions should have settled');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`tool-execution reporter grouping + seq + isEngine: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
      window.fetch = originalFetch;
      await drainExecutor();
      __resetToolExecutionReporterForTest();
    }
  }

  // Test 11: when a conversation's running work drains, the reporter emits exactly
  // one EMPTY (settle) report for it on the next tick — so the worker sees the set
  // cleared rather than inferring it from silence — and thereafter emits nothing
  // while idle (zero steady-state traffic).
  {
    const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
    const originalFetch = window.fetch;
    try {
      assert(!actionExecutor.hasRunningActions(), 'precondition: no leftover running actions before the settle test');
      __resetToolExecutionReporterForTest();
      /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;

      const conv = await createTestConversation(session);
      const a = await startHungGrep(session, conv, 'settle-1', 5);

      /** @type {Array<{conversationId: string, message: any}>} */
      const sent = [];
      const spyWm = { sendToWorker: (/** @type {string} */ conversationId, /** @type {any} */ message) => { sent.push({ conversationId, message }); } };

      // Tick 1: work present → one non-empty report.
      sendToolExecutionReports(spyWm);
      assert(sent.length === 1 && sent[0].message.executing.length === 1, 'first tick must report the running tool');

      // Drain the work, then tick 2: exactly one empty settle report for this conv.
      actionExecutor.cancelByToolUseId('settle-1', conv.id);
      await a.execPromise;
      sent.length = 0;
      sendToolExecutionReports(spyWm);
      assert(sent.length === 1, `draining must produce exactly one settle report, got ${sent.length}`);
      assert(sent[0].conversationId === conv.id && sent[0].message.executing.length === 0, 'the settle report must be empty and for the drained conversation');

      // Tick 3: fully idle → no traffic at all.
      sent.length = 0;
      sendToolExecutionReports(spyWm);
      assert(sent.length === 0, 'an idle reporter must emit nothing (zero steady-state traffic)');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`tool-execution reporter settle + idle-silence: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
      window.fetch = originalFetch;
      await drainExecutor();
      __resetToolExecutionReporterForTest();
    }
  }

  // Test 12: an execute-tool command for a toolUseId this engine is ALREADY
  // executing must not start a second run, even when the doc has lost the claim.
  //
  // Regression target: claimRunning's compare-and-set is only as durable as the
  // `running` it writes. With the doc back at approved (a replica reloaded under
  // the execution, or a merge reverting `state`), the worker's level-based
  // re-drive dispatches execute-tool again and the CAS legitimately succeeds a
  // second time — two concurrent runs of one tool, neither cancelling the other,
  // the later result overwriting the earlier IN PLACE. Seen in the wild as a bash
  // tool run twice 6s apart whose second, differently-timed output replaced the
  // first AFTER the first had been sent to the provider, diverging a claudecode
  // session and cold-starting a 180k-token prompt cache.
  //
  // The guard repairs rather than merely declines: a tool left at approved would
  // be re-driven to the worker's attempt cap and escalated to a terminal error
  // while it is still genuinely running. Restoring the in-flight generation
  // (rather than claiming a fresh, bumped one) is what keeps a later cancel-tool's
  // generation guard matching the execution that is actually running.
  {
    const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
    const originalFetch = window.fetch;
    try {
      assert(!actionExecutor.hasRunningActions(), 'precondition: no leftover running actions before the re-entrancy test');
      /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;

      const conversation = await createTestConversation(session);
      const mt = conversation.rootMessageThread;
      const toolUseId = 'tc-double-claim-1';
      mt.addEvent(createToolActionMessage({ toolUseId, toolName: 'grep', toolInput: { pattern: 'x' } }));
      mt.updateToolActionState(toolUseId, TOOL_STATES.APPROVED);
      const ymap = mt.getToolAction(toolUseId);

      // Claim it exactly as handleExecuteTool would, then put a real execution in
      // flight under that generation.
      assert(claimRunning(conversation, ymap) === true, 'first claim should win the CAS');
      const epoch = ymap.get('runningEpoch');
      const a = await startHungGrep(session, conversation, toolUseId, epoch);
      assert(actionExecutor.executingSetFor(conversation.id).length === 1, 'precondition: exactly one in-flight execution');

      // The claim is lost: the doc falls back to approved while the execution
      // above keeps running. This is what makes the worker re-drive.
      conversation._doc.doc.transact(() => {
        ymap.set('state', TOOL_STATES.APPROVED);
        ymap.set('runningStartedAt', null);
      });

      const spyWm = {
        _session: session,
        loader: { pendingAutoLoad: () => null, loadExisting: async () => conversation },
        sendToWorker: () => {},
      };
      const handled = await handleExecuteTool(spyWm, conversation.id, toolUseId);

      assert(handled === false, 're-driven execute-tool for an executing id must report that it did not act');
      const stillOne = actionExecutor.executingSetFor(conversation.id);
      assert(stillOne.length === 1, `the tool must not run twice, got ${stillOne.length} in-flight executions`);
      assert(ymap.get('state') === TOOL_STATES.RUNNING, 'the doc must be repaired to running so the worker stops re-driving');
      assert(ymap.get('runningEpoch') === epoch,
        `the repair must restore the in-flight generation, not claim a new one (expected ${epoch}, got ${ymap.get('runningEpoch')})`);

      // The restored epoch still matches the execution actually in flight.
      const outcome = actionExecutor.cancelByToolUseId(toolUseId, conversation.id, ymap.get('runningEpoch'));
      assert(outcome === 'hit', `a cancel scoped to the repaired epoch must abort the live execution, got ${outcome}`);
      await a.execPromise;
      assert(!actionExecutor.hasRunningActions(), 'the action should have settled');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`execute-tool re-entrancy (no double execution when the claim is lost): ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
      window.fetch = originalFetch;
      await drainExecutor();
    }
  }

  // Test 13: an execution that outlives every legitimate tool deadline must be
  // reported as overdue — once, then again only after the repeat interval.
  //
  // Regression target: a tool that reached `running` and then hung was invisible
  // to every ladder in the system. The worker's tool-command escalation covers
  // only tools stuck at a DELIVERY state ("" or approved) and skips `running`;
  // the worker's tool-execution-report rule finalizes only a tool ABSENT from the
  // engine's executing set, and a hung tool is present in every report forever;
  // and the engine's heartbeat keeps firing, because an await that never settles
  // leaves the event loop free. Nothing anywhere recorded that the execution
  // existed, so a permanent hang left no trace to find afterwards.
  {
    const originalFetch = window.fetch;
    try {
      assert(!actionExecutor.hasRunningActions(), 'precondition: no leftover running actions before the watchdog test');

      const conversation = await createTestConversation(session);
      const a = await startHungGrep(session, conversation, 'overdue-1', 7);

      const fresh = actionExecutor.overdueRunningActions();
      assert(fresh.length === 0, `a just-started execution must not be overdue, got ${fresh.length}`);

      // Well past the longest deadline any tool is given (bash's 20 minutes).
      const late = Date.now() + 22 * 60 * 1000;
      const first = actionExecutor.overdueRunningActions(late);
      assert(first.length === 1, `an execution running for 22 minutes must be reported overdue, got ${first.length}`);
      assert(first[0].toolUseId === 'overdue-1', `the report must name the tool, got ${first[0].toolUseId}`);
      assert(first[0].conversationId === conversation.id, 'the report must name the conversation so the trace can be addressed');
      assert(first[0].runningMs >= 22 * 60 * 1000 - 5000, `the report must carry the elapsed time, got ${first[0].runningMs}`);

      // Rate-limited: still stuck is not news every 3 seconds.
      const again = actionExecutor.overdueRunningActions(late + 1000);
      assert(again.length === 0, 'an already-reported execution must not be re-reported within the repeat interval');

      // But a wedge that lasts leaves a trail rather than one line at the start.
      const later = actionExecutor.overdueRunningActions(late + 11 * 60 * 1000);
      assert(later.length === 1, 'an execution still stuck past the repeat interval must be reported again');

      actionExecutor.cancelByToolUseId('overdue-1', conversation.id);
      await a.execPromise;
      assert(actionExecutor.overdueRunningActions(late).length === 0, 'a settled execution must not be reported overdue');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`overdue-execution watchdog: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = originalFetch;
      await drainExecutor();
    }
  }

  // Test 14: the reporter tick turns an overdue execution into a `tool-overdue`
  // engine-trace, which the worker logs at Info. That trace is the ONLY durable
  // record of a hung execution — the engine's console is captured nowhere — so
  // the wiring from the executor's watchdog to the wire is the thing under test,
  // not just the ageing rule above.
  {
    const wsService = (await import('../../js/services/websocket.js')).default;
    const originalSendWorkerMessage = wsService.sendWorkerMessage;
    const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
    const originalFetch = window.fetch;
    try {
      assert(!actionExecutor.hasRunningActions(), 'precondition: no leftover running actions before the overdue-trace test');
      __resetToolExecutionReporterForTest();
      /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;

      const conversation = await createTestConversation(session);
      const a = await startHungGrep(session, conversation, 'overdue-trace-1', 9);

      // Age the execution in place. The reporter reads the executor's own clock,
      // so backdating the entry is the only way to reach 22 minutes in a test.
      for (const entry of /** @type {any} */ (actionExecutor)._runningActions.values()) {
        entry.startTime -= 22 * 60 * 1000;
      }

      /** @type {any[]} */
      const traces = [];
      /** @type {any} */ (wsService).sendWorkerMessage = (/** @type {string} */ conversationId, /** @type {any} */ message) => {
        traces.push({ conversationId, message });
      };
      const spyWm = { sendToWorker: () => {} };

      sendToolExecutionReports(spyWm);

      const overdue = traces.filter((t) => t.message?.event === 'tool-overdue');
      assert(overdue.length === 1, `the reporter tick must emit exactly one tool-overdue trace, got ${overdue.length}`);
      assert(overdue[0].conversationId === conversation.id, 'the trace must be addressed to the tool\'s conversation');
      assert(overdue[0].message.type === 'engine-trace', 'the overdue report must ride the engine-trace channel');
      assert(overdue[0].message.toolUseId === 'overdue-trace-1', `the trace must name the tool, got ${overdue[0].message.toolUseId}`);
      assert(typeof overdue[0].message.runningMs === 'number', 'the trace must carry how long the execution has been running');

      actionExecutor.cancelByToolUseId('overdue-trace-1', conversation.id);
      await a.execPromise;

      passed++;
    } catch (e) {
      failed++;
      errors.push(`overdue execution reaches the worker as an engine-trace: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      /** @type {any} */ (wsService).sendWorkerMessage = originalSendWorkerMessage;
      /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
      window.fetch = originalFetch;
      await drainExecutor();
      __resetToolExecutionReporterForTest();
    }
  }

  return { passed, failed, errors };
}
