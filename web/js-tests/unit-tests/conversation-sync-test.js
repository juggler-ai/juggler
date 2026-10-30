//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The session's reducer for the `conversations-changed` broadcast
 * (`model/conversation-sync-reducer.js`).
 *
 * Pinned here: the reducer reaches the session only through its host (Session
 * carries none of the handlers or their state), `apply` is the whole op
 * vocabulary and contains what an op throws, and a duplicate's own `created`
 * echo is suppressed for as long as the duplicate is in flight, not merely
 * while its POST is.
 *
 * The focus-follow rules are `unit:conversation-focus-policy`, and the reorder
 * merge is `unit:tab-order-merge`.
 * @module unit-tests/conversation-sync-test
 */

import { assert, trackTestSession, waitFor } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import ConversationSyncReducer from '../../js/model/conversation-sync-reducer.js';
import workerManager from '../../js/services/worker-manager.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A reducer over a stub host that records what was asked of it.
 * @param {Partial<import('../../js/model/conversation-sync-reducer.js').SyncHost>} [overrides] - Host entries to replace
 * @returns {{sync: ConversationSyncReducer, calls: string[]}} The reducer, and
 *   one `entry:arg` line per host call
 */
function reducerOverStub(overrides = {}) {
  /** @type {string[]} */
  const calls = [];
  const host = /** @type {any} */ ({
    holds: () => false,
    order: () => [],
    setName: (/** @type {string} */ id) => { calls.push(`setName:${id}`); },
    notify: (/** @type {string} */ type) => { calls.push(`notify:${type}`); },
    notifyChange: (/** @type {string} */ type) => { calls.push(`notifyChange:${type}`); },
    loadAtHead: async (/** @type {string} */ id) => { calls.push(`loadAtHead:${id}`); return { id }; },
    drop: async (/** @type {string} */ id) => { calls.push(`drop:${id}`); return { id }; },
    reorder: () => { calls.push('reorder'); },
    follow: (/** @type {string} */ id) => { calls.push(`follow:${id}`); },
    shouldFollow: () => true,
    bin: {
      noteBinned: () => { calls.push('bin.noteBinned'); },
      noteLeft: (/** @type {string} */ id) => { calls.push(`bin.noteLeft:${id}`); }
    },
    ...overrides
  });
  return { sync: new ConversationSyncReducer(host), calls };
}

/**
 * Run `fn` with console.error and console.warn captured.
 * @param {() => Promise<void>} fn - The code to run
 * @returns {Promise<{errors: string[], warnings: string[]}>} What was logged
 */
