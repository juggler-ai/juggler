//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Deadlines on the engine's unbounded awaits.
 *
 * The engine runs almost entirely inside one module worker: WebSocket, Yjs, tool
 * handlers and the liveness heartbeat all share its event loop. That makes a CPU
 * wedge detectable — the heartbeat stops with everything else, and the server's
 * eviction ladder fires. It makes the OPPOSITE failure invisible: an `await` on a
 * promise that never settles leaves the loop free, so the heartbeat keeps firing,
 * the engine keeps reporting the stuck tool as executing, and the tool sits at
 * `running` for the rest of the session with every ladder in the system
 * satisfied. The only cure is for the awaits themselves to be bounded.
 *
 * Three of them could hang forever, and each is covered here:
 *   - `/api/ops/call`, which carries every read/grep/glob/MCP/webfetch tool and
 *     had no client deadline (and has no server-side request deadline either).
 *   - the query_code sandbox, whose timeout sat on the far side of a postMessage
 *     boundary — enforced on the throttled WebView main thread, while the worker
 *     that awaited the answer had no timer at all.
 *   - a cancel that reached no one: query_code built an AbortSignal and never
 *     passed it to the sandbox, so Escape aborted a controller nobody listened to.
 *     The signal must also stop the script, on whichever side of the boundary
 *     its Worker lives.
 * @module unit-tests/unbounded-await
 */

import { assert } from '../utilities/test-helpers.js';
import { __setOpCallTimeoutForTest } from '../../js/services/ops-api.js';
import { readFileLoad } from '../../js/services/ops-api.js';
import { runInSandbox } from '../../sdk/lib/sandbox-runner.js';
import { createSandboxBridge } from '../../js/engine-worker-sandbox.js';

/** The op boundary every read tool's execute() ends up at (see services/ops-api.js). */
const OP_ENDPOINT = '/api/ops/call';

/**
 * Stub the op boundary with a backend that accepted the request and will never
 * answer — the shape the deadline exists for. It honours its abort signal the
 * way the real `fetch` does, so the only thing that can end the wait is somebody
 * aborting: the caller, or the deadline. Everything else goes through untouched.
 * @returns {() => void} Puts the real fetch back
 */
