//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Lost-server tests: a desktop window onto a server by URL that has been
 * reconnecting for a minute asks the app to show its "can't reach the server"
 * stand-in instead — once per outage, never during a blip, and not at all for
 * a window that has no stand-in to become.
 *
 * The watcher is driven with a fake event source and a hand-cranked clock, so a
 * minute's outage costs nothing.
 * @module unit-tests/server-lost-test
 */

import { assert } from '../utilities/test-helpers.js';
import { watchForLostServer, GIVE_UP_AFTER_MS } from '../../js/services/server-lost.js';

/**
 * An event source shaped like wsService's `on`.
 * @returns {{on: (name: string, fn: Function) => () => void, emit: (name: string) => void, listeners: () => number}} The source.
 */
function fakeEvents() {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)?.add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    emit(name) {
      for (const fn of [...(handlers.get(name) || [])]) fn();
    },
    listeners() {
      let n = 0;
      for (const set of handlers.values()) n += set.size;
      return n;
    },
  };
}

/**
 * A clock that only moves when told to.
 * @returns {{setTimeout: (fn: Function, ms: number) => number, clearTimeout: (id: number) => void, advance: (ms: number) => void, pending: () => number}} The clock.
 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  /** @type {Map<number, {at: number, fn: Function}>} */
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((x, y) => x[1].at - y[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    pending() {
      return timers.size;
    },
  };
}

/** Let the report's promise settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/**
 * Run the lost-server tests.
 * @param {any} _ctx - Test context (unused).
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test name
   * @param {() => Promise<void>|void} fn - Test body
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  /**
   * A watcher on fakes, counting its reports.
   * @param {{eligible?: boolean, answers?: boolean[]}} [opts] - Whether the window may be replaced, and what each report resolves to.
   * @returns {{events: ReturnType<typeof fakeEvents>, clock: ReturnType<typeof fakeClock>, reports: () => number, stop: () => void}} The rig.
   */
  function rig({ eligible = true, answers = [true] } = {}) {
    const events = fakeEvents();
    const clock = fakeClock();
    let reports = 0;
    const stop = watchForLostServer({
      events,
      eligible,
      timers: clock,
      report: async () => answers[Math.min(reports++, answers.length - 1)],
    });
    return { events, clock, reports: () => reports, stop };
  }

  await test('a minute of reconnecting asks for the stand-in, once', async () => {
    const r = rig();
    r.events.emit('close');
    r.clock.advance(GIVE_UP_AFTER_MS - 1);
    assert(r.reports() === 0, 'asked before the minute was up');
    r.clock.advance(1);
    assert(r.reports() === 1, `want one report at the minute, got ${r.reports()}`);
    await settle();
    r.clock.advance(10 * GIVE_UP_AFTER_MS);
    assert(r.reports() === 1, 'asked again after the app said it was replacing the window');
    r.stop();
  });

  await test('every failed attempt closing again does not restart the minute', () => {
    const r = rig();
    r.events.emit('close');
    for (let i = 0; i < 6; i++) {
      r.clock.advance(10_000);
      r.events.emit('close');
    }
    assert(r.reports() === 1, `want the report a minute after the FIRST close, got ${r.reports()} reports`);
    r.stop();
  });

  await test('a link that comes back before the minute is never reported', () => {
    const r = rig();
    r.events.emit('close');
    r.clock.advance(GIVE_UP_AFTER_MS - 1000);
    r.events.emit('open');
    r.clock.advance(GIVE_UP_AFTER_MS);
    assert(r.reports() === 0, 'reported an outage that ended');
    // A later outage gets a whole minute of its own.
    r.events.emit('close');
    r.clock.advance(GIVE_UP_AFTER_MS - 1000);
    assert(r.reports() === 0, 'the second outage inherited the first one\'s time');
    r.clock.advance(1000);
    assert(r.reports() === 1, 'the second outage was never reported');
    r.stop();
  });

  await test('a server the app still reaches is given another minute', async () => {
    const r = rig({ answers: [false, true] });
    r.events.emit('close');
    r.clock.advance(GIVE_UP_AFTER_MS);
    await settle();
    assert(r.reports() === 1, 'want the first report');
    r.clock.advance(GIVE_UP_AFTER_MS);
    assert(r.reports() === 2, 'a server that answered the app but never this page was not asked about again');
    r.stop();
  });

  await test('a refusal as full is not an outage', () => {
    const r = rig();
    r.events.emit('close');
    r.events.emit('server-full');
    r.clock.advance(2 * GIVE_UP_AFTER_MS);
    assert(r.reports() === 0, 'a viewer turned away as full was sent to the unreachable page');
    r.stop();
  });

  await test('a window with no stand-in to become watches nothing', () => {
    const r = rig({ eligible: false });
    assert(r.events.listeners() === 0, 'an ineligible window subscribed anyway');
    r.events.emit('close');
    r.clock.advance(2 * GIVE_UP_AFTER_MS);
    assert(r.reports() === 0, 'an ineligible window reported');
  });

  await test('stopping leaves no listener or timer behind', () => {
    const r = rig();
    r.events.emit('close');
    r.stop();
    assert(r.events.listeners() === 0, 'listeners left behind');
    assert(r.clock.pending() === 0, 'timer left behind');
  });

  return { passed, failed, errors };
}
