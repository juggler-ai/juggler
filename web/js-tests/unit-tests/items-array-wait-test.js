//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: `Conversation.whenItemsArray` hears the worker's items array
 * arrive, rather than sleeping until it has.
 *
 * Seeding SYSTEM_1 before the worker's root `items` Y.Array has been applied
 * creates a competing local array that Yjs later discards, SYSTEM_1 with it, so
 * the loader waits for the array first. The wait is answered by an observer on
 * the root map: it resolves in the same task the array lands in, through the
 * document's sync batch or a direct write, and gives up at its deadline.
 * @module unit-tests/items-array-wait
 */

import { assert } from '../utilities/test-helpers.js';
import * as Y from '../../js/vendor/yjs.mjs';
import Conversation from '../../js/model/conversation.js';
import { ConversationDocument } from '../../js/model/conversation-document.js';
import { ConversationLoader } from '../../js/services/conversation-loader.js';

/**
 * A conversation stand-in carrying only a real document.
 * @returns {any} The stand-in
 */
function withDocument() {
  const conv = Object.create(Conversation.prototype);
  Object.defineProperty(conv, '_doc', {
    value: new ConversationDocument('conv-items-wait', 'user:test'),
    writable: true, configurable: true,
  });
  return conv;
}

/**
 * The update a worker would send that creates the root items array.
 * @returns {Uint8Array} The update bytes
 */
function workerItemsUpdate() {
  const worker = new Y.Doc();
  worker.getMap('root').set('items', new Y.Array());
  return Y.encodeStateAsUpdate(worker);
}

/**
 * A virtual clock: callbacks scheduled on it run, in time order, only when the
 * test steps it, so a case says exactly when each thing happens.
 * @returns {{now: () => number, after: (ms: number, fn: () => void) => () => void, runUntil: (settled: () => boolean, limitMs: number) => Promise<void>}} The clock
 */
