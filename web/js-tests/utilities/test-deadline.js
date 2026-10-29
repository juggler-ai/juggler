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
 * The whole budget the armed deadline represents, when that deadline is shared
 * by many cases, and 0 when it belongs to a single test. See
 * {@link MAX_SHARE_OF_SHARED_BUDGET}.
 * @type {number}
 */
let sharedBudgetMs = 0;

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
 * The most of a shared budget one wait may take.
 *
 * `SHARED_DEADLINE_SLACK` alone caps a wait at a multiple of its own nominal,
 * which stops binding the moment that multiple exceeds the budget: a 10s
 * nominal in a 45s suite is capped at 60s, so the first stuck wait spends
 * everything and the suite is reported as one that "stopped making progress",
 * naming neither the wait nor the case. A cap expressed as a share of the
 * budget cannot come loose that way, whatever nominal a caller picks. A third
 * leaves room for the case to fail, for a couple of later ones to run, and for
 * the suite to post a result that says which wait ran out.
 */
const MAX_SHARE_OF_SHARED_BUDGET = 1 / 3;

/**
 * Which test the armed deadline belongs to, counted up every time one is armed
 * or disarmed.
 *
 * A lane abandons a failed test's body where it stands — the runner aborts, the
 * result is posted, and the next test starts — but the waits inside that body
 * are ordinary promises and nobody is holding them. They go on polling, and what
 * they poll for will never happen, so they run to their bound and then ask for
 * more time out of a budget that now belongs to the test that came after them.
 * On a loaded machine a few hundred of those turn a red run into an endless one.
 *
 * A wait cannot hold a reference to its test — that is the whole reason this
 * module is module state — so it holds the generation instead, and gives up the
 * moment it does not match. One number, read in the same breath as the deadline.
 * @type {number}
 */
let generation = 0;

/**
 * How many things this lane's running test has done that prove it is alive: an
 * assertion evaluated, a wait satisfied. Read by the stall watchdog
 * (`stall-watch.js`) as part of its stamp, so a unit suite whose cases are
 * passing is never mistaken for a stalled one, however slow its core. Only its
 * changing matters, never its value.
 * @type {number}
 */
let progress = 0;

/** Record that the running test did something that proves it alive. */
export function noteProgress() {
  progress++;
}

/** @returns {number} A mark that changes whenever {@link noteProgress} is called. */
export function progressMark() {
  return progress;
}

/**
 * How many cases of the running suite have finished, pass or fail.
 *
 * Progress ({@link noteProgress}) is something a case that loops forever
 * keeps making: it evaluates the same assertions and satisfies the same waits
 * every time round. Finishing is the one thing it cannot do, so the runner's
 * runaway guard is re-armed by this count rather than by progress.
 * @type {number}
 */
let casesFinished = 0;

/**
 * Record that a case of the running suite has finished, pass or fail. A
 * suite's own case loop calls it once per case; a suite that never does is
 * one case to the runner from start to end.
 */
export function noteCaseFinished() {
  casesFinished++;
  noteProgress();
}

/** @returns {number} A mark that changes whenever {@link noteCaseFinished} is called. */
export function caseMark() {
  return casesFinished;
}

/**
 * Arm the deadline for the test now starting.
 *
 * `shared` says the deadline covers a whole suite of cases rather than one
 * test, which is what makes a single wait's share of it worth capping.
 *
 * Re-arming for the SAME test — which the stall watchdog does every time the
 * test makes progress — must not orphan that test's own waits, so the caller
 * says whether this is a new test or the same one moving its deadline.
 * @param {number} deadlineMs - Absolute Date.now()-based timestamp.
 * @param {{shared?: boolean, sameTest?: boolean}} [options] - Whether many cases ride this deadline, and whether this is a re-arm rather than a new test.
 */
export function setTestDeadline(deadlineMs, { shared = false, sameTest = false } = {}) {
  currentDeadlineMs = deadlineMs;
  sharedBudgetMs = shared ? Math.max(0, deadlineMs - Date.now()) : 0;
  if (!sameTest) generation++;
}

/**
 * Whether a case has taken the deadline into its own hands
 * ({@link pinTestDeadline}), so the stall watchdog's moves must leave it be.
 */
let pinned = false;

