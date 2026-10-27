//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The waits every test rides: poll a condition, or race a promise, until it
 * answers or the test it belongs to stops making progress.
 *
 * A wait's own bound is its nominal timeout, and it follows the test's deadline
 * past it: the stall watchdog (`stall-watch.js`) moves that deadline every time
 * the test makes progress, and a wait still running when its nominal ends is
 * owed exactly the distance it moved (`deadlineMoves`, test-deadline.js). So a
 * test that is being served slowly — a slow core, a saturated machine, a
 * duty-cycled process — keeps every wait it is in, and a wedge fails on the
 * nominal because nothing is moving.
 *
 * Nothing here asks the machine whether it was busy. That question used to buy
 * a failing wait more time, and it is the wrong question: a slow core reads as a
 * quiet machine, and its timer hops look like a fault, so the waits it most
 * needed to keep were the ones it refused. What the machine was doing is still
 * printed when a wait gives up ({@link whyGivingUp}), as a reading for whoever
 * diagnoses the failure, never as a verdict.
 *
 * A satisfied wait is progress (`noteProgress`): a test whose waits keep being
 * answered is alive, whatever else it is doing.
 * @module js-tests/utilities/test-patience
 */

import { fetchMachineLoad, measureTimerGrid } from './machine-load.js';
import { deadlineMoves, noteProgress, testGeneration } from './test-deadline.js';

/**
 * What the machine looked like as a wait gave up, for its timeout message: the
 * load average and the worst timer hop this lane saw. A reading, not an
 * excuse — neither says whether the wait was being served.
 * @returns {Promise<string>} A clause describing the machine, ready to append.
 */
export async function whyGivingUp() {
  const [load, grid] = await Promise.all([
    fetchMachineLoad(),
    measureTimerGrid().catch(() => null)
  ]);
  const clauses = [load?.available ? `load ${load.perCpu.toFixed(2)}/CPU` : 'load unreadable'];
  if (grid) clauses.push(`worst timer hop ${grid.worstMs}ms`);
  return `machine at give-up: ${clauses.join(', ')}`;
}

/**
 * Poll `probe` until it returns something truthy, for its nominal and for as
 * long past it as the test keeps making progress.
 *
 * The shape every polling wait in the suite wants: probe, sleep, probe, and on
 * reaching the bound follow the deadline if it has moved rather than throwing. Callers
 * get `null` back when the bound ran out and raise their own error, because the
 * message a wait fails with is the most useful line in its failure block and
 * belongs to the wait, not to this module.
 * A wait outlives its test whenever that test fails: the runner abandons the
 * body where it stands, and the promises inside it keep their own counsel. So
 * the generation is captured on the way in and checked on every round — the
 * instant this wait belongs to nobody it stops, rather than polling on for a
 * state that is never coming and charging its patience to the next test.
 *
 * While it runs it is listed for {@link waitsInFlightReport}, under `what`.
 * @template T
 * @param {() => T} probe - Checked immediately and after every interval; any truthy value ends the wait.
 * @param {{nominalMs: number, intervalMs?: number, what?: WaitDescription}} opts - The wait's own bound, how often to look, and what it waits for.
 * @returns {Promise<T|null>} The probe's truthy value, or null if the wait gave up or was abandoned.
 */
export async function pollPatiently(probe, { nominalMs, intervalMs = 10, what }) {
  const mine = testGeneration();
  const wait = openWait(what);
  let outcome = 'gave up';
  try {
    const started = Date.now();
    const moved = deadlineMoves();
    let allowanceMs = nominalMs;
    for (;;) {
      const got = probe();
      if (got) {
        outcome = 'satisfied';
        return got;
      }
      if (testGeneration() !== mine) {
        outcome = 'abandoned';
        return null;
      }
      if (Date.now() - started >= allowanceMs) {
        // Owed first: the runner moved the deadline because the test made
        // progress since this wait began (deadlineMoves, test-deadline.js).
        const by = moved();
        if (by <= 0) return null;
        allowanceMs += by;
        continue;
      }
      await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    }
  } catch (e) {
    outcome = 'threw';
    throw e;
  } finally {
    closeWait(wait, outcome);
  }
}

/**
 * {@link pollPatiently} for a wait that has a promise to race rather than a
 * condition to poll.
 *
 * The promise is re-raced each time the deadline has moved, which is safe —
 * awaiting one twice is free — and means the work carries on across the
 * extension rather than being restarted by it.
 *
 * Listed for {@link waitsInFlightReport} like a polling wait, unless `track` is
 * false — which is for the runner's own race over a whole suite, a wait that is
 * running whenever anything in the suite is and so would name nothing.
 * @template T
 * @param {Promise<T>} promise - The work being waited on.
 * @param {number} nominalMs - The wait's own bound.
 * @param {{what?: WaitDescription, track?: boolean}} [opts] - What it waits for, and whether to list it.
 * @returns {Promise<{value: T}|null>} The settled value, or null if the wait gave up. A rejection propagates.
 */
export async function racePatiently(promise, nominalMs, { what, track = true } = {}) {
  const wait = track ? openWait(what) : null;
  let outcome = 'gave up';
  try {
    const wrapped = promise.then((value) => ({ value }), (error) => { throw error; });
    const moved = deadlineMoves();
    let remainingMs = nominalMs;
    for (;;) {
      /** @type {{value: T}|undefined} */
      const settled = await Promise.race([
        wrapped,
        new Promise((resolve) => { setTimeout(() => resolve(undefined), remainingMs); })
      ]);
      if (settled) {
        outcome = 'satisfied';
        return settled;
      }
      // Owed first: the test made progress since this wait began.
      const by = moved();
      if (by <= 0) return null;
      remainingMs = by;
    }
  } catch (e) {
    outcome = 'threw';
    throw e;
  } finally {
    if (wait) closeWait(wait, outcome);
  }
}

