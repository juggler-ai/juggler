//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The exclusivity flag reaches the Go runner from every kind of suite.
 *
 * `needsExclusiveRun` is how a test says no sibling lane may be in flight while
 * it runs, and the lanes share one fixture root, so a declaration that never
 * arrives costs a cross-test failure nobody can read. Three kinds of suite
 * declare it — an integration test on its definition, an internal unit suite on
 * its table entry, an extension suite as a module export — and each travels a
 * different path into listExclusiveTests(). This pins all three: the collector
 * that reads them, the loader step that turns an extension's export into a table
 * entry, and the real declarations, so a flag that quietly stops counting fails
 * here rather than as somebody else's timeout.
 * @module unit-tests/exclusive-test-flags-test
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
  const {
    exclusiveNamesIn,
    extensionSuiteEntry,
    listExclusiveTests,
    ensureExtensionSuitesLoaded
  } = await import('../utilities/integration-test-executor.js');

  /**
   * @param {string} label
   * @param {() => (void | Promise<void>)} fn
   */
  const run = async (label, fn) => {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  await run('a flag on any table reaches the collector', () => {
    const integrationTests = [
      { name: 'integration:flagged', needsExclusiveRun: true },
      { name: 'integration:plain' }
    ];
    const unitSuites = [{ name: 'unit:flagged', needsExclusiveRun: true }, { name: 'unit:plain' }];
    const extensionSuites = [{ name: 'unit:ext-flagged', needsExclusiveRun: true }, { name: 'unit:ext-plain' }];

    const got = exclusiveNamesIn(integrationTests, unitSuites, extensionSuites);
    const want = ['integration:flagged', 'unit:flagged', 'unit:ext-flagged'];
    if (got.join(',') !== want.join(',')) {
      throw new Error(`collected ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  });

  await run('an extension module\'s export becomes the suite entry\'s flag', () => {
    const runTestsStub = async () => ({ passed: 0, failed: 0, errors: [] });
    const flagged = extensionSuiteEntry('unit:ext', { runTests: runTestsStub, needsExclusiveRun: true });
    if (flagged.needsExclusiveRun !== true) {
      throw new Error('an extension exporting needsExclusiveRun produced an entry without it');
    }
    if (flagged.run !== runTestsStub || flagged.name !== 'unit:ext') {
      throw new Error('the entry lost the suite name or its runTests export');
    }
    const plain = extensionSuiteEntry('unit:ext', { runTests: runTestsStub });
    if (plain.needsExclusiveRun !== false) {
      throw new Error('an extension exporting nothing was made exclusive anyway');
    }
  });

  await run('every kind of real declaration is in the list', async () => {
    await ensureExtensionSuitesLoaded();
    const exclusive = new Set(listExclusiveTests());

    // One live declaration of each kind. A suite that deliberately stops being
    // exclusive gets swapped here for another of its kind — the point is that
    // each path stays covered, not that these particular suites are exclusive.
    const declarations = [
      ['an integration test', 'integration:compaction-preserves-memory'],
      ['an internal unit suite', 'unit:escape-behaviour'],
      ['an extension suite', 'unit:git-worktree']
    ];
    for (const [kind, name] of declarations) {
      if (!exclusive.has(name)) throw new Error(`${kind} (${name}) declares exclusivity and the runner is not told`);
    }
  });

  await run('the suites that churn the shared fixture root are exclusive', async () => {
    await ensureExtensionSuitesLoaded();
    const exclusive = new Set(listExclusiveTests());

    // Both make and remove directories directly in the fixture root every lane
    // shares, which a sibling walking the project reads as they come and go.
    const missing = ['unit:scratch-sandbox', 'unit:conversation-workspace'].filter(name => !exclusive.has(name));
    if (missing.length) {
      throw new Error(`${missing.join(', ')} build and remove directories in the shared fixture root, so they must run alone`);
    }
  });

  await run('the suites that switch tool grouping on are exclusive', () => {
    const exclusive = new Set(listExclusiveTests());

    // The preference is read by every lane's renderer, so while one of these has
    // it on, a sibling's tool rows fold into a group and its DOM assertions fail.
    const missing = ['unit:tool-grouping', 'unit:delete-selection-neighbour', 'unit:jump-to-attention-reveal']
      .filter(name => !exclusive.has(name));
    if (missing.length) {
      throw new Error(`${missing.join(', ')} turn tool grouping on, so they must run alone`);
    }
  });

  await run('the suites that assert the composer keeps focus are exclusive', () => {
    const exclusive = new Set(listExclusiveTests());
    // A sibling lane taking the window's focus blurs the composer mid-case.
    if (!exclusive.has('unit:column-navigation')) {
      throw new Error('unit:column-navigation asserts document.activeElement, so it must run alone');
    }
  });

  return { passed, failed, errors };
}
