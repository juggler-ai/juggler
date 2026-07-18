//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Regression: the persistent engine must repoint its project root when the user
 * switches projects via the picker.
 *
 * The server broadcasts `project-changed` on a runtime switch, but the engine is
 * persistent across it and — unlike viewers — never reloads. It therefore kept
 * its boot-time project root, so `explore_code`'s `projectRoot` binding (and the
 * root the LLM reads and globs against) stayed pointed at the PREVIOUS project
 * after a switch: the model saw e.g. "/home/crem/tmp/codex" while the header bar
 * showed "/home/crem/dev/tmp/lc0-eval".
 *
 * The fix routes `project-changed` through `_applyEngineProjectRoot(newPath)` in
 * the engine realm, which repoints both `session.projectPath` and the live
 * `globalThis.__jugglerProjectRoot` the sandbox delegates read per run.
 * @module unit-tests/engine-project-switch
 */

import { createTestSession, assert } from '../utilities/test-helpers.js';

/** @typedef {{passed: number, failed: number, errors: string[]}} TestResult */

/** @returns {Promise<TestResult>} Aggregate pass/fail counts and collected errors. */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const session = await createTestSession();

  /**
   * @param {string} name
   * @param {() => void | Promise<void>} fn
   */
  async function t(name, fn) {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  await t('engine repoints its project root on a project switch (not stale)', async () => {
    const g = /** @type {any} */ (globalThis);
    const hadEngine = Object.prototype.hasOwnProperty.call(g, 'JUGGLER_ENGINE');
    const savedEngine = g.JUGGLER_ENGINE;
    const hadRoot = Object.prototype.hasOwnProperty.call(g, '__jugglerProjectRoot');
    const savedRoot = g.__jugglerProjectRoot;
    const savedPath = session.projectPath;
    const savedApply = session._applyEngineProjectRoot;
    try {
      // Present as the engine realm so isEngine() picks the persistent-engine
      // branch (which never calls window.location.reload — safe to drive here).
      g.JUGGLER_ENGINE = true;
      const newPath = '/home/crem/dev/tmp/lc0-eval';

      // Core contract: applying an engine project switch repoints BOTH the
      // session path and the live root the explore_code sandbox exposes. This
      // runs FIRST — in the unfixed build the method is absent and throws here,
      // so the reload-capable handler exercised below is never reached.
      session._applyEngineProjectRoot(newPath);
      assert(session.projectPath === newPath, 'session.projectPath repointed to the new project');
      assert(g.__jugglerProjectRoot === newPath, 'live sandbox projectRoot repointed to the new project');

      // Wiring: the project-changed handler must route the engine realm through
      // _applyEngineProjectRoot (rather than ignoring the new path as before).
      let routedWith = null;
      session._applyEngineProjectRoot = (/** @type {string} */ p) => { routedWith = p; };
      try {
        session._projectChangedHandler({ projectPath: newPath });
      } finally {
        session._applyEngineProjectRoot = savedApply;
      }
      assert(routedWith === newPath, 'project-changed routes the engine realm to _applyEngineProjectRoot');
    } finally {
      session.projectPath = savedPath;
      session._applyEngineProjectRoot = savedApply;
      if (hadEngine) g.JUGGLER_ENGINE = savedEngine; else delete g.JUGGLER_ENGINE;
      if (hadRoot) g.__jugglerProjectRoot = savedRoot; else delete g.__jugglerProjectRoot;
    }
  });

  return { passed, failed, errors };
}
