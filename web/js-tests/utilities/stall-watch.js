//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The one bound a running test or unit suite is failed on: it has stopped
 * getting anywhere.
 *
 * A bound on total runtime fails a test for the machine's sins. On a slow core
 * every piece of work costs some multiple of its fast-core cost, and a runtime
 * bound picked on a fast one is simply wrong there — the worker tape of a test
 * killed that way shows deltas still landing at the instant of death. What the
 * bound should mean is "this is not getting anywhere", so that is what it
 * measures: the caller supplies a stamp, one comparable value made of
 * everything that says the work is alive, and any change to it resets the
 * clock. A wedge leaves the stamp alone and fails in one window, however fast
 * or slow the core it is wedged on.
 *
 * The machine is never asked for an excuse. Load averages and timer hops are
 * printed in the failure block as readings, but a quiet-looking machine can be
 * a slow one, and a busy one can be serving the lane perfectly well, so neither
 * is evidence about whether this test was making progress. The stamp is.
 * @module js-tests/utilities/stall-watch
 */

import { whyGivingUp } from './test-patience.js';
import { apiUrl } from '../../js/utils/api-url.js';

/**
 * How often the watchdog looks for progress. Fine enough that the moment
 * the work goes quiet is pinned to within a quarter second, coarse enough to be
 * invisible next to the work it is watching.
 */
const STALL_TICK_MS = 250;

/**
 * How late a tick may run and still count its whole gap as time the work was
 * observed being silent.
 *
 * The watchdog can only see progress while this realm runs: tape entries,
 * assertions and finished operations are all recorded by this lane's own
 * code. A tick that arrives seconds late is the realm itself not having been
 * run — a slow core, a main thread the window's other lanes were holding — and
 * in that gap nothing here could have recorded progress whatever the test was
 * doing. So a gap past this is not silence: the window's clock is moved on by
 * the excess, and so is the deadline every wait rides. A lane wedged in a
 * synchronous loop never ticks at all; the Go harness's own silence window,
 * fed by this module's progress reports, is what catches that.
 */
const OBSERVED_GAP_MS = 1000;

/**
 * @typedef {object} StallWatch
 * @property {Promise<never>} stalled Rejects, once, when the stamp has not changed for a whole window.
 * @property {() => void} stop Its off switch; call on every exit path.
 * @property {() => string} stalls A one-line account of the quietest stretch, for the failure block.
 */

/**
 * Watch some running work and fail it only once it has stopped getting
 * anywhere.
 * @param {object} opts - What to watch.
 * @param {() => string} opts.stamp - Everything that says the work is alive, as one comparable value; read every tick.
 * @param {number} opts.windowMs - How long the work may make no progress at all.
 * @param {(deadlineMs: number) => void} opts.onExtend - Called with the new deadline whenever the window moves, so waits inside the work can follow it.
 * @param {string} [opts.subject] - What the rejection names as having stalled.
 * @param {() => boolean} [opts.unobservable] - True while progress cannot be observed at all — the server not answering the lane's progress probe — so the time passing is not counted as silence, as time this realm is not run is not.
 * @returns {StallWatch} The rejection to race, its off switch, and its account.
 */
export function watchForStall({ stamp, windowMs, onExtend, subject = 'Test', unobservable = () => false }) {
  let stop = () => {};
  let lastProgressAt = Date.now();
  let lastTickAt = lastProgressAt;
  let lastStamp = '';
  let quietestMs = 0;
  let unobservedMs = 0;

  const stalled = new Promise((_, reject) => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const tickAt = Date.now();
      // Time this realm was not run is not time the work was silent
      // (OBSERVED_GAP_MS): move the window's origin, and the deadline, on by it.
      const sinceTick = tickAt - lastTickAt;
      const unobserved = unobservable() ? sinceTick : sinceTick - OBSERVED_GAP_MS;
      lastTickAt = tickAt;
      if (unobserved > 0) {
        unobservedMs += unobserved;
        lastProgressAt += unobserved;
        onExtend(lastProgressAt + windowMs);
      }
      const now = stamp();
      if (now !== lastStamp) {
        lastStamp = now;
        lastProgressAt = Date.now();
        onExtend(lastProgressAt + windowMs);
        return;
      }
      const quietMs = Date.now() - lastProgressAt;
      if (quietMs > quietestMs) quietestMs = quietMs;
      if (quietMs < windowMs) return;
      stopped = true;
      clearInterval(timer);
      reject(new Error(
        `${subject} made no progress for ${Math.round(quietMs / 1000)}s (window ${Math.round(windowMs / 1000)}s) — ${await whyGivingUp()}`
      ));
    };
    const timer = setInterval(tick, STALL_TICK_MS);
    stop = () => {
      stopped = true;
      clearInterval(timer);
    };
  });
  // A watchdog stopped before it fired is never raced again; one that fires
  // after its race was abandoned must not surface as an unhandled rejection.
  stalled.catch(() => {});

  return {
    stalled: /** @type {Promise<never>} */ (stalled),
    stop,
    stalls: () => `longest quiet stretch ${Math.round(quietestMs / 1000)}s of an allowed ${Math.round(windowMs / 1000)}s`
      + (unobservedMs > 0 ? `, not counting ${Math.round(unobservedMs / 1000)}s in which this lane was not run or the server did not answer it` : '')
  };
}

