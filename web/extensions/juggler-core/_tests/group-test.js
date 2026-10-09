//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The group provider: a workspace that is only a box to put conversations in.
 *
 * A group is the project under another name, so most of what is asserted here
 * is sameness — its root is the project's, its status says nothing the project
 * does not, it holds no work and seeds no instructions of its own. The two
 * things it does that no other provider does are its place at the head of the
 * list of kinds, and an ending that hands its conversations back to the project
 * instead of taking them to the bin.
 * @module _tests/group-test
 */

import {
  initializeRegistries,
  createTestSession,
  releaseTestConversation,
  waitForWorkerReady,
  waitFor,
  assert
} from '../../../js-tests/utilities/test-helpers.js';
import { ensureFixtureProvider } from '../../../js-tests/utilities/conversation-workspace-helpers.js';
import { fetchJson } from '../../../js/services/http.js';
import { listWorkspaces, unregisterWorkspace } from '../../../js/services/workspaces.js';
import {
  provisionWorkspace,
  workspaceStatus,
  workspaceFinishOptions,
  finishWorkspace
} from '../../../js/services/workspace-provisioning.js';
import { setupRows, NEW_ROW_PREFIX } from '../../../js/services/workspace-places.js';
import { openWorkspaceCreate, workspaceCreatePlaces } from '../../../js/components/workspace-create-dialog.js';
import { getExtensionCapabilities } from '../../../js/services/extensions.js';
import workspaceProviderRegistry from '../../../js/registries/workspace-provider-registry.js';
import GroupWorkspaceProvider from '../workspaces/group-workspace-provider.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/** @type {string} The provider under test, as the registry knows it. */
const PROVIDER_ID = GroupWorkspaceProvider.MANIFEST.id;

/**
 * Put the provider in the registry under its own id, unless it is already there.
 *
 * Some other kind goes in first. The registry lists kinds in the order they
 * arrived, so a group registered into an empty registry would head the list
 * whether or not anything puts it there — and heading the list on purpose is
 * one of the things this suite is for. The fixture is the kind every workspace
 * suite registers anyway, so no new kind is left behind in the lane.
 * @returns {string} What the registry said when it refused, or '' when the
 *   provider is in place.
 */
function registerProvider() {
  ensureFixtureProvider();
  if (workspaceProviderRegistry.get(PROVIDER_ID)) return '';
  const registration = workspaceProviderRegistry.registerClass(GroupWorkspaceProvider, {
    extensionId: '@juggler/core',
    modulePath: '(test)'
  });
  return registration.registered ? '' : String(registration.reason);
}

/**
 * A conversation, ready to be sent to: model configured and its worker up.
 * @param {any} session - The test session.
 * @param {string} name - Conversation name.
 * @param {object} [options] - Passed through to createConversation.
 * @returns {Promise<any>} The conversation.
 */
async function makeConversation(session, name, options = {}) {
  const id = await session.createConversation(name, options);
  const conversation = session.conversations.get(id);
  if (!conversation) throw new Error(`conversation ${id} was created but is not in the session`);
  conversation.setModelConfig({ provider: 'test-provider', model: 'test-model' });
  await waitForWorkerReady(id);
  return conversation;
}

/**
 * A short tag nothing else in this run will choose.
 * @returns {string} The tag.
 */
