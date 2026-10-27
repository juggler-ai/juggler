//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: `Conversation.cancelAndSettle` waits on events, not a clock.
 *
 * A turn is settled when the worker's `processingState` frame is idle and no
 * frontend tool action of the conversation is still running. The first is a
 * Yjs metadata write; the second is the action executor's `onSettled` event,
 * which fires once a conversation's last action has unwound. These cases drive
 * a real executor with an action held open on a gate, and check that the wait
 * ends when the action does, scoped to its own conversation, with no timer
 * polling behind it.
 * @module unit-tests/cancel-settle
 */

import { assert } from '../utilities/test-helpers.js';
import Conversation from '../../js/model/conversation.js';
import actionExecutor from '../../js/services/action-executor.js';
import { WorkerManager } from '../../js/services/worker-manager.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';

/** The action id the fake class is registered under for the walk. */
const GATED = 'cancel-settle-gated-action';

/**
 * A fresh executor, so nothing another lane runs on the shared one is counted.
 * @returns {any} The executor
 */
const freshExecutor = () => new (/** @type {any} */ (actionExecutor).constructor)();

/**
 * Register the gated fake action for the walk: its prepare() waits on the gate
 * its conversation was started with, then throws — an exit like any other for
 * the executor's bookkeeping. Returns the restorer.
 * @returns {() => void} Puts the registry's `get` back
 */
function registerGated() {
  const prior = contextItemRegistry.get;
  /** @type {any} */ (contextItemRegistry).get = (/** @type {string} */ id) => {
    if (id !== GATED) return prior.call(contextItemRegistry, id);
    return class {
      /** @param {any} ctx */
      constructor(ctx) { this.ctx = ctx; }
      async prepare() {
        entered.get(this.ctx.conversation)?.();
        await gateOf(this.ctx);
        throw new Error('released');
      }
    };
  };
  return () => { /** @type {any} */ (contextItemRegistry).get = prior; };
}

/** @type {WeakMap<object, Promise<unknown>>} */
const gates = new WeakMap();
/**
 * @param {any} ctx - The action's construction context.
 * @returns {Promise<unknown>} The gate its execution was started with.
 */
const gateOf = (ctx) => gates.get(ctx.conversation) || Promise.resolve();

/**
 * Called by the fake prepare() on entry. The executor registers an action
 * before it calls prepare(), so reaching prepare() means the action is running.
 * @type {WeakMap<object, () => void>}
 */
