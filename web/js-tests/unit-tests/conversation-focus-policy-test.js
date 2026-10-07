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
 * so the policy is pinned deterministically.
 * @module unit-tests/conversation-focus-policy-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Build a Session holding two stub conversations: 'caller' (the one that asks
 * for the switch) and 'target' (the newly created peer). Neither touches the
 * network — applyConversationFocus only reads the map, the visible id, and the
 * caller's tab element.
 * @param {{composerText?: boolean}} [opts] - composerText marks the caller's
 *   tab as holding an unsent draft.
 * @returns {{session: any, switched: string[]}} The session and a log of every
 *   conversation id switchConversation was asked to show.
 */
function makeSession({ composerText = false } = {}) {
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
  session.conversations.set('target', stubConversation('target'));
  session._setSelection({ kind: 'conversation', id: 'caller' });

  /** @type {string[]} */
  const switched = [];
  session.switchConversation = (/** @type {string} */ id) => {
    switched.push(id);
    session._setSelection({ kind: 'conversation', id });
    return true;
  };

  return { session, switched };
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
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  run('follows a focus request from the conversation being watched', () => {
    const { session, switched } = makeSession();
    session.applyConversationFocus('target', 'caller');
    assert(switched.length === 1 && switched[0] === 'target',
      `expected a switch to "target", got ${JSON.stringify(switched)}`);
  });

  run('ignores a focus request while a different conversation is on screen', () => {
    const { session, switched } = makeSession();
    session._setSelection({ kind: 'conversation', id: 'other' });
    session.applyConversationFocus('target', 'caller');
    assert(switched.length === 0,
      `a background conversation pulled the viewer away: ${JSON.stringify(switched)}`);
  });

  run('ignores a focus request while the user is mid-message', () => {
    const { session, switched } = makeSession({ composerText: true });
    session.applyConversationFocus('target', 'caller');
    assert(switched.length === 0,
      `switched away from a half-typed message: ${JSON.stringify(switched)}`);
  });

  run('follows an unattributed focus request unconditionally', () => {
    const { session, switched } = makeSession({ composerText: true });
    session._setSelection({ kind: 'conversation', id: 'other' });
    session.applyConversationFocus('target');
    assert(switched.length === 1 && switched[0] === 'target',
      `an unattributed request must always be followed, got ${JSON.stringify(switched)}`);
  });

  run('parks the switch until the created conversation is announced', () => {
    const { session, switched } = makeSession();
    // Mid-create: the id is already in the map (early publish) but no
    // `conversation:created` has fired, so no tab element exists yet.
    session._remoteCreates.add('target');
    session.applyConversationFocus('target', 'caller');
    assert(switched.length === 0,
      `switched to a conversation with no tab element yet — blank panel: ${JSON.stringify(switched)}`);

    session._remoteCreates.delete('target');
    session._redeemPendingFocus('target');
    assert(switched.length === 1 && switched[0] === 'target',
      `parked focus was not redeemed on insert, got ${JSON.stringify(switched)}`);
  });

  run('drops a parked switch when the user starts typing during the load', () => {
    const { session, switched } = makeSession();
    session._remoteCreates.add('target');
    session.applyConversationFocus('target', 'caller');

    // The user began a message while the create was still loading.
    session.conversations.get('caller').getTabElement = () => ({ hasComposerText: () => true });
    session._remoteCreates.delete('target');
    session._redeemPendingFocus('target');
    assert(switched.length === 0,
      `redeemed a stale focus over a message typed since: ${JSON.stringify(switched)}`);
  });

  run('a redeem for an unrelated conversation leaves the parked request alone', () => {
    const { session, switched } = makeSession();
    session._remoteCreates.add('target');
    session.applyConversationFocus('target', 'caller');

    session._redeemPendingFocus('someone-else');
    assert(switched.length === 0, 'an unrelated insert redeemed the parked focus');

    session._remoteCreates.delete('target');
    session._redeemPendingFocus('target');
    assert(switched.length === 1 && switched[0] === 'target',
      `the parked request was lost, got ${JSON.stringify(switched)}`);
  });

  return { passed, failed, errors };
}
