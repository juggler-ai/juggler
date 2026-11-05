//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A window has one wait on screen at a time. Until the app reaches `ready` the
 * startup overlay covers it and already says "Connecting", so a link that drops
 * (or never comes up) in that stretch must not put the disconnection overlay
 * over it as a second spinner. Once the app is up, a drop is the disconnection
 * overlay's to report — and a startup that ends with the link down hands over
 * to it rather than leaving the window bare.
 * @module unit-tests/disconnect-during-startup-test
 */

import { assert } from '../utilities/test-helpers.js';
import ConnectionManager from '../../js/services/connection-manager.js';
import appPhase, { setAppPhase } from '../../js/services/app-phase.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>|void} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * A ConnectionManager with a counting stand-in for the disconnection overlay.
   * setup() is never called, so nothing is wired to the real socket; whether the
   * link is up is whatever the test says.
   * @param {boolean} linkUp - What the manager is told about the link.
   * @returns {{cm: any, shown: () => number}} The manager and how often it showed the overlay.
   */
  const manager = (linkUp) => {
    let shown = 0;
    const cm = /** @type {any} */ (new ConnectionManager({
      llmState: /** @type {any} */ (null),
      onServerMessage: () => {},
      services: /** @type {any} */ ({}),
      disconnectionOverlay: { show: () => { shown++; }, hide: () => {}, startCountdown: () => {} }
    }));
    cm._linkIsUp = () => linkUp;
    // As setup() subscribes it, so the handler sees the phase already moved.
    appPhase.subscribe((phase) => cm._handlePhase(phase));
    return { cm, shown: () => shown };
  };

  try {
    await run('a drop while starting up leaves the startup overlay to say so', () => {
      appPhase.__resetForTests();
      setAppPhase('connecting');
      const { cm, shown } = manager(false);
      cm._handleClose();
      assert(shown() === 0,
        `the startup overlay already says "Connecting"; a second overlay over it is one too many, got ${shown()}`);
    });

    await run('a drop once the app is up shows the disconnection overlay', () => {
      appPhase.__resetForTests();
      setAppPhase('ready');
      const { cm, shown } = manager(false);
      cm._handleClose();
      assert(shown() === 1, `a running app has only this overlay to report a drop with; got ${shown()}`);
    });

    await run('startup ending with the link down hands over to the disconnection overlay', () => {
      appPhase.__resetForTests();
      setAppPhase('session');
      const { cm, shown } = manager(false);
      cm._handleClose();
      setAppPhase('ready');
      assert(shown() === 1,
        `the startup overlay is gone and the link is still down, so the wait is now this overlay's; got ${shown()}`);
    });

    await run('startup ending with the link up shows nothing', () => {
      appPhase.__resetForTests();
      setAppPhase('session');
      const { shown } = manager(true);
      setAppPhase('ready');
      assert(shown() === 0, `there is nothing to wait for; got ${shown()}`);
    });

    await run('a viewer turned away as full is not told it is reconnecting', () => {
      appPhase.__resetForTests();
      setAppPhase('session');
      const { cm, shown } = manager(false);
      cm._refusedAsFull = true;
      setAppPhase('ready');
      cm._handleClose();
      assert(shown() === 0, `the refusal notice says what is happening; got ${shown()}`);
    });
  } finally {
    appPhase.__resetForTests();
  }

  return { passed, failed, errors };
}
