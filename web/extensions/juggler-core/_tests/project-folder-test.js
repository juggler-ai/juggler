//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The project-folder provider: the one that builds nothing.
 *
 * Every case here is about a thing NOT happening. The folder exists before the
 * provision and after the undo; the provision runs no command; the endings are
 * empty on purpose. A provider like that is easy to write and easy to get
 * subtly wrong in one direction — by removing something it never made — so the
 * folder is checked for after every path that could have taken it away.
 *
 * The other half is the boundary. A path that leaves the project is refused
 * before a row is registered, and the conversation bound to a folder reads that
 * folder rather than the project around it, which is asserted with a file that
 * exists nowhere else.
 * @module _tests/project-folder-test
 */

import {
  initializeRegistries,
  createTestSession,
  releaseTestConversation,
  waitForWorkerReady,
  waitFor,
  assert
} from '../../../js-tests/utilities/test-helpers.js';
import { fetchJson } from '../../../js/services/http.js';
import { createBoundOps } from '../../../sdk/ops.js';
import { listWorkspaces } from '../../../js/services/workspaces.js';
import {
  provisionWorkspace,
  workspaceStatus,
  workspaceFinishOptions
} from '../../../js/services/workspace-provisioning.js';
import { rebindConversation } from '../../../js/services/workspace-rebinding.js';
import { getExtensionCapabilities } from '../../../js/services/extensions.js';
import workspaceProviderRegistry from '../../../js/registries/workspace-provider-registry.js';
import contextItemRegistry from '../../../js/registries/context-item-registry.js';
import ProjectFolderWorkspaceProvider from '../workspaces/project-folder-workspace-provider.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/** @type {string} The provider under test, as the registry knows it. */
const PROVIDER_ID = ProjectFolderWorkspaceProvider.MANIFEST.id;

/**
 * Put the provider in the registry under its own id, unless it is already there.
 *
 * A lane is one JS realm running suite after suite, and nothing resets this
 * registry between them, so a registration outlives the run of the suite that
 * made it. `registerClass` skips an id that is taken rather than replacing it —
 * so a second pass over this suite in the same lane would be told the provider
 * is already registered, which is the outcome it was asking for, not a refusal.
 * The id cannot be made unique instead: it is the shipped provider's own, and
 * both the panel label below and every provision in this suite resolve through
 * it.
 * @returns {string} What the registry said when it refused, or '' when the
 *   provider is in place.
 */
function registerProvider() {
  if (workspaceProviderRegistry.get(PROVIDER_ID)) return '';
  const registration = workspaceProviderRegistry.registerClass(ProjectFolderWorkspaceProvider, {
    extensionId: '@juggler/core',
    modulePath: '(test)'
  });
  return registration.registered ? '' : String(registration.reason);
}

/**
 * A name nothing else in this run will choose. The lanes share one project, and
 * what these cases make inside it is stamped and removed by the case that made
 * it.
 * @returns {string} A short unique tag.
 */
function uniqueTag() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
 * Read a file through the real `read` tool, as a turn in this conversation
 * would. The path is relative on purpose: which tree it lands in is the
 * question, and only a relative path asks it.
 * @param {any} session - The test session.
 * @param {any} conversation - The conversation whose tools these are.
 * @param {string} path - Path relative to wherever the conversation works.
 * @returns {Promise<any>} The read result.
 */
async function readIn(session, conversation, path) {
  const ReadFile = /** @type {any} */ (contextItemRegistry.getByToolName('read'));
  if (!ReadFile) throw new Error('the read tool is not registered');
  const item = new ReadFile({
    id: 'read-file',
    session,
    conversation,
    messageThread: conversation.rootMessageThread
  });
  return item.execute({ path });
}

/**
 * Open the provider's setup form the way the panel opens it.
 *
 * Attached to the document, unlike the other providers' form cases: this form's
 * field is a custom element that builds its input when it is connected, and its
 * completion menu is portaled to `<body>`. A detached container would test a
 * control that never came up.
 * @param {any} session - The test session.
 * @param {object} [values] - What the section last reported, for a form being rebuilt.
 * @returns {any} The provider, its container, the field, and how to put it away.
 */
