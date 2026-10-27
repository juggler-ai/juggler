//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A browser test that asserted nothing does not pass.
 *
 * suiteVerdict() is what turns a test's counts into the verdict the Go runner
 * receives. A suite whose case table came out empty, or whose run() returned
 * before its first case, reports 0 passed and 0 failed — and if that read as a
 * pass, the suite would go on "passing" forever having tested nothing.
 * @module unit-tests/suite-verdict-test
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // Imported dynamically: the executor's own table imports this suite, and a
  // static import back would read its exports before they are initialised.
  const { suiteVerdict, suiteBudgetWarning } = await import('../utilities/integration-test-executor.js');

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  run('zero passed and zero failed is a failure naming the test', () => {
    const v = suiteVerdict('unit:empty', { passed: 0, failed: 0, errors: [] });
    if (v.passed) throw new Error('a test that asserted nothing was given a pass');
    if (!v.errors.some(e => e.startsWith('unit:empty: NO TESTS RAN'))) {
      throw new Error(`errors do not name the empty test: ${JSON.stringify(v.errors)}`);
    }
  });

  run('missing counts are treated as nothing run', () => {
    const v = suiteVerdict('unit:shapeless', /** @type {any} */ ({ failed: 0 }));
    if (v.passed) throw new Error('a result with no passed count was given a pass');
  });

  run('a passing test passes and reports no errors', () => {
    const v = suiteVerdict('unit:ok', { passed: 3, failed: 0, errors: [] });
    if (!v.passed || v.errors.length !== 0) throw new Error(`got ${JSON.stringify(v)}`);
  });

  run('a failing test fails with its own errors, unchanged', () => {
    const v = suiteVerdict('unit:bad', { passed: 2, failed: 1, errors: ['boom'] });
    if (v.passed || v.errors.join('|') !== 'boom') throw new Error(`got ${JSON.stringify(v)}`);
  });

  // A passing suite prints nothing, so the warning is the only way one creeping
  // towards its budget is found before it fails instead of by its sightings.
  run('a passing suite over ten seconds is flagged, naming itself and the time', () => {
    const w = suiteBudgetWarning('unit:slow', { wallMs: 12_340 });
    if (!w.includes('unit:slow') || !w.includes('12.3s')) throw new Error(`got ${JSON.stringify(w)}`);
  });

  run('under ten seconds is not flagged', () => {
    const w = suiteBudgetWarning('unit:fine', { wallMs: 9_900 });
    if (w !== '') throw new Error(`got ${JSON.stringify(w)}`);
  });

  return { passed, failed, errors };
}
