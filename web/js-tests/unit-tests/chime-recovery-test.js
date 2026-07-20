//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Chime-synth context-recovery unit tests.
 *
 * The desktop app reuses one process-lifetime AudioContext for every
 * notification chime. In the WKWebView the app runs in, macOS can park that
 * context: `suspended` under autoplay policy until a user gesture, or
 * `interrupted` (a non-standard WebKit state) after an output-device change,
 * sleep/wake, or another app grabbing audio. A parked context schedules chimes
 * against a clock that isn't advancing — i.e. silence — so recovery matters.
 *
 * `wakeContext` is the play-time safety net: it resumes on any non-`running`
 * state (`suspended` autoplay start, or a genuine `interrupted` after a real
 * device change), so a chime fired against a parked context still tries. When
 * resume() *can't* clear a wedged session, `isContextWedged` is the predicate the
 * gesture path (unlockAudio) uses to rebuild the context from scratch instead.
 * These tests exercise both against fake contexts (a real one can't be driven
 * into `interrupted`, and headless runs have no real output device).
 * @module unit-tests/chime-recovery-test
 */

import { assert } from '../utilities/test-helpers.js';
import { wakeContext, isContextWedged, rearmAudio, recoverThenSchedule, keepAudioContextWarm, shouldAutoResume } from '../../js/utils/chime-synth.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of assertions that passed.
 * @property {number} failed Number of assertions that failed.
 * @property {string[]} errors Collected failure messages.
 */

/**
 * Minimal AudioContext stand-in that records resume() calls.
 * @param {string} state - Initial context state.
 * @param {boolean} [reject] - Make resume() reject (as a `closed` context would).
 * @returns {{state: string, resumeCalls: number, resume: () => Promise<void>}} The fake context object.
 */
function fakeContext(state, reject = false) {
  return {
    state,
    resumeCalls: 0,
    resume() {
      this.resumeCalls++;
      return reject ? Promise.reject(new Error('closed')) : Promise.resolve();
    },
  };
}

/**
 * AudioContext stand-in for the play-time recovery driver ({@link recoverThenSchedule}):
 * records resume() calls and can transition state and/or reject on resume.
 * @param {string} state - Initial context state.
 * @param {{resumeTo?: string, reject?: boolean}} [opts] - resumeTo: state to adopt once resume() resolves; reject: make resume() reject.
 * @returns {any} The fake context object.
 */
function fakeDriveContext(state, { resumeTo, reject = false } = {}) {
  return {
    state,
    resumeCalls: 0,
    resume() {
      this.resumeCalls++;
      if (reject) return Promise.reject(new Error('resume refused'));
      if (resumeTo) this.state = resumeTo;
      return Promise.resolve();
    },
  };
}

