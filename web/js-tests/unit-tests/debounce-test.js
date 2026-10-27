//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for `juggler/utils/debounce` (web/sdk/lib/debounce.js). Time is a
 * scheduler the test owns: the helper consults no clock of its own, so
 * advancing the scheduler is advancing time, and every case is deterministic
 * however slow the machine running it.
 * @module unit-tests/debounce-test
 */

import { debounce } from '../../sdk/lib/debounce.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing cases.
 * @property {number} failed Number of failing cases.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A scheduler whose time moves only when told to.
 * @returns {{timers: import('../../sdk/lib/debounce.js').DebounceTimers, advance: (ms: number) => void, now: () => number}}
 *   The timers to hand the helper, a way to move time on (running whatever falls
 *   due, in order), and the current virtual time.
 */
function virtualScheduler() {
  let now = 0;
  let nextId = 1;
  /** @type {Map<number, {at: number, fn: () => void}>} */
  const queue = new Map();
  return {
    timers: {
      setTimeout: (fn, ms) => {
        const id = nextId++;
        queue.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (id) => { queue.delete(id); },
    },
    advance: (ms) => {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, entry] of queue) {
          if (entry.at <= end && (due === null || entry.at < due[1].at)) due = [id, entry];
        }
        if (due === null) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    now: () => now,
  };
}

/**
 * Run the debounce tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What the case shows.
   * @param {() => void} fn - The case.
   */
  const test = (name, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  test('a burst closer together than the wait still fires by maxWait', () => {
    const clock = virtualScheduler();
    /** @type {number[]} */
    const fired = [];
    const call = debounce(() => fired.push(clock.now()), 150, { maxWait: 1000, timers: clock.timers });
    // Every 100ms for 3s: the trailing timer is always restarted before it can
    // fire, so only the ceiling can end a burst.
    for (let t = 0; t < 3000; t += 100) {
      call();
      clock.advance(100);
    }
    assert(fired.length > 0,
      'a 3s burst of calls 100ms apart never ran the work once — a 150ms debounce with no ceiling waits for quiet that never comes');
    assert(fired[0] <= 1000, `the first run is owed by maxWait (1000ms), it came at ${fired[0]}ms`);
    assert(fired.length >= 2, `a burst three times maxWait runs at least twice during it, ran ${fired.length}`);
  });

  test('a lone call fires once, after the wait', () => {
    const clock = virtualScheduler();
    /** @type {number[]} */
    const fired = [];
    const call = debounce(() => fired.push(clock.now()), 150, { maxWait: 1000, timers: clock.timers });
    call();
    clock.advance(149);
    assert(fired.length === 0, 'nothing runs before the wait');
    clock.advance(5000);
    assert(fired.length === 1 && fired[0] === 150, `one run at 150ms, got ${JSON.stringify(fired)}`);
  });

  test('a short burst is still coalesced into one call', () => {
    const clock = virtualScheduler();
    let runs = 0;
    const call = debounce(() => { runs++; }, 150, { maxWait: 1000, timers: clock.timers });
    for (let i = 0; i < 5; i++) { call(); clock.advance(50); }
    clock.advance(5000);
    assert(runs === 1, `five calls 50ms apart are one run, got ${runs}`);
  });

  test('the latest arguments are the ones it runs with', () => {
    const clock = virtualScheduler();
    /** @type {string[]} */
    const seen = [];
    const call = debounce((/** @type {string} */ v) => seen.push(v), 150, { timers: clock.timers });
    call('a'); call('b'); call('c');
    clock.advance(200);
    assert(JSON.stringify(seen) === '["c"]', `got ${JSON.stringify(seen)}`);
  });

  test('without maxWait it waits for quiet, however long', () => {
    const clock = virtualScheduler();
    let runs = 0;
    const call = debounce(() => { runs++; }, 150, { timers: clock.timers });
    for (let t = 0; t < 3000; t += 100) { call(); clock.advance(100); }
    assert(runs === 0, `no ceiling means no run mid-burst, got ${runs}`);
    clock.advance(150);
    assert(runs === 1, `and one run once it is quiet, got ${runs}`);
  });

  test('cancel drops the waiting run, ceiling included', () => {
    const clock = virtualScheduler();
    let runs = 0;
    const call = debounce(() => { runs++; }, 150, { maxWait: 1000, timers: clock.timers });
    call();
    assert(call.pending(), 'a call leaves a run waiting');
    call.cancel();
    assert(!call.pending(), 'and cancel takes it away');
    clock.advance(5000);
    assert(runs === 0, `nothing runs after cancel, got ${runs}`);
  });

  test('flush runs a waiting call now, and only once', () => {
    const clock = virtualScheduler();
    let runs = 0;
    const call = debounce(() => { runs++; }, 150, { maxWait: 1000, timers: clock.timers });
    call.flush();
    assert(runs === 0, 'flush with nothing waiting runs nothing');
    call();
    call.flush();
    assert(runs === 1, 'flush runs the waiting call');
    clock.advance(5000);
    assert(runs === 1, `and leaves no timer to run it again, got ${runs}`);
  });

  return { passed, failed, errors };
}
