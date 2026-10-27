//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The harness's own budget contract.
 *
 * Every wait in a test is supposed to ride the deadline the run will actually
 * fail on, rather than a nominal sub-timeout chosen when a lane had the pool to
 * itself. That rule was written once for mock-LLM tests and quietly missed the
 * unit suites entirely — for months every "rides the budget" wait in a unit
 * suite fell back to its bare 3s or 5s, and the suite paid for it in browser
 * tests lost to load, one different one per run.
 *
 * Nothing detected that, because a budget is invisible until the machine is
 * busy. These cases are the detector: they assert the deadline exists and that
 * the waits which claim to ride it actually do.
 * @module unit-tests/test-budget-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { budgetFor, deadlineTimer, testDeadlineMs, setTestDeadline, pinTestDeadline } from '../utilities/test-deadline.js';
import { watchForStall } from '../utilities/stall-watch.js';
import { trackWait, waitsInFlightReport } from '../utilities/test-patience.js';
import UIDriver from '../utilities/ui-driver.js';
import { UITestHarness } from '../utilities/ui-test-harness.js';
import { executeUIOperation, lastConfirmGiveUp, disarmConfirm, waitForNestedCall } from '../utilities/ui-operation-executor.js';
import { afterEngineReload, REGISTRIES_CHANNEL } from '../utilities/plugin-config.js';
import { setReportedTest, reportTestProgress } from '../utilities/progress-report.js';

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Fixture directory (unused here).
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * The Go harness gives up on a test's result once the lane has reported no
 * progress for this long (`pollResultWhileProgressing`,
 * `browser_suite_test.go`), so a deadline at or past it reports nothing: the
 * subtest dies on a bare poll timeout with no message.
 */
const GO_SILENCE_WINDOW_MS = 120000;

/**
 * A nominal no correct wait in this file comes anywhere near: a wait that is
 * meant to give up on a spent deadline gives up at once, and one that wrongly
 * rides its nominal instead never does — so the case fails as a stalled suite
 * naming that wait, rather than on a reading of how fast this core is.
 */
const NEVER_MS = 10 * 60_000;

