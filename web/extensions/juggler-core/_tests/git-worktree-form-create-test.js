//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The worktree setup form, from what it refuses to what it builds.
 *
 * A branch name git will not take is refused before anything is built; a form
 * filled in and created makes a tree the conversation then works in; and every
 * word the form says is translated. What the form works out on the user's
 * behalf — where the tree goes, which repository and which tree of a submodule
 * is meant — is git-worktree-form-test's. Split from it so each suite fits a
 * unit suite's budget when every shell is a `wsl.exe`.
 * @module _tests/git-worktree-form-create-test
 */

import { waitFor, assert } from '../../../js-tests/utilities/test-helpers.js';
import { unregisterWorkspace, listWorkspaces } from '../../../js/services/workspaces.js';
import { provisionWorkspace } from '../../../js/services/workspace-provisioning.js';
import { rebindConversation } from '../../../js/services/workspace-rebinding.js';
import GitWorktreeWorkspaceProvider from '../workspaces/git-worktree-workspace-provider.js';
import api from '../../../js/services/api.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import {
  runWorktreeSuite,
  PROVIDER_ID,
  BRANCH,
  uniqueTag,
  makeConversation,
  readIn,
  mustRun,
  buildRepo,
  typeInto,
  pick,
  waitForRepoField,
  openForm,
  shell
} from './git-worktree-helpers.js';

/**
 * This suite builds real git repositories inside the shared fixture project and
 * removes them again, so no sibling lane may be in flight while it runs.
 *
 * The directories are stamped per case and cleaned up by the case that made
 * them, which keeps them from colliding with each other — but it cannot keep
 * them out of the way of a lane that walks the *project*. Anything copying the
 * tree, listing it, or reporting on the repositories under it reads a
 * `wt-…/greeting.txt` that a case here is in the middle of deleting, and fails
 * carrying a path it has never heard of.
 * @type {boolean}
 */
export const needsExclusiveRun = true;