function stubDeadOpFetch() {
  const realFetch = window.fetch;
  window.fetch = (/** @type {any} */ url, /** @type {any} */ opts = {}) => {
    if (String(url) !== OP_ENDPOINT) return realFetch.call(window, url, opts);
    return new Promise((_resolve, reject) => {
      const signal = opts.signal;
      const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (!signal) return; // nothing can end this — the state before the fix
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  return () => { window.fetch = realFetch; };
}

/**
 * Reject if a promise has not settled within `ms`, so a regression fails the
 * test rather than hanging the lane to its 60s budget.
 * @param {Promise<any>} p - The promise under test
 * @param {number} ms - Patience budget
 * @param {string} what - Message for the timeout
 * @returns {Promise<any>} p's settlement
 */
function within(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_r, rej) => setTimeout(() => rej(new Error(what)), ms))
  ]);
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all unbounded-await tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // Test 1: an op whose backend never answers must fail, not hang. The
  // production backstop is deliberately generous (it sits at the ceiling of the
  // largest budget any op is permitted, so it can never pre-empt real work), so
  // the test shortens it rather than waiting it out.
  {
    const restoreFetch = stubDeadOpFetch();
    try {
      __setOpCallTimeoutForTest(200);

      let threw = null;
      try {
        await within(
          readFileLoad({ path: '/anything' }),
          4000,
          'a dead /api/ops/call never settled — the request has no deadline, so the tool sits at running forever'
        );
      } catch (e) {
        threw = e;
      }

      assert(!!threw, 'a backend that never answers must surface as an error');
      const message = threw instanceof Error ? threw.message : String(threw);
      assert(/never answered/.test(message),
        `the failure must say the backend never answered, got: ${message}`);
      assert(/read-file\.loadFile/.test(message),
        `the failure must name the op that hung, got: ${message}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`op call deadline: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      __setOpCallTimeoutForTest();
      restoreFetch();
    }
  }

  // Test 2: the caller's own abort must still read as an abort, not as the
  // deadline expiring. The executor turns an AbortError into a cancelled result;
  // anything else becomes a tool failure the model is told about.
  {
    const restoreFetch = stubDeadOpFetch();
    try {
      __setOpCallTimeoutForTest(60000);
      const controller = new AbortController();
      const call = readFileLoad({ path: '/anything' }, controller.signal);
      controller.abort();

      let threw = null;
      try {
        await within(call, 4000, 'an aborted op call never settled');
      } catch (e) {
        threw = e;
      }
      assert(!!threw, 'an aborted op call must reject');
      assert(/** @type {any} */ (threw).name === 'AbortError',
        `the caller's cancel must stay an AbortError, got ${/** @type {any} */ (threw).name}: ${/** @type {any} */ (threw).message}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`op call abort is not mistaken for the deadline: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      __setOpCallTimeoutForTest();
      restoreFetch();
    }
  }

  // Test 3: the engine worker's sandbox delegate must give up on a host that
  // never answers. The script's own timeout is enforced on the main thread, on
  // the far side of a postMessage boundary, so it cannot settle this promise —
  // and the main thread it waits on is deliberately allowed to throttle. With no
  // timer here, a single missed `sandbox-result` hung every query_code for the
  // life of the engine.
  {
    try {
      /** @type {any[]} */
      const posted = [];
      // A host that swallows every request: exactly a wedged main thread, or an
      // iframe that never signals ready.
      const bridge = createSandboxBridge({ post: (m) => { posted.push(m); }, graceMs: 150 });

      const run = bridge.delegate('return 1', { fs: {} }, 50);
      assert(posted.length === 1 && posted[0].type === 'sandbox-run', 'the delegate must ask the host to run the script');
      assert(bridge.pendingCount() === 1, 'the run must be tracked while in flight');

      let threw = null;
      try {
        await within(run, 4000, 'the sandbox delegate never settled — a host that never answers hangs query_code forever');
      } catch (e) {
        threw = e;
      }
      assert(!!threw, 'a host that never answers must surface as an error');
      assert(/never answered/.test(/** @type {any} */ (threw).message),
        `the failure must say the host never answered, got: ${/** @type {any} */ (threw).message}`);
      assert(bridge.pendingCount() === 0,
        'the timed-out run must be dropped — its entry retains the run\'s capability closures');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`sandbox delegate backstop: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Test 4: a host that DOES answer must settle the run and leave nothing behind.
  // The guard against fixing the hang by breaking the ordinary path.
  {
    try {
      /** @type {any[]} */
      const posted = [];
      const bridge = createSandboxBridge({ post: (m) => { posted.push(m); }, graceMs: 5000 });
      const run = bridge.delegate('return 42', {}, 1000);
      bridge.handleResult({ id: posted[0].id, ok: true, result: 42 });

      const value = await within(run, 4000, 'an answered sandbox run never settled');
      assert(value === 42, `the host's result must reach the caller, got ${value}`);
      assert(bridge.pendingCount() === 0, 'a settled run must leave no bookkeeping behind');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`sandbox delegate happy path: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Test 5: runInSandbox must honour a cancel signal. query_code's execute()
  // passes its action's signal, which is what Escape aborts; without this the
  // signal reached nothing and the tool stayed at `running` until the script's
  // own budget — up to ten minutes — ran out. Settling the caller is half of
  // it: the script itself must stop, or it goes on calling its capabilities
  // for a run nobody is waiting on.
  {
    try {
      // The real iframe sandbox, with a script that loops forever calling a
      // capability, and a budget far longer than this test's patience: if the
      // signal reached nothing, the call would wait out the full minute and the
      // guard below would fire.
      let ticks = 0;
      const controller = new AbortController();
      const run = runInSandbox(
        'for (;;) { await tick(); await new Promise((r) => setTimeout(r, 10)); }',
        { capabilities: { tick: () => { ticks++; } }, timeoutMs: 60000, signal: controller.signal }
      );
      await within((async () => {
        while (ticks < 3) await new Promise((r) => { setTimeout(r, 10); });
      })(), 15000, 'the looping script never got going');
      controller.abort();

      let threw = null;
      try {
        await within(run, 4000, 'an aborted runInSandbox never settled — the signal reaches nothing');
      } catch (e) {
        threw = e;
      }
      assert(!!threw, 'aborting a sandbox run must settle the caller');
      assert(/** @type {any} */ (threw).name === 'AbortError',
        `the abort must surface as an AbortError, got ${/** @type {any} */ (threw).name}: ${/** @type {any} */ (threw).message}`);

      // Let anything already in flight at the abort land, then watch for more.
      await new Promise((r) => { setTimeout(r, 200); });
      const ticksAfterAbort = ticks;
      await new Promise((r) => { setTimeout(r, 500); });
      assert(ticks === ticksAfterAbort,
        `the script kept running after the abort: ${ticksAfterAbort} capability calls became ${ticks} over 500ms`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`runInSandbox honours a cancel signal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Test 6: in the engine worker the run lives on the main-thread host, across a
  // postMessage boundary, so an abort must cross it too. The bridge has to tell
  // the host to stop the run, and settle and drop its own entry at once rather
  // than wait for a result the host may never send.
  {
    try {
      /** @type {any[]} */
      const posted = [];
      const bridge = createSandboxBridge({ post: (m) => { posted.push(m); }, graceMs: 5000 });
      const controller = new AbortController();
      const run = bridge.delegate('for (;;) {}', {}, 60000, undefined, { signal: controller.signal });
      const runId = posted[0].id;
      controller.abort();

      let threw = null;
      try {
        await within(run, 4000, 'an aborted delegate run never settled');
      } catch (e) {
        threw = e;
      }
      assert(!!threw && /** @type {any} */ (threw).name === 'AbortError',
        `the abort must surface as an AbortError, got ${threw && /** @type {any} */ (threw).name}`);
      assert(posted.some((m) => m.type === 'sandbox-abort' && m.id === runId),
        `the bridge must ask the host to stop the run, posted: ${JSON.stringify(posted.map((m) => m.type))}`);
      assert(bridge.pendingCount() === 0, 'an aborted run must leave no bookkeeping behind');

      // A signal that was already aborted never starts a run at all.
      const before = posted.length;
      const dead = new AbortController();
      dead.abort();
      let threwEarly = null;
      try {
        await within(bridge.delegate('return 1', {}, 1000, undefined, { signal: dead.signal }), 4000, 'a pre-aborted run never settled');
      } catch (e) {
        threwEarly = e;
      }
      assert(!!threwEarly && /** @type {any} */ (threwEarly).name === 'AbortError', 'a pre-aborted run must reject with an AbortError');
      assert(posted.length === before, 'a pre-aborted run must not be sent to the host');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`sandbox delegate forwards an abort: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { passed, failed, errors };
}