/**
 * Run the budget-contract tests.
 * @param {TestContext} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // A unit suite is a test like any other and must be given a deadline. Left
  // unarmed, every wait below silently reverts to its nominal timeout.
  try {
    const deadline = testDeadlineMs();
    assert(deadline > 0, 'no deadline is armed while a unit suite is running; every wait in this suite is falling back to its nominal timeout');
    const remaining = deadline - Date.now();
    assert(
      remaining > 0,
      `the armed deadline has already passed (${remaining}ms remaining), so every wait in this suite fails instantly`
    );
    assert(
      remaining < GO_SILENCE_WINDOW_MS,
      `the armed deadline leaves ${remaining}ms, past the Go harness's ${GO_SILENCE_WINDOW_MS}ms silence window — a failure here would be reported as a bare poll timeout with no message`
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`a unit suite runs under a deadline: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The point of the deadline is patience: a wait nominally allowed 3s must be
  // allowed the whole remaining budget instead.
  try {
    const nominal = 3000;
    const budget = budgetFor(nominal);
    assert(
      budget > nominal,
      `budgetFor(${nominal}) returned ${budget}; a wait is still capped at its nominal timeout rather than riding the deadline`
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`waits ride the deadline, not their nominal timeout: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The driver is built by unit suites directly, with no deadline passed in.
  // It must still find the armed one rather than falling back.
  try {
    const container = document.createElement('div');
    const driver = new UIDriver(container);
    const budget = /** @type {any} */ (driver)._budget(3000);
    assert(
      budget > 3000,
      `a UIDriver constructed without an explicit deadline budgets ${budget}ms for a 3000ms wait; it is not picking up the armed deadline`
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`a driver built without an explicit deadline still rides it: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The runner's stall watchdog moves a progressing test's deadline forward
  // (`watchForStall`, stall-watch.js) by setting it on the
  // UITestHarness. Its waits run on the inner harness and the driver, so those
  // must read the deadline as it stands now, not as it stood at setup: a copy
  // taken then expires ~26s in and gives every later wait a 0ms budget, however
  // live the test is. On a slow core every long integration test reached that.
  {
    /** @type {UITestHarness|null} */
    let harness = null;
    try {
      harness = new UITestHarness({ llmResponses: [], fixture: 'unit-test-fixture', fixtureDir: '', approvalFlow: false });
      const armedAt = Date.now() + 2000;
      harness._perTestDeadlineMs = armedAt;
      await harness.setup();
      // As the watchdog does when the test makes progress.
      const movedTo = Date.now() + 120000;
      harness._perTestDeadlineMs = movedTo;
      const inner = /** @type {any} */ (harness.innerHarness)._deadline(6000);
      const driverBudget = /** @type {any} */ (harness.driver)._budget(3000);
      assert(inner === movedTo,
        `the inner harness bounds its waits by ${inner ? new Date(inner).toISOString() : inner}, not by the deadline the runner moved to (${new Date(movedTo).toISOString()}); it kept the one from setup`);
      assert(driverBudget > 60000,
        `the driver budgets ${driverBudget}ms for a wait after the deadline moved two minutes out; it kept the one from setup`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`a moved deadline reaches the inner harness and the driver: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await harness?.teardown().catch(() => {});
    }
  }

  // A wait already running when the deadline moves must follow it too: every
  // wait turns its budget into a timer as it starts, and a long one started in
  // a progressing test outlives the deadline it started under.
  {
    const MOVE_MS = 1500;
    const original = testDeadlineMs();
    // Pinned, so the only move the wait sees is this case's own.
    const unpin = pinTestDeadline(original, { shared: true });
    try {
      const started = Date.now();
      const expiredAt = await new Promise((resolve) => {
        deadlineTimer(() => resolve(Date.now()), 100);
        setTestDeadline(original + MOVE_MS, { shared: true, sameTest: true });
      });
      const waited = /** @type {number} */ (expiredAt) - started;
      assert(waited >= MOVE_MS,
        `a 100ms wait running when the deadline moved ${MOVE_MS}ms expired after ${waited}ms; it ignored the move`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`a running wait follows a moved deadline: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      unpin();
    }
  }

  // waitFor is the most-used wait in the unit suites and the one with no
  // harness to ask. It keeps its caller's timeout, following the deadline past
  // it only as far as the deadline moves, so with the deadline held far off and
  // nothing moving it gives up on its own 100ms. A waitFor that rode the
  // deadline instead would still be waiting when the suite's watchdog fired,
  // and the suite would fail naming this wait.
  {
    const unpin = pinTestDeadline(Date.now() + NEVER_MS, { shared: true });
    try {
      let threw = null;
      try {
        await waitFor(() => false, { timeoutMs: 100, description: 'a condition that is never true' });
      } catch (e) {
        threw = e;
      }
      assert(threw !== null, 'waitFor resolved for a condition that is never true');
      const message = threw instanceof Error ? threw.message : String(threw);
      assert(
        message.includes('a condition that is never true'),
        `waitFor's timeout must name what it was waiting for, got: ${message}`
      );
      passed++;
    } catch (e) {
      failed++;
      errors.push(`waitFor stays bounded and names its condition: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      unpin();
    }
  }

  // A cap expressed only as a multiple of a wait's own nominal stops binding
  // as soon as that multiple exceeds the budget it is drawn from: at six times
  // a 10s nominal it does not bind inside a 45s suite at all, so the first
  // stuck wait spends the lot and the suite is reported as one that "stopped
  // making progress" — naming neither the wait nor the case, which is exactly
  // how two Windows suites failed with no diagnostic. A wait may take a share
  // of a shared budget, never all of it.
  try {
    const budget = 45000;
    const unpin = pinTestDeadline(Date.now() + budget, { shared: true });
    try {
      // A nominal whose slack multiple (6x) is larger than the whole budget:
      // only a share cap can bound this.
      const generous = budgetFor(10000);
      assert(generous < budget,
        `a single wait may not take the whole ${budget}ms suite budget, got ${generous}ms`);
      // And the share must still leave room for the cases that come after.
      assert(generous <= Math.ceil(budget / 2),
        `a single wait took ${generous}ms of a ${budget}ms budget, leaving too little for later cases`);
      // A deadline belonging to one test is still spendable in full, so
      // mock-LLM waits keep the patience they were given.
      setTestDeadline(Date.now() + budget, { sameTest: true });
      assert(budgetFor(10000) > Math.ceil(budget / 2),
        'a per-test deadline is not shared, so a wait may still spend it');
    } finally {
      unpin();
    }
    passed++;
  } catch (e) {
    failed++;
    errors.push(`one wait cannot swallow a shared suite budget: ${e instanceof Error ? e.message : String(e)}`);
  }

  // `expect-confirm` is the one wait in the harness whose nominal timeout, when
  // missed, does not produce a failure at all. It arms a watcher BEFORE the
  // operation that raises the dialog, because that operation blocks on the
  // production confirm promise — and that promise has no timeout of its own
  // (modal-dialog.js resolves it on a click and on nothing else). So a watcher
  // that gives up early leaves nobody to answer the dialog, and the operation
  // hangs until the runner kills the whole test. Both halves are covered here:
  // the watcher must ride the deadline like every other wait, and when it does
  // give up it must leave a record, so the hang that follows names its cause
  // instead of arriving as an anonymous timeout.
  try {
    // A deadline already spent collapses budgetFor to nothing, so a watcher
    // riding it gives up at once while one pinned to its nominal never does.
    const unpin = pinTestDeadline(Date.now() - 4900);
    try {
      await executeUIOperation(/** @type {any} */ ({}), { type: 'expect-confirm', answer: true, timeoutMs: NEVER_MS });
      // Generous: giving up includes taking the machine readings, which on a
      // slow core is seconds. A watcher on its nominal is still waiting after it.
      await waitFor(() => lastConfirmGiveUp() !== null, {
        timeoutMs: 30000,
        description: 'the armed confirmation watcher to give up and say so'
      });
      const giveUp = lastConfirmGiveUp() || '';
      assert(
        giveUp.includes('no confirmation'),
        `the recorded give-up must say what the watcher was waiting for, got: ${giveUp}`
      );
    } finally {
      disarmConfirm();
      unpin();
    }
    passed++;
  } catch (e) {
    failed++;
    errors.push(`the armed confirmation watcher rides the deadline and records giving up: ${e instanceof Error ? e.message : String(e)}`);
  }

  // A plugin-config write waits for the engine to report its registries
  // reloaded. That wait must ride the deadline like every other, and when it
  // runs out it must say what it was waiting for: a silent one becomes a test
  // that times out on a turn offered the wrong tools.
  try {
    // A deadline all but spent: a wait riding it budgets a fraction of a
    // second, one pinned to its nominal 10s budgets the nominal. The message
    // names the budget it chose, which is the behaviour, however long it took.
    const unpin = pinTestDeadline(Date.now() - 900);
    try {
      let threw = null;
      try {
        await afterEngineReload(async () => {}, 'a write that never happened');
      } catch (e) {
        threw = e;
      }
      assert(threw !== null, 'the reload wait resolved with no acknowledgement from the engine');
      const message = threw instanceof Error ? threw.message : String(threw);
      assert(
        message.includes('a write that never happened') && message.includes(REGISTRIES_CHANNEL),
        `the reload wait must name its trigger and the channel it listened on, got: ${message}`
      );
      const budget = Number(/within (\d+)ms/.exec(message)?.[1] ?? NaN);
      assert(budget <= 1000, `the reload wait budgeted ${budget}ms against a spent deadline; it is not riding it (${message})`);
    } finally {
      unpin();
    }
    passed++;
  } catch (e) {
    failed++;
    errors.push(`the engine-reload wait rides the deadline and names what it waited for: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The wait on a program tool's call rows must ride the deadline too, and
  // when it gives up say which call it wanted and what rows it saw: the rows
  // are written by the engine, so a silent timeout here would hide whether the
  // program never started or the call never got there.
  try {
    // Against a spent deadline and a nominal it could never reach: a wait
    // riding the deadline gives up at once, one on its nominal never does.
    const unpin = pinTestDeadline(Date.now() - 900);
    try {
      let threw = null;
      try {
        await waitForNestedCall({}, 'prog_x', 'bash', 'running', NEVER_MS);
      } catch (e) {
        threw = e;
      }
      assert(threw !== null, 'the nested-call wait resolved with no program to watch');
      const message = threw instanceof Error ? threw.message : String(threw);
      assert(
        message.includes('prog_x') && message.includes('bash call to be running') && message.includes('rows were none'),
        `the nested-call wait must name the program, the call and the rows it saw, got: ${message}`
      );
    } finally {
      unpin();
    }
    passed++;
  } catch (e) {
    failed++;
    errors.push(`the nested-call wait rides the deadline and names what it waited for: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Underneath every budget is a timer, and a hidden window's timers are not
  // the ones a suite thinks it is scheduling. Two mechanisms coarsen them to a
  // 1s grid and the pool window is exposed to both: WebKit and WebKitGTK snap a
  // hidden page's DOM timers once a chain passes its nesting limit, switched off
  // at startup (unthrottleHiddenPageTimers, cmd/juggler/app); and WebCore
  // throttles any frame that has a box but intersects nothing visible, which is
  // every lane of a window nothing ever allocated, answered by giving the pool's
  // web view a size of its own (ensureHiddenPoolWebViewSized, same package).
  // When either does not take, a suite awaiting eighty timers takes eighty
  // seconds and is reported as a suite that stopped making progress. Nothing
  // else would notice: the tax is spread a tick at a time across every wait in
  // the run. The page size goes in the failure because it says which one it is.
  //
  // What identifies a grid is its shape, not its speed: past the nesting limit
  // EVERY hop lands on the quantum, a second give or take. A slow core, or a
  // main thread another lane is holding, makes hops long and ragged — some
  // near zero, some well past a second — and that is not this fault, so a
  // total-time bound cannot tell the two apart and fails a slow core for
  // nothing.
  try {
    // Ten deep is where the alignment applies from; six past it is enough
    // that a slow core's ragged hops cannot all happen to land on a second.
    const links = 16;
    const nesting = 10;
    /** @type {number[]} */
    const hops = [];
    for (let i = 0; i < links; i++) {
      const at = Date.now();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      hops.push(Date.now() - at);
    }
    const past = hops.slice(nesting);
    const onGrid = past.filter((h) => h >= 900 && h <= 1100).length;
    assert(
      onGrid < past.length,
      `every one of the ${past.length} zero-delay timer hops past the nesting limit took about a second (${past.join(', ')}ms) in a page of ${window.innerWidth}x${window.innerHeight}; that is a 1s grid — a page of no size means the pool's web view never took one, a page with a size means the hidden-page alignment is still on, and either way every wait in every suite is being charged a tick`
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`the pool's timers are the ones the suite asked for: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The unit runner bounds a suite by progress, not by wall time: every
  // assertion is progress, so the deadline this suite's waits ride moves
  // forward while its cases keep passing. Without that, a late case on a slow
  // core starts with whatever was left of a budget armed when the suite began,
  // and its waits are given nothing.
  try {
    const before = testDeadlineMs();
    assert(true, 'progress');
    await waitFor(() => testDeadlineMs() > before, {
      timeoutMs: 30000,
      description: () => `the unit runner to move this suite's deadline on progress (armed ${new Date(before).toISOString()}, now ${new Date(testDeadlineMs()).toISOString()})`
    });
    passed++;
  } catch (e) {
    failed++;
    errors.push(`progress moves a unit suite's deadline: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The watchdog's two halves. Work whose stamp keeps changing is never
  // stalled, however many ticks it takes; work whose stamp never changes is,
  // one window after it last moved, and the report taken then names the wait
  // it is parked on. Both are about what the stamp did, not how fast anything ran.
  {
    /** @type {ReturnType<typeof watchForStall>|null} */
    let watch = null;
    try {
      let reads = 0;
      let moves = 0;
      let stalled = false;
      watch = watchForStall({ stamp: () => String(reads++), windowMs: 300, onExtend: () => { moves++; }, subject: 'progressing work' });
      watch.stalled.catch(() => { stalled = true; });
      await waitFor(() => moves >= 4, { timeoutMs: 30000, description: 'the watchdog to see four changes of stamp' });
      assert(!stalled, 'work whose stamp changed at every tick was reported as stalled');
      passed++;
    } catch (e) {
      failed++;
      errors.push(`progress keeps the watchdog quiet: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      watch?.stop();
    }
  }
  // Time this realm is not run is not silence: the watchdog sees progress only
  // through this lane's own code, so a main thread held elsewhere — a slow
  // core, a sibling lane's work — would otherwise read as a stalled test.
  // Holding the thread here for longer than the window must not stall it.
  {
    /** @type {ReturnType<typeof watchForStall>|null} */
    let watch = null;
    try {
      let stalled = false;
      watch = watchForStall({ stamp: () => 'unchanging', windowMs: 2000, onExtend: () => {}, subject: 'unscheduled work' });
      watch.stalled.catch(() => { stalled = true; });
      const holdUntil = Date.now() + 3000;
      // eslint-disable-next-line juggler/no-private-test-wait -- holding this realm's main thread is the subject
      while (Date.now() < holdUntil) { /* the realm is not run */ }
      const w = watch;
      await waitFor(() => w.stalls().includes('not run'), { timeoutMs: 10000, description: () => `the watchdog to discount the held thread (${w.stalls()})` });
      assert(!stalled, `3s in which this realm was not run counted against a 2s window: ${w.stalls()}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`time the lane is not run is not silence: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      watch?.stop();
    }
  }
  {
    const close = trackWait('a deliberate wedge');
    /** @type {ReturnType<typeof watchForStall>|null} */
    let watch = null;
    try {
      watch = watchForStall({ stamp: () => 'unchanging', windowMs: 300, onExtend: () => {}, subject: 'wedged work' });
      /** @type {string[]} */
      let parked = [];
      const stall = await watch.stalled.then(() => null, (/** @type {unknown} */ e) => {
        parked = waitsInFlightReport();
        return e;
      });
      const message = stall instanceof Error ? stall.message : String(stall);
      assert(message.includes('wedged work made no progress'),
        `a wedge must be reported as the subject making no progress, got: ${message}`);
      assert(parked.some((l) => l.includes('a deliberate wedge')),
        `the report taken at the stall must name the wait it is parked on, got: ${parked.join(' | ')}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`a wedge stalls and names its wait: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      watch?.stop();
      close('abandoned');
    }
  }

  // A lane is a page as well as a clock, and a page has to have a size. The
  // pool window is permanently hidden, and a hidden window is not necessarily an
  // allocated one — GTK sizes a widget in a layout pass and only runs one for a
  // window that is mapped, so nothing there measures anything and a lane inside
  // lays every element out in a page 0 pixels wide, where every rect is empty and
  // every measurement is zero. Nothing fails for that reason on its own: the
  // tests that measure something pass vacuously, and the one test that needs a
  // measurement to exist reports it as a fault in the thing it was measuring.
  try {
    const width = window.innerWidth;
    const height = window.innerHeight;
    assert(
      width > 0 && height > 0,
      `this lane lays out in a page of ${width}x${height}, so every rect in every test here is empty and anything measured is measured as zero — either the pool's web view never took a size (ensureHiddenPoolWebViewSized, cmd/juggler/app) or the lane size floor is not reaching this lane (serveTestPool, cmd/juggler/server)`
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`a lane has a page with a size to lay out in: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The progress report is the harness talking to itself, so a suite that
  // stubs `window.fetch` must not see it: a stub that rejects requests it does
  // not expect would fail its test whenever a report happens to fall inside
  // the stub's lifetime, which on a slow core is whenever the stub lives
  // longer than the report interval.
  {
    const realFetch = window.fetch;
    /** @type {string[]} */
    const seen = [];
    try {
      window.fetch = /** @type {any} */ (async (/** @type {any} */ input) => {
        seen.push(String(typeof input === 'string' ? input : input.url));
        throw new Error('stubbed');
      });
      setReportedTest('unit:test-budget'); // this suite's queued name; also lifts the rate limit
      reportTestProgress();
      window.fetch = realFetch;
      assert(seen.length === 0, `a suite's fetch stub received the harness's progress report: ${JSON.stringify(seen)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`a fetch stub never sees the progress report: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      window.fetch = realFetch;
    }
  }

  return { passed, failed, errors };
}
