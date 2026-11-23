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
import { watchForLostServer, sessionGone, GIVE_UP_AFTER_MS } from '../../js/services/server-lost.js';

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
   * A watcher on fakes, counting its reports, its probes and its loads of the link again.
   * @param {{eligible?: boolean, answers?: boolean[], forgotten?: Array<boolean|'forgotten'|'relaunch'|null>}} [opts] - Whether the window may be replaced, what each report resolves to, and what each probe of the session finds (gone or not, and how).
   * @returns {{events: ReturnType<typeof fakeEvents>, clock: ReturnType<typeof fakeClock>, reports: () => number, probes: () => number, reopens: () => number, stop: () => void}} The rig.
   */
  function rig({ eligible = true, answers = [true], forgotten = [false] } = {}) {
    const events = fakeEvents();
    const clock = fakeClock();
    let reports = 0;
    let probes = 0;
    let reopens = 0;
    const stop = watchForLostServer({
      events,
      eligible,
      timers: clock,
      report: async () => answers[Math.min(reports++, answers.length - 1)],
      probe: async () => /** @type {any} */ (forgotten[Math.min(probes++, forgotten.length - 1)]),
      reopen: () => { reopens++; },
    });
    return { events, clock, reports: () => reports, probes: () => probes, reopens: () => reopens, stop };
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
    r.events.emit('stable');
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

  // A server that accepts the link and drops it a moment later, over and over:
  // every open is followed by a close before the link has proved itself, so
  // the outage never ended, and the window must still be moved on.
  await test('a link that keeps opening and dropping does not restart the minute', () => {
    const r = rig();
    r.events.emit('close');
    for (let elapsed = 0; elapsed < GIVE_UP_AFTER_MS - 7_000; elapsed += 7_000) {
      r.clock.advance(6_000);
      r.events.emit('open');
      r.clock.advance(1_000);
      r.events.emit('close');
    }
    r.clock.advance(7_000);
    assert(r.reports() === 1, `want the report a minute after the outage began, got ${r.reports()} reports`);
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

  // A server restarted under the window answers again with no session for it:
  // the socket is refused for ever, and waiting out the minute only keeps the
  // user looking at "Reconnecting…".
  await test('a failed attempt whose server has forgotten the session asks at once', async () => {
    const r = rig({ forgotten: [false, true] });
    r.events.emit('close');
    await settle();
    assert(r.reports() === 0, 'asked while the server was still down');
    r.clock.advance(5_000);
    r.events.emit('close');
    await settle();
    assert(r.reports() === 1, `want a report as soon as the session was found forgotten, got ${r.reports()}`);
    r.clock.advance(2 * GIVE_UP_AFTER_MS);
    r.events.emit('close');
    await settle();
    assert(r.reports() === 1, 'asked again after the app said it was replacing the window');
    r.stop();
  });

  await test('a forgotten session the app will not act on is not asked about at every attempt', async () => {
    const r = rig({ forgotten: [true], answers: [false, true] });
    r.events.emit('close');
    await settle();
    assert(r.reports() === 1, 'want the first report');
    for (let i = 0; i < 4; i++) {
      r.clock.advance(5_000);
      r.events.emit('close');
      await settle();
    }
    assert(r.reports() === 1, `asked at every attempt: ${r.reports()} reports`);
    r.clock.advance(GIVE_UP_AFTER_MS);
    assert(r.reports() === 2, 'the minute no longer runs after an early report');
    r.stop();
  });

  await test('a probe still in flight is not started again', async () => {
    const r = rig();
    r.events.emit('close');
    r.events.emit('close');
    await settle();
    assert(r.probes() === 1, `want one probe for two closes in one tick, got ${r.probes()}`);
    r.stop();
  });

  // A browser tab has no stand-in to become, so it asks the app nothing. A
  // session that only relaunching the server opens again is the one outage it
  // does not wait out: it loads its link again, where the server's page offers
  // the relaunch, and opens the session once it is done. Once an outage.
  await test('a browser tab asks nothing of the app, and loads its link again for a session only a relaunch opens', async () => {
    const r = rig({ eligible: false, forgotten: [true, 'relaunch'] });
    r.events.emit('close');
    r.clock.advance(2 * GIVE_UP_AFTER_MS);
    await settle();
    assert(r.reports() === 0, 'a browser tab asked the app');
    assert(r.reopens() === 0, 'a tab loaded its link again for a session that is merely forgotten');
    r.events.emit('close');
    await settle();
    assert(r.reopens() === 1, `a session only a relaunch opens: ${r.reopens()} loads of the link, want 1`);
    r.events.emit('close');
    await settle();
    assert(r.reopens() === 1, 'the link was loaded again twice in one outage');
    r.stop();
    assert(r.events.listeners() === 0, 'listeners left behind');
  });

  // The proxy says a session is gone for good in two ways: none for the link
  // (404), and one that only a relaunch of the server opens again (503, saying so).
  await test('the probe tells a forgotten session from one only a relaunch opens', async () => {
    const answering = (/** @type {number} */ status, /** @type {string} */ body) => async () => /** @type {any} */ ({ status, text: async () => body });
    const gone = async (/** @type {number} */ status, /** @type {string} */ body) => sessionGone({ base: '/p/x-0000', fetchImpl: answering(status, body) });
    assert(await gone(404, 'this project has no session') === 'forgotten', 'a 404 is not a forgotten session');
    assert(await gone(503, JSON.stringify({ error: 'x', relaunchNeeded: true })) === 'relaunch', 'a 503 saying a relaunch is needed is not one');
    assert(await gone(503, 'session is not running (state: restarting)') === null, 'a session between lives is taken for gone');
    assert(await sessionGone({ base: '', fetchImpl: answering(404, '') }) === null, 'a page with no proxy is taken for gone');
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
