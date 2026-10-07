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

import { assert, trackTestSession } from '../utilities/test-helpers.js';
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
    session.conversations.set('src', { id: 'src', name: 'Source', isTurnActive: () => false });

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

  return { passed, failed, errors };
}
