//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What an 'open' means depends on whether the first session load has finished,
 * and ConnectionManager cannot read that off `getSession()`: the Session is
 * assigned synchronously and only *then* is its load awaited, so there is a
 * window in which a session exists that cannot yet spawn a worker —
 * `workerManager.init` runs at the END of that load.
 *
 * An 'open' inside that window is not a reconnect, and treating it as one runs
 * the catch-up path against an uninitialised worker manager: every conversation
 * the manifest lists looks new (the load has cleared the map), each is spawned,
 * and each throws "[WorkerManager] Not initialized - call init() first" — so the
 * conversations it was trying to load are lost instead of loaded.
 *
 * The window is not hypothetical. On the juggler.studio remote path
 * `wsService.connect()` adopts an already-open DataChannel and flushes its
 * buffered handoff frames synchronously, so the one-shot 'session' frame and
 * 'open' are emitted in the same stretch: the first starts the load, the second
 * arrives with it still in flight. These cases pin that an 'open' waits for the
 * load rather than racing it, that one load serves every caller who asks, and
 * that a genuine reconnect still catches up.
 * @module unit-tests/open-during-load-test
 */

import { assert } from '../utilities/test-helpers.js';
import ConnectionManager from '../../js/services/connection-manager.js';
import workerManager from '../../js/services/worker-manager.js';

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
   * @param {() => Promise<void>} fn
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
   * A ConnectionManager with nothing wired to a real socket: setup() is never
   * called, so it holds no listeners and 'open' is delivered by hand.
   *
   * The worker manager is a module singleton shared with the rest of the page,
   * so the two catch-up calls are stood in for — counted here, and kept off
   * whatever workers other suites left behind.
   * @returns {{cm: any, refreshes: () => number, resyncs: () => number, reinits: () => number, relinks: () => number, restore: () => void}} The manager and what it reached for.
   */
  const manager = () => {
    const cm = /** @type {any} */ (new ConnectionManager({
      llmState: /** @type {any} */ (null),
      onServerMessage: () => {},
      services: /** @type {any} */ ({})
    }));
    let refreshes = 0;
    let resyncs = 0;
    let reinits = 0;
    let relinks = 0;
    const wm = /** @type {any} */ (workerManager);
    const origResync = wm.resyncReadyConversations;
    const origReinit = wm.reinitPendingConversations;
    const origRelink = wm.relinkPendingAcks;
    wm.resyncReadyConversations = () => { resyncs++; };
    wm.reinitPendingConversations = () => { reinits++; };
    wm.relinkPendingAcks = () => { relinks++; };
    cm._refreshes = () => refreshes;
    cm._fakeSession = { persistence: { refreshFromServer: async () => { refreshes++; } } };
    return {
      cm,
      refreshes: () => refreshes,
      resyncs: () => resyncs,
      reinits: () => reinits,
      relinks: () => relinks,
      restore: () => {
        wm.resyncReadyConversations = origResync;
        wm.reinitPendingConversations = origReinit;
        wm.relinkPendingAcks = origRelink;
      }
    };
  };

  await run('an open while the first load is in flight does not catch up on it', async () => {
    const { cm, refreshes, resyncs, reinits, restore } = manager();
    try {
      // The state _initializeSession is in between assigning the Session and
      // its load resolving: a session to be found, and no worker manager yet.
      let release = () => {};
      const loading = new Promise((resolve) => { release = () => resolve(undefined); });
      let waited = false;
      cm._session = cm._fakeSession;
      cm._initializeSession = async () => {
        await loading;
        waited = true;
      };

      const open = cm._handleOpen();
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert(refreshes() === 0,
        `a manifest refresh before the load would spawn workers against an uninitialised manager; got ${refreshes()}`);
      assert(resyncs() === 0, `nothing is ready to resync yet; got ${resyncs()}`);
      assert(reinits() === 0, `and nothing is pending re-init either; got ${reinits()}`);
      assert(waited === false, 'the load is still in flight — the handler is holding, not finished');

      release();
      await open;
      assert(waited === true, 'the open waited for the load it found in flight');
      assert(refreshes() === 0,
        `and still does not refresh: the load read the same manifest, so there is nothing to catch up on; got ${refreshes()}`);
    } finally {
      restore();
    }
  });

  await run('an open with no session at all starts the load', async () => {
    const { cm, refreshes, restore } = manager();
    try {
      let loads = 0;
      cm._initializeSession = async () => { loads++; };
      await cm._handleOpen();
      assert(loads === 1, `the first open is what starts the session load; got ${loads}`);
      assert(refreshes() === 0, `with nothing yet loaded to refresh; got ${refreshes()}`);
    } finally {
      restore();
    }
  });

  await run('an open once the session is loaded is a reconnect and catches up', async () => {
    const { cm, refreshes, resyncs, reinits, relinks, restore } = manager();
    try {
      let loads = 0;
      cm._initializeSession = async () => { loads++; };
      cm._session = cm._fakeSession;
      cm._sessionLoaded = true;

      await cm._handleOpen();

      assert(resyncs() === 1, `a recovered link must resync the documents it missed; got ${resyncs()}`);
      assert(relinks() === 1, `and settle the ack'd requests the dropped link carried; got ${relinks()}`);
      assert(reinits() === 1, `and re-send the inits the transport discarded; got ${reinits()}`);
      assert(refreshes() === 1, `and re-read the manifest nothing replayed; got ${refreshes()}`);
      assert(loads === 0, 'a reconnect does not re-run the session load');
    } finally {
      restore();
    }
  });

  await run('a reconnect whose refresh throws is reported, not left to reject', async () => {
    const { cm, restore } = manager();
    try {
      cm._session = { persistence: { refreshFromServer: async () => { throw new Error('manifest went missing'); } } };
      cm._sessionLoaded = true;
      // The handler is a socket listener: nobody is awaiting it, so a rejection
      // here is an unhandled one.
      await cm._handleOpen();
    } finally {
      restore();
    }
  });

  await run('the session frame and the open that follows it start one load between them', async () => {
    const { cm, restore } = manager();
    try {
      // The studio adopt ordering, in one synchronous stretch: the flushed
      // 'session' frame, then 'open', neither awaited by the thing that emitted
      // them. Both routes ask for a session; only one load may happen.
      let loads = 0;
      let release = () => {};
      const loading = new Promise((resolve) => { release = () => resolve(undefined); });
      cm._loadSession = async () => {
        loads++;
        cm._session = cm._fakeSession;
        await loading;
      };

      const fromSessionFrame = cm._initializeSession();
      const fromOpen = cm._handleOpen();
      release();
      await Promise.all([fromSessionFrame, fromOpen]);

      assert(loads === 1, `one connection, one session load; got ${loads}`);
      assert(cm._refreshes() === 0,
        `and the open that raced it did not refresh a session that was still loading; got ${cm._refreshes()}`);
    } finally {
      restore();
    }
  });

  return { passed, failed, errors };
}