/**
 * @returns {Promise<TestResult>} Resolves to counts of passed/failed assertions and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => (void | Promise<void>)} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('wakeContext resumes an interrupted context (the WKWebView stuck state)', () => {
    const ac = fakeContext('interrupted');
    wakeContext(/** @type {any} */ (ac));
    assert(ac.resumeCalls === 1, `expected resume() on interrupted, got ${ac.resumeCalls} calls`);
  });

  await run('wakeContext resumes a suspended context', () => {
    const ac = fakeContext('suspended');
    wakeContext(/** @type {any} */ (ac));
    assert(ac.resumeCalls === 1, `expected resume() on suspended, got ${ac.resumeCalls} calls`);
  });

  await run('wakeContext leaves a running context untouched', () => {
    const ac = fakeContext('running');
    wakeContext(/** @type {any} */ (ac));
    assert(ac.resumeCalls === 0, `expected no resume() on running, got ${ac.resumeCalls} calls`);
  });

  await run('wakeContext swallows a rejected resume() (closed context never throws)', async () => {
    const ac = fakeContext('closed', true);
    // Must not throw synchronously...
    wakeContext(/** @type {any} */ (ac));
    assert(ac.resumeCalls === 1, `expected resume() attempt on closed, got ${ac.resumeCalls} calls`);
    // ...and the rejection must be caught (an unhandled rejection would surface
    // as a test-runner error on the next microtask flush).
    await Promise.resolve();
  });

  await run('isContextWedged flags an interrupted context for rebuild (resume() can stick)', () => {
    assert(isContextWedged(/** @type {any} */ ({ state: 'interrupted' })) === true, 'interrupted must be wedged');
  });

  await run('isContextWedged flags a closed context for rebuild (resume() rejects forever)', () => {
    assert(isContextWedged(/** @type {any} */ ({ state: 'closed' })) === true, 'closed must be wedged');
  });

  await run('isContextWedged treats a missing context as wedged (nothing to resume)', () => {
    assert(isContextWedged(null) === true, 'null must be wedged');
    assert(isContextWedged(undefined) === true, 'undefined must be wedged');
  });

  await run('isContextWedged leaves running/suspended alone — resume() handles those in a gesture', () => {
    assert(isContextWedged(/** @type {any} */ ({ state: 'running' })) === false, 'running must not be wedged');
    assert(isContextWedged(/** @type {any} */ ({ state: 'suspended' })) === false, 'suspended must not be wedged');
  });

  await run('rearmAudio is a no-op with no unlocked context (never creates one, never throws)', () => {
    // No unlock gesture has run in this module, so the shared context is null;
    // a passive re-arm must do nothing rather than lazily construct a context.
    rearmAudio();
    assert(true, 'unreachable');
  });

  // ── recoverThenSchedule: the play-time "recover, then schedule" driver ──────
  // Injected deps make the control flow testable without a real AudioContext:
  // `immediateDefer` runs each retry synchronously (so a bounded retry chain
  // drains within one macrotask), and `settle` awaits that chain's completion.
  const immediateDefer = (/** @type {() => void} */ fn) => fn();
  const settle = () => new Promise((r) => setTimeout(r, 0));

  await run('recoverThenSchedule schedules at once on a running context (no resume, no rebuild)', () => {
    const ac = fakeDriveContext('running');
    /** @type {any[]} */ const scheduled = [];
    let rebuilds = 0;
    recoverThenSchedule(/** @type {any} */ (ac), (c) => scheduled.push(c), () => { rebuilds++; return null; }, { defer: immediateDefer });
    assert(scheduled.length === 1, `expected 1 schedule on a running context, got ${scheduled.length}`);
    assert(ac.resumeCalls === 0, 'must not resume an already-running context');
    assert(rebuilds === 0, 'must not rebuild an already-running context');
  });

  await run('recoverThenSchedule resumes a suspended context, then schedules once running (no rebuild)', async () => {
    const ac = fakeDriveContext('suspended', { resumeTo: 'running' });
    /** @type {string[]} */ const scheduled = [];
    let rebuilds = 0;
    recoverThenSchedule(/** @type {any} */ (ac), (c) => scheduled.push(c.state), () => { rebuilds++; return null; }, { defer: immediateDefer });
    await settle();
    assert(ac.resumeCalls === 1, `expected exactly 1 resume, got ${ac.resumeCalls}`);
    assert(rebuilds === 0, 'suspended is not wedged — must not rebuild');
    assert(scheduled.length === 1 && scheduled[0] === 'running', 'must schedule only after the state is running');
  });

  await run('recoverThenSchedule rebuilds a wedged (interrupted) context once, then drives the fresh one', async () => {
    const ac = fakeDriveContext('interrupted');
    const fresh = fakeDriveContext('suspended', { resumeTo: 'running' });
    /** @type {any[]} */ const scheduled = [];
    let rebuilds = 0;
    recoverThenSchedule(/** @type {any} */ (ac), (c) => scheduled.push(c), () => { rebuilds++; return /** @type {any} */ (fresh); }, { defer: immediateDefer });
    await settle();
    assert(rebuilds === 1, `expected exactly one rebuild, got ${rebuilds}`);
    assert(ac.resumeCalls === 0, 'a wedged context must be rebuilt, not resumed');
    assert(fresh.resumeCalls === 1, `expected the fresh context resumed once, got ${fresh.resumeCalls}`);
    assert(scheduled.length === 1 && scheduled[0] === fresh, 'must schedule on the rebuilt context');
  });

  await run('recoverThenSchedule gives up (bounded) when resume never reaches running — never schedules', async () => {
    const ac = fakeDriveContext('suspended'); // resume() resolves but leaves it suspended
    /** @type {any[]} */ const scheduled = [];
    recoverThenSchedule(/** @type {any} */ (ac), (c) => scheduled.push(c), () => null, { retries: 3, defer: immediateDefer });
    await settle();
    assert(scheduled.length === 0, 'must never schedule against a context that never runs');
    assert(ac.resumeCalls === 4, `expected 1 initial + 3 retries = 4 resume calls, got ${ac.resumeCalls}`);
  });

  await run('recoverThenSchedule gives up (bounded) on persistent resume() rejection — no schedule, no throw', async () => {
    const ac = fakeDriveContext('suspended', { reject: true });
    /** @type {any[]} */ const scheduled = [];
    recoverThenSchedule(/** @type {any} */ (ac), (c) => scheduled.push(c), () => null, { retries: 3, defer: immediateDefer });
    await settle();
    assert(scheduled.length === 0, 'a context whose resume() always rejects must never schedule');
    assert(ac.resumeCalls === 4, `expected 4 resume attempts before giving up, got ${ac.resumeCalls}`);
  });

  await run('recoverThenSchedule bails quietly when a wedged context cannot be rebuilt', async () => {
    const ac = fakeDriveContext('closed');
    /** @type {any[]} */ const scheduled = [];
    recoverThenSchedule(/** @type {any} */ (ac), (c) => scheduled.push(c), () => null, { defer: immediateDefer });
    await settle();
    assert(scheduled.length === 0, 'no rebuild available → nothing to schedule on');
    assert(ac.resumeCalls === 0, 'a closed context is wedged — rebuilt (and failed), never resumed');
  });

  // ── idle-suspend: park the context when the app goes quiet (non-Apple) ──────
  // shouldAutoResume is the guard the automatic wake paths (onstatechange,
  // rearmAudio) consult so a context WE parked for idleness is left parked,
  // while an OS/policy park is still recovered.

  await run('shouldAutoResume: never resumes an already-running context', () => {
    assert(shouldAutoResume('running', false) === false, 'running never needs resume');
    assert(shouldAutoResume('running', true) === false, 'running never needs resume even if flagged');
  });

  await run('shouldAutoResume: leaves a deliberately idle-parked context suspended', () => {
    assert(shouldAutoResume('suspended', true) === false, 'our own idle-park must not be auto-resumed');
  });

  await run('shouldAutoResume: resumes an OS/autoplay suspend we did not set', () => {
    assert(shouldAutoResume('suspended', false) === true, 'a suspend we did not cause should be resumed');
  });

  await run('shouldAutoResume: always recovers interrupted/closed, idle-flag notwithstanding', () => {
    assert(shouldAutoResume('interrupted', false) === true, 'interrupted is an OS park — resume');
    assert(shouldAutoResume('interrupted', true) === true, 'interrupted is never our idle-park — still resume');
    assert(shouldAutoResume('closed', true) === true, 'closed → attempt resume (rejects, handled elsewhere)');
  });

  await run('keepAudioContextWarm: true on Apple platforms (macOS/iOS), false elsewhere', () => {
    assert(keepAudioContextWarm('MacIntel', '') === true, 'macOS keeps the context warm');
    assert(keepAudioContextWarm('', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)') === true, 'iOS keeps the context warm');
    assert(keepAudioContextWarm('Linux x86_64', 'X11; Linux x86_64') === false, 'Linux parks when idle');
    assert(keepAudioContextWarm('Win32', 'Windows NT 10.0') === false, 'Windows parks when idle');
  });

  return { passed, failed, errors };
}
