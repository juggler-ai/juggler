//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Focus-follow policy for the `conversations-changed` op="focus" broadcast —
 * the only way a headless creator (the engine's `new_conversation` tool) can
 * move a viewer to a new tab.
 *
 * Two rules are pinned here, both regressions the tool shipped with:
 *
 *   1. A switch may only happen when the request is *welcome*: the viewer is
 *      showing the conversation that asked (`from`) and its composer is empty.
 *      Anyone reading another tab, or part-way through typing, keeps their
 *      place and just gains a new tab in the sidebar.
 *   2. A switch may only happen once the target is genuinely switchable.
 *      `loader.loadExisting` publishes its conversation into `session.conversations`
 *      early — the worker's yjs-sync must find it — so the map reports the id
 *      well before `conversation:created` fires and the tab bar builds the
 *      element. Focusing inside that window hides every other tab and shows
 *      nothing: a blank panel until the next manual switch. The request must be
 *      parked and redeemed after the insert is announced.
 *
 * Runs against a bare Session with stub conversations — no server, no workers —
 * so the policy is pinned deterministically. The broadcasts go through the
 * session's sync reducer, and a create's load is a stub the test settles by
 * hand, so the parked window is the real one between `created` and its load.
 * @module unit-tests/conversation-focus-policy-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';

/**
 * Stand in for the session's load of a remote create: publish the conversation
 * into the map at once, as the real load does before its worker is ready, and
 * resolve only when the test says so.
 * @param {any} session - The session whose loads to script
 * @param {(id: string) => any} stubConversation - Builds the published entry
 * @returns {Map<string, () => void>} Per id, the function that lands its load
 */
function scriptLoads(session, stubConversation) {
  /** @type {Map<string, () => void>} */
  const land = new Map();
  session._loadIntoHead = (/** @type {string} */ id) => new Promise((resolve) => {
    const conv = stubConversation(id);
    session.conversations.set(id, conv);
    land.set(id, () => resolve(conv));
  });
  return land;
}

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Build a Session holding two stub conversations: 'caller' (the one that asks
 * for the switch) and 'target' (the newly created peer). Neither touches the
 * network — a focus only reads the map, the visible id, and the caller's tab
 * element. With `creating`, 'target' is left out of the map: its `created`
 * broadcast is what will bring it in.
 * @param {{composerText?: boolean, creating?: boolean}} [opts] - composerText
 *   marks the caller's tab as holding an unsent draft.
 * @returns {{session: any, switched: string[], land: Map<string, () => void>}}
 *   The session, a log of every conversation id switchConversation was asked to
 *   show, and the scripted loads.
 */
function makeSession({ composerText = false, creating = false } = {}) {
  const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({}))));

  /**
   * @param {string} id - Conversation id
   * @returns {any} Stub conversation exposing just the tab element the policy reads
   */
  const stubConversation = (id) => ({
    id,
    getTabElement: () => ({ hasComposerText: () => composerText })
  });

  session.conversations.set('caller', stubConversation('caller'));
  if (!creating) session.conversations.set('target', stubConversation('target'));
  session._setSelection({ kind: 'conversation', id: 'caller' });
  const land = scriptLoads(session, stubConversation);

  /** @type {string[]} */
  const switched = [];
  session.switchConversation = (/** @type {string} */ id) => {
    switched.push(id);
    session._setSelection({ kind: 'conversation', id });
    return true;
  };

  return { session, switched, land };
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
   * @param {() => void|Promise<void>} fn
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

  await run('follows a focus request from the conversation being watched', () => {
    const { session, switched } = makeSession();
    session.sync.apply({ op: 'focus', id: 'target', from: 'caller' });
    assert(switched.length === 1 && switched[0] === 'target',
      `expected a switch to "target", got ${JSON.stringify(switched)}`);
  });

  await run('ignores a focus request while a different conversation is on screen', () => {
    const { session, switched } = makeSession();
    session._setSelection({ kind: 'conversation', id: 'other' });
    session.sync.focus('target', 'caller');
    assert(switched.length === 0,
      `a background conversation pulled the viewer away: ${JSON.stringify(switched)}`);
  });

  await run('ignores a focus request while the user is mid-message', () => {
    const { session, switched } = makeSession({ composerText: true });
    session.sync.focus('target', 'caller');
    assert(switched.length === 0,
      `switched away from a half-typed message: ${JSON.stringify(switched)}`);
  });

  await run('follows an unattributed focus request unconditionally', () => {
    const { session, switched } = makeSession({ composerText: true });
    session._setSelection({ kind: 'conversation', id: 'other' });
    session.sync.focus('target');
    assert(switched.length === 1 && switched[0] === 'target',
      `an unattributed request must always be followed, got ${JSON.stringify(switched)}`);
  });

  await run('parks the switch until the created conversation is announced', async () => {
    const { session, switched, land } = makeSession({ creating: true });
    // Mid-create: the load has published the id into the map but has not
    // landed, so no `conversation:created` has fired and no tab element exists.
    const created = session.sync.apply({ op: 'created', id: 'target', name: 'Target' });
    assert(session.conversations.has('target'), 'precondition: the load publishes early');
    session.sync.apply({ op: 'focus', id: 'target', from: 'caller' });
    assert(switched.length === 0,
      `switched to a conversation with no tab element yet — blank panel: ${JSON.stringify(switched)}`);

    land.get('target')?.();
    await created;
    assert(switched.length === 1 && switched[0] === 'target',
      `parked focus was not redeemed on insert, got ${JSON.stringify(switched)}`);
  });

  await run('drops a parked switch when the user starts typing during the load', async () => {
    const { session, switched, land } = makeSession({ creating: true });
    const created = session.sync.created('target', 'Target');
    session.sync.focus('target', 'caller');

    // The user began a message while the create was still loading.
    session.conversations.get('caller').getTabElement = () => ({ hasComposerText: () => true });
    land.get('target')?.();
    await created;
    assert(switched.length === 0,
      `redeemed a stale focus over a message typed since: ${JSON.stringify(switched)}`);
  });

  await run('an unrelated arrival leaves the parked request alone', async () => {
    const { session, switched, land } = makeSession({ creating: true });
    const target = session.sync.created('target', 'Target');
    const unrelated = session.sync.created('someone-else', 'Someone else');
    session.sync.focus('target', 'caller');

    land.get('someone-else')?.();
    await unrelated;
    assert(switched.length === 0, 'an unrelated insert redeemed the parked focus');

    land.get('target')?.();
    await target;
    assert(switched.length === 1 && switched[0] === 'target',
      `the parked request was lost, got ${JSON.stringify(switched)}`);
  });

  await run('a created echo for a local create in flight loads nothing', async () => {
    const { session, land } = makeSession({ creating: true });
    session.sync.beginLocalCreate('target');
    await session.sync.created('target', 'Target');
    assert(!land.has('target') && !session.conversations.has('target'),
      'the echo of this viewer\'s own create took the remote-load path');
    session.sync.endLocalCreate('target');
    const created = session.sync.created('target', 'Target');
    assert(land.has('target'), 'a created after the bracket closed must load the conversation');
    land.get('target')?.();
    await created;
  });

  return { passed, failed, errors };
}
