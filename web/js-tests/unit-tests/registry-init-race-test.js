//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Concurrent-init tests for BaseRegistry.
 *
 * `init()` marks itself initialized only once its whole load pass has finished,
 * so callers arriving while one is running see a cold registry and start their
 * own. Read-only sub-agents run in parallel and each turn's tool list calls
 * `contextItemRegistry.init()`, so four threads dispatching together produced
 * four full import passes — each with its own HTTP fetches — on the single
 * engine thread they share.
 * @module unit-tests/registry-init-race-test
 */

import BaseRegistry from '../../js/registries/base-registry.js';
import { assert, nextTask } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A registry whose load pass is a counted, externally-released promise, so a
 * test can hold several callers inside one init and see how many passes ran.
 */
class CountingRegistry extends BaseRegistry {
  constructor() {
    super('CountingRegistry', ['id']);
    /** @type {number} */
    this.passes = 0;
    /**
     * One release per blocked pass. A single handle would strand every pass but
     * the last, turning a failing assertion into a hung suite.
     * @type {Array<() => void>}
     */
    this.releases = [];
  }

  /**
   * Count the pass and block until the test releases it.
   * @returns {Promise<import('../../js/services/extensions.js').CapabilityRef[]>} No modules
   */
  async getModulePaths() {
    this.passes++;
    await new Promise((resolve) => this.releases.push(/** @type {any} */ (resolve)));
    return [];
  }

  /** Let every blocked pass finish. */
  releaseAll() {
    const pending = this.releases;
    this.releases = [];
    for (const release of pending) release();
  }

  /**
   * The disabled-set filter fetches over HTTP in the real registry; a test has
   * no server for it and it is not what these cases are about.
   * @returns {Promise<void>} Resolves immediately
   */
  async _applyDisabledFilter() {}
}

/**
 * Run registry concurrent-init tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  await test('four concurrent callers share one load pass', async () => {
    const registry = new CountingRegistry();
    const callers = [registry.init(), registry.init(), registry.init(), registry.init()];
    try {
      await nextTask();
      assert(registry.passes === 1, `four concurrent init() calls must run one load pass, ran ${registry.passes}`);
    } finally {
      registry.releaseAll();
    }
    await Promise.all(callers);
    assert(registry.isInitialized(), 'the shared init must leave the registry initialized');
  });

  await test('a caller arriving after init finished does not reload', async () => {
    const registry = new CountingRegistry();
    const first = registry.init();
    await nextTask();
    registry.releaseAll();
    await first;

    await registry.init();
    assert(registry.passes === 1, `an initialized registry must not reload, ran ${registry.passes} passes`);
  });

  await test('a reset during an init is not served the stale pass', async () => {
    // Without this, the in-flight promise outlives the reset that invalidated
    // it and every later caller is handed the pre-reset load — leaving the
    // registry holding the plugin set the user just changed, for good.
    const registry = new CountingRegistry();
    const first = registry.init();
    try {
      await nextTask();
      registry.reset();
      const second = registry.init();
      await nextTask();
      assert(registry.passes === 2, `a reset must force a fresh pass, ran ${registry.passes}`);
      registry.releaseAll();
      await Promise.all([first, second]);
    } finally {
      registry.releaseAll();
    }
  });

  return { passed, failed, errors };
}
