//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The session's conversation list belongs to its `ConversationRegistry`: the
 * map and its order, the selection, the most-recently-used list and the name
 * cache. The session decides; the registry records.
 *
 * The first two cases are structural: the session must hold none of that state
 * itself and offer no way to write it except through the registry, so the
 * old shape cannot quietly come back. The rest drive the registry through a
 * real session, and the last drives `refreshFromServer`, whose rebuild was once
 * the one write to the list that left nothing on the tape.
 * @module unit-tests/conversation-registry-test
 */

import { trackTestSession, assert } from '../utilities/test-helpers.js';
import { dumpTape } from '../../js/utils/event-tape.js';
import Session from '../../js/model/session.js';

/**
 * A session with no server behind it, beyond the manifest a refresh reads.
 * @param {Record<string, any>} [manifest] - What `GET /api/session` answers.
 * @returns {any} The session.
 */
function makeSession(manifest = {}) {
  return trackTestSession(new Session(/** @type {any} */ ({
    getSession: async () => manifest
  })));
}

/**
 * A conversation as the list sees it: an id, a loaded document, and a teardown
 * a refresh may call.
 * @param {string} id - Conversation id.
 * @returns {any} The stand-in.
 */
function stub(id) {
  return { id, name: id, workspaceId: '', loadState: 'loaded', destroy() {} };
}

/**
 * Run `fn` with the event tape recording, as it does under the browser pool,
 * and put the switch back the way it was found.
 * @param {() => Promise<void>} fn - The work to record.
 * @returns {Promise<void>}
 */