function virtualClock() {
  let now = 0;
  let seq = 0;
  /** @type {{at: number, seq: number, fn: () => void, live: boolean}[]} */
  const queue = [];
  return {
    now: () => now,
    after(ms, fn) {
      const entry = { at: now + ms, seq: seq++, fn, live: true };
      queue.push(entry);
      return () => { entry.live = false; };
    },
    async runUntil(settled, limitMs) {
      while (!settled()) {
        queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = queue.shift();
        if (!next || next.at > limitMs) return;
        now = next.at;
        if (next.live) next.fn();
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
    },
  };
}

/**
 * A conversation stand-in whose timed waits run on `clock`, and a worker
 * manager whose `watchSilence` keeps the real contract on it: expiry only once
 * the worker has said nothing for the whole window, or at the ceiling.
 * @param {ReturnType<typeof virtualClock>} clock - The clock
 * @returns {{conv: any, wm: any, heard: () => void}} The fakes, and how the worker speaks
 */
function onClock(clock) {
  const conv = withDocument();
  conv.id = 'conv-items-wait';
  conv.whenDocument = (/** @type {() => boolean} */ ready, /** @type {number} */ timeoutMs) => {
    conv.flushPendingSyncs();
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (/** @type {boolean} */ answer) => { cancel(); off(); resolve(answer); };
      const off = conv.onDocumentChange(() => { if (ready()) finish(true); });
      const cancel = clock.after(timeoutMs, () => finish(ready()));
    });
  };
  let lastHeard = 0;
  const wm = {
    watchSilence(/** @type {string} */ _id, /** @type {number} */ silenceMs, /** @type {(e: any) => void} */ onExpire, ceilingMs = Infinity) {
      const startedAt = clock.now();
      const check = () => {
        const quietMs = clock.now() - Math.max(startedAt, lastHeard);
        const elapsedMs = clock.now() - startedAt;
        if (quietMs >= silenceMs || elapsedMs >= ceilingMs) {
          const silent = quietMs >= silenceMs;
          onExpire({ silent, quietMs, elapsedMs, describe: () => `the worker said nothing for ${quietMs}ms` });
          return;
        }
        stop = clock.after(Math.min(silenceMs - quietMs, ceilingMs - elapsedMs), check);
      };
      let stop = clock.after(Math.min(silenceMs, ceilingMs), check);
      return () => stop();
    },
  };
  return { conv, wm, heard: () => { lastHeard = clock.now(); } };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => Promise<void>} fn - Test body.
   */
  const run = async (label, fn) => {
    const priorWarn = console.warn;
    console.warn = () => {};
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      console.warn = priorWarn;
    }
  };

  await run('resolves at once when the array is already there', async () => {
    const conv = withDocument();
    conv._doc.root.set('items', new Y.Array());
    assert(await conv.whenItemsArray(1000) === true, 'did not report the array present');
  });

  await run('resolves in the task the array lands in, not on a later tick', async () => {
    const conv = withDocument();
    let present = /** @type {boolean|null} */ (null);
    const waiting = conv.whenItemsArray(5000).then((/** @type {boolean} */ v) => { present = v; });
    await Promise.resolve();
    assert(present === null, 'resolved before the array arrived');
    conv._doc.root.set('items', new Y.Array());
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert(present === true, `still waiting after the array was written (got ${present})`);
    await waiting;
  });

  await run('hears an array that arrives through the sync batch', async () => {
    const conv = withDocument();
    const waiting = conv.whenItemsArray(5000);
    conv._doc.applySyncUpdate(workerItemsUpdate());
    assert(await waiting === true, 'missed the synced array');
    assert(conv.hasRootItemsArray, 'the array is not in the document');
  });

  await run('applies an update already waiting in the batch before looking', async () => {
    const conv = withDocument();
    conv._doc.applySyncUpdate(workerItemsUpdate());
    let present = /** @type {boolean|null} */ (null);
    const waiting = conv.whenItemsArray(5000).then((/** @type {boolean} */ v) => { present = v; });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert(present === true, 'waited out the batch timer for an update it could have flushed');
    await waiting;
  });

  await run('gives up with false at its deadline', async () => {
    const conv = withDocument();
    assert(await conv.whenItemsArray(20) === false, 'reported an array that never came');
  });

  // The context callback's wait: a requested item can land deep in a thread's
  // own array, so whenDocument re-asks after every change, nested ones included.
  await run('whenDocument hears a nested write that makes its question true', async () => {
    const conv = withDocument();
    const items = new Y.Array();
    conv._doc.root.set('items', items);
    const thread = new Y.Map();
    thread.set('items', new Y.Array());
    items.push([thread]);
    const wanted = () => thread.get('items').toArray().some((/** @type {any} */ m) => m.get('id') === 'CTX_1');
    let answered = /** @type {boolean|null} */ (null);
    const waiting = conv.whenDocument(wanted, 5000).then((/** @type {boolean} */ v) => { answered = v; });
    await Promise.resolve();
    assert(answered === null, 'answered before the item arrived');
    const item = new Y.Map();
    item.set('id', 'CTX_1');
    thread.get('items').push([item]);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert(answered === true, `still waiting after the nested item was written (got ${answered})`);
    await waiting;
  });

  // A slow core: the worker keeps syncing other state and its items array
  // lands at 3s. The loader must wait for it, not fall back to a local array.
  await run('loader waits for an array that lands after 2s of a worker still syncing', async () => {
    const clock = virtualClock();
    const { conv, wm, heard } = onClock(clock);
    for (let at = 500; at < 3000; at += 500) {
      clock.after(at, () => { heard(); conv._doc.root.set('tick', at); });
    }
    clock.after(3000, () => { heard(); conv._doc.root.set('items', new Y.Array()); });
    const loader = /** @type {any} */ (new ConversationLoader(wm));
    let result = /** @type {unknown} */ (null);
    loader._waitForItemsArray(conv).then((/** @type {boolean} */ v) => { result = v; }, (/** @type {unknown} */ e) => { result = e; });
    await clock.runUntil(() => result !== null, 600_000);
    assert(result === true, `gave up at ${clock.now()}ms while the worker was still syncing (got ${result})`);
    assert(clock.now() === 3000, `settled at ${clock.now()}ms, not when the array landed`);
  });

  await run('loader fails rather than seeding a rival array once the worker falls silent', async () => {
    const clock = virtualClock();
    const { conv, wm } = onClock(clock);
    let seeded = false;
    Object.defineProperty(conv, 'rootMessageThread', {
      value: { ensureSystemPromptPlaceholder() { seeded = true; } },
      configurable: true,
    });
    const loader = /** @type {any} */ (new ConversationLoader(wm));
    let outcome = /** @type {unknown} */ (null);
    loader._ensureNewConversationSystemPrompt(conv).then(() => { outcome = 'seeded'; }, (/** @type {unknown} */ e) => { outcome = e; });
    await clock.runUntil(() => outcome !== null, 600_000);
    assert(outcome instanceof Error, `did not fail on a silent worker (got ${outcome} at ${clock.now()}ms)`);
    assert(!seeded && !conv.hasRootItemsArray, 'seeded SYSTEM_1 into a local array the worker\'s would discard');
  });

  return { passed, failed, errors };
}
