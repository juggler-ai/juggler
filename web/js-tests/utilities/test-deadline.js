//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The one deadline every wait in a test rides.
 *
 * A wait's own nominal timeout — 3s to go quiet, 5s for a condition — was
 * chosen when a lane had the pool to itself. Nine lanes now share one machine
 * and genuinely run at once, so a lane's work can be sitting behind eight
 * siblings' and any wait tight enough to notice is measuring the pool rather
 * than the code. The honest bound is the one the run will actually fail on:
 * stay patient right up to it, and never past it.
 *
 * The runner sets this per test, and it is deliberately module state rather
 * than a parameter: `waitFor` is a free function called from hundreds of sites
 * that have no harness to ask, and threading a deadline through all of them is
 * how the last attempt at this came to cover only half the suite.
 *
 * A lane is single-threaded and runs one test at a time, so one value per realm
 * is exactly right.
 * @module js-tests/utilities/test-deadline
 */

/**
 * Absolute Date.now() the current test will be failed at, or 0 when unset.
 * @type {number}
 */
let currentDeadlineMs = 0;

/**
 * How much longer than its nominal timeout a wait may run when it is riding a
 * SHARED deadline.
 *
 * A mock-LLM test is one test behind one deadline, so a wait there may spend
 * all of it. A unit suite is dozens of cases behind one deadline, and a wait
 * allowed to spend the lot would turn the first genuine failure into a
 * cascade: one real message followed by every later case failing instantly
 * with no budget left. Capping a single wait keeps the suite's report
 * readable while still absorbing the load the nominal timeouts cannot.
 *
 * Six against the measured spread: a lane's work under a full concurrent run
 * has been seen to cost five to nine times its idle cost, and a wait needing
 * more than that is not slow, it is stuck.
 */
const SHARED_DEADLINE_SLACK = 6;

/**
 * Arm the deadline for the test now starting.
 * @param {number} deadlineMs - Absolute Date.now()-based timestamp.
 */
export function setTestDeadline(deadlineMs) {
  currentDeadlineMs = deadlineMs;
}

/**
 * Disarm it, so anything running between tests (cleanup, the lane loop) falls
 * back to its own nominal timeouts rather than to a deadline that has passed.
 */
export function clearTestDeadline() {
  currentDeadlineMs = 0;
}

/**
 * @returns {number} The armed deadline, or 0 when none is set.
 */
export function testDeadlineMs() {
  return currentDeadlineMs;
}

/**
 * How long a wait may run for.
 *
 * The +1s lets the runner's own hard timeout fire first, so a failure is
 * reported as the test that ran out of time — with its operation trace and
 * event tapes — rather than as whichever wait happened to be innermost.
 * `fallbackMs` applies only when no deadline is armed.
 *
 * A deadline passed in explicitly belongs to this wait's own test and may be
 * spent entirely; the armed one may be shared with the rest of a suite, so a
 * single wait takes at most `SHARED_DEADLINE_SLACK` times its nominal from it.
 * @param {number} fallbackMs - Nominal timeout to use when no deadline is set.
 * @param {number} [deadlineMs] - An explicit deadline, preferred over the armed one.
 * @returns {number} Milliseconds this wait may take.
 */
export function budgetFor(fallbackMs, deadlineMs = 0) {
  if (deadlineMs) return Math.max(0, deadlineMs - Date.now() + 1000);
  if (!currentDeadlineMs) return fallbackMs;
  const remaining = Math.max(0, currentDeadlineMs - Date.now() + 1000);
  return Math.min(remaining, fallbackMs * SHARED_DEADLINE_SLACK);
}

/**
 * The same answer as {@link budgetFor}, expressed as an absolute deadline for
 * the waits that take one (turn-sync's `observeUntil` and friends).
 * @param {number} fallbackMs - The wait's nominal timeout.
 * @param {number} [deadlineMs] - An explicit deadline, preferred over the armed one.
 * @returns {number} A deadline, or 0 when none applies and the wait should use its nominal.
 */
export function deadlineFor(fallbackMs, deadlineMs = 0) {
  if (deadlineMs) return deadlineMs;
  if (!currentDeadlineMs) return 0;
  return Date.now() + budgetFor(fallbackMs);
}