const entered = new WeakMap();

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
    const restore = registerGated();
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      restore();
    }
  };

  /**
   * Start an action of `conversationId` that stays running until `release`.
   * `started` settles once the executor has registered it — or once the
   * execution has ended without getting that far, so a test asserting on it
   * fails rather than hangs. execute() awaits a dynamic import before it
   * registers anything, and how many turns of the event loop that takes is
   * the engine's business, so no timer stands in for it.
   * @param {any} executor
   * @param {string} conversationId
   * @returns {{release: () => void, done: Promise<unknown>, started: Promise<unknown>}} The gate, the execution, and its registration
   */
  const gated = (executor, conversationId) => {
    /** @type {() => void} */
    let release = () => {};
    const conversation = { id: conversationId };
    gates.set(conversation, new Promise((resolve) => { release = () => resolve(undefined); }));
    const reached = new Promise((resolve) => { entered.set(conversation, () => resolve(undefined)); });
    const done = executor.execute(GATED, {}, { conversation, _approvalHandled: true })
      .catch((/** @type {unknown} */ e) => e);
    return { release, done, started: Promise.race([reached, done]) };
  };

  await run('onSettled fires once the conversation\'s last action unwinds', async () => {
    const executor = freshExecutor();
    let fired = 0;
    const a = gated(executor, 'conv-a');
    const b = gated(executor, 'conv-a');
    const off = executor.onSettled('conv-a', () => { fired++; });
    await Promise.all([a.started, b.started]);
    assert(executor.hasRunningActionsFor('conv-a'), 'the gated actions are not running');
    a.release();
    await a.done;
    assert(fired === 0, 'fired while another action of the conversation was still running');
    b.release();
    await b.done;
    assert(fired === 1, `expected one settle, got ${fired}`);
    off();
  });

  await run('onSettled is scoped to its own conversation', async () => {
    const executor = freshExecutor();
    let fired = 0;
    const off = executor.onSettled('conv-a', () => { fired++; });
    const other = gated(executor, 'conv-b');
    other.release();
    await other.done;
    assert(fired === 0, 'another conversation\'s action settled this one');
    off();
  });

  await run('an unsubscribed listener is not called', async () => {
    const executor = freshExecutor();
    let fired = 0;
    const off = executor.onSettled('conv-a', () => { fired++; });
    off();
    const a = gated(executor, 'conv-a');
    a.release();
    await a.done;
    assert(fired === 0, 'a removed listener still fired');
  });

  await run('cancelAndSettle resolves when the running action does, without polling', async () => {
    const executor = freshExecutor();
    const conv = Object.create(Conversation.prototype);
    const pin = (/** @type {string} */ key, /** @type {any} */ value) =>
      Object.defineProperty(conv, key, { value, writable: true, configurable: true });
    pin('id', 'conv-settle');
    pin('_actionExecutor', executor);
    pin('_workerManager', new WorkerManager());
    pin('processingState', undefined);
    pin('stopProcessing', () => {});
    pin('showWarning', () => {});
    pin('observeMetadata', () => {});
    pin('unobserveMetadata', () => {});

    const a = gated(executor, 'conv-settle');
    await a.started;
    assert(conv.isTurnActive(), 'the running action does not hold the turn');

    const realInterval = globalThis.setInterval;
    let intervals = 0;
    globalThis.setInterval = /** @type {any} */ ((/** @type {any[]} */ ...args) => { intervals++; return realInterval(...args); });
    let settled = false;
    let waiting;
    try {
      waiting = conv.cancelAndSettle('test').then(() => { settled = true; });
    } finally {
      globalThis.setInterval = realInterval;
    }
    await Promise.resolve();
    assert(!settled, 'settled while the action was still running');
    a.release();
    await a.done;
    await waiting;
    assert(settled, 'never settled');
    assert(intervals === 0, `cancelAndSettle started ${intervals} interval timer(s)`);
  });

  await run('a cancel waits while the worker keeps talking, and fails on its silence', async () => {
    const executor = freshExecutor();
    const wm = /** @type {any} */ (new WorkerManager());
    const conv = Object.create(Conversation.prototype);
    const pin = (/** @type {string} */ key, /** @type {any} */ value) =>
      Object.defineProperty(conv, key, { value, writable: true, configurable: true });
    pin('id', 'conv-slow-cancel');
    pin('_actionExecutor', executor);
    pin('_workerManager', wm);
    pin('processingState', undefined);
    pin('stopProcessing', () => {});
    pin('showWarning', () => {});
    pin('observeMetadata', () => {});
    pin('unobserveMetadata', () => {});

    const a = gated(executor, 'conv-slow-cancel');
    await a.started;

    // The clock and the timers are in hand: time passes one second per step,
    // and every timer armed meanwhile fires at that step.
    /** @type {Array<() => void>} */
    let timers = [];
    const realSetTimeout = window.setTimeout;
    const realNow = Date.now;
    let clock = realNow();
    /**
     * Run `fn` with the clock stopped and timers captured rather than scheduled.
     * @param {() => void} fn - What to run.
     */
    const inHand = (fn) => {
      window.setTimeout = /** @type {any} */ ((/** @type {() => void} */ cb) => { timers.push(cb); return 0; });
      Date.now = () => clock;
      try { fn(); } finally { window.setTimeout = realSetTimeout; Date.now = realNow; }
    };
    /** @type {unknown} */
    let outcome = null;
    /**
     * Advance a second and fire whatever was armed.
     * @param {boolean} talking - Whether the worker is heard from in it.
     */
    const step = async (talking) => {
      clock += 1000;
      if (talking) wm._lastHeardAt.set(conv.id, clock);
      const due = timers;
      timers = [];
      inHand(() => { for (const fire of due) fire(); });
      await Promise.resolve();
      await Promise.resolve();
    };

    try {
      inHand(() => {
        conv.cancelAndSettle('test').then(() => { outcome = 'settled'; }, (/** @type {unknown} */ e) => { outcome = e; });
      });
      // A slow core: the cancel is still being carried out a minute on, the
      // worker reporting all the while.
      for (let i = 0; i < 60; i++) await step(true);
      assert(outcome === null,
        `a cancel the worker is still carrying out was settled after a minute: ${String(outcome)}`);
      assert(timers.length > 0, 'and it stopped watching while the turn was still active');

      // Then the worker goes quiet for good: the wait fails, and never reads as settled.
      for (let i = 0; i < 300 && outcome === null; i++) await step(false);
      assert(outcome instanceof Error && /said nothing/.test(outcome.message),
        `a cancel the worker fell silent on must fail, saying so; got ${outcome instanceof Error ? outcome.message : String(outcome)}`);
      assert(conv.isTurnActive(), 'the turn is still active, so nothing may treat the wait as settled');
    } finally {
      a.release();
      await a.done;
    }
  });

  return { passed, failed, errors };
}