async function captureConsole(fn) {
  const { error, warn } = console;
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  console.error = (/** @type {any[]} */ ...args) => { errors.push(args.map(String).join(' ')); };
  console.warn = (/** @type {any[]} */ ...args) => { warnings.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
  return { errors, warnings };
}

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

  await run('the handlers and their state live on the reducer, not on Session', () => {
    const moved = [
      'applyConversationCreated', 'applyConversationFocus', 'applyConversationDeleted',
      'applyConversationRenamed', 'applyConversationBinned', 'applyConversationRestored',
      'applyConversationsReordered', '_redeemPendingFocus', '_followFocus'
    ];
    const left = moved.filter((name) => name in Session.prototype);
    assert(left.length === 0, `still on Session.prototype: ${left.join(', ')}`);

    const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({}))));
    assert(session.sync instanceof ConversationSyncReducer, 'session.sync is not a ConversationSyncReducer');
    const fields = ['_pendingCreates', '_remoteCreates', '_pendingFocus'].filter((f) => f in session);
    assert(fields.length === 0, `Session still carries the reducer's state: ${fields.join(', ')}`);
  });

  await run('apply routes every op to its handler', async () => {
    const { sync, calls } = reducerOverStub({
      holds: (id) => id === 'held',
      order: () => ['held']
    });
    await sync.apply({ op: 'created', id: 'new', name: 'New' });
    await sync.apply({ op: 'deleted', id: 'gone' });
    await sync.apply({ op: 'renamed', id: 'held', name: 'Renamed' });
    await sync.apply({ op: 'binned', id: 'binned' });
    await sync.apply({ op: 'restored', id: 'back', name: 'Back' });
    await sync.apply({ op: 'binned-deleted', id: 'purged' });
    await sync.apply({ op: 'focus', id: 'held' });
    const got = calls.join(' ');
    const want = [
      'setName:new loadAtHead:new notify:conversation:created',
      'drop:gone notify:conversation:deleted',
      'setName:held notifyChange:conversation:renamed',
      'drop:binned bin.noteBinned notify:conversation:deleted',
      'setName:back bin.noteLeft:back loadAtHead:back notify:conversation:created',
      'bin.noteLeft:purged',
      'follow:held'
    ].join(' ');
    assert(got === want, `got "${got}", want "${want}"`);
  });

  await run('naming-started and naming-ended bracket a conversation being auto-named', async () => {
    const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({}))));
    /** @type {string[]} */
    const seen = [];
    session.subscribe((/** @type {any} */ e) => {
      if (e.type === 'conversation:auto-naming') seen.push(`${e.data.conversationId}:${e.data.active}`);
    });
    await session.sync.apply({ op: 'naming-started', id: 'c1' });
    assert(session.isAutoNaming('c1') === true, 'naming-started did not mark c1 as being named');
    assert(session.isAutoNaming('c2') === false, 'naming-started marked a conversation it did not name');
    await session.sync.apply({ op: 'naming-ended', id: 'c1' });
    assert(session.isAutoNaming('c1') === false, 'naming-ended left c1 marked as being named');
    // A second end (a reconnect, a duplicated echo) is not a change, so says nothing.
    await session.sync.apply({ op: 'naming-ended', id: 'c1' });
    assert(seen.join(' ') === 'c1:true c1:false', `announced "${seen.join(' ')}", want "c1:true c1:false"`);
  });

  await run('a naming mark nobody ends clears itself', async () => {
    const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({}))));
    // The end can be lost with the socket that would have carried it; the tab
    // must not say "Auto-naming…" for ever.
    session.setAutoNaming('c1', true, { timeoutMs: 20 });
    assert(session.isAutoNaming('c1') === true, 'the mark was not set');
    await waitFor(() => session.isAutoNaming('c1') === false, 'the mark to clear after its 20ms timeout');
  });

  await run('an unknown op is reported and changes nothing', async () => {
    const { sync, calls } = reducerOverStub();
    const logged = await captureConsole(() => sync.apply({ op: 'exploded', id: 'x' }));
    assert(calls.length === 0, `an unknown op reached the host: ${calls.join(' ')}`);
    assert(logged.warnings.some((w) => w.includes('exploded')), 'an unknown op was not reported');
  });

  await run('an op that throws is contained and reported under its name', async () => {
    const { sync } = reducerOverStub({
      drop: async () => { throw new Error('teardown blew up'); }
    });
    /** @type {unknown} */
    let escaped = null;
    const logged = await captureConsole(async () => {
      try {
        await sync.apply({ op: 'deleted', id: 'x' });
      } catch (e) {
        escaped = e;
      }
    });
    assert(escaped === null, `apply rejected: ${String(escaped)}`);
    assert(logged.errors.some((e) => e.includes('conversations-changed:deleted') && e.includes('teardown blew up')),
      `the fault was not reported under its op: ${JSON.stringify(logged.errors)}`);
  });

  await run('a duplicate\'s created echo is suppressed until the clone is placed', async () => {
    const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({
      createConversation: async (/** @type {string} */ name, /** @type {string} */ id) => ({ id, name }),
      reorderConversations: async () => null,
      updateSession: async () => ({ success: true })
    }))));
    session.registry.insert('src', { id: 'src', name: 'Source', isTurnActive: () => false }, 'test');

    const loader = workerManager.loader;
    const { loadExisting } = loader;
    const { clearUndoStacks } = workerManager;
    /** @type {string[]} */
    const loads = [];
    /** @type {(conv: any) => void} */
    let land = () => {};
    /** @type {() => void} */
    let loadStarted = () => {};
    const started = new Promise((resolve) => { loadStarted = () => resolve(undefined); });
    /** @type {any} */ (loader).loadExisting = (/** @type {string} */ id) => {
      loads.push(id);
      loadStarted();
      return new Promise((resolve) => { land = resolve; });
    };
    /** @type {any} */ (workerManager).clearUndoStacks = async () => {};
    /** @type {string[]} */
    const announced = [];
    const unsubscribe = session.subscribe((/** @type {any} */ event) => {
      if (event.type === 'conversation:created') announced.push(event.data?.id);
    });

    try {
      const duplicating = session.duplicateConversation('src');
      await started;
      const cloneId = loads[0];

      // The POST has answered and the clone's load is under way: the echo of
      // this viewer's own create lands now. A remote-path load starts
      // synchronously, so the count is read before anything is awaited; a
      // second load would never land, and awaiting it would hang the test.
      const echo = session.sync.apply({ op: 'created', id: cloneId, name: 'Source copy' });
      assert(loads.length === 1,
        `the echo loaded the clone a second time: ${loads.length} loads`);
      await echo;

      land({ id: cloneId, name: 'Source copy' });
      await duplicating;
      assert(announced.length === 1 && announced[0] === cloneId,
        `the clone was announced ${announced.length} times, want once`);
      const order = [...session.conversations.keys()].join(',');
      assert(order === `src,${cloneId}`, `the clone must sit right after its source, got ${order}`);
    } finally {
      unsubscribe();
      /** @type {any} */ (loader).loadExisting = loadExisting;
      /** @type {any} */ (workerManager).clearUndoStacks = clearUndoStacks;
    }
  });

  await run('a duplicate waits out a slow flush, and refuses on the worker\'s silence', async () => {
    /** @type {string[]} */
    const posted = [];
    const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({
      createConversation: async (/** @type {string} */ name, /** @type {string} */ id) => { posted.push(id); return { id, name }; },
      reorderConversations: async () => null,
      updateSession: async () => ({ success: true })
    }))));
    session.registry.insert('src', { id: 'src', name: 'Source', isTurnActive: () => false }, 'test');

    const wm = /** @type {any} */ (workerManager);
    const loader = wm.loader;
    const saved = {
      loadExisting: loader.loadExisting,
      clearUndoStacks: wm.clearUndoStacks,
      isWorkerReady: wm.isWorkerReady,
      sendToWorker: wm.sendToWorker
    };
    loader.loadExisting = async (/** @type {string} */ id) => ({ id, name: 'Source copy' });
    wm.clearUndoStacks = async () => {};
    wm.isWorkerReady = () => true;
    /** @type {any[]} */
    const sent = [];
    wm.sendToWorker = (/** @type {string} */ _id, /** @type {any} */ msg) => { sent.push(msg); return Promise.resolve(); };
    wm._lastHeardAt.delete('src');

    // The clock and the timers are in hand: time passes one second per step,
    // and every timer armed meanwhile fires at that step.
    /** @type {Array<() => void>} */
    let timers = [];
    const realSetTimeout = window.setTimeout;
    const realNow = Date.now;
    let clock = realNow();
    /**
     * Run `fn` with the clock stopped and timers captured rather than scheduled.
     * @template T
     * @param {() => T} fn - What to run.
     * @returns {T} Its value.
     */
    const inHand = (fn) => {
      window.setTimeout = /** @type {any} */ ((/** @type {() => void} */ cb) => { timers.push(cb); return 0; });
      Date.now = () => clock;
      try { return fn(); } finally { window.setTimeout = realSetTimeout; Date.now = realNow; }
    };
    const step = async () => {
      clock += 1000;
      const due = timers;
      timers = [];
      inHand(() => { for (const fire of due) fire(); });
      await Promise.resolve();
      await Promise.resolve();
    };

    try {
      // A slow core: the worker is busy with the message ahead of the flush
      // and says nothing for ten seconds before answering it.
      /** @type {unknown} */
      let outcome = null;
      const first = inHand(() => session.duplicateConversation('src'));
      first.then((/** @type {unknown} */ id) => { outcome = id; }, (/** @type {unknown} */ e) => { outcome = e; });
      const flush = sent.find((m) => m.type === 'flush-persistence');
      assert(flush, `the duplicate did not ask the worker to flush: ${JSON.stringify(sent)}`);
      for (let i = 0; i < 10; i++) await step();
      assert(posted.length === 0 && outcome === null,
        `the duplicate copied the source before its flush was answered: ${posted.length} POST(s), outcome ${String(outcome)}`);
      wm.settleAck(flush.ackId);
      const cloneId = await first;
      assert(typeof cloneId === 'string' && posted.length === 1,
        `once flushed, the duplicate goes ahead; got ${String(cloneId)} after ${posted.length} POST(s)`);

      // The worker never answers: the duplicate refuses rather than copy a
      // source it cannot vouch for.
      sent.length = 0;
      timers = [];
      wm._lastHeardAt.delete('src');
      outcome = null;
      const second = inHand(() => session.duplicateConversation('src'));
      second.then((/** @type {unknown} */ id) => { outcome = id; }, (/** @type {unknown} */ e) => { outcome = e; });
      for (let i = 0; i < 300 && outcome === null; i++) await step();
      assert(outcome instanceof Error && /said nothing/.test(outcome.message),
        `a duplicate whose worker fell silent must fail, saying so; got ${outcome instanceof Error ? outcome.message : String(outcome)}`);
      assert(posted.length === 1, `and copy nothing: ${posted.length} POST(s)`);
      assert(session.isDuplicating('src') === false,
        'a duplicate refused before its POST must not leave the source marked as duplicating');
    } finally {
      loader.loadExisting = saved.loadExisting;
      wm.clearUndoStacks = saved.clearUndoStacks;
      wm.isWorkerReady = saved.isWorkerReady;
      wm.sendToWorker = saved.sendToWorker;
    }
  });

  await run('one duplicate per source at a time, and the mark clears when it fails', async () => {
    /** @type {Array<{id: string, settle: (v: unknown) => void, fail: (e: Error) => void}>} */
    const posts = [];
    const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({
      createConversation: (/** @type {string} */ _name, /** @type {string} */ id) =>
        new Promise((settle, fail) => { posts.push({ id, settle, fail }); }),
      reorderConversations: async () => null,
      updateSession: async () => ({ success: true })
    }))));
    /**
     * @param {number} i - Which POST, in the order they were made.
     * @returns {{id: string, settle: (v: unknown) => void, fail: (e: Error) => void}} That POST, held open.
     */
    const post = (i) => {
      const p = posts[i];
      if (!p) throw new Error(`no POST #${i}: ${posts.length} made`);
      return p;
    };
    /** @type {string[]} */
    const warnings = [];
    session.registry.insert('src', {
      id: 'src', name: 'Source', isTurnActive: () => false,
      showWarning: (/** @type {string} */ m) => { warnings.push(m); }
    }, 'test');

    const wm = /** @type {any} */ (workerManager);
    const loader = wm.loader;
    const saved = { loadExisting: loader.loadExisting, clearUndoStacks: wm.clearUndoStacks, isWorkerReady: wm.isWorkerReady };
    loader.loadExisting = async (/** @type {string} */ id) => ({ id, name: 'Source copy' });
    wm.clearUndoStacks = async () => {};
    // No worker, so no flush: the POST is the first thing a duplicate awaits.
    wm.isWorkerReady = () => false;
    /** @type {string[]} */
    const marks = [];
    const unsubscribe = session.subscribe('conversation:duplicating',
      (/** @type {any} */ e) => { marks.push(`${e.data.conversationId}:${e.data.active}`); });

    try {
      const first = session.duplicateConversation('src');
      const again = session.duplicateConversation('src');
      const fork = session.duplicateConversation('src', { exclusive: true });
      /** @type {unknown[]} */
      const outcomes = [];
      first.catch((/** @type {unknown} */ e) => { outcomes.push(e); });
      again.catch((/** @type {unknown} */ e) => { outcomes.push(e); });

      // Read before anything is awaited: a POST is made synchronously when no
      // flush precedes it, and every POST here is held open, so a second copy
      // would be awaited for ever.
      assert(posts.length === 1, `a repeated duplicate must not start a second copy: ${posts.length} POST(s)`);
      assert(await fork === null, 'a fork while a duplicate of its source is in flight is refused');
      assert(warnings.length === 1, `the refusal says why: ${JSON.stringify(warnings)}`);
      assert(session.isDuplicating('src') === true, 'the source reads as duplicating while its copy is made');
      assert(JSON.stringify(marks) === '["src:true"]', `the start is announced once: ${JSON.stringify(marks)}`);

      post(0).fail(new Error('disk full'));
      await Promise.allSettled([first, again]);
      assert(outcomes.length === 2 && outcomes.every((e) => e instanceof Error && /disk full/.test(e.message)),
        `both callers hear the one failure: ${outcomes.map(String).join(', ')}`);
      assert(session.isDuplicating('src') === false, 'a failed duplicate clears the mark');
      assert(JSON.stringify(marks) === '["src:true","src:false"]', `the end is announced: ${JSON.stringify(marks)}`);

      // With nothing in flight, the next duplicate is a copy of its own.
      const retry = session.duplicateConversation('src');
      await Promise.resolve();
      assert(posts.length === 2, `after a failure a duplicate starts afresh: ${posts.length} POST(s)`);
      post(1).settle({ id: post(1).id, name: 'Source copy' });
      assert(await retry === post(1).id, 'and resolves to its own copy');
      assert(session.isDuplicating('src') === false, 'a finished duplicate clears the mark');
    } finally {
      unsubscribe();
      loader.loadExisting = saved.loadExisting;
      wm.clearUndoStacks = saved.clearUndoStacks;
      wm.isWorkerReady = saved.isWorkerReady;
    }
  });

  return { passed, failed, errors };
}
