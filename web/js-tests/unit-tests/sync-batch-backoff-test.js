//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Sync batch backoff test
 *
 * DocumentSyncManager widens its inbound batching window as applying a batch
 * gets more expensive, so a long streamed message costs a bounded fraction of
 * wall-clock time instead of degrading to O(n²) over the turn.
 *
 * The properties that matter, and that this pins:
 * - cheap batches are untouched (the overwhelming majority of them),
 * - the window tracks MEASURED cost, not a guess,
 * - one expensive outlier can't pin the window wide,
 * - the window recovers, both by decay and by the idle reset,
 * - and nothing is ever dropped, however wide the window gets.
 *
 * That last one is the safety property: nothing downstream guarantees a final
 * re-render once a turn ends, so an update the batcher loses is text the user
 * never sees.
 * @module unit-tests/sync-batch-backoff-test
 */

import { assert, waitFor, withTimeout } from '../utilities/test-helpers.js';
import { YJS_SYNC_BATCH_MS, YJS_SYNC_BATCH_MAX_MS } from '../../js/utils/constants.js';

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Fixture directory (not used by this test)
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run sync batch backoff tests.
 * @param {TestContext} _ctx - Test context (unused - this test doesn't need fixtures)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const Y = await import('../../js/vendor/yjs.mjs');
  const { default: DocumentSyncManager } = await import('../../js/utils/document-sync-manager.js');

  /**
   * Build a manager plus a second doc to generate real updates from.
   * @returns {{doc: any, mgr: any, push: (text: string) => void}} The manager under
   *   test, its doc, and a function that feeds it one real update.
   */
  const makeManager = () => {
    const doc = new Y.Doc();
    const mgr = new DocumentSyncManager(doc);
    mgr.initializeAsClient();
    const peer = new Y.Doc();
    /**
     * Write to the peer and hand the resulting update to the manager.
     * @param {string} text - Value to append to the peer's items array.
     */
    const push = (text) => {
      const before = Y.encodeStateVector(doc);
      peer.getArray('items').push([text]);
      mgr.applySyncUpdate(Y.encodeStateAsUpdate(peer, before));
    };
    return { doc, mgr, push };
  };

  const run = (/** @type {string} */ name, /** @type {() => void|Promise<void>} */ fn) => {
    return Promise.resolve().then(fn).then(() => { passed++; }).catch((e) => {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  // A fresh manager, and any manager whose batches are cheap, must behave
  // exactly as it did before backoff existed — this is nearly every batch.
  await run('cheap batches stay at the floor', () => {
    const { mgr } = makeManager();
    assert(mgr._nextBatchDelay() === YJS_SYNC_BATCH_MS,
      `fresh manager should use the floor, got ${mgr._nextBatchDelay()}`);

    // 3ms × 8 = 24ms, under the 50ms floor.
    mgr._batchCostMs = 3;
    mgr._lastBatchAt = performance.now();
    assert(mgr._nextBatchDelay() === YJS_SYNC_BATCH_MS,
      `a 3ms batch should still use the floor, got ${mgr._nextBatchDelay()}`);
  });

  await run('expensive batches widen the window, up to the cap', () => {
    const { mgr } = makeManager();
    mgr._lastBatchAt = performance.now();

    mgr._batchCostMs = 12;
    assert(mgr._nextBatchDelay() === 96,
      `a 12ms batch should give a 96ms window, got ${mgr._nextBatchDelay()}`);

    mgr._batchCostMs = 500;
    assert(mgr._nextBatchDelay() === YJS_SYNC_BATCH_MAX_MS,
      `the window must be capped at ${YJS_SYNC_BATCH_MAX_MS}, got ${mgr._nextBatchDelay()}`);
  });

  // The whole design rests on the cost estimate being a real measurement of the
  // fan-out, not of Yjs alone: observers run synchronously inside applyUpdate,
  // so an expensive observer must show up in the estimate.
  await run('the estimate measures the observer fan-out', async () => {
    const { doc, mgr, push } = makeManager();
    // The manager's clock moves only when the observer says it spent time, so
    // the estimate is exactly what the fan-out cost — and the idle reset, which
    // reads the same clock, sees no gap however late the poll below notices.
    let clock = 1000;
    mgr.now = () => clock;
    doc.getArray('items').observeDeep(() => { clock += 20; });

    push('a');
    await waitFor(() => mgr._batchCostMs > 0, { description: 'first batch applied' });

    assert(mgr._batchCostMs === 20,
      `a 20ms observer should be measured as 20ms, got ${mgr._batchCostMs.toFixed(1)}ms`);
    assert(mgr._nextBatchDelay() > YJS_SYNC_BATCH_MS,
      `an expensive batch should widen the window, got ${mgr._nextBatchDelay()}`);
  });

  // A structural render or a tab activation costs many times what a streaming
  // token does. Smoothing is what stops one of those slamming the window to the
  // cap and leaving it there.
  await run('one outlier does not pin the window wide', () => {
    const { mgr } = makeManager();
    mgr._batchCostMs = 2;
    mgr._lastBatchAt = performance.now();

    // Fold in a single 60ms spike by hand, the way _applyBatchedUpdates does.
    const smoothing = 0.4;
    mgr._batchCostMs = mgr._batchCostMs * (1 - smoothing) + 60 * smoothing;

    assert(mgr._batchCostMs < 60 * smoothing + 2,
      `the spike should be damped, got ${mgr._batchCostMs.toFixed(1)}ms`);
    assert(mgr._nextBatchDelay() < YJS_SYNC_BATCH_MAX_MS,
      `one spike should not reach the cap, got ${mgr._nextBatchDelay()}`);
  });

  // The update a user is most likely to be waiting on is the first of a new
  // burst — their own message echoing back — and it must not inherit the
  // previous burst's backoff.
  await run('an idle gap resets the estimate', () => {
    const { mgr } = makeManager();
    mgr._batchCostMs = 200;
    mgr._lastBatchAt = performance.now() - 5000;

    assert(mgr._nextBatchDelay() === YJS_SYNC_BATCH_MS,
      `after an idle gap the window should be back at the floor, got ${mgr._nextBatchDelay()}`);
    assert(mgr._batchCostMs === 0, 'the idle reset should clear the estimate');
  });

  // The safety property. However wide the window gets, every update lands.
  await run('no update is dropped at the widest window', async () => {
    const { doc, mgr, push } = makeManager();
    // Force the window to its cap for the whole burst.
    mgr._batchCostMs = 500;
    mgr._lastBatchAt = performance.now();

    // Wait on the batcher itself, not on the item count: the property is that
    // once the window closes and the queue is drained, every update is in the
    // doc. Asserting at that moment fails on a drop at once and by name,
    // where polling the count would only time out — and would time out on a
    // slow timer grid too, which is not a drop.
    /** @type {() => void} */
    let drained = () => {};
    const queueDrained = new Promise((resolve) => { drained = () => resolve(undefined); });
    const applyBatch = mgr._applyBatchedUpdates.bind(mgr);
    mgr._applyBatchedUpdates = () => {
      applyBatch();
      if (mgr._pendingUpdates.length === 0 && mgr._batchTimer === null) drained();
    };

    for (let i = 0; i < 12; i++) push(`item-${i}`);

    await withTimeout(queueDrained, YJS_SYNC_BATCH_MAX_MS * 6, 'the widest-window batch to be applied');

    const got = doc.getArray('items').toArray();
    assert(got.length === 12, `expected 12 items, got ${got.length}`);
    assert(got[11] === 'item-11', `the trailing update must land, got '${got[11]}'`);
  });

  // flushPendingUpdates is the synchronous escape hatch for code that must read
  // state depending on updates just received; backoff must not have made it
  // asynchronous.
  await run('flushPendingUpdates still applies synchronously', () => {
    const { doc, mgr, push } = makeManager();
    mgr._batchCostMs = 500;
    mgr._lastBatchAt = performance.now();

    push('pending');
    assert(doc.getArray('items').length === 0, 'the update should still be batched');

    mgr.flushPendingUpdates();
    assert(doc.getArray('items').length === 1,
      'flushPendingUpdates must apply the batch synchronously');
  });

  return { passed, failed, errors };
}
