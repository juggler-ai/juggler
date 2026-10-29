//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A unit suite cannot hand its `<html>`/`<body>` state to the next suite.
 *
 * A lane's page runs suite after suite, and product CSS keys whole regions off
 * the document element and body: a body class can hide the conversation bar.
 * One suite leaving one set made a later, unrelated suite measure a 0px-wide
 * mark and find no animation running. The runner snapshots both elements
 * before a suite and, after it, restores them and fails the suite that changed
 * them. This pins that pair.
 * @module unit-tests/suite-document-isolation-test
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
  const { snapshotDocumentState, restoreDocumentState } = await import('../utilities/integration-test-executor.js');

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    // Each case leaves the document as it found it whatever it asserts, so
    // this suite never trips the very check it is testing.
    const outer = snapshotDocumentState();
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
    finally { restoreDocumentState(outer); }
  };

  run('a body class left set is reported and taken off', () => {
    const before = snapshotDocumentState();
    document.body.classList.add('suite-isolation-probe');
    const leaks = restoreDocumentState(before);
    if (!leaks.some((l) => l.includes('<body> class') && l.includes('suite-isolation-probe'))) {
      throw new Error(`the leak was not named: ${JSON.stringify(leaks)}`);
    }
    if (document.body.classList.contains('suite-isolation-probe')) throw new Error('the class was left on');
  });

  run('an html attribute changed or added is reported and put back', () => {
    const root = document.documentElement;
    const before = snapshotDocumentState();
    const theme = root.getAttribute('data-theme');
    root.setAttribute('data-theme', theme === 'light' ? 'dark' : 'light');
    root.setAttribute('data-suite-isolation-probe', '1');
    const leaks = restoreDocumentState(before);
    if (leaks.length !== 2) throw new Error(`want both changes named, got ${JSON.stringify(leaks)}`);
    if (root.getAttribute('data-theme') !== theme) throw new Error(`data-theme is ${root.getAttribute('data-theme')}, was ${theme}`);
    if (root.hasAttribute('data-suite-isolation-probe')) throw new Error('the added attribute was left on');
  });

  run('a class toggled off and back on is not a leak', () => {
    document.body.classList.add('suite-isolation-a', 'suite-isolation-b');
    const before = snapshotDocumentState();
    document.body.classList.remove('suite-isolation-a');
    document.body.classList.add('suite-isolation-a');
    const leaks = restoreDocumentState(before);
    if (leaks.length !== 0) throw new Error(`a reordering was reported: ${JSON.stringify(leaks)}`);
  });

  run('an inline style set and then cleared is not a leak', () => {
    const body = document.body;
    const had = body.getAttribute('style');
    body.removeAttribute('style');
    const before = snapshotDocumentState();
    body.style.cursor = 'ew-resize';
    body.style.cursor = '';
    const leaks = restoreDocumentState(before);
    if (had !== null) body.setAttribute('style', had);
    if (leaks.length !== 0) throw new Error(`an empty style attribute was reported: ${JSON.stringify(leaks)}`);
  });

  return { passed, failed, errors };
}