/**
 * How often the worker-progress probe asks. Far inside any stall window, and
 * slow enough that nine lanes asking cost a busy server nothing it notices.
 */
const WORKER_POLL_MS = 2000;

/**
 * Progress the lane cannot see from its own events: whether the workers of the
 * conversations it owns are still getting through their work.
 *
 * A lane hears its worker only when the worker sends it something, and a
 * worker working through a backlog in front of the lane's request — the shape
 * of every turn on a slow core, where one server process serves every lane —
 * sends nothing until it reaches that request. The worker records each thing
 * it does on its own tape, so the tape's head moving is progress for this test.
 * So is any worker's (the "*" head): one server process and one engine serve
 * every lane, and a request queued behind the other lanes' work is being
 * served while they are. A wedge still fails — alone, in one window; behind
 * busy siblings, one window after they go quiet. One
 * request at a time, so a server that is slow to answer is never asked twice.
 * @param {() => string[]} convIds - The conversations whose workers count, read at each poll.
 *
 * While a probe goes unanswered for longer than a poll, the server is not
 * answering this lane at all, and nothing the lane could observe would show
 * progress: `unanswered` says so, for the watchdog to leave that time
 * uncounted. A server that has wedged outright is caught where it can be — the
 * lane's progress reports stop reaching the Go harness, whose own silence
 * window fails the test.
 * @returns {{mark: () => string, unanswered: () => boolean, stop: () => void}} The latest answer, as a stamp part; whether a probe has been waiting on the server past a poll; and the off switch.
 */
export function watchWorkerProgress(convIds) {
  let mark = '';
  let inFlight = false;
  let sentAt = 0;
  let stopped = false;
  const poll = async () => {
    if (stopped || inFlight) return;
    // Asked even with no conversations of its own: the server-wide head, and
    // whether the server answers at all, bear on every wait in the lane.
    const ids = convIds();
    inFlight = true;
    sentAt = Date.now();
    try {
      const resp = await fetch(apiUrl(`/test/tape-head?convIds=${encodeURIComponent(ids.join(','))}`));
      if (resp.ok) {
        const body = await resp.json();
        if (!stopped) mark = JSON.stringify(body?.heads ?? {});
      }
    } catch {
      // A probe that fails says nothing either way; the lane's own signals stand.
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => { void poll(); }, WORKER_POLL_MS);
  void poll();
  return {
    mark: () => mark,
    unanswered: () => inFlight && Date.now() - sentAt > WORKER_POLL_MS,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
}

/**
 * The longest a single fetch may be in flight and still count as the server
 * working on this lane's request (see {@link awaitingServer}). Past it, the
 * fetch is a connection held open, not a request being served, and must not
 * keep a wedged test alive.
 */
const FETCH_IN_FLIGHT_CAP_MS = 2 * 60_000;

/** When each of this lane's in-flight fetches started, by sequence number. */
const laneFetches = new Map();
let fetchSeq = 0;
let fetchTrackingInstalled = false;

/**
 * Count this lane's fetches in and out, for {@link awaitingServer}. Installed
 * once per lane, before any test runs; a test that replaces `window.fetch` for
 * its own case puts it back, and this wrapper with it.
 */
export function installFetchTracking() {
  if (fetchTrackingInstalled || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  fetchTrackingInstalled = true;
  const real = window.fetch.bind(window);
  window.fetch = /** @type {typeof window.fetch} */ ((...args) => {
    const id = ++fetchSeq;
    laneFetches.set(id, Date.now());
    return real(...args).finally(() => { laneFetches.delete(id); });
  });
}

/**
 * Whether the lane is waiting on the server: a fetch it made is in flight, and
 * has not been so long that it is a held connection. Any age counts — a first
 * load on a slow core is a run of short fetches, none long on its own.
 *
 * The time that passes then is the server working on this lane's request, and
 * nothing in the lane can move until it answers — on a slow core a single read
 * of a file is longer than a wait's whole nominal. So the watchdog leaves that
 * time uncounted, as it does time the realm is not run. A test wedged on an
 * event that never comes has nothing in flight, and still stalls in a window.
 * @returns {boolean} True while some fetch is outstanding and under the cap.
 */
export function awaitingServer() {
  const now = Date.now();
  for (const at of laneFetches.values()) {
    if (now - at < FETCH_IN_FLIGHT_CAP_MS) return true;
  }
  return false;
}