function openForm(session, values) {
  const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
  if (!provider) throw new Error('the provider is not registered, so it has no form to render');
  const container = document.createElement('div');
  document.body.appendChild(container);
  provider.renderSetup(container, {
    session,
    ops: createBoundOps(() => ({})),
    baseOps: createBoundOps(() => ({})),
    baseWorkspaceId: '',
    values,
    signal: new AbortController().signal,
    rollback: { push: () => {} },
    checkpoint: async () => {},
    progress: () => {}
  });
  const element = container.querySelector('[data-field="folder"]');
  return {
    provider,
    container,
    element,
    input: container.querySelector('.path-input-field'),
    note: container.querySelector('[data-field-note="folder"]'),
    close: () => {
      container.remove();
      document.querySelectorAll('.path-input-menu').forEach(menu => menu.remove());
    }
  };
}

/**
 * Type into the form's field the way a user does, so the element's own input
 * handling runs — a value assigned to the property completes nothing.
 * @param {any} form - What {@link openForm} returned.
 * @param {string} text - What to type.
 */
function type(form, text) {
  form.input.value = text;
  form.input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Run the project-folder tests.
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
  const separator = projectPath.includes('\\') && !projectPath.includes('/') ? '\\' : '/';
  const ops = createBoundOps(() => ({}));

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
      assert(registerProvider() === '',
        'and asking a second time, as the next run of this suite in this lane does, finds it there');

      const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
      assert(provider !== undefined, 'the provider is not in the registry under its own id');
      assert(provider.getSetupLabel() === 'A subfolder of this project',
        `the "New…" row would read ${JSON.stringify(provider.getSetupLabel())}`);
      assert(provider.finishOptions({}).length === 0,
        'a folder has no endings: nothing was made, so nothing can be disposed of');
    });

    await run('the field completes folders of the project, and nothing outside it', async () => {
      // The completions come from the project-restricted endpoint, which is the
      // difference between this field and the one in the project picker. A
      // menu of absolute paths here would mean the element was asking the other
      // endpoint, and the first sign of it would be a user browsing their home
      // directory in a form headed "a subfolder of this project".
      const tag = uniqueTag();
      const folder = `pf-${tag}`;
      await ops.writeFile({ path: `${folder}/inner/marker.txt`, content: `only-here-${tag}` });
      const form = openForm(session, undefined);
      try {
        type(form, 'pf-');
        await waitFor(() => document.querySelector('.path-input-menu'),
          { description: 'the completion menu to open' });
        const offered = [...document.querySelectorAll('.path-input-menu .menu-item')]
          .map(item => String(item.textContent ?? '').trim());
        assert(offered.some(path => path.startsWith(`${folder}/`) || path === `${folder}/`),
          `the folder just made is offered, relative to the project, got ${JSON.stringify(offered)}`);
        assert(!offered.some(path => path.startsWith('/')),
          `and nothing is offered as an absolute path, got ${JSON.stringify(offered)}`);
      } finally {
        form.close();
        await ops.shell({ command: `rm -rf ${folder}` }).catch(() => {});
      }
    });

    await run('a folder picked from the menu counts as a folder entered', async () => {
      // The pick is what this field is for — a few keystrokes and a click — and
      // it arrives without a keystroke of its own. The check the prefix started
      // is deliberately waited out first, so nothing pending is left to look at
      // the field again by chance: after that, the pick is the only thing that
      // can put the form right, and Create stays dead unless it does.
      const tag = uniqueTag();
      const folder = `pf-${tag}`;
      await ops.writeFile({ path: `${folder}/inner/marker.txt`, content: `picked-${tag}` });
      const form = openForm(session, undefined);
      let heard = 0;
      const listen = () => { heard++; };
      form.container.addEventListener('input', listen);
      form.container.addEventListener('change', listen);
      try {
        type(form, 'pf-');
        await waitFor(() => String(form.note.textContent ?? '').includes('no such folder'),
          { description: 'the half-typed prefix to be reported as no folder of its own' });
        heard = 0;

        const offered = () => [...document.querySelectorAll('.path-input-menu .menu-item')]
          .find(item => String(item.textContent ?? '').trim() === `${folder}/`);
        await waitFor(offered, { description: `${folder}/ to be offered in the menu` });
        offered()?.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));

        // The line under the field, not the validity: clearing the verdict is
        // the first thing a check does, so validity turns on before anything
        // has looked at the picked path, and waiting on it would prove only
        // that the form is hopeful.
        await waitFor(() => String(form.note.textContent ?? '').includes('Commands run here'),
          { description: 'the picked folder to be found, which is what leaves Create pressable' });
        assert(form.provider.getSetupValue().valid === true,
          `so Create is live, got ${JSON.stringify(form.provider.getSetupValue())}`);
        assert(heard > 0,
          'and the form says so in the events the panel listens to, or Create is never asked again');
      } finally {
        form.close();
        await ops.shell({ command: `rm -rf ${folder}` }).catch(() => {});
      }
    });

    await run('a folder the project does not have is refused before anything is registered', async () => {
      const before = (await listWorkspaces()).length;
      const tag = uniqueTag();
      let refusal = '';
      try {
        await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { folder: `no-such-folder-${tag}` }
        });
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      assert(refusal.includes('no such folder'),
        `the provision says what is wrong in its own words, got ${JSON.stringify(refusal)}`);
      assert((await listWorkspaces()).length === before,
        'and leaves no row behind for a place that is not there');
    });

    await run('a path that climbs out of the project is refused, however it is spelled', async () => {
      const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
      const ctx = { session, ops, baseWorkspaceId: '', signal: new AbortController().signal };

      for (const folder of ['..', `..${separator}elsewhere`, 'deep/../../elsewhere']) {
        let refusal = '';
        try {
          await provider.provision({ folder }, ctx);
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error);
        }
        assert(refusal.includes('outside the project'),
          `${JSON.stringify(folder)} is refused as outside the project, got ${JSON.stringify(refusal)}`);
      }

      let itself = '';
      try {
        await provider.provision({ folder: '.' }, ctx);
      } catch (error) {
        itself = error instanceof Error ? error.message : String(error);
      }
      assert(itself.includes('the project itself'),
        `and the project itself is sent back to the row that already offers it, got ${JSON.stringify(itself)}`);
    });

    await run('binding to a folder puts the conversation in it, and takes nothing away', async () => {
      const tag = uniqueTag();
      const folder = `pf-${tag}`;
      const marker = `only-in-the-folder-${tag}`;
      await ops.writeFile({ path: `${folder}/greeting.txt`, content: marker });

      /** @type {any} */
      let outcome = null;
      const saved = session.workspaces;
      /** @type {any} */
      let conversation = null;
      try {
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { folder }
        });
        session.workspaces = [...saved, outcome.workspace];

        assert(outcome.workspace.state === 'ready',
          `the row is ready as soon as the provider returns, got ${JSON.stringify(outcome.workspace.state)}`);
        assert(outcome.workspace.root === `${projectPath}${separator}${folder}`,
          `rooted at the folder itself, got ${JSON.stringify(outcome.workspace.root)}`);
        assert(outcome.workspace.label === folder,
          `and labelled as the project sees it, got ${JSON.stringify(outcome.workspace.label)}`);

        conversation = await makeConversation(session, `in-${folder}`, { workspaceId: outcome.workspace.id });
        release(conversation);
        const inFolder = await readIn(session, conversation, 'greeting.txt');
        assert(inFolder.exists !== false && String(inFolder.content ?? '').includes(marker),
          `the conversation's own tools read the folder, got ${JSON.stringify(inFolder)}`);

        const elsewhere = await makeConversation(session, `in-${folder}-project`);
        release(elsewhere);
        const inProject = await readIn(session, elsewhere, 'greeting.txt');
        assert(inProject.exists === false,
          `while the project holds no such file, which is what makes the line above mean anything, got ${JSON.stringify(inProject)}`);
      } finally {
        session.workspaces = saved;
        if (outcome) await outcome.undo();
      }

      // The undo is the sharp end of this provider: it unregisters a row, and a
      // provider that had pushed a compensation out of habit would have taken
      // the user's folder with it.
      assert(!(await listWorkspaces()).some((/** @type {any} */ row) => row.root.endsWith(folder)),
        'the undo takes the row away');
      assert((await ops.stat({ path: `${folder}/greeting.txt` })).exists,
        'and leaves the folder exactly where it was, which is the whole point of the provider');
      await ops.shell({ command: `rm -rf ${folder}` }).catch(() => {});
    });

    await run('a folder says what it is, and says when it is gone', async () => {
      const tag = uniqueTag();
      const folder = `pf-${tag}`;
      await ops.writeFile({ path: `${folder}/keep.txt`, content: 'kept' });
      /** @type {any} */
      let outcome = null;
      try {
        outcome = await provisionWorkspace({ session, providerId: PROVIDER_ID, values: { folder } });

        const reported = await workspaceStatus(session, outcome.workspace);
        assert(reported.available === true,
          `a folder that is there says so, got ${JSON.stringify(reported)}`);
        // And does not name it. The row does that, from the moment any surface
        // draws; a name arriving with the status would land after the first
        // draw and change the title under whoever was reading it.
        assert(reported.label === undefined,
          `leaving the naming to the row, got ${JSON.stringify(reported)}`);
        assert(outcome.workspace.label === folder,
          `which is named by where it is in the project, got ${JSON.stringify(outcome.workspace.label)}`);
        // And stops there. A folder has no branch, no drift and no work of its
        // own to report, so a status line could only spell its path a second
        // time under the path every surface already shows beside it.
        assert(!reported.detail,
          `with nothing further, because a folder has no state of its own, got ${JSON.stringify(reported.detail)}`);
        assert(!reported.problem,
          `and nothing is wrong with it, got ${JSON.stringify(reported.problem)}`);

        const missing = await workspaceStatus(
          session, { ...outcome.workspace, available: false });
        assert(missing.detail === 'The folder is missing.' && missing.available === false,
          `a folder that has gone says so rather than reporting on it, got ${JSON.stringify(missing)}`);

        const { options, unavailableReason } = workspaceFinishOptions(session, outcome.workspace);
        assert(options.length === 0 && !unavailableReason,
          `and offers no endings, without pretending the provider is missing, got ${JSON.stringify({ options, unavailableReason })}`);
      } finally {
        if (outcome) await outcome.undo();
        await ops.shell({ command: `rm -rf ${folder}` }).catch(() => {});
      }
    });

    await run('the extension really ships it, which is one glob and no registration', async () => {
      // Every case above registers the class by hand. What puts it in front of a
      // user is the manifest's `workspaceProviders` glob matching the file's
      // name, and nothing else — so a file renamed out of that pattern would
      // leave this suite passing and the panel one row short.
      const offered = (await getExtensionCapabilities('workspace-provider'))
        .map((/** @type {any} */ ref) => String(ref.path ?? ''));
      assert(offered.some(path => path.endsWith('project-folder-workspace-provider.js')),
        `juggler-core offers the provider to load, got ${JSON.stringify(offered)}`);
    });

    await run('a conversation already under way can be moved into a folder', async () => {
      // The move dialog's own path, minus the dialog. A third provider has to
      // work in it as well as in the setup panel, and it is the case that would
      // notice a provider that only ever expects to be provisioned into.
      const tag = uniqueTag();
      const folder = `pf-${tag}`;
      const marker = `moved-in-${tag}`;
      await ops.writeFile({ path: `${folder}/moved.txt`, content: marker });

      /** @type {any} */
      let outcome = null;
      const saved = session.workspaces;
      try {
        outcome = await provisionWorkspace({ session, providerId: PROVIDER_ID, values: { folder } });
        session.workspaces = [...saved, outcome.workspace];

        const conversation = await makeConversation(session, `moving-${tag}`);
        release(conversation);
        const before = await readIn(session, conversation, 'moved.txt');
        assert(before.exists === false,
          `it starts in the project, which cannot see that file, got ${JSON.stringify(before)}`);

        await rebindConversation(conversation, outcome.workspace.id);
        assert(conversation.workspaceId === outcome.workspace.id,
          `the binding moves, got ${JSON.stringify(conversation.workspaceId)}`);

        const after = await readIn(session, conversation, 'moved.txt');
        assert(after.exists !== false && String(after.content ?? '').includes(marker),
          `and its tools are in the folder from the next call onwards, got ${JSON.stringify(after)}`);
      } finally {
        session.workspaces = saved;
        if (outcome) await outcome.undo();
        await ops.shell({ command: `rm -rf ${folder}` }).catch(() => {});
      }
    });

    await run('a folder is seeded with the project\'s instructions as well as its own', async () => {
      // The folder's own AGENTS.md is the host's business — it probes the
      // workspace root without being told. What only this provider knows is that
      // the project above it is holding the instructions that say how anything
      // in here is built and tested, and that nothing inside the folder will
      // ever mention them.
      const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
      const ctx = { session };

      const inFolder = provider.instructionRoots(
        { root: `${projectPath}${separator}packages${separator}ui` }, ctx);
      assert(inFolder.length === 1 && inFolder[0] === projectPath,
        `a folder of the project is seeded from the project, got ${JSON.stringify(inFolder)}`);

      const atTheProject = provider.instructionRoots({ root: projectPath }, ctx);
      assert(atTheProject.length === 0,
        `while a row somehow rooted at the project names nowhere else, got ${JSON.stringify(atTheProject)}`);
    });
  } finally {
    if (session) {
      for (const id of created) {
        await releaseTestConversation(session, id, 'project-folder-test');
      }
    }
  }

  return { passed, failed, errors };
}