/**
 * Move the running test's deadline because it made progress — what the stall
 * watchdog does (`stall-watch.js`). A re-arm of the same test, so its waits
 * keep their generation and follow the move. Ignored while a case has the
 * deadline pinned.
 * @param {number} deadlineMs - The new absolute deadline.
 * @param {{shared?: boolean}} [options] - Whether many cases ride it.
 */
export function moveTestDeadline(deadlineMs, { shared = false } = {}) {
  if (pinned) return;
  setTestDeadline(deadlineMs, { shared, sameTest: true });
}

/**
 * Hold the deadline at a value of the caller's choosing, for a case that tests
 * how waits behave against a particular deadline — one already spent, one far
 * off. The watchdog moves the deadline whenever the suite makes progress, and
 * the case's own assertions are progress, so without this the deadline a case
 * set would be replaced under it within a quarter second. The case may still
 * call {@link setTestDeadline} itself while pinned.
 *
 * The returned function puts back exactly what was armed before, shared or
 * not, which a case re-arming the deadline by hand cannot reliably do.
 * @param {number} deadlineMs - The deadline to hold.
 * @param {{shared?: boolean}} [options] - Whether to arm it as shared.
 * @returns {() => void} Releases the pin and restores the previous deadline.
 */
export function pinTestDeadline(deadlineMs, { shared = false } = {}) {
  const before = { deadline: currentDeadlineMs, shared: sharedBudgetMs, wasPinned: pinned };
  pinned = true;
  setTestDeadline(deadlineMs, { shared, sameTest: true });
  return () => {
    currentDeadlineMs = before.deadline;
    sharedBudgetMs = before.shared;
    pinned = before.wasPinned;
  };
}

/**
 * Disarm it, so anything running between tests (cleanup, the lane loop) falls
 * back to its own nominal timeouts rather than to a deadline that has passed —
 * and so every wait still running from the test just finished knows it has been
 * abandoned and stops.
 */
export function clearTestDeadline() {
  pinned = false;
  currentDeadlineMs = 0;
  sharedBudgetMs = 0;
  generation++;
}

/**
 * The token a wait holds to tell its own test from its successor.
 * @returns {number} The current generation.
 */
export function testGeneration() {
  return generation;
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
  const capped = Math.min(remaining, fallbackMs * SHARED_DEADLINE_SLACK);
  if (!sharedBudgetMs) return capped;
  return Math.min(capped, Math.ceil(sharedBudgetMs * MAX_SHARE_OF_SHARED_BUDGET));
}

/**
 * How far the armed deadline has moved since this was last asked, so a wait can
 * follow a test that is still making progress.
 *
 * A wait turns its budget into a timer when it starts. The runner's stall
 * watchdog then moves the test's deadline forward every time the test makes
 * progress, and a timer set before that knows nothing of it. Each wait that
 * started more than one window into a progressing test would expire on the old
 * deadline, however live the test. On a slow core that was every long
 * integration test. A wait asks this when its timer fires, and is owed
 * exactly the distance the deadline moved: no more, so a wait capped at a
 * share of its suite stays capped, and nothing once its test has ended.
 * @returns {() => number} Milliseconds the deadline has moved since the last call (or since this was made); 0 once the test it belongs to has ended.
 */
export function deadlineMoves() {
  const mine = generation;
  let seen = currentDeadlineMs;
  return () => {
    if (generation !== mine || !seen || currentDeadlineMs <= seen) return 0;
    const by = currentDeadlineMs - seen;
    seen = currentDeadlineMs;
    return by;
  };
}

/**
 * A `setTimeout` for a wait's budget that follows the test's deadline: when it
 * fires and the deadline has moved since it was set, it sets itself again for
 * the distance moved instead of expiring (see {@link deadlineMoves}).
 * @param {() => void} onExpired - Called once, when the budget is spent and the deadline has not moved.
 * @param {number} budgetMs - The wait's budget as it stood when it began.
 * @returns {() => void} Cancels it.
 */
export function deadlineTimer(onExpired, budgetMs) {
  const moved = deadlineMoves();
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  const fire = () => {
    const by = moved();
    if (by > 0) {
      timer = setTimeout(fire, by);
      return;
    }
    onExpired();
  };
  timer = setTimeout(fire, budgetMs);
  return () => clearTimeout(timer);
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
