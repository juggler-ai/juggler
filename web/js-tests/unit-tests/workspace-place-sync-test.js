//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A workspace box's place, as this window draws it when the tab it sits behind
 * is deleted.
 *
 * A box is placed by the conversation it sits behind. When that conversation
 * goes, the server hands the box on to the conversation ahead of it
 * (`reanchorBoxesAt`, pinned by `TestRemoveConv_ReanchorsBoxesOntoThePredecessor`)
 * and broadcasts the table (`TestWorkspaceRoutes_RemovingABoxAnchorBroadcastsItsNewPlace`).
 * The window applies the same rule to its own order at once, so the box does
 * not drop to the end of the bar and jump back when that broadcast lands.
 *
 * Driven through `Session.prototype._dropActiveConversation` on a stand-in
 * session with a fixed order: both sides read an order that is written out
 * here, so the rule is pinned without a server, and without a shared project
 * whose other lanes' tabs the window may not have heard of yet.
 * @module unit-tests/workspace-place-sync-test
 */

import { assert } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import ConversationRegistry from '../../js/model/conversation-registry.js';
import { workspaceGroups } from '../../js/services/workspace-provisioning.js';

/**
 * A minimal `this` for {@link Session.prototype._dropActiveConversation}: a
 * real registry in tab order and the box table, with teardown reduced to
 * removing the conversation from the registry.
 * @param {string[]} ids - Conversation ids in tab order.
 * @param {any[]} workspaces - The box table.
 * @returns {any} The stand-in session.
 */
function fakeSession(ids, workspaces) {
  const registry = new ConversationRegistry();
  for (const id of ids) registry.insert(id, /** @type {any} */ ({ id, workspaceId: '' }), 'test');
  return {
    registry,
    get conversations() { return registry.conversations; },
    workspaces,
    loadedConversationId: null,
    events: { notify: () => {} },
    _reanchorBoxesBeforeMove: /** @type {any} */ (Session.prototype)._reanchorBoxesBeforeMove,
    async _teardownConversation(/** @type {any} */ conv) { registry.remove(conv.id, 'test'); },
  };
}

/**
 * An empty, usable box sitting behind `place`.
 * @param {string} id - The workspace id.
 * @param {string} place - The conversation it sits behind, or 'head'.
 * @returns {any} The row.
 */
const box = (id, place) => ({ id, root: `/tmp/${id}`, label: id, state: 'ready', place });

/**
 * The strip as drawn: conversations by id, boxes as `[id]`.
 * @param {any} session - The stand-in session.
 * @returns {string} e.g. `P [ws] C`.
 */
const drawn = (session) => workspaceGroups(session).flatMap((group) =>
  (group.workspace ? [`[${group.workspace.id}]`] : group.conversations.map((c) => c.id))).join(' ');

/**
 * Run the workspace-place-sync tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test label.
   * @param {() => Promise<void>} fn - Test body.
   */
  async function run(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  await run('deleting the tab a box sits behind hands the box to the tab ahead of it', async () => {
    const session = fakeSession(['P', 'X', 'C'], [box('ws', 'X'), box('other', 'C')]);
    assert(drawn(session) === 'P X [ws] C [other]', `precondition: got "${drawn(session)}"`);
    await Session.prototype._dropActiveConversation.call(session, 'X', { clearVisibleIfNoFallback: false });
    const places = Object.fromEntries(session.workspaces.map((/** @type {any} */ row) => [row.id, row.place]));
    assert(places.ws === 'P', `the box sits behind the tab that was ahead of X, got ${JSON.stringify(places)}`);
    assert(places.other === 'C', `a box behind another tab stays put, got ${JSON.stringify(places)}`);
    assert(drawn(session) === 'P [ws] C [other]', `and is drawn where it was, got "${drawn(session)}"`);
  });

  await run('deleting the first tab sends the box behind it to the head', async () => {
    const session = fakeSession(['X', 'C'], [box('ws', 'X')]);
    await Session.prototype._dropActiveConversation.call(session, 'X', { clearVisibleIfNoFallback: false });
    assert(session.workspaces[0].place === 'head', `got ${JSON.stringify(session.workspaces[0].place)}`);
    assert(drawn(session) === '[ws] C', `drawn "${drawn(session)}"`);
  });

  return { passed, failed, errors };
}
