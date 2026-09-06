//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The harness's own budget contract.
 *
 * Every wait in a test is supposed to ride the deadline the run will actually
 * fail on, rather than a nominal sub-timeout chosen when a lane had the pool to
 * itself. That rule was written once for mock-LLM tests and quietly missed the
 * unit suites entirely — for months every "rides the budget" wait in a unit
 * suite fell back to its bare 3s or 5s, and the suite paid for it in browser
 * tests lost to load, one different one per run.
 *
 * Nothing detected that, because a budget is invisible until the machine is
 * busy. These cases are the detector: they assert the deadline exists and that
 * the waits which claim to ride it actually do.
 * @module unit-tests/test-budget-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { budgetFor, testDeadlineMs, setTestDeadline } from '../utilities/test-deadline.js';
import UIDriver from '../utilities/ui-driver.js';
import { executeUIOperation, lastConfirmGiveUp, disarmConfirm } from '../utilities/ui-operation-executor.js';

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Fixture directory (unused here).
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * The Go harness stops polling for this test's result at 60s
 * (`browser_suite_test.go`), so a deadline at or past that reports nothing:
 * the subtest dies on a bare poll timeout with no message, which is precisely
 * the shape of half the entries in the flaky-test log.
 */
const GO_RESULT_POLL_MS = 60000;

/**
 * Run the budget-contract tests.
 * @param {TestContext} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // A unit suite is a test like any other and must be given a deadline. Left
  // unarmed, every wait below silently reverts to its nominal timeout.
  try {
    const deadline = testDeadlineMs();
    assert(deadline > 0, 'no deadline is armed while a unit suite is running; every wait in this suite is falling back to its nominal timeout');
    const remaining = deadline - Date.now();
    assert(
      remaining > 0,
      `the armed deadline has already passed (${remaining}ms remaining), so every wait in this suite fails instantly`
    );
    assert(
      remaining < GO_RESULT_POLL_MS,
      `the armed deadline leaves ${remaining}ms, past the Go harness's ${GO_RESULT_POLL_MS}ms result poll — a failure here would be reported as a bare poll timeout with no message`
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`a unit suite runs under a deadline: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The point of the deadline is patience: a wait nominally allowed 3s must be
  // allowed the whole remaining budget instead.
  try {
    const nominal = 3000;
    const budget = budgetFor(nominal);
    assert(
      budget > nominal,
      `budgetFor(${nominal}) returned ${budget}; a wait is still capped at its nominal timeout rather than riding the deadline`
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`waits ride the deadline, not their nominal timeout: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The driver is built by unit suites directly, with no deadline passed in.
  // It must still find the armed one rather than falling back.
  try {
    const container = document.createElement('div');
    const driver = new UIDriver(container);
    const budget = /** @type {any} */ (driver)._budget(3000);
    assert(
      budget > 3000,
      `a UIDriver constructed without an explicit deadline budgets ${budget}ms for a 3000ms wait; it is not picking up the armed deadline`
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`a driver built without an explicit deadline still rides it: ${e instanceof Error ? e.message : String(e)}`);
  }

  // waitFor is the most-used wait in the unit suites and the one with no
  // harness to ask. It deliberately keeps its caller's timeout rather than
  // riding the deadline — making it patient was measured and cost the suite
  // two of three clean runs (see its own doc comment). What it must do is stay
  // bounded and say what it was waiting for.
  try {
    const started = Date.now();
    let threw = null;
    try {
      await waitFor(() => false, { timeoutMs: 100, description: 'a condition that is never true' });
    } catch (e) {
      threw = e;
    }
    assert(threw !== null, 'waitFor resolved for a condition that is never true');
    const message = threw instanceof Error ? threw.message : String(threw);
    assert(
      message.includes('a condition that is never true'),
      `waitFor's timeout must name what it was waiting for, got: ${message}`
    );
    const elapsed = Date.now() - started;
    assert(
      elapsed < 5000,
      `waitFor with an explicit 100ms timeout took ${elapsed}ms; it must keep its caller's bound, not spend the suite's budget`
    );
    passed++;
  } catch (e) {
    failed++;
    errors.push(`waitFor stays bounded and names its condition: ${e instanceof Error ? e.message : String(e)}`);
  }

  // `expect-confirm` is the one wait in the harness whose nominal timeout, when
  // missed, does not produce a failure at all. It arms a watcher BEFORE the
  // operation that raises the dialog, because that operation blocks on the
  // production confirm promise — and that promise has no timeout of its own
  // (modal-dialog.js resolves it on a click and on nothing else). So a watcher
  // that gives up early leaves nobody to answer the dialog, and the operation
  // hangs until the runner kills the whole test. Both halves are covered here:
  // the watcher must ride the deadline like every other wait, and when it does
  // give up it must leave a record, so the hang that follows names its cause
  // instead of arriving as an anonymous timeout.
  try {
    const armedDeadline = testDeadlineMs();
    try {
      // A deadline already spent collapses budgetFor to nothing, so a watcher
      // riding it gives up at once while one pinned to its nominal 5s does not.
      setTestDeadline(Date.now() - 4900);
      await executeUIOperation(/** @type {any} */ ({}), { type: 'expect-confirm', answer: true });
      await waitFor(() => lastConfirmGiveUp() !== null, {
        timeoutMs: 1000,
        description: 'the armed confirmation watcher to give up and say so'
      });
      const giveUp = lastConfirmGiveUp() || '';
      assert(
        giveUp.includes('no confirmation'),
        `the recorded give-up must say what the watcher was waiting for, got: ${giveUp}`
      );
    } finally {
      disarmConfirm();
      setTestDeadline(armedDeadline);
    }
    passed++;
  } catch (e) {
    failed++;
    errors.push(`the armed confirmation watcher rides the deadline and records giving up: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
