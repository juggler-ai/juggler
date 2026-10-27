//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The scratch-copy sandbox provider, and the fact it is built on.
 *
 * A sandbox lives INSIDE the project, under `.juggler/sandboxes/<name>/`, which
 * is the one directory this app treats as its own everywhere it looks: the
 * gitignore matcher refuses `.juggler` at any depth whatever the project's own
 * ignore file says (`internal/gitignore/gitignore.go:81`), symbol search skips
 * it by name (`ops/search_ops.go:279`), the file watcher leaves it out, and
 * command spill is written into it. None of that was written with a workspace
 * living there in mind, and a place the app cannot see into is no place to work.
 *
 * So the first two cases ask both halves directly, against a real directory: a
 * conversation bound to a workspace down there reads, writes and searches inside
 * it — and the project it is buried in still cannot see any of it, which is what
 * keeps a sandbox out of everybody else's search results.
 * @module _tests/scratch-sandbox-test
 */

import {
  initializeRegistries,
  createTestSession,
  releaseTestConversation,
  waitForWorkerReady,
  withTimeout,
  assert
} from '../../../js-tests/utilities/test-helpers.js';
import { fetchJson } from '../../../js/services/http.js';
import { createBoundOps } from '../../../sdk/ops.js';
import {
  registerWorkspace,
  unregisterWorkspace,
  listWorkspaces
} from '../../../js/services/workspaces.js';
import {
  provisionWorkspace,
  workspaceStatus,
  finishWorkspace
} from '../../../js/services/workspace-provisioning.js';
import contextItemRegistry from '../../../js/registries/context-item-registry.js';
import {
  probeSetupAdoptions,
  setupRows,
  adoptSetupRow
} from '../../../js/services/workspace-places.js';
import { rebindConversation } from '../../../js/services/workspace-rebinding.js';
import workspaceProviderRegistry from '../../../js/registries/workspace-provider-registry.js';
import ScratchCopyWorkspaceProvider, { sandboxPlaces, slug } from '../workspaces/scratch-copy-workspace-provider.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';

/** juggler-core's English for what a scratch copy says, standing in for its catalogue. */
const CORE_TEXT = [
  'Name',
  'That leaves nothing that can be a directory name.',
  'Work in a copy of the project, not your own files. Files git ignores are not copied.',
  "Couldn't make a copy: the workspace it would be a copy of has no root.",
  "Couldn't make a copy: {name} leaves nothing that can be a directory name.",
  "Couldn't make a copy at {dir}: there is already something there.",
  'Copying the tree',
  'Taking a snapshot of it',
  'The copy is missing.',
  'There is no record of what this is a copy of.',
  '{count, plural, one {{count} file changed since the copy was made} other {{count} files changed since the copy was made}}',
  'Nothing changed since the copy was made',
  'Apply the changes',
  "{target, select, project {Copies what changed here back into the project, then removes the copy. Anything the project has changed since is refused by name, and nothing is applied. Conversations here go to the bin, which they can be restored from.} other {Copies what changed here back into {tree}, then removes the copy. Anything {tree} has changed since is refused by name, and nothing is applied. Conversations here go to the bin, which they can be restored from.}}",
  'Close the workspace, keep the copy',
  'The copy and everything in it stays on disk, ready to be adopted again. Conversations here go to the bin, which they can be restored from.',
  'Apply, overwriting',
  "{target, select, project {Copies the changes back even over files the project has changed since. What is in the project is lost. Conversations here go to the bin, which they can be restored from.} other {Copies the changes back even over files {tree} has changed since. What is in {tree} is lost. Conversations here go to the bin, which they can be restored from.}}",
  'Close the workspace and delete the copy',
  'Deletes the copy and everything done in it. Conversations here go to the bin, which they can be restored from.',
  "Can't finish with this copy: there's no record of what it was copied from.",
  "Closed the workspace. {dir} is still on disk.",
  '{name} has no action "{actionId}".',
  'Nothing has changed in the copy, so there is nothing to apply.',
  '{name} could not be applied: {files} {count, plural, one {has} other {have}} changed since the copy was taken. Nothing was applied.',
  '{name} could not be applied: {files} and {rest, plural, one {{rest} file} other {{rest} files}} more have changed since the copy was taken. Nothing was applied.',
  'Applied {count, plural, one {{count} file} other {{count} files}} and removed {dir}.',
  '{dir} is still there and could not be removed.',
  'Removed {dir}.',
  '{dir} is not there any more.',
  '{dir} — a copy with no conversation',
  'Nothing was checkpointed, so there is nothing to undo.'
];

/**
 * This suite's ops are bound to no workspace, so its shell commands run at the
 * project root: it makes `probe-src-…/` and `probe-copy-…/` directly in the
 * shared fixture root and removes them again. No sibling lane may be in flight
 * while it does.
 *
 * The per-case tag keeps those directories from colliding with each other, but
 * it cannot keep them out of the way of a lane that walks the *project* — and
 * one of this suite's own cases copies the whole tree, so it is both cause and
 * victim. Anything copying, listing or reporting on the project reads a
 * `probe-…` entry another case is in the middle of deleting, and fails carrying
 * a path it has never heard of.
 * @type {boolean}
 */
export const needsExclusiveRun = true;

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * A name nothing else in this run will choose.
 *
 * Lanes of a pool share one project, so every sandbox is stamped and removed by
 * the case that made it rather than trusted to a fixture reset.
 * @returns {string} A short unique tag.
 */
function uniqueTag() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * How long one command in this suite is waited for. Each writes or reads a
 * file or two; the figure is a bound for a report, not a cost anyone expects
 * to pay.
 * @type {number}
 */
const SHELL_WAIT_MS = 15000;

/**
 * Run a command and hand back what it said, whether or not it succeeded.
 *
 * For the commands whose failure is an answer — `test -e` of a copy that
 * should be gone — and for cleanup. The command is a named wait, so one that
 * never returns is reported by name rather than as a silent suite timeout.
 * @param {any} ops - Operations, project-pinned or bound to a sandbox.
 * @param {string} command - What to run.
 * @returns {Promise<any>} The result.
 */
function shell(ops, command) {
  return withTimeout(ops.shell({ command }), SHELL_WAIT_MS, `\`${command}\` to return`);
}

/**
 * Several steps as one command, each run only if the one before it worked.
 *
 * Every command is a process launch, and where commands go through WSL a launch
 * costs a large and unsteady share of a second. A fixture is therefore one
 * launch however many files it writes, which keeps the suite's cost a matter of
 * what it tests rather than of how many lines its setup was written in.
 * @param {...string} steps - The commands, in order.
 * @returns {string} One command running them all.
 */
function chain(...steps) {
  return steps.join(' && ');
}

/**
 * Run a command and insist it worked.
 * @param {any} ops - Operations, project-pinned or bound to a sandbox.
 * @param {string} command - What to run.
 * @returns {Promise<any>} The result, once it has succeeded.
 */
