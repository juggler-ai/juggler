//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * `juggler/utils/debounce` — a trailing-edge debounce with an optional ceiling.
 *
 * A plain trailing debounce is restarted by every call, so while calls keep
 * arriving closer together than `wait` the work is postponed for as long as
 * they do — which, for a view refreshing on a stream of change events, means it
 * shows the old state until the stream stops. On a slow machine that may be
 * never. `maxWait` bounds it: the first call of a burst starts a second timer
 * that later calls do not restart, and whichever of the two fires first runs
 * the work and ends the burst.
 *
 * Clock-free: both deadlines are timers, so the only time it consults is the
 * scheduler's, and a test that captures `setTimeout`/`clearTimeout` (or passes
 * `timers`) drives it deterministically.
 *
 * Pure and DOM-free, so it serves the viewer, the engine worker and extensions
 * alike — exposed as `juggler/utils/debounce` in the document import maps and
 * in `workerSDKImports` (cmd/juggler/server/worker_module.go), mirroring
 * `juggler/utils/html`.
 */

/**
 * @typedef {object} DebounceTimers
 * @property {(fn: () => void, ms: number) => unknown} setTimeout - Schedules a call,
 *   returning an id only its own `clearTimeout` need understand.
 * @property {(id: unknown) => void} clearTimeout - Cancels one, by the id `setTimeout` returned.
 */

/**
 * @typedef {object} DebounceOptions
 * @property {number} [maxWait] - The longest, in ms, the first call of a burst
 *   may be postponed by the calls that follow it. Omitted: no ceiling, for the
 *   cases where waiting for quiet is the whole point.
 * @property {DebounceTimers} [timers] - The scheduler. Defaults to the global
 *   one, looked up at each call so a test that replaces it is honoured.
 */

/**
 * @template {unknown[]} A
 * @typedef {((...args: A) => void) & {
 *   cancel: () => void,
 *   flush: () => void,
 *   pending: () => boolean,
 * }} Debounced
 */

/** @type {DebounceTimers} */
const GLOBAL_TIMERS = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(/** @type {ReturnType<typeof globalThis.setTimeout>} */ (id)),
};

/**
 * Wrap `fn` so a burst of calls runs it once, `wait` ms after the last of them
 * — or `maxWait` ms after the first, if the burst is still going then. The
 * arguments of the latest call are the ones it runs with.
 *
 * The returned function also has `cancel()` (drop a waiting run), `flush()`
 * (run a waiting one now) and `pending()` (whether one is waiting).
 * @template {unknown[]} A
 * @param {(...args: A) => void} fn - The work.
 * @param {number} wait - Quiet, in ms, that ends a burst.
 * @param {DebounceOptions} [options] - Ceiling and scheduler.
 * @returns {Debounced<A>} The debounced function.
 */
export function debounce(fn, wait, options = {}) {
  const { maxWait, timers = GLOBAL_TIMERS } = options;
  /** @type {unknown} */
  let trailing = null;
  /** @type {unknown} */
  let ceiling = null;
  /** @type {A|null} */
  let lastArgs = null;

  const clear = () => {
    if (trailing !== null) timers.clearTimeout(trailing);
    if (ceiling !== null) timers.clearTimeout(ceiling);
    trailing = null;
    ceiling = null;
  };

  const run = () => {
    // A timer the scheduler failed to cancel has nothing left to run.
    if (lastArgs === null) return;
    const args = lastArgs;
    // Cleared before the work, so a call made by the work itself (or the next
    // event) begins a new burst rather than inheriting this one's ceiling.
    clear();
    lastArgs = null;
    fn(...args);
  };

  /** @type {Debounced<A>} */
  const debounced = Object.assign(
    (/** @type {A} */ ...args) => {
      lastArgs = args;
      if (trailing !== null) timers.clearTimeout(trailing);
      trailing = timers.setTimeout(run, wait);
      if (ceiling === null && maxWait !== undefined) {
        ceiling = timers.setTimeout(run, maxWait);
      }
    },
    {
      cancel: () => { clear(); lastArgs = null; },
      flush: () => { if (trailing !== null) run(); },
      pending: () => trailing !== null,
    },
  );
  return debounced;
}