/**
 * List a wait that neither polls nor races — one woken by observers, which
 * {@link pollPatiently} and {@link racePatiently} cannot carry — for
 * {@link waitsInFlightReport}, until the returned function is called.
 * @param {WaitDescription} what - What it waits for; a function is evaluated when a report asks.
 * @returns {(outcome: 'satisfied'|'gave up'|'threw'|'abandoned') => void} Call once, as the wait ends.
 */
export function trackWait(what) {
  const wait = openWait(what);
  let closed = false;
  return (outcome) => {
    if (closed) return;
    closed = true;
    closeWait(wait, outcome);
  };
}

/**
 * A wait in progress, as the suite timeout reports it.
 * @typedef {object} OpenWait
 * @property {WaitDescription|undefined} what What it waits for, if its caller said.
 * @property {number} startedAt When it began (Date.now()).
 * @property {number} generation The test it belongs to.
 * @property {Error} origin Taken as it began, for its call site; the stack is parsed only if a report needs it.
 */

/** @typedef {string | (() => string)} WaitDescription */

/**
 * The waits running now.
 *
 * A suite that outlives its budget used to be reported as having "stopped making
 * progress" and nothing more, so the sighting named no case and no wait, and the
 * next sighting could say no more than the last. Every wait registers here for
 * as long as it runs, so the timeout can say where the suite was parked. The
 * cost on a passing run is one `new Error()` per wait.
 * @type {Set<OpenWait>}
 */
const openWaits = new Set();

/** @type {{wait: OpenWait, endedAt: number, outcome: string}|null} */
let lastSettled = null;

/**
 * Register a wait that is starting. Waits left behind by an earlier test are
 * dropped here: they stop on their own next round, and are not this test's.
 * @param {WaitDescription|undefined} what - What it waits for.
 * @returns {OpenWait} The token to close it with.
 */
function openWait(what) {
  const generation = testGeneration();
  for (const w of openWaits) if (w.generation !== generation) openWaits.delete(w);
  const wait = { what, startedAt: Date.now(), generation, origin: new Error() };
  openWaits.add(wait);
  return wait;
}

/**
 * @param {OpenWait} wait - The wait that has ended.
 * @param {string} outcome - How: 'satisfied', 'gave up', or 'abandoned'.
 */
function closeWait(wait, outcome) {
  openWaits.delete(wait);
  if (outcome === 'satisfied') noteProgress();
  if (wait.generation === testGeneration()) lastSettled = { wait, endedAt: Date.now(), outcome };
}

/** The frames that are this machinery's own, never a caller worth naming. */
const OWN_FRAME = /\/js-tests\/utilities\/(test-patience|test-helpers|turn-sync)\.js:/;

/**
 * Where a wait was called from: the first two frames outside the waits
 * themselves, which is the helper that waited and the case that called it —
 * or the case alone, when it waited directly.
 * @param {Error} origin - Taken when the wait began.
 * @returns {string} One `name@path:line` per frame, innermost first.
 */
function callSite(origin) {
  const frames = String(origin.stack ?? '').split('\n')
    .map((f) => f.trim())
    .filter((f) => /\.js:\d+/.test(f) && !OWN_FRAME.test(f))
    .slice(0, 2)
    .map((f) => f
      .replace(/^at\s+/, '')
      .replace(/[a-z]+:\/\/[^/]+\//, '')
      .replace(/:(\d+):\d+\)?$/, ':$1')
      .replace(/\s*\(/, '@'));
  return frames.length ? frames.join(' ← ') : 'an unknown call site';
}

/**
 * @param {WaitDescription|undefined} what - The wait's description.
 * @returns {string} It, evaluated now when it is a function.
 */
function describeWait(what) {
  if (typeof what !== 'function') return what ?? 'an undescribed condition';
  try { return what(); }
  catch (e) { return `(its description threw: ${e instanceof Error ? e.message : String(e)})`; }
}

/**
 * Where the current test is parked, for a timeout's failure block: each wait
 * still running, oldest first, with its call site, its age, and its description
 * evaluated now — so a description written as a function reports the state the
 * wait last saw. With none running, the suite is parked on an await no wait
 * guards, and the last wait to finish is what places it.
 * @returns {string[]} Report lines, indented for a failure block.
 */
export function waitsInFlightReport() {
  const now = Date.now();
  const generation = testGeneration();
  const secs = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(1)}s`;
  const running = [...openWaits].filter((w) => w.generation === generation)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (running.length) {
    const shown = running.slice(0, 5).map((w) =>
      `  STILL WAITING (${secs(now - w.startedAt)}): ${callSite(w.origin)} — for ${describeWait(w.what)}`);
    if (running.length > shown.length) shown.push(`  …and ${running.length - shown.length} more wait(s) still running`);
    return shown;
  }
  if (lastSettled && lastSettled.wait.generation === generation) {
    const { wait, endedAt, outcome } = lastSettled;
    return [`  NO WAIT IN FLIGHT: the suite is parked on an await no wait guards. The last wait to finish (${outcome}, ${secs(now - endedAt)} ago) was ${callSite(wait.origin)} — for ${describeWait(wait.what)}`];
  }
  return ['  NO WAIT IN FLIGHT, and none has run in this test: it is parked before its first wait'];
}