async function mustRun(ops, command) {
  const result = await shell(ops, command);
  if (!result.success) {
    throw new Error(`\`${command}\` failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result;
}

/**
 * Read a file through the real `read` tool, as a turn in this conversation would.
 *
 * The path is relative on purpose: which tree it lands in is the whole question,
 * and only a relative path asks it.
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
 * Put a tree of files where a sandbox would be, without provisioning one.
 *
 * The cases below are about the place rather than about how it came to be
 * there, and a fixture that does not run the provider cannot be passed by the
 * provider being wrong.
 * @param {any} ops - Project-pinned operations.
 * @param {any} places - From `sandboxPlaces`.
 * @param {string} greeting - The discriminator written into the copy.
 * @returns {Promise<void>} When the directory is there.
 */
async function buildSandboxDirectory(ops, places, greeting) {
  await mustRun(ops, chain(
    `mkdir -p ${places.workRel}/src`,
    `printf '${greeting}' > ${places.workRel}/greeting.txt`,
    `printf '${greeting}' > ${places.workRel}/src/deep.txt`
  ));
}

/**
 * What is under `.juggler/sandboxes` right now, as one string.
 *
 * Taken before a provision and after the undo of one, because "left nothing
 * behind" is a claim about that listing and about nothing else.
 * @param {any} ops - Project-pinned operations.
 * @returns {Promise<string>} The listing, or '' when there is no such directory.
 */
async function sandboxListing(ops) {
  const result = await shell(ops, 'ls -A .juggler/sandboxes 2>/dev/null || true');
  return String(result?.stdout ?? '').trim();
}

/** @type {string} The provider under test, as the registry knows it. */
const PROVIDER_ID = ScratchCopyWorkspaceProvider.MANIFEST.id;

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
  const registration = workspaceProviderRegistry.registerClass(ScratchCopyWorkspaceProvider, {
    extensionId: '@juggler/core',
    modulePath: '(test)'
  });
  return registration.registered ? '' : String(registration.reason);
}

/**
 * Put a value in a field the way a user does, so that everything listening to
 * the field hears about it. Assigning `value` on its own tells nobody, which is
 * also what lets the form set a field itself without being mistaken for the user
 * having typed in it.
 * @param {HTMLInputElement} input - The field.
 * @param {string} value - What to type into it.
 */
function typeInto(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Open the provider's setup form the way the panel opens it.
 *
 * The container is deliberately left out of the document: nothing here needs
 * layout or focus. What the panel does beyond this is listen for `input` on the
 * container and ask `getSetupValue()`, which is what each case does by hand.
 * @param {any} session - The test session.
 * @param {string} baseWorkspaceId - What the copy would be of; '' is the project.
 * @param {object} [values] - What the section last reported, for a form being rebuilt.
 * @returns {any} The provider, its container, and its one field.
 */
function openForm(session, baseWorkspaceId, values) {
  const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
  if (!provider) throw new Error('the provider is not registered, so it has no form to render');
  const container = document.createElement('div');
  provider.renderSetup(container, {
    session,
    ops: createBoundOps(() => ({ workspaceId: baseWorkspaceId })),
    baseOps: createBoundOps(() => ({ workspaceId: baseWorkspaceId })),
    baseWorkspaceId,
    values,
    signal: new AbortController().signal,
    rollback: { push: () => {} },
    checkpoint: async () => {},
    progress: () => {}
  });
  return {
    provider,
    container,
    name: container.querySelector('[data-field="name"]'),
    note: container.querySelector('[data-field-note="name"]')
  };
}

/**
 * Run the scratch-copy sandbox tests.
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
  const ops = createBoundOps(() => ({}));

  /** @type {any} */
  let session = null;
  /** @type {string[]} */
  const created = [];
  /** @param {any} conversation - The conversation to release at the end. */
  const release = (conversation) => { if (conversation) created.push(conversation.id); };

  await run('a name in any script survives as a directory name, and nothing unsafe does', () => {
    /** @type {Array<[string, string]>} */
    const cases = [
      ['日本語 メモ', '日本語-メモ'],
      ['हिन्दी', 'हिन्दी'],
      ['Ελληνικά 2', 'Ελληνικά-2'],
      ['cafe\u0301', 'café'],
      ['risky-idea', 'risky-idea'],
      ['a/b\\c:d*e?f', 'a-b-c-d-e-f'],
      ['..', ''],
      ['.hidden.', 'hidden'],
      ['a..b', 'a.b'],
      ['x.lock', 'x'],
      ['  ', ''],
    ];
    const wrong = cases
      .map(([name, want]) => ({ name, want, got: slug(name) }))
      .filter(({ want, got }) => want !== got);
    assert(wrong.length === 0, `slug() got these wrong: ${JSON.stringify(wrong)}`);
  });

  try {
    session = await createTestSession();

    await run('a conversation bound to a sandbox works inside it', async () => {
      const tag = uniqueTag();
      const places = sandboxPlaces(projectPath, `probe-${tag}`);
      const greeting = `hello-from-the-sandbox-${tag}`;
      const saved = session.workspaces;
      /** @type {any} */
      let made = null;
      /** @type {any} */
      let bound = null;
      try {
        await buildSandboxDirectory(ops, places, greeting);

        made = await registerWorkspace({
          kind: 'local',
          root: places.work,
          label: `probe-${tag} (sandbox)`,
          state: 'ready'
        });
        assert(made.available !== false,
          `the server found the copy where it was told it was, got ${JSON.stringify(made)}`);
        // The unit session's websocket is a mock, so the broadcast that would
        // carry this row never arrives; the table is set by hand instead.
        session.workspaces = [...saved, made];

        bound = await makeConversation(session, `works-in-the-sandbox-${tag}`, { workspaceId: made.id });
        release(bound);

        const read = await readIn(session, bound, 'greeting.txt');
        assert(read.exists !== false && String(read.content ?? '').includes(greeting),
          `the bound conversation read the copy's own file, got ${JSON.stringify(read)}`);

        const inside = createBoundOps(() => ({ workspaceId: made.id }));
        // The question this case exists for: everything down here has `.juggler`
        // in its path, and the matcher that decides what a search may see refuses
        // that name at any depth. It counts depth from the root it is given, so a
        // search rooted INSIDE the sandbox sees the files — but nothing had ever
        // asked it to be rooted there.
        const globbed = await inside.glob({ pattern: '**/*.txt' });
        assert((globbed?.files ?? []).includes('src/deep.txt'),
          `and its glob sees what is in there, got ${JSON.stringify(globbed?.files)}`);

        const searched = await inside.grep({ pattern: greeting });
        assert((searched?.matches ?? []).length === 2,
          `and its search finds both copies of the discriminator, got ${JSON.stringify(searched?.matches)}`);

        await mustRun(inside, `printf 'written-by-${tag}' > made-here.txt`);
        const landed = await shell(ops, `cat ${places.workRel}/made-here.txt`);
        assert(landed.success === true && landed.stdout.includes(`written-by-${tag}`),
          `and a command it runs writes into the copy rather than anywhere else, got ${JSON.stringify(landed.stdout || landed.stderr)}`);
      } finally {
        session.workspaces = saved;
        if (made) await unregisterWorkspace(made.id).catch(() => {});
        await shell(ops, `rm -rf ${places.rel}`).catch(() => {});
      }
    });

    await run('a copy carries what matters and knows what has happened to it since', async () => {
      // The primitive the provider is built on, through the facade a provider
      // reaches it by. The ignore rules come from the project's own .gitignore
      // and are applied by the server, so this holds on a machine with no git
      // installed — which is the difference between this and every `cp`-and-pipe
      // recipe that would otherwise have done the job.
      const tag = uniqueTag();
      const source = `probe-src-${tag}`;
      const copy = `probe-copy-${tag}`;
      try {
        await mustRun(ops, chain(
          `mkdir -p ${source}/src ${source}/build`,
          `printf 'build/\\n' > ${source}/.gitignore`,
          `printf 'package main\\n' > ${source}/main.go`,
          `printf 'package src\\n' > ${source}/src/util.go`,
          `printf 'binary\\n' > ${source}/build/artifact.bin`
        ));

        const copied = await ops.copyTree({ from: source, to: copy });
        assert(copied?.copied === 3,
          `three files were worth copying, got ${JSON.stringify(copied)}`);
        const landed = await mustRun(ops, `ls ${copy} ${copy}/src`);
        assert(landed.stdout.includes('main.go') && landed.stdout.includes('util.go'),
          `the source came across, got ${JSON.stringify(landed.stdout)}`);
        const ignored = await shell(ops, `test -e ${copy}/build`);
        assert(ignored.success === false,
          'and the gitignored build output did not');

        const fresh = await ops.compareTrees({ left: source, right: copy });
        const differences = [...(fresh?.changed ?? []), ...(fresh?.added ?? []), ...(fresh?.removed ?? [])];
        assert(differences.length === 0,
          `a copy just taken differs from its source in nothing, got ${JSON.stringify(fresh)}`);

        await mustRun(ops, chain(
          `printf 'package main // edited\\n' > ${copy}/main.go`,
          `rm ${copy}/src/util.go`,
          // A build in the copy makes its own output directory, since the copy
          // quite rightly did not bring one.
          `mkdir -p ${copy}/build`,
          `printf 'noise\\n' > ${copy}/build/ignored-here.txt`
        ));
        const after = await ops.compareTrees({ left: source, right: copy });
        assert((after?.changed ?? []).join() === 'main.go',
          `an edited file reads as changed, got ${JSON.stringify(after?.changed)}`);
        assert((after?.removed ?? []).join() === 'src/util.go',
          `a deleted one as removed, got ${JSON.stringify(after?.removed)}`);
        assert((after?.added ?? []).length === 0,
          `and work done under an ignored path is not work at all, got ${JSON.stringify(after?.added)}`);
      } finally {
        await shell(ops, `rm -rf ${source} ${copy}`).catch(() => {});
      }
    });

    await run('what is in a sandbox stays out of the project it is buried in', async () => {
      const tag = uniqueTag();
      const places = sandboxPlaces(projectPath, `probe-${tag}`);
      const greeting = `hello-from-the-sandbox-${tag}`;
      /** @type {any} */
      let outside = null;
      try {
        // The same discriminator in both places, so the assertions below are
        // about where a search looked rather than about what it was looking for:
        // a project search that quietly descended into the sandbox would find
        // three of these, and one is the answer that means it did not.
        await buildSandboxDirectory(ops, places, greeting);
        await mustRun(ops, `printf '${greeting}' > in-the-project-${tag}.txt`);

        const globbed = await ops.glob({ pattern: '**/*.txt' });
        const files = globbed?.files ?? [];
        assert(files.includes(`in-the-project-${tag}.txt`),
          `the project's glob sees the project's own file, got ${JSON.stringify(files.slice(0, 20))}`);
        assert(!files.some((/** @type {string} */ file) => file.includes('.juggler')),
          `and none of the copy's, got ${JSON.stringify(files.filter((/** @type {string} */ f) => f.includes('.juggler')))}`);

        const searched = await ops.grep({ pattern: greeting });
        const matched = searched?.matches ?? [];
        assert(matched.length === 1,
          `and the project's search finds it once, in the project, got ${JSON.stringify(matched)}`);

        outside = await makeConversation(session, `works-in-the-project-${tag}`);
        release(outside);
        const read = await readIn(session, outside, 'greeting.txt');
        assert(read.exists === false,
          `while a project conversation has no greeting.txt at all, which is what makes the case above mean anything, got ${JSON.stringify(read)}`);
      } finally {
        await shell(ops, `rm -rf ${places.rel} in-the-project-${tag}.txt`).catch(() => {});
      }
    });
    await run('the provider registers, and names itself for the setup panel', async () => {
      const refusal = registerProvider();
      assert(refusal === '', `the registry refused the provider: ${refusal}`);
      assert(registerProvider() === '',
        'and asking a second time, as the next run of this suite in this lane does, finds it there');

      const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
      assert(provider !== undefined, 'the provider is not in the registry under its own id');
      assert(provider?.getSetupLabel() === 'New scratch copy',
        `and the panel's row would say ${JSON.stringify(provider?.getSetupLabel())}`);
    });

    await run('a provision makes a copy of the tree, and a snapshot of the copy', async () => {
      const tag = uniqueTag();
      const name = `try-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      /** @type {any} */
      let outcome = null;
      try {
        await mustRun(ops, `printf 'before-${tag}' > probe-${tag}.txt`);

        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { name },
          baseWorkspaceId: ''
        });

        assert(outcome?.workspace?.state === 'ready' && outcome.workspace.root === places.work,
          `the row is ready and rooted at the copy, got ${JSON.stringify(outcome?.workspace)}`);
        const carried = await shell(ops, `cat ${places.workRel}/probe-${tag}.txt`);
        assert(carried.success === true && carried.stdout.includes(`before-${tag}`),
          `the project's file came across, got ${JSON.stringify(carried.stdout || carried.stderr)}`);
        const snapshot = await shell(ops, `cat ${places.pristineRel}/probe-${tag}.txt`);
        assert(snapshot.success === true && snapshot.stdout.includes(`before-${tag}`),
          `and so did the snapshot beside it, got ${JSON.stringify(snapshot.stdout || snapshot.stderr)}`);
        // The copy is not a clone: a sandbox has no repository of its own, which
        // is what "no git required" means from the inside.
        const repo = await shell(ops, `test -e ${places.workRel}/.git`);
        assert(repo.success === false, 'and no .git went with it');
        const marker = await shell(ops, 'cat .juggler/sandboxes/.gitignore');
        assert(marker.success === true && marker.stdout.includes('*'),
          `the copies ignore themselves, for a project whose own .gitignore says nothing about .juggler, got ${JSON.stringify(marker.stdout)}`);
      } finally {
        if (outcome?.workspace?.id) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `rm -rf ${places.rel} probe-${tag}.txt`).catch(() => {});
      }
    });

    await run('undoing a provision leaves nothing of it behind', async () => {
      const tag = uniqueTag();
      const name = `undone-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      /** @type {any} */
      let outcome = null;
      try {
        const before = await sandboxListing(ops);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { name },
          baseWorkspaceId: ''
        });
        const during = await sandboxListing(ops);
        assert(during.includes(name),
          `the copy was there to begin with, got ${JSON.stringify(during)}`);

        await outcome.undo();
        outcome = null;

        const after = await sandboxListing(ops);
        assert(!after.includes(name),
          `and the undo took it away, got ${JSON.stringify(after)}`);
        // The marker is the one thing an undo may leave, because it describes
        // the directory the copies live in rather than any one of them.
        assert(after.replace('.gitignore', '').trim() === before.replace('.gitignore', '').trim(),
          `leaving the listing as it found it, got ${JSON.stringify(after)} against ${JSON.stringify(before)}`);
        const rows = await listWorkspaces();
        assert(!rows.some((/** @type {any} */ row) => row.root === places.work),
          'and no row describing a copy that is not there');
      } finally {
        if (outcome?.workspace?.id) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `rm -rf ${places.rel}`).catch(() => {});
      }
    });

    await run('cancelling part-way through leaves nothing behind either', async () => {
      const tag = uniqueTag();
      const name = `cancelled-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      const controller = new AbortController();
      /** @type {any} */
      let outcome = null;
      /** @type {string[]} */
      const steps = [];
      try {
        // Cancelled from the progress line, which is the one moment in a
        // provision this suite can name exactly: a step announces itself BEFORE
        // it starts, so the abort lands after the checkpoint and the
        // compensation are recorded and before the copy they cover. Waiting for
        // the directory to appear instead was tried and is not a test — a copy
        // of a fixture project finishes inside one poll, and the case passed
        // only by cancelling something that had already succeeded.
        const pending = provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { name },
          baseWorkspaceId: '',
          signal: controller.signal,
          onProgress: (/** @type {string} */ step) => {
            steps.push(step);
            if (steps.length === 1) controller.abort();
          }
        }).then(result => { outcome = result; return result; });

        let refused = false;
        try {
          await pending;
        } catch {
          refused = true;
        }
        assert(refused, 'a cancelled provision rejects rather than quietly finishing');
        assert(steps[0] === 'Copying the tree',
          `having got as far as the copy it announced, got ${JSON.stringify(steps)}`);

        const after = await sandboxListing(ops);
        assert(!after.includes(name),
          `and what it had made is gone, got ${JSON.stringify(after)}`);
        const rows = await listWorkspaces();
        assert(!rows.some((/** @type {any} */ row) => String(row.root ?? '').includes(name)),
          'along with the row it registered before it began');
      } finally {
        if (outcome?.workspace?.id) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `rm -rf ${places.rel}`).catch(() => {});
      }
    });

    await run('a name already in use is refused, and what is there survives', async () => {
      // The guard phase 4 learned the hard way: without it the provision still
      // fails, but fails after registering a compensation that then removes
      // somebody else's directory on the way out.
      const tag = uniqueTag();
      const name = `occupied-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      try {
        await mustRun(ops, chain(`mkdir -p ${places.rel}`, `printf 'precious-${tag}' > ${places.rel}/precious.txt`));

        let refusal = '';
        try {
          await provisionWorkspace({
            session,
            providerId: PROVIDER_ID,
            values: { name },
            baseWorkspaceId: ''
          });
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error);
        }
        assert(refusal.includes(places.dir),
          `the refusal says where, got ${JSON.stringify(refusal)}`);

        const survived = await shell(ops, `cat ${places.rel}/precious.txt`);
        assert(survived.success === true && survived.stdout.includes(`precious-${tag}`),
          `and what was already there is untouched, got ${JSON.stringify(survived.stdout || survived.stderr)}`);
      } finally {
        await shell(ops, `rm -rf ${places.rel}`).catch(() => {});
      }
    });

    await run('a copy reports what has happened to it since it was taken', async () => {
      const tag = uniqueTag();
      const name = `watched-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      /** @type {any} */
      let outcome = null;
      try {
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { name },
          baseWorkspaceId: ''
        });

        const fresh = await workspaceStatus(session, outcome.workspace);
        // Both readings name what they are measured against. A bare count is a
        // number whose question the reader has to guess at, and every guess —
        // against the project, against the last turn — is an answer it is not
        // giving.
        assert(fresh?.dirty === false && fresh?.detail === 'Nothing changed since the copy was made',
          `a copy taken a moment ago holds no work of its own, got ${JSON.stringify(fresh)}`);
        assert(outcome.workspace.label === name,
          `and is known by the name it was given, got ${JSON.stringify(outcome.workspace.label)}`);
        // Named by its row alone. A copy whose status also named it renamed
        // itself when the walk of the two trees came back, seconds after a
        // reader had already been shown the first name.
        assert(fresh?.label === undefined,
          `which the status does not restate, got ${JSON.stringify(fresh)}`);

        // Edited the way the conversation bound to it would: through operations
        // pinned to the copy, with a relative path.
        const inside = createBoundOps(() => ({ workspaceId: outcome.workspace.id }));
        await mustRun(inside, `printf 'risky idea ${tag}' > idea.txt`);

        const changed = await workspaceStatus(session, outcome.workspace);
        assert(changed?.dirty === true && changed?.detail === '1 file changed since the copy was made',
          `and one file added to it reads as one file changed, got ${JSON.stringify(changed)}`);
        assert(changed?.badge === 'changed',
          `with a word for it in the chip, got ${JSON.stringify(changed?.badge)}`);
      } finally {
        if (outcome?.workspace?.id) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `rm -rf ${places.rel}`).catch(() => {});
      }
    });

    await run('a copy lists the work it holds, for a move that would carry it', async () => {
      // The case the hook exists for. Git has never heard of a copy under
      // `.juggler/sandboxes` — no repository, nothing committed — so an
      // afternoon's work in one reads as clean to the only other thing here that
      // can enumerate a tree, and a conversation moving out of it used to be
      // told its work stayed behind and offered nothing.
      const tag = uniqueTag();
      const name = `held-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
      /**
       * The context the host gives this hook: pinned to the copy, with the base
       * workspace's operations beside it, because the snapshot is a sibling of
       * the copy and outside what the copy's own operations may reach.
       * @param {any} workspace - The row being asked about.
       * @returns {any} The hook's context.
       */
      const contextFor = (workspace) => ({
        session,
        ops: createBoundOps(() => ({ workspaceId: workspace.id })),
        baseOps: ops,
        baseWorkspaceId: '',
        signal: new AbortController().signal,
        rollback: { push: () => {} },
        checkpoint: async () => {},
        progress: () => {}
      });

      /** @type {any} */
      let outcome = null;
      try {
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { name },
          baseWorkspaceId: ''
        });

        const fresh = await provider?.heldWork(outcome.workspace, contextFor(outcome.workspace));
        assert(fresh?.complete === true && fresh.paths.length === 0 && fresh.removed.length === 0,
          `a copy taken a moment ago holds nothing, and accounts for all of it, got ${JSON.stringify(fresh)}`);

        // One file added in the copy, and one taken away. The second is written
        // into the SNAPSHOT rather than deleted from the copy, which is the same
        // fact from the other side and needs no file of the project's: the
        // snapshot is the record of what was there when the copy was taken, and
        // something in it that the copy lacks is something the copy removed.
        const inside = createBoundOps(() => ({ workspaceId: outcome.workspace.id }));
        await mustRun(inside, `printf 'risky idea ${tag}' > idea.txt`);
        await mustRun(ops, `printf 'here when the copy was taken' > ${places.pristineRel}/gone.txt`);

        const held = await provider?.heldWork(outcome.workspace, contextFor(outcome.workspace));
        assert(held?.complete === true && held.paths.includes('idea.txt'),
          `a file written in the copy is work the copy holds, got ${JSON.stringify(held)}`);
        assert(held?.removed.includes('gone.txt'),
          `and a file the copy no longer has is work too, got ${JSON.stringify(held)}`);
        assert(held.paths.every((/** @type {string} */ path) => !path.startsWith('/')),
          `named relative to the copy, which is how an operation takes them, got ${JSON.stringify(held.paths)}`);

        // The panel's count and the carry's list are one comparison asked twice,
        // and a sandbox whose chip said two files while the move copied one
        // would be the kind of disagreement nobody looks for.
        const status = await workspaceStatus(session, outcome.workspace);
        assert(status?.detail === '2 files changed since the copy was made',
          `the count on screen is that same list, counted, got ${JSON.stringify(status?.detail)}`);
      } finally {
        if (outcome?.workspace?.id) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `rm -rf ${places.rel}`).catch(() => {});
      }
    });

    await run('a copy with nothing to compare against holds work it cannot list', async () => {
      // The distinction the host is required to keep: this says "I cannot say
      // what is in here", and it must never be read as "there is nothing in
      // here". The first refuses a carry; the second copies an empty list over
      // somebody's tree and reports that it brought everything.
      const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
      const context = {
        session,
        ops,
        baseOps: ops,
        baseWorkspaceId: '',
        signal: new AbortController().signal,
        rollback: { push: () => {} },
        checkpoint: async () => {},
        progress: () => {}
      };

      const unrecorded = await provider?.heldWork(
        { id: 'ws_nameless', root: '/nowhere/work', label: 'nameless', available: true, meta: {} }, context);
      assert(unrecorded?.complete === false && unrecorded.paths.length === 0,
        `a row with no record of what it is a copy of cannot account for itself, got ${JSON.stringify(unrecorded)}`);

      const missing = await provider?.heldWork(
        { id: 'ws_gone', root: '/nowhere/work', label: 'gone', available: false, meta: { name: 'gone', baseDir: projectPath } },
        context);
      assert(missing?.complete === false,
        `nor can one whose copy is not there to be compared, got ${JSON.stringify(missing)}`);
    });

    await run('a copy that is not there any more says so rather than guessing', async () => {
      const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
      const status = await provider?.status(
        { id: 'ws_gone', root: '/nowhere/work', label: 'gone', available: false, meta: { name: 'gone' } },
        {
          session,
          ops,
          baseOps: ops,
          baseWorkspaceId: '',
          signal: new AbortController().signal,
          rollback: { push: () => {} },
          checkpoint: async () => {},
          progress: () => {}
        });
      assert(status?.available === false && String(status?.detail ?? '').includes('missing'),
        `an unavailable row is reported, not compared, got ${JSON.stringify(status)}`);
    });

    await run('the form asks for a name and says where the copy will go', async () => {
      const tag = uniqueTag();
      const form = openForm(session, '');
      assert(form.name, 'the form has a field to name the copy');

      typeInto(form.name, `an idea ${tag}`);
      const value = form.provider.getSetupValue();
      const places = sandboxPlaces(projectPath, `an idea ${tag}`);
      assert(value?.valid === true && value.values.name === `an idea ${tag}`,
        `a name makes it submittable, got ${JSON.stringify(value)}`);
      assert(value?.values?.location === places.work,
        `and the location it reports is where a copy of the project goes, got ${JSON.stringify(value?.values?.location)}`);
      assert(form.note?.querySelector('.setup-field-note-path')?.textContent === places.work,
        `which the form shows rather than deciding quietly, got ${JSON.stringify(form.note?.textContent)}`);

      // Where the copy goes is half of it. The reader meeting a scratch copy
      // here is told what one is — their files copied, and the copy worked in —
      // because a path alone answers a question they have not asked yet.
      assert(String(form.note?.textContent ?? '').includes('copy of the project'),
        `and says what a copy is for somebody meeting one, got ${JSON.stringify(form.note?.textContent)}`);
      assert(!form.note?.classList.contains('setup-field-note-error'),
        'and is not painted as an error, being a fact about what will happen rather than something to fix');

      // A name is a directory name here, so what the filesystem will not take,
      // this will not take either — and it says which field to go back to,
      // which is what the panel's refused send focuses.
      typeInto(form.name, '///');
      const refused = form.provider.getSetupValue();
      assert(refused?.valid === false && refused.invalidFieldId === form.name.id,
        `a name with nothing usable in it is refused by its own field, got ${JSON.stringify(refused)}`);
      assert(form.note?.classList.contains('setup-field-note-error'),
        `while the line about a name nobody can use is, got ${JSON.stringify(form.note?.className)}`);
    });

    await run('a form put back after a cancel comes back filled in', async () => {
      // 3e promises that cancelling returns the form with what was typed still
      // in it, and the panel rebuilds the form whenever its shape moves — so the
      // promise is only kept by a provider that fills its fields back in.
      const restored = openForm(session, '', { name: 'second-thoughts' });
      assert(restored.name?.value === 'second-thoughts',
        `the name is where it was left, got ${JSON.stringify(restored.name?.value)}`);
      assert(restored.provider.getSetupValue()?.valid === true,
        'and the form is submittable without anyone retyping it');
    });

    await run('the panel builds a copy and binds the conversation to it', async () => {
      const tag = uniqueTag();
      const name = `panel-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      /** @type {any} */
      let conversation = null;
      try {
        await mustRun(ops, `printf 'from-the-project-${tag}' > probe-${tag}.txt`);

        const form = openForm(session, '');
        typeInto(form.name, name);
        const value = form.provider.getSetupValue();

        conversation = await makeConversation(session, `panel-to-copy-${tag}`);
        release(conversation);

        // Built with no conversation in the question, then moved into.
        const built = await provisionWorkspace({
          session, providerId: PROVIDER_ID, values: value.values
        });
        session.workspaces = [...(session.workspaces ?? []), built.workspace];
        assert(built.workspace.state === 'ready',
          `Create made the copy, got ${JSON.stringify(built.workspace.state)}`);

        await rebindConversation(conversation, built.workspace.id);
        assert(conversation.workspaceId === built.workspace.id,
          `and the conversation works in it, got ${JSON.stringify(conversation.workspaceId)}`);

        const row = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === conversation.workspaceId);
        assert(row?.root === places.work,
          `the copy is where the form said it would be, got ${JSON.stringify(row?.root)}`);
        const read = await readIn(session, conversation, `probe-${tag}.txt`);
        assert(read.exists !== false && String(read.content ?? '').includes(`from-the-project-${tag}`),
          `and the conversation's own tools read the copy, got ${JSON.stringify(read)}`);
      } finally {
        if (conversation?.workspaceId) await unregisterWorkspace(conversation.workspaceId).catch(() => {});
        await shell(ops, `rm -rf ${places.rel} probe-${tag}.txt`).catch(() => {});
      }
    });

    await run('applying carries the change back and takes the copy with it', async () => {
      const tag = uniqueTag();
      const name = `applied-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      /** @type {any} */
      let outcome = null;
      try {
        await mustRun(ops, chain(
          `printf 'original-${tag}' > probe-${tag}.txt`,
          `printf 'untouched-${tag}' > elsewhere-${tag}.txt`
        ));

        outcome = await provisionWorkspace({
          session, providerId: PROVIDER_ID, values: { name }, baseWorkspaceId: ''
        });
        const inside = createBoundOps(() => ({ workspaceId: outcome.workspace.id }));
        await mustRun(inside, chain(`printf 'risky-${tag}' > probe-${tag}.txt`, `printf 'new-${tag}' > invented-${tag}.txt`));

        // The project moves on under the copy, somewhere the copy never went.
        // Applying must not be refused over a file nobody is arguing about.
        await mustRun(ops, `printf 'moved-on-${tag}' > elsewhere-${tag}.txt`);

        const result = await finishWorkspace({
          session, workspace: outcome.workspace, actionId: 'apply'
        });
        assert(result?.done === true,
          `the apply went through, got ${JSON.stringify(result)}`);

        const edited = await mustRun(ops, `cat probe-${tag}.txt`);
        assert(edited.stdout.includes(`risky-${tag}`),
          `the project has what the copy did to it, got ${JSON.stringify(edited.stdout)}`);
        const invented = await mustRun(ops, `cat invented-${tag}.txt`);
        assert(invented.stdout.includes(`new-${tag}`),
          `including the file the copy invented, got ${JSON.stringify(invented.stdout)}`);
        const untouched = await mustRun(ops, `cat elsewhere-${tag}.txt`);
        assert(untouched.stdout.includes(`moved-on-${tag}`),
          `and what the project did meanwhile is still there, got ${JSON.stringify(untouched.stdout)}`);

        const left = await shell(ops, `test -e ${places.rel}`);
        assert(left.success === false, 'and the copy is gone, having nothing left to hold');
        assert(result?.workspace?.state === 'closed',
          `with the row closed behind it, got ${JSON.stringify(result?.workspace?.state)}`);
      } finally {
        if (outcome?.workspace?.id) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `rm -rf ${places.rel} probe-${tag}.txt elsewhere-${tag}.txt invented-${tag}.txt`).catch(() => {});
      }
    });

    await run('an edit the clock cannot see is carried back too', async () => {
      // Same length, same modification time — what a formatter that puts
      // timestamps back leaves behind, and what a comparison trusting size and
      // time reads as unchanged. An apply deletes the copy when it is done, so
      // a file left out of it is not left behind anywhere: it is destroyed, and
      // the sentence on screen says the apply worked.
      const tag = uniqueTag();
      const name = `timeless-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      /** @type {any} */
      let outcome = null;
      try {
        await mustRun(ops, `printf 'aaaa' > probe-${tag}.txt`);

        outcome = await provisionWorkspace({
          session, providerId: PROVIDER_ID, values: { name }, baseWorkspaceId: ''
        });
        const inside = createBoundOps(() => ({ workspaceId: outcome.workspace.id }));
        await mustRun(inside, `printf 'bbbb' > probe-${tag}.txt`);
        // The snapshot's own timestamp, put back on the file that was edited.
        await mustRun(ops,
          `touch -r ${places.pristineRel}/probe-${tag}.txt ${places.workRel}/probe-${tag}.txt`);

        const result = await finishWorkspace({
          session, workspace: outcome.workspace, actionId: 'apply'
        });
        assert(result?.done === true,
          `the apply found the change and went through, got ${JSON.stringify(result)}`);
        const applied = await mustRun(ops, `cat probe-${tag}.txt`);
        assert(applied.stdout.includes('bbbb'),
          `and the edit is in the project rather than in the bin with the copy, got ${JSON.stringify(applied.stdout)}`);
      } finally {
        if (outcome?.workspace?.id) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `rm -rf ${places.rel} probe-${tag}.txt`).catch(() => {});
      }
    });

    await run('a file the project has changed since refuses the whole apply', async () => {
      // The phase's real question, answered once here: applying is whole files
      // or nothing. A half-applied change is the outcome that costs more than it
      // saves, and a patch forced over a file somebody else edited is the same
      // thing with the evidence destroyed.
      const tag = uniqueTag();
      const name = `contested-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      /** @type {any} */
      let outcome = null;
      try {
        await mustRun(ops, `printf 'original-${tag}' > probe-${tag}.txt`);
        outcome = await provisionWorkspace({
          session, providerId: PROVIDER_ID, values: { name }, baseWorkspaceId: ''
        });
        const inside = createBoundOps(() => ({ workspaceId: outcome.workspace.id }));
        await mustRun(inside, chain(`printf 'risky-${tag}' > probe-${tag}.txt`, `printf 'new-${tag}' > invented-${tag}.txt`));
        await mustRun(ops, `printf 'someone-else-${tag}' > probe-${tag}.txt`);

        const refused = await finishWorkspace({
          session, workspace: outcome.workspace, actionId: 'apply'
        });
        assert(refused?.done === false && String(refused?.message ?? '').includes(`probe-${tag}.txt`),
          `the refusal names the file, got ${JSON.stringify(refused)}`);

        const project = await mustRun(ops, `cat probe-${tag}.txt`);
        assert(project.stdout.includes(`someone-else-${tag}`),
          `the project's own version survives, got ${JSON.stringify(project.stdout)}`);
        const invented = await shell(ops, `test -e invented-${tag}.txt`);
        assert(invented.success === false,
          'and nothing else was applied either, which is what all-or-nothing means');
        const copy = await shell(ops, `test -e ${places.workRel}`);
        assert(copy.success === true, 'while the copy is still there to work it out in');

        // The same ending, chosen deliberately: it says what it will do and it
        // does exactly that.
        const forced = await finishWorkspace({
          session, workspace: outcome.workspace, actionId: 'apply-anyway'
        });
        assert(forced?.done === true,
          `overwriting is an ending of its own, got ${JSON.stringify(forced)}`);
        const overwritten = await mustRun(ops, `cat probe-${tag}.txt`);
        assert(overwritten.stdout.includes(`risky-${tag}`),
          `and it overwrites, got ${JSON.stringify(overwritten.stdout)}`);
      } finally {
        if (outcome?.workspace?.id) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `rm -rf ${places.rel} probe-${tag}.txt invented-${tag}.txt`).catch(() => {});
      }
    });

    await run('a change the project has already made for itself is not a conflict', async () => {
      // Two people arriving at the same line is not a disagreement. Refusing
      // here would teach the user that the refusal means nothing.
      const tag = uniqueTag();
      const name = `agreed-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      /** @type {any} */
      let outcome = null;
      try {
        await mustRun(ops, `printf 'original-${tag}' > probe-${tag}.txt`);
        outcome = await provisionWorkspace({
          session, providerId: PROVIDER_ID, values: { name }, baseWorkspaceId: ''
        });
        const inside = createBoundOps(() => ({ workspaceId: outcome.workspace.id }));
        await mustRun(inside, `printf 'agreed-${tag}' > probe-${tag}.txt`);
        await mustRun(ops, `printf 'agreed-${tag}' > probe-${tag}.txt`);

        const result = await finishWorkspace({
          session, workspace: outcome.workspace, actionId: 'apply'
        });
        assert(result?.done === true,
          `applying a change the project already holds is not refused, got ${JSON.stringify(result)}`);
      } finally {
        if (outcome?.workspace?.id) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `rm -rf ${places.rel} probe-${tag}.txt`).catch(() => {});
      }
    });

    await run('the copy can be kept, or deleted, without anything being applied', async () => {
      const tag = uniqueTag();
      const kept = `kept-${tag}`;
      const deleted = `deleted-${tag}`;
      const keptPlaces = sandboxPlaces(projectPath, kept);
      const deletedPlaces = sandboxPlaces(projectPath, deleted);
      /** @type {any} */
      let keptRow = null;
      /** @type {any} */
      let deletedRow = null;
      try {
        keptRow = await provisionWorkspace({
          session, providerId: PROVIDER_ID, values: { name: kept }, baseWorkspaceId: ''
        });
        const keeping = await finishWorkspace({
          session, workspace: keptRow.workspace, actionId: 'keep'
        });
        assert(keeping?.done === true,
          `leaving it where it is finishes with it, got ${JSON.stringify(keeping)}`);
        const still = await shell(ops, `test -e ${keptPlaces.workRel}`);
        assert(still.success === true, 'and the files stay where they are');

        deletedRow = await provisionWorkspace({
          session, providerId: PROVIDER_ID, values: { name: deleted }, baseWorkspaceId: ''
        });
        const deleting = await finishWorkspace({
          session, workspace: deletedRow.workspace, actionId: 'discard'
        });
        assert(deleting?.done === true,
          `deleting it finishes with it too, got ${JSON.stringify(deleting)}`);
        const gone = await shell(ops, `test -e ${deletedPlaces.rel}`);
        assert(gone.success === false, 'and takes the copy with it');
      } finally {
        if (keptRow?.workspace?.id) await unregisterWorkspace(keptRow.workspace.id).catch(() => {});
        if (deletedRow?.workspace?.id) await unregisterWorkspace(deletedRow.workspace.id).catch(() => {});
        await shell(ops, `rm -rf ${keptPlaces.rel} ${deletedPlaces.rel}`).catch(() => {});
      }
    });

    await run('a copy with no row is offered, and a row with no copy is reported', async () => {
      const tag = uniqueTag();
      const stray = `stray-${tag}`;
      const vanished = `vanished-${tag}`;
      const strayPlaces = sandboxPlaces(projectPath, stray);
      const vanishedPlaces = sandboxPlaces(projectPath, vanished);
      try {
        await mustRun(ops, `mkdir -p ${strayPlaces.workRel} ${strayPlaces.pristineRel}`);

        const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
        const row = {
          id: 'ws_vanished',
          root: vanishedPlaces.work,
          label: vanished,
          providerId: PROVIDER_ID,
          state: 'ready',
          meta: { name: vanished, baseDir: projectPath, dir: vanishedPlaces.dir }
        };
        const report = await provider?.reconcile([row], {
          session,
          ops,
          baseWorkspaceId: '',
          signal: new AbortController().signal,
          rollback: { push: () => {} },
          checkpoint: async () => {},
          progress: () => {}
        });

        const orphaned = (report?.orphanedWorkspaces ?? [])
          .find((/** @type {any} */ entry) => entry.id === 'ws_vanished');
        assert(orphaned,
          `a row whose copy has gone is reported, got ${JSON.stringify(report?.orphanedWorkspaces)}`);
        assert(orphaned?.tombstone !== true,
          'and is reported rather than closed: a copy that is missing is missing, not pretending to be something else');

        const offered = (report?.orphanedArtifacts ?? [])
          .find((/** @type {any} */ entry) => entry.label === stray);
        assert(offered?.workspace?.root === strayPlaces.work,
          `while a copy nobody has a row for is offered, got ${JSON.stringify(report?.orphanedArtifacts)}`);

        // And the panel turns that offer into a row on one click, because
        // adopting builds nothing — the copy is already sitting there.
        await probeSetupAdoptions(session);
        const adoptRow = setupRows(session)
          .find((/** @type {any} */ entry) => entry.kind === 'adopt' && entry.label?.includes(stray));
        assert(adoptRow, 'the panel lists it in the band between what exists and what could be made');

        const adopted = await adoptSetupRow(session, adoptRow.id);
        try {
          assert(adopted?.state === 'ready' && adopted?.root === strayPlaces.work,
            `adopting registers it where it already is, got ${JSON.stringify(adopted)}`);
          const status = await workspaceStatus(session, adopted);
          assert(status?.dirty === false,
            `and it can be asked about itself straight away, got ${JSON.stringify(status)}`);
        } finally {
          if (adopted?.id) await unregisterWorkspace(adopted.id).catch(() => {});
          session.workspaces = (session.workspaces ?? [])
            .filter((/** @type {any} */ entry) => entry.id !== adopted?.id);
        }
      } finally {
        await shell(ops, `rm -rf ${strayPlaces.rel}`).catch(() => {});
      }
    });

    await run('a provision that died with its tab is undone from its checkpoint alone', async () => {
      // The restart path: no closure outlived the tab, so `meta` is the whole of
      // what there is to work from — and it describes a step that may never have
      // landed, because a checkpoint is written before the thing it describes.
      const tag = uniqueTag();
      const name = `orphan-${tag}`;
      const places = sandboxPlaces(projectPath, name);
      /** @type {any} */
      let row = null;
      try {
        await mustRun(ops, chain(`mkdir -p ${places.workRel}`, `printf 'half-copied' > ${places.workRel}/partial.txt`));
        row = await registerWorkspace({
          kind: 'local',
          root: places.work,
          label: name,
          providerId: PROVIDER_ID,
          state: 'provisioning',
          meta: { name, baseDir: projectPath, dir: places.dir }
        });

        const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
        const outcome = await provider?.cleanupPartial(row, {
          session,
          ops,
          baseOps: ops,
          baseWorkspaceId: '',
          signal: new AbortController().signal,
          rollback: { push: () => {} },
          checkpoint: async () => {},
          progress: () => {}
        });
        assert(outcome?.removed === true,
          `the cleanup says it removed it, got ${JSON.stringify(outcome)}`);
        const left = await shell(ops, `test -e ${places.rel}`);
        assert(left.success === false, 'and the half-made copy is really gone');
      } finally {
        if (row) await unregisterWorkspace(row.id).catch(() => {});
        await shell(ops, `rm -rf ${places.rel}`).catch(() => {});
      }
    });

    await run('everything a scratch copy says to the user is translated under en-XA', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      // Every path the provider names is under `.juggler/sandboxes`, whose
      // letters are data: each place is mapped to a digit before the check.
      const places = sandboxPlaces('/1', '2');
      const manifestName = String(ScratchCopyWorkspaceProvider.MANIFEST.name);
      /**
       * A shown line with its data mapped to digits.
       * @param {any} text - What was shown.
       * @returns {string} The line, ready for the check.
       */
      const scrub = (text) => String(text)
        .split(places.work).join('3')
        .split(places.pristine).join('3')
        .split(places.dir).join('3')
        .split(manifestName).join('3');

      await underPseudoLocale('scratch-sandbox-test', async () => {
        // Hooks called directly, every operation stubbed: nothing is registered
        // and nothing on disk is made, looked at or removed.
        const provider = new ScratchCopyWorkspaceProvider({});
        /** @type {any} The private hooks, which a test may reach. */
        const hooks = provider;
        /** @type {any} */
        let found = { exists: false };
        /** @type {any[]} What each `compareTrees` call answers, in turn; the last repeats. */
        let compared = [{}];
        let calls = 0;
        /** @type {string[]} */
        const steps = [];
        const ops = {
          stat: async () => found,
          writeFile: async () => ({}),
          copyTree: async () => ({}),
          compareTrees: async () => compared[Math.min(calls++, compared.length - 1)],
          expandDirectory: async () => ({ items: [{ isDir: true, name: '2' }] })
        };
        /**
         * Answer the next comparisons with these.
         * @param {any[]} answers - In call order.
         */
        const compare = (answers) => { compared = answers; calls = 0; };
        const session = { projectPath: '/1', workspaceRoot: () => '/1' };
        const ctx = {
          session,
          baseWorkspaceId: '',
          ops,
          baseOps: ops,
          signal: new AbortController().signal,
          rollback: { push: () => {} },
          checkpoint: async () => {},
          progress: (/** @type {string} */ step) => { steps.push(step); }
        };

        const container = document.createElement('div');
        provider.renderSetup(container, { ...ctx, values: { name: '2' } });
        shown['field label'] = String(container.querySelector('label')?.textContent);
        const form = hooks._form;
        const note = () => String(form.note.childNodes[0]?.textContent);
        shown['destination note'] = note();
        form.input.value = '!';
        hooks._showDestination();
        shown['unusable-name note'] = note();

        /**
         * What a call threw.
         * @param {() => any} fn - The call.
         * @returns {Promise<string>} Its message.
         */
        const thrown = async (fn) => {
          try {
            await fn();
            return '(nothing thrown)';
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        };
        shown['no-root refusal'] = await thrown(() => hooks._places({ name: '2' }, {}));
        shown['unusable-name refusal'] = await thrown(() => hooks._places({ name: '!' }, ctx));
        found = { exists: true };
        shown['occupied refusal'] = await thrown(() => provider.provision({ name: '2' }, ctx));
        found = { exists: false };
        await provider.provision({ name: '2' }, ctx);
        assert(steps.length === 2, `a provision reports two steps, got ${JSON.stringify(steps)}`);
        steps.forEach((step, i) => { shown[`progress ${i}`] = step; });

        const row = { label: '2', root: places.work, meta: { name: '2', baseDir: '/1', dir: places.dir } };
        shown['missing status'] = String((await provider.status({ available: false }, ctx))?.detail);
        shown['unrecorded status'] = String((await provider.status({}, ctx))?.detail);
        compare([{}]);
        shown['unchanged status'] = String((await provider.status(row, ctx))?.detail);
        compare([{ changed: ['4'] }]);
        shown['one-changed status'] = String((await provider.status(row, ctx))?.detail);
        compare([{ changed: ['4'], added: ['5'] }]);
        shown['changed status'] = String((await provider.status(row, ctx))?.detail);

        for (const [which, workspace] of [['project', {}], ['named', { meta: { baseDir: '/4' } }]]) {
          for (const option of provider.finishOptions(workspace)) {
            shown[`${which} ${option.id} label`] = String(option.label);
            shown[`${which} ${option.id} description`] = String(option.description);
          }
        }

        /**
         * What finishing with the row says.
         * @param {string} actionId - Which ending.
         * @returns {Promise<string>} Its message.
         */
        const finished = async (actionId) => String((await provider.finish(row, actionId, ctx))?.message);
        shown['unrecorded finish'] = String((await provider.finish({}, 'keep', ctx))?.message);
        shown['keep'] = await finished('keep');
        shown['unknown action'] = await finished('5');
        compare([{}]);
        shown['nothing to apply'] = await finished('apply');
        compare([{ changed: ['4'] }]);
        shown['one conflict'] = await finished('apply');
        compare([{ changed: ['4', '5'] }]);
        shown['two conflicts'] = await finished('apply');
        compare([{ changed: ['4', '5', '6', '7', '8'] }]);
        shown['many conflicts'] = await finished('apply');
        compare([{ changed: ['4'] }]);
        shown['applied one'] = await finished('apply-anyway');
        compare([{ changed: ['4'], removed: ['5'] }]);
        shown['applied two'] = await finished('apply-anyway');
        found = { exists: true };
        shown['discard stuck'] = await finished('discard');
        found = { exists: false };
        shown['discarded'] = await finished('discard');

        const report = await provider.reconcile(
          [{ id: '9', root: places.work, meta: { name: '8', baseDir: '/1', dir: places.dir } }], ctx);
        assert(report.orphanedWorkspaces.length === 1 && report.orphanedArtifacts.length === 1,
          `one row missing its copy and one copy with no row, got ${JSON.stringify(report)}`);
        shown['missing reason'] = String(report.orphanedWorkspaces[0].reason);
        shown['unclaimed detail'] = String(report.orphanedArtifacts[0].detail);

        assert((await provider.cleanupPartial({}, ctx))?.removed === false, 'an unrecorded provision is not removed');
        found = { exists: true };
        assert((await provider.cleanupPartial(row, ctx))?.removed === false, 'a copy that would not go is not removed');
        found = { exists: false };
        assert((await provider.cleanupPartial(row, ctx))?.removed === true, 'a copy that went is removed');
      }, { '@juggler/core': CORE_TEXT });

      const english = Object.entries(shown).filter(([, text]) => !isPseudoLocalized(scrub(text)));
      assert(english.length === 0, `still English under en-XA: ${JSON.stringify(english)}`);
    });
  } finally {
    if (session) {
      for (const id of created) {
        await releaseTestConversation(session, id, 'scratch-sandbox-test');
      }
    }
  }

  return { passed, failed, errors };
}