/** juggler-core's English for what the worktree form says, standing in for its catalogue. */
const CORE_TEXT = [
  'Base',
  'Branch',
  'Location',
  'beside the repository',
  'Repository',
  'Worktree',
  '{target, select, named {{project}, with {repo} in it} other {the project, with {repo} in it}}',
  '{repo} on its own',
  'Only {repo}. Nothing of the project around it comes with it.',
  '{repo} starts uninitialised; {hook} runs in the new tree.',
  '{repo} starts uninitialised — there is no {hook} to fill it in.',
  'git will not take that as a branch name.',
  "{what, select, repo {Couldn't use that repository path: {value} contains a character that cannot appear in a command.} branch {Couldn't use that branch name: {value} contains a character that cannot appear in a command.} base {Couldn't use that base: {value} contains a character that cannot appear in a command.} other {Couldn't use that location: {value} contains a character that cannot appear in a command.}}",
  "Couldn't make a worktree: the base workspace has no root.",
  "Couldn't make a worktree: no branch was named.",
  "Couldn't make a worktree at {location}: it is not on the same drive as {repoRoot}.",
  '`{command}` failed with no output (exit {code}).'
];

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run the git-worktree-form-create tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  return runWorktreeSuite('git-worktree-form-create-test', async ({ run, ops, session, parent, separator, release }) => {
    await run('a branch name git will not take is refused before anything is built', async () => {
      // `feat..tunnels` is a perfectly good-looking string and git will not have
      // it. Nothing short of asking git knows that, which is the point: the
      // rules for a ref name are git's, and a regexp of our own would be a
      // second set that drifts.
      const form = openForm(session, '');
      const branch = form.branch;

      typeInto(branch, 'feat..tunnels');
      await waitFor(() => form.provider.getSetupValue().valid === false,
        { description: 'git to be asked what it makes of the name' });
      const refused = form.provider.getSetupValue();
      assert(refused.invalidFieldId === branch.id,
        `the refusal names the branch field, got ${JSON.stringify(refused.invalidFieldId)}`);
      const note = form.container.querySelector('[data-field-note="branch"]');
      assert(Boolean(note?.textContent?.trim()),
        `and the field says so where it is, got ${JSON.stringify(note?.textContent)}`);

      typeInto(branch, BRANCH);
      await waitFor(() => form.provider.getSetupValue().valid === true,
        { description: 'a name git will take to be accepted' });
      assert(!form.container.querySelector('[data-field-note="branch"]')?.textContent?.trim(),
        'and the complaint goes away with the name that caused it');
    });

    await run('the form fills in, Create builds, and the conversation works in the tree', async () => {
      // End to end from the form: what it reports is what the provision is
      // given, and the tools of a conversation moved into the result then
      // resolve in the tree the form named.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let conversation = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);

        // The project as the base workspace, with the repository inside it —
        // which is the case the Repository field exists for, and the case the
        // provision could not be reached in at all until the form could name
        // one. Nothing here tells the provision where the repository is: the
        // form is the only thing that knows, and what it hands on is what
        // `git worktree add` ends up running in.
        const form = openForm(session, '');
        pick(await waitForRepoField(form), repo);
        typeInto(form.branch, BRANCH);
        await waitFor(() => form.base.value === 'main',
          { description: "the base to fill in from the chosen repository's HEAD" });
        const value = form.provider.getSetupValue();
        assert(value.values.repo === repo,
          `the form names the repository it was pointed at, got ${JSON.stringify(value.values.repo)}`);

        conversation = await makeConversation(session, 'form-to-tree');
        release(conversation);

        // The place is built first, with no conversation in the question, and
        // something is moved into it afterwards — the two acts the dialog and
        // the strip now perform separately.
        const built = await provisionWorkspace({
          session, providerId: PROVIDER_ID, values: value.values
        });
        session.workspaces = [...(session.workspaces ?? []), built.workspace];
        assert(built.workspace.state === 'ready',
          `Create built the tree, got ${JSON.stringify(built.workspace.state)}`);

        await rebindConversation(conversation, built.workspace.id);
        assert(conversation.workspaceId === built.workspace.id,
          `and the conversation works in it, got ${JSON.stringify(conversation.workspaceId)}`);

        const row = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === conversation.workspaceId);
        assert(row?.root === value.values.location,
          `the tree is where the form said it would be, got ${JSON.stringify(row?.root)} rather than ${JSON.stringify(value.values.location)}`);
        // Of THAT repository, which is the whole of what the field is for: the
        // project is the tree the command ran in, and a `repo` that went astray
        // anywhere between the form and `git worktree add` leaves this listing
        // empty rather than wrong.
        const listed = await mustRun(ops, `git -C ${repo} worktree list --porcelain`);
        assert(listed.stdout.includes(`branch refs/heads/${BRANCH}`),
          `on the branch that was typed into the form, got ${JSON.stringify(listed.stdout)}`);
        assert(row?.root === `${parent}${separator}${tree}`,
          `and beside the project rather than inside it, got ${JSON.stringify(row?.root)}`);

        const read = await readIn(session, conversation, 'greeting.txt');
        assert(read.exists !== false && String(read.content ?? '').includes(`hello-${tag}`),
          `and the conversation's own tools read that tree, got ${JSON.stringify(read)}`);
      } finally {
        if (conversation?.workspaceId) await unregisterWorkspace(conversation.workspaceId).catch(() => {});
        await shell(ops, `git -C ${repo} worktree remove --force ../../${tree}; rm -rf ../${tree} ${repo}`).catch(() => {});
      }
    });

    await run('everything the worktree form says to the user is translated under en-XA', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      // Paths and the hook's name are data; each is mapped to a digit before the
      // check, as the repository and branch names already are.
      const hook = '.juggler/worktree-setup';
      /**
       * A shown line with its data mapped to digits.
       * @param {any} text - What was shown.
       * @returns {string} The line, ready for the check.
       */
      const scrub = (text) => String(text)
        .split('C:\\1').join('6')
        .split('D:\\2').join('7')
        .split(hook).join('8');

      // The repository list is the server's; every case owns it rather than
      // inheriting whatever the lane's last suite left behind.
      const realStatus = Object.prototype.hasOwnProperty.call(api, 'getGitStatus')
        ? /** @type {any} */ (api).getGitStatus : null;
      /** @type {any} */ (api).getGitStatus = async () => ({ repos: [{ path: '' }, { path: '3' }] });
      try {
        await underPseudoLocale('git-worktree-form-test', async () => {
          // Every shell command stubbed: nothing on disk is made or looked at.
          let hookThere = true;
          const shell = async (/** @type {any} */ { command }) => {
            if (command.endsWith('git rev-parse --abbrev-ref HEAD')) return { success: true, stdout: '2' };
            if (command === 'git config -f .gitmodules --list') return { success: true, stdout: 'submodule.3.path=3\n' };
            if (command.startsWith('test -f')) return { success: hookThere };
            return { success: false, stdout: '', stderr: '', exitCode: 1 };
          };
          const ops = {
            shell,
            shellStreaming: async () => ({ success: false, stdout: '', exitCode: 1 })
          };
          const ctx = {
            session: { projectPath: '/1', workspaceRoot: () => '/1' },
            baseWorkspaceId: '',
            ops,
            signal: new AbortController().signal,
            rollback: { push: () => {} },
            checkpoint: async () => {},
            progress: () => {}
          };

          const provider = new GitWorktreeWorkspaceProvider({});
          /** @type {any} The private hooks, which a test may reach. */
          const hooks = provider;
          const container = document.createElement('div');
          // Restored onto the submodule, so the scope question arises as soon as
          // the repositories and submodules are known.
          provider.renderSetup(container, { ...ctx, values: { repo: '3' } });
          const form = hooks._form;
          await waitFor(() => Boolean(form.scopeRow) && form.scopeRow.hidden === false,
            { description: 'the form to offer the repositories and ask which end of the submodule' });

          for (const row of container.querySelectorAll('.setup-field')) {
            const name = row.querySelector('[data-field]')?.getAttribute('data-field');
            shown[`${name} label`] = String(row.querySelector('label')?.textContent);
          }
          assert(Object.keys(shown).length === 5,
            `five fields once a submodule is chosen, got ${JSON.stringify(Object.keys(shown))}`);
          shown['location placeholder'] = form.location.placeholder;
          assert(form.repo.value === '3' && form.base.value === '2',
            `the restored repository is chosen and the base filled in, got ${JSON.stringify([form.repo.value, form.base.value])}`);

          shown['whole-project scope'] = String(form.scope.options[0].textContent);
          shown['submodule-alone scope'] = String(form.scope.options[1].textContent);
          const scopeNote = () => String(form.scopeNote.textContent);
          assert(form.scopeWanted === 'project', `a hook starts it on the project, got ${form.scopeWanted}`);
          shown['hooked note'] = scopeNote();
          form.hasSetupHook = false;
          hooks._showScopeNote();
          shown['unhooked note'] = scopeNote();
          form.scopeWanted = 'repo';
          hooks._showScopeNote();
          shown['alone note'] = scopeNote();

          // A base workspace with no name of its own to offer.
          const realCtx = form.ctx;
          form.ctx = { ...realCtx, session: { workspaceRoot: () => '' } };
          hooks._offerScope();
          shown['unnamed whole-project scope'] = String(form.scope.options[0].textContent);
          form.ctx = realCtx;

          clearTimeout(form.timer);
          form.branch.value = '5';
          await hooks._checkBranch();
          assert(form.verdicts.get('5') === false, 'git turned the name down');
          shown['branch verdict'] = String(form.branchNote.textContent);
          clearTimeout(form.timer);

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
          shown['no-root refusal'] = await thrown(() => hooks._repoRoot({}, { session: { workspaceRoot: () => '' } }));
          shown['repository refusal'] = await thrown(() => hooks._repoRoot({ repo: '4"' }, ctx));
          shown['branch refusal'] = await thrown(() => hooks._places({ branch: '4"' }, ctx));
          shown['no-branch refusal'] = await thrown(() => hooks._places({ branch: '' }, ctx));
          shown['base refusal'] = await thrown(() => hooks._places({ branch: '4', base: '4"' }, ctx));
          shown['location refusal'] = await thrown(() => hooks._places({ branch: '4', location: '/1/4"' }, ctx));
          shown['other-drive refusal'] = await thrown(() => hooks._places({ branch: '4', location: 'D:\\2' },
            { ...ctx, session: { workspaceRoot: () => 'C:\\1' } }));
          shown['silent failure'] = await thrown(() => hooks._mustRun(ctx, '', '5'));
          shown['silent stream failure'] = await thrown(() => hooks._mustStream(ctx, '', '5', () => {}));
          hookThere = false;
        }, { '@juggler/core': CORE_TEXT });
      } finally {
        if (realStatus) /** @type {any} */ (api).getGitStatus = realStatus;
        else delete (/** @type {any} */ (api)).getGitStatus;
      }

      const english = Object.entries(shown).filter(([, text]) => !isPseudoLocalized(scrub(text)));
      assert(english.length === 0, `still English under en-XA: ${JSON.stringify(english)}`);
    });
  });
}