async function withTape(fn) {
  const host = /** @type {any} */ (globalThis.window || globalThis);
  const was = host.__jugglerTrace;
  host.__jugglerTrace = true;
  try {
    await fn();
  } finally {
    host.__jugglerTrace = was;
  }
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
   * @param {string} label - Case under test, used to label a failure.
   * @param {() => Promise<void>|void} fn - Assertions; throws to fail.
   * @returns {Promise<void>} Resolves once the case has run.
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

  await run('the session keeps no conversation list of its own', () => {
    const proto = /** @type {any} */ (Session.prototype);
    const strayMethods = ['_setConversationOrder', '_replaceConversations', '_setSelection', 'retainUnloadedConversationId']
      .filter((name) => name in proto);
    assert(strayMethods.length === 0, `Session still writes the list itself: ${strayMethods.join(', ')}`);

    const session = makeSession();
    const strayFields = ['conversations', 'selection', 'loadedConversationId', '_mruList', '_conversationNames', '_unloadedConversationIds']
      .filter((name) => Object.hasOwn(session, name));
    assert(strayFields.length === 0, `Session holds list state as fields of its own: ${strayFields.join(', ')}`);
  });

  await run('the list is the registry\'s, and cannot be swapped from outside', () => {
    const session = makeSession();
    assert(!!session.registry, 'the session has no registry');
    assert(session.conversations === session.registry.conversations,
      'session.conversations must be the registry\'s own map, not a copy');
    let threw = false;
    try {
      session.conversations = new Map();
    } catch (e) {
      threw = e instanceof TypeError;
    }
    assert(threw, 'assigning session.conversations must throw: the registry is the only writer');
  });

  await run('arranging rebuilds the order inside the map the tab bar holds', () => {
    const { registry } = makeSession();
    const held = registry.conversations;
    registry.insert('a', stub('a'), 'test');
    registry.insert('b', stub('b'), 'test');
    registry.insert('c', stub('c'), 'test');

    registry.arrange(['c', 'gone', 'a'], new Map([['n', stub('n')]]));
    assert(registry.conversations === held, 'arranging replaced the Map, stranding every caller mid-await');
    assert(registry.ids().join() === 'c,a,b',
      `named ids go first, an id it does not hold is skipped, an unnamed one keeps its place at the end — got ${registry.ids().join()}`);

    registry.arrange(['n', 'c'], new Map([['n', stub('n')]]));
    assert(registry.ids().join() === 'n,c,a,b', `an addition is put where it is named — got ${registry.ids().join()}`);
  });

  await run('a removed conversation is never the one fallen back to', () => {
    const { registry } = makeSession();
    for (const id of ['c', 'a', 'b']) registry.insert(id, stub(id), 'test');
    assert(registry.fallback() === 'c', `with nothing used yet, the fallback is the first tab — got ${registry.fallback()}`);

    registry.touch('a');
    registry.touch('b');
    const removed = registry.remove('b', 'test');
    assert(removed?.id === 'b', 'remove() hands back what it removed');
    assert(registry.fallback() === 'a', `the fallback is the most recently used tab still held — got ${registry.fallback()}`);
    assert(registry.remove('b', 'test') === null, 'removing what is not held is a miss, not a throw');
  });

  await run('choosing a conversation makes it the one to come back to; choosing a workspace does not', () => {
    const { registry } = makeSession();
    registry.select({ kind: 'conversation', id: 'a' });
    assert(registry.visibleConversationId === 'a' && registry.loadedConversationId === 'a',
      'a chosen conversation is both on screen and the one to come back to');

    registry.select({ kind: 'workspace', id: 'ws' });
    assert(registry.visibleConversationId === null && registry.visibleWorkspaceId === 'ws',
      'a chosen workspace is what is on screen');
    assert(registry.loadedConversationId === 'a', 'and the conversation behind it is still the one to come back to');

    registry.clearSelection();
    assert(registry.selection === null && registry.loadedConversationId === null,
      'clearing leaves nothing on screen and nothing to come back to');
  });

  await run('a refresh keeps the name of a held conversation it no longer lists', () => {
    const { registry } = makeSession();
    registry.insert('a', stub('a'), 'test');
    registry.insert('b', stub('b'), 'test');
    registry.adoptNames({ a: 'Alpha', b: 'Beta', z: 'Zed' });
    registry.mergeNames({ a: 'Alpha 2' });
    assert(registry.name('a') === 'Alpha 2', 'a listed name is the manifest\'s');
    assert(registry.name('b') === 'Beta', 'a held conversation the manifest omits stays renderable while it is torn down');
    assert(registry.name('z') === '', 'a name for a conversation neither held nor listed is dropped');
  });

  await run('a project switch leaves nothing behind', () => {
    const { registry } = makeSession();
    registry.insert('a', stub('a'), 'test');
    registry.setName('a', 'Alpha');
    registry.touch('a');
    registry.select({ kind: 'conversation', id: 'a' });
    registry.reset();
    assert(registry.size === 0 && registry.name('a') === '' && registry.selection === null
      && registry.loadedConversationId === null && registry.fallback() === undefined,
    'reset must clear the map, the names, the selection and the most-recently-used list together');
  });

  await run('replacing the list records each arrival and departure', async () => {
    await withTape(async () => {
      const { registry } = makeSession();
      const kept = `reg-kept-${Math.random().toString(36).slice(2)}`;
      const left = `reg-left-${Math.random().toString(36).slice(2)}`;
      const came = `reg-came-${Math.random().toString(36).slice(2)}`;
      registry.insert(kept, stub(kept), 'test');
      registry.insert(left, stub(left), 'test');

      registry.replace(new Map([[came, stub(came)], [kept, stub(kept)]]), 'test-replace');
      assert(registry.ids().join() === `${came},${kept}`, `the map is exactly what it was given — got ${registry.ids().join()}`);

      const ops = (/** @type {string} */ id) => dumpTape(id)
        .filter((e) => e.kind === 'session-mut' && /** @type {any} */ (e.summary).from === 'test-replace')
        .map((e) => /** @type {any} */ (e.summary).op);
      assert(ops(came).join() === 'set', `the arrival is taped once as a set — got [${ops(came).join()}]`);
      assert(ops(left).join() === 'delete', `the departure is taped once as a delete — got [${ops(left).join()}]`);
      assert(ops(kept).length === 0, `a conversation that stayed is not taped — got [${ops(kept).join()}]`);
    });
  });

  await run('a refresh records the conversations it drops', async () => {
    await withTape(async () => {
      const kept = `refresh-kept-${Math.random().toString(36).slice(2)}`;
      const dropped = `refresh-dropped-${Math.random().toString(36).slice(2)}`;
      const session = makeSession({ conversationOrder: [kept], conversationNames: { [kept]: 'Kept' } });
      // Through the live map, so this setup means the same thing before and
      // after the list had an owner — the assertion is what is under test.
      session.conversations.set(kept, stub(kept));
      session.conversations.set(dropped, stub(dropped));

      await session.refreshFromServer();

      assert([...session.conversations.keys()].join() === kept,
        `the refresh drops what the server no longer lists — got ${[...session.conversations.keys()].join()}`);
      const departures = dumpTape(dropped)
        .filter((e) => e.kind === 'session-mut' && /** @type {any} */ (e.summary).op === 'delete');
      assert(departures.length === 1,
        `a conversation another view deleted must leave a delete on the tape, as every other removal does — found ${departures.length}`);
    });
  });

  return { passed, failed, errors };
}
