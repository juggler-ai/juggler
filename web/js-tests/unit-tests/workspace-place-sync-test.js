//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A workspace box's place, as this window draws it and as the server keeps it.
 *
 * A box is placed by the conversation it sits behind. When that conversation
 * goes, the server hands the box on to the conversation ahead of it
 * (`reanchorBoxesAt`). The window has to come to the same answer: if it draws
 * the box somewhere else, nothing looks wrong until the server's table next
 * reaches it — a reconnect, any workspace edit — and then the box jumps past
 * tabs nobody touched.
 *
 * Run against the real server, because the disagreement is between the two.
 * @module unit-tests/workspace-place-sync-test
 */

import { assert } from '../utilities/test-helpers.js';
import { registerWorkspace, patchWorkspace, listWorkspaces, unregisterWorkspace } from '../../js/services/workspaces.js';
import { workspaceGroups } from '../../js/services/workspace-provisioning.js';
import { runWorkspaceSuite, makeConversation } from '../utilities/conversation-workspace-helpers.js';

/**
 * The strip as drawn, narrowed to the entries a case made: its conversations by
 * name, and its box as `[box]`. Every lane shares one project, so the strip also
 * holds other lanes' tabs, which are left out.
 * @param {any} session - The session drawn from.
 * @param {Map<string, string>} names - Conversation id → the name the case gave it.
 * @param {string} boxId - The case's workspace.
 * @returns {string} e.g. `P X [box] C`.
 */
function drawn(session, names, boxId) {
  return workspaceGroups(session).flatMap((group) => {
    if (group.workspace?.id === boxId) return ['[box]'];
    if (group.workspace) return [];
    return group.conversations.map(conversation => names.get(conversation.id)).filter(Boolean);
  }).join(' ');
}

/**
 * Run the workspace-place-sync tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  return runWorkspaceSuite('workspace-place-sync-test', async ({ run, session, projectPath, release }) => {
    await run('deleting the tab a box sits behind leaves the box where the server will put it', async () => {
      // Created bottom-first, since a new tab goes to the head: the strip reads
      // P X C, and the box is anchored behind X.
      const c = await makeConversation(session, 'below-the-box');
      release(c);
      const x = await makeConversation(session, 'the-anchor');
      const p = await makeConversation(session, 'above-the-box');
      release(p);
      const names = new Map([[p.id, 'P'], [x.id, 'X'], [c.id, 'C']]);

      // Registered after the tabs, so that no create of this case takes the
      // head from it: its place is the one written here and nothing else.
      const made = await registerWorkspace({ root: projectPath, label: 'a box with nothing in it', state: 'ready' });
      const apiService = session._apiService;
      const deleteWas = apiService.deleteConversation;
      try {
        const anchored = await patchWorkspace(made.id, { place: x.id });
        session.workspaces = [...session.workspaces, anchored];
        assert(drawn(session, names, made.id) === 'P X [box] C',
          `precondition: the box is drawn behind X, got "${drawn(session, names, made.id)}"`);

        // The user's delete, made permanent so the case leaves nothing in the
        // OS trash. Both go through the same server path.
        apiService.deleteConversation = (/** @type {string} */ id, /** @type {any} */ options = {}) =>
          deleteWas.call(apiService, id, { ...options, permanent: true });
        const deleted = await session.deleteConversation(x.id, 'workspace-place-sync-test');
        assert(deleted, 'precondition: X was deleted');

        const here = drawn(session, names, made.id);
        const server = (await listWorkspaces()).find(row => row.id === made.id);
        const ours = session.getWorkspace(made.id);

        // What the window draws once the server's table reaches it, which is
        // what any reconnect or workspace edit delivers.
        session._onWorkspacesChanged({ workspaces: await listWorkspaces() });
        const afterSync = drawn(session, names, made.id);

        assert(here === afterSync,
          `the box moves when the server's table arrives: drawn "${here}" after the delete, `
          + `"${afterSync}" once the table arrived (this window's place ${JSON.stringify(ours?.place)}, `
          + `the server's ${JSON.stringify(server?.place)})`);
        assert(afterSync === 'P [box] C',
          `and the box stays behind the tab that was above X, got "${afterSync}"`);
      } finally {
        apiService.deleteConversation = deleteWas;
        // Only a case that failed before its delete still holds X.
        if (session.conversations.has(x.id)) release(x);
        session.workspaces = session.workspaces.filter((/** @type {any} */ row) => row.id !== made.id);
        await unregisterWorkspace(made.id).catch(() => {});
      }
    });
  });
}
