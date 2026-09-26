//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Per-iframe ring-buffer event tape for debugging cross-iframe Yjs and
 * worker-message races. Records timestamped events (WS in/out, session
 * mutations, observer fires, mock-LLM pops, etc.) so that when an
 * integration test fails, the failure block can show every iframe's view
 * of what happened on the affected conversation, interleaved by wall
 * clock. Production page loads no-op every recordTape() call (the gate
 * is the truthy `window.__jugglerTrace` flag, set only by the test
 * harness), so there is no cost in normal operation.
 * @module utils/event-tape
 */

/**
 * Maximum buffered entries before the oldest one is evicted. Sized for the
 * 9-lane pool under peak load: every lane's broadcasts land in every iframe's
 * ring, so a small ring wraps in under a second and a failing test's own
 * events are already evicted by the time the failure block is built. Entries
 * are compact summaries, so even at capacity this stays a few MB.
 */
const TAPE_CAPACITY = 20000;

/**
 * @typedef {object} TapeEntry
 * @property {number} ts - Wall-clock ms (performance.timeOrigin + performance.now()).
 * @property {string} kind - Short category, e.g. 'ws-out', 'session-mut'.
 * @property {string|null} convId - Conversation id this event pertains to, or null.
 * @property {object} summary - Small JSON-serialisable payload, kept tight.
 */

/** @type {TapeEntry[]} */
const _tape = [];
let _head = 0;
let _size = 0;

/**
 * True when the tape should record. Set by the test harness once at startup
 * (`window.__jugglerTrace = true`); production page loads leave it falsy so
 * recordTape() short-circuits in one boolean test.
 * @returns {boolean} True iff tape recording is active
 */
function _enabled() {
  return Boolean(/** @type {any} */ (globalThis.window || globalThis).__jugglerTrace);
}

/**
 * Append one event to the per-iframe ring buffer. Cheap when disabled.
 * @param {string} kind - Short category tag.
 * @param {string|null} convId - Affected conversation, or null if global.
 * @param {object} [summary] - Small payload object; will be shallow-copied.
 */
export function recordTape(kind, convId, summary) {
  if (!_enabled()) return;
  const ts = Date.now();
  const entry = { ts, kind, convId: convId || null, summary: summary || {} };
  if (_size < TAPE_CAPACITY) {
    _tape.push(entry);
    _size++;
  } else {
    _tape[_head] = entry;
    _head = (_head + 1) % TAPE_CAPACITY;
  }
}

/**
 * Return entries in chronological order, optionally filtered by convId.
 * Used by the test harness's dump-request handler.
 * @param {string|string[]|null} [filterConvIds] - One convId, an array of them, or null for all.
 * @returns {TapeEntry[]} Entries sorted oldest-first.
 */
export function dumpTape(filterConvIds) {
  /** @type {TapeEntry[]} */
  const ordered = [];
  if (_size < TAPE_CAPACITY) {
    for (let i = 0; i < _size; i++) ordered.push(/** @type {TapeEntry} */ (_tape[i]));
  } else {
    for (let i = 0; i < TAPE_CAPACITY; i++) {
      ordered.push(/** @type {TapeEntry} */ (_tape[(_head + i) % TAPE_CAPACITY]));
    }
  }
  if (!filterConvIds) return ordered;
  const set = new Set(Array.isArray(filterConvIds) ? filterConvIds : [filterConvIds]);
  return ordered.filter((e) => e.convId !== null && set.has(e.convId));
}

/**
 * When something last happened on any of `convIds` — the signal a stall
 * watchdog rides, so a test is bounded by how long it has gone without making
 * progress rather than by how long it has been running.
 *
 * Filtering by conversation is not an optimisation, it is the whole point: every
 * lane's broadcasts land in every iframe's ring, so an unfiltered "last entry"
 * is kept permanently fresh by the eight other lanes and would never report a
 * stall. Scans the ring in place rather than materialising it like
 * {@link dumpTape} does, because this runs on a timer for the whole of every
 * test instead of once while a failure is being assembled.
 * @param {string[]} convIds - The conversations this test owns.
 * @returns {number} The newest matching entry's timestamp, or 0 when there is none.
 */
export function lastTapeTs(convIds) {
  if (!convIds || convIds.length === 0) return 0;
  const set = new Set(convIds);
  let newest = 0;
  for (let i = 0; i < _size; i++) {
    const entry = _tape[i];
    if (!entry || entry.convId === null) continue;
    if (entry.ts > newest && set.has(entry.convId)) newest = entry.ts;
  }
  return newest;
}

/**
 * Clear the tape. The test runner calls this at the start of each test so
 * one test's events don't leak into another's failure dump.
 */
export function clearTape() {
  _tape.length = 0;
  _head = 0;
  _size = 0;
}