function uniqueTag() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run the group provider tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
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

  const projectPath = (await fetchJson('/api/session')).projectPath;

  /** @type {any} */
  let session = null;
  /** @type {string[]} */
  const created = [];
  /** @param {any} conversation - The conversation to release at the end. */
  const release = (conversation) => { if (conversation) created.push(conversation.id); };

  try {
    session = await createTestSession();

    await run('the provider registers, and names itself for the setup panel', async () => {
      const refusal = registerProvider();
      assert(refusal === '', `the registry refused the provider: ${refusal}`);

      const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
      assert(provider !== undefined, 'the provider is not in the registry under its own id');
      assert(provider.getSetupLabel() === 'New group',
        `the "New…" row would read ${JSON.stringify(provider.getSetupLabel())}`);

      const endings = provider.finishOptions({});
      assert(JSON.stringify(endings.map((/** @type {any} */ e) => e.id)) === '["ungroup","delete"]',
        `a group ends by being ungrouped or deleted, in that order, got ${JSON.stringify(endings)}`);
      assert(!endings[0].danger && endings[1].danger === true,
        `and only deleting destroys anything, got ${JSON.stringify(endings)}`);
    });

    await run('a group heads the list of kinds, and is the one the dialog opens on', async () => {
      registerProvider();
      const ids = workspaceProviderRegistry.getIds();
      assert(ids.length > 1,
        `precondition: another kind is registered to be ahead of, got ${JSON.stringify(ids)}`);

      const made = setupRows(session).filter((/** @type {any} */ row) => row.kind === 'new');
      assert(made[0]?.providerId === PROVIDER_ID,
        `a group is the first way to make one, got ${JSON.stringify(made.map((/** @type {any} */ r) => r.providerId))}`);
      assert(workspaceCreatePlaces(session)[0]?.providerId === PROVIDER_ID,
        'and so the first row in the dialog');

      const settled = openWorkspaceCreate(session);
      try {
        await waitFor(() => document.querySelector('.workspace-create-overlay .setup-row') !== null, 2000);
        const chosen = /** @type {HTMLElement|undefined} */ (Array.from(
          document.querySelectorAll('.workspace-create-overlay .setup-row'))
          .find((row) => row.getAttribute('aria-checked') === 'true'));
        assert(chosen?.dataset.rowId === `${NEW_ROW_PREFIX}${PROVIDER_ID}`,
          `the dialog opens on it, got ${JSON.stringify(chosen?.dataset.rowId)}`);
      } finally {
        /** @type {HTMLElement|null} */ (document.querySelector('.workspace-create-overlay .workspace-create-cancel'))?.click();
        await settled;
      }
    });

    await run('a group is the project, under the name it was given', async () => {
      registerProvider();
      const name = `a group ${uniqueTag()}`;
      /** @type {any} */
      let outcome = null;
      try {
        outcome = await provisionWorkspace({ session, providerId: PROVIDER_ID, values: { name } });
        assert(outcome.workspace.state === 'ready',
          `it is ready as soon as it is made, got ${JSON.stringify(outcome.workspace.state)}`);
        assert(outcome.workspace.root === projectPath,
          `rooted at the project itself, got ${JSON.stringify(outcome.workspace.root)}`);
        assert(outcome.workspace.kind === 'local',
          `on this machine, got ${JSON.stringify(outcome.workspace.kind)}`);
        assert(outcome.workspace.label === name,
          `and called what it was called, got ${JSON.stringify(outcome.workspace.label)}`);
      } finally {
        if (outcome) await outcome.undo();
      }
    });

    await run('a group made without a name is given one of its own', async () => {
      registerProvider();
      /** @type {any[]} */
      const outcomes = [];
      const saved = session.workspaces;
      try {
        outcomes.push(await provisionWorkspace({ session, providerId: PROVIDER_ID, values: { name: '  ' } }));
        outcomes.push(await provisionWorkspace({ session, providerId: PROVIDER_ID, values: {} }));
        const [first, second] = outcomes.map((outcome) => String(outcome.workspace.label));
        assert(/^Group \d+$/.test(first) && /^Group \d+$/.test(second),
          `a blank name becomes "Group N", got ${JSON.stringify([first, second])}`);
        assert(first !== second,
          `and two of them are told apart, got ${JSON.stringify([first, second])}`);
      } finally {
        session.workspaces = saved;
        for (const outcome of outcomes) await outcome.undo();
      }
    });

    await run('a group reports nothing the project does not, and holds no work of its own', async () => {
      registerProvider();
      /** @type {any} */
      let outcome = null;
      try {
        outcome = await provisionWorkspace({ session, providerId: PROVIDER_ID, values: { name: 'quiet' } });
        const reported = await workspaceStatus(session, outcome.workspace);
        assert(reported.available === true,
          `it says it can be reached, got ${JSON.stringify(reported)}`);
        // The project's own changes belong to the project, and a dot on every
        // group box would be the same dot drawn once per group.
        assert(!reported.dirty && !reported.badge && !reported.detail && !reported.problem,
          `and nothing else, since what is in its tree is the project's, got ${JSON.stringify(reported)}`);

        const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
        const held = await provider.heldWork(outcome.workspace, { session });
        assert(held?.complete === true && held.paths.length === 0 && held.removed.length === 0,
          `a group holds no work, rather than leaving git to count the project's, got ${JSON.stringify(held)}`);
        const roots = provider.instructionRoots(outcome.workspace, { session });
        assert(Array.isArray(roots) && roots.length === 0,
          `and names no instructions beyond the project's, which are already its own, got ${JSON.stringify(roots)}`);

        const { options, unavailableReason } = workspaceFinishOptions(session, outcome.workspace);
        assert(options.length === 2 && !unavailableReason,
          `its box offers both endings, got ${JSON.stringify({ options, unavailableReason })}`);
      } finally {
        if (outcome) await outcome.undo();
      }
    });

    await run('ungrouping puts its conversations back in the project, and closes it', async () => {
      registerProvider();
      const saved = session.workspaces;
      /** @type {string} */
      let workspaceId = '';
      try {
        const outcome = await provisionWorkspace({ session, providerId: PROVIDER_ID, values: { name: 'to ungroup' } });
        workspaceId = outcome.workspace.id;
        const one = await makeConversation(session, 'grouped-one', { workspaceId });
        release(one);
        const two = await makeConversation(session, 'grouped-two', { workspaceId });
        release(two);
        assert(one.workspaceId === workspaceId && two.workspaceId === workspaceId,
          'precondition: both conversations are in the group');

        const finished = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'ungroup' });
        assert(finished.done === true, `ungrouping goes through, got ${JSON.stringify(finished)}`);

        assert(session.conversations.has(one.id) && session.conversations.has(two.id),
          'neither conversation went to the bin');
        assert((one.workspaceId || '') === '' && (two.workspaceId || '') === '',
          `both are in the project, got ${JSON.stringify([one.workspaceId, two.workspaceId])}`);
        assert(/back in the project/.test(String(finished.message ?? '')),
          `and the ending says where they went, got ${JSON.stringify(finished.message)}`);

        const row = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === workspaceId);
        assert(row?.state === 'closed',
          `the group itself is closed, got ${JSON.stringify(row?.state)}`);
      } finally {
        session.workspaces = saved;
        if (workspaceId) await unregisterWorkspace(workspaceId).catch(() => {});
      }
    });

    await run('deleting a group takes its conversations to the bin, as any ending does', async () => {
      registerProvider();
      const saved = session.workspaces;
      /** @type {string} */
      let workspaceId = '';
      /** @type {any} */
      let inside = null;
      try {
        const outcome = await provisionWorkspace({ session, providerId: PROVIDER_ID, values: { name: 'to delete' } });
        workspaceId = outcome.workspace.id;
        inside = await makeConversation(session, 'deleted-with-it', { workspaceId });

        const finished = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'delete' });
        assert(finished.done === true, `deleting goes through, got ${JSON.stringify(finished)}`);
        assert(!session.conversations.has(inside.id),
          'the conversation in it is gone from the strip');
        const binned = (await session.bin.list()).map((/** @type {any} */ entry) => entry.id);
        assert(binned.includes(inside.id),
          `and is in the bin rather than gone, got ${JSON.stringify(binned)}`);
        assert(/in the bin/.test(String(finished.message ?? '')),
          `which the ending says, got ${JSON.stringify(finished.message)}`);
      } finally {
        session.workspaces = saved;
        if (inside?.id) await session.bin.deletePermanently(inside.id).catch(() => {});
        if (workspaceId) await unregisterWorkspace(workspaceId).catch(() => {});
      }
    });

    await run('the extension really ships it, which is one glob and no registration', async () => {
      const offered = (await getExtensionCapabilities('workspace-provider'))
        .map((/** @type {any} */ ref) => String(ref.path ?? ''));
      assert(offered.some(path => path.endsWith('group-workspace-provider.js')),
        `juggler-core offers the provider to load, got ${JSON.stringify(offered)}`);
    });
  } finally {
    if (session) {
      for (const id of created) {
        await releaseTestConversation(session, id, 'group-test');
      }
    }
  }

  return { passed, failed, errors };
}
