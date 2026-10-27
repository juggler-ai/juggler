//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The git worktree provider, and the two facts everything about it rests on.
 *
 * A worktree lives BESIDE the repository it came from — `../repo-branch` — and
 * in ordinary use the repository is the project, so the tree the provider makes
 * is outside the root the command that makes it is confined to. Both halves of
 * that are assumed everywhere in the design and neither had ever been run:
 * whether a command pinned to the project may write outside it, and whether a
 * workspace registered out there resolves a conversation's operations to it.
 *
 * So this suite builds a real repository inside the fixture and a real worktree
 * outside it, because the questions are about git and about the path clamp, and
 * a mock of either would answer whatever it was written to answer.
 *
 * The provider's own cases here are a provision that succeeds and its undo;
 * what one that stops half way leaves behind is git-worktree-provision-test's.
 * @module _tests/git-worktree-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { registerWorkspace, unregisterWorkspace } from '../../../js/services/workspaces.js';
import { provisionWorkspace } from '../../../js/services/workspace-provisioning.js';
import workspaceProviderRegistry from '../../../js/registries/workspace-provider-registry.js';
import GitWorktreeWorkspaceProvider, { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';
import {
  runWorktreeSuite,
  PROVIDER_ID,
  registerProvider,
  BRANCH,
  uniqueTag,
  makeConversation,
  readIn,
  mustRun,
  buildRepo,
  snapshot,
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

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run the git-worktree tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  return runWorktreeSuite('git-worktree-test', async ({ run, ops, session, projectPath, parent, separator, release }) => {
    await run('a worktree can be made beside the repository, outside the tree the command runs in', async () => {
      // The placement the whole feature assumes. The command runs pinned to the
      // project, and the tree it makes is a sibling of the project — so if the
      // path clamp measured what a command writes rather than where it starts,
      // every worktree this provider will ever make would be refused, and the
      // first anyone would know of it is the day the provider shipped.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const tree = `juggler-wt-${tag}`;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');

        // Before, so that the assertion after it cannot pass against something
        // that was already there — the tree is named for this run alone, but a
        // probe that can only succeed proves nothing whichever way it answers.
        const before = await shell(ops, `ls ../${tree}`);
        assert(before.success === false,
          `nothing is beside the project under that name yet, got ${JSON.stringify(before.stdout)}`);

        await mustRun(ops, `git -C ${repo} worktree add -q -b feat/tunnels ../../${tree} main`);

        const after = await shell(ops, `ls ../${tree}/greeting.txt`);
        assert(after.success === true,
          `a command confined to the project made a tree beside it, got ${JSON.stringify(after.stderr)}`);

        // Beside, not inside — which is the half of "outside the tree the
        // command runs in" that the probe above would still pass without, since
        // a relative `..` only means the parent if the command really did start
        // where we think it did.
        const inside = await shell(ops, `ls ${tree}`);
        assert(inside.success === false,
          `and beside it rather than within it, got ${JSON.stringify(inside.stdout)}`);

        const listed = await mustRun(ops, `git -C ${repo} worktree list --porcelain`);
        assert(listed.stdout.includes(tree),
          `and git knows it as a worktree of the repository, got ${JSON.stringify(listed.stdout)}`);
        assert(listed.stdout.includes('branch refs/heads/feat/tunnels'),
          `on the branch it was asked for, got ${JSON.stringify(listed.stdout)}`);
      } finally {
        // Ordered, and each tolerant of the step before it having failed: the
        // tree is outside the project, where no fixture reset will ever reach it.
        await shell(ops, `git -C ${repo} worktree remove --force ../../${tree}; rm -rf ../${tree} ${repo}`).catch(() => {});
      }
    });

    await run('a conversation bound to a worktree reads the worktree', async () => {
      // The other half: a workspace registered outside the project resolves a
      // conversation's operations to it. The discriminator is the repository's
      // one committed file, which exists in the worktree because `worktree add`
      // checked it out there and exists nowhere the project can see — so a read
      // that quietly resolved against the project comes back missing rather than
      // coming back with something plausible.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const tree = `juggler-wt-${tag}`;
      const root = `${parent}${separator}${tree}`;
      /** @type {any} */
      let made = null;
      const saved = session.workspaces;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        await mustRun(ops, `git -C ${repo} worktree add -q -b feat/reads ../../${tree} main`);

        made = await registerWorkspace({
          kind: 'local',
          root,
          label: 'feat/reads (worktree)',
          state: 'ready'
        });
        assert(made.available !== false,
          `the server found the tree where it was told it was, got ${JSON.stringify(made)}`);
        // The unit session's websocket is a mock, so the broadcast that would
        // carry this row never arrives; the table is set by hand instead.
        session.workspaces = [...saved, made];

        const bound = await makeConversation(session, 'works-in-the-worktree', { workspaceId: made.id });
        release(bound);
        const inTree = await readIn(session, bound, 'greeting.txt');
        assert(inTree.exists !== false,
          `the bound conversation read the worktree's file, got ${JSON.stringify(inTree)}`);
        assert(String(inTree.content ?? '').includes('hello-from-the-worktree'),
          `and got its contents, got ${JSON.stringify(inTree.content)}`);

        const unbound = await makeConversation(session, 'works-in-the-project');
        release(unbound);
        const inProject = await readIn(session, unbound, 'greeting.txt');
        assert(inProject.exists === false,
          `while the project holds no such file, which is what makes the case above mean anything, got ${JSON.stringify(inProject)}`);
      } finally {
        session.workspaces = saved;
        if (made) await unregisterWorkspace(made.id).catch(() => {});
        await shell(ops, `git -C ${repo} worktree remove --force ../../${tree}; rm -rf ../${tree} ${repo}`).catch(() => {});
      }
    });

    await run('the provider registers, and names itself for the setup panel', async () => {
      const refusal = registerProvider();
      assert(refusal === '', `the registry refused the provider: ${refusal}`);
      assert(registerProvider() === '',
        'and asking a second time, as the next run of this suite in this lane does, finds it there');

      const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
      assert(provider !== undefined, 'the provider is not in the registry under its own id');
      assert(provider.getSetupLabel() === 'New git worktree',
        `the "New…" row would read ${JSON.stringify(provider.getSetupLabel())}`);
    });

    await run('a worktree of a subrepo is seeded with the project\'s own instructions', async () => {
      // A tree of a repository the project merely holds has never had a copy of
      // the project's AGENTS.md, and nothing below that tree will ever mention
      // it — so a conversation working there loses the house rules entirely. A
      // worktree of the project itself is the opposite case: it carries its own
      // copy on its own branch, and a second one read out of the main checkout
      // would be a second answer to the same question.
      const provider = new GitWorktreeWorkspaceProvider({ session });
      const ctx = { session };

      const ofSubrepo = provider.instructionRoots(
        { meta: { repoDir: `${projectPath}${separator}sub${separator}repo` } }, ctx);
      assert(ofSubrepo.length === 1 && ofSubrepo[0] === projectPath,
        `a tree of a repository inside the project is seeded from the project, got ${JSON.stringify(ofSubrepo)}`);

      const ofProject = provider.instructionRoots({ meta: { repoDir: projectPath } }, ctx);
      assert(ofProject.length === 0,
        `while a tree of the project itself names nowhere else, got ${JSON.stringify(ofProject)}`);

      const unknown = provider.instructionRoots({ meta: {} }, ctx);
      assert(unknown.length === 0,
        `and a row that records no repository says nothing rather than guessing, got ${JSON.stringify(unknown)}`);
    });

    await run('a provision makes the tree, on the branch it was asked for', async () => {
      // From here on the trees land BESIDE the repository but still inside the
      // fixture, because the repository is a directory of the fixture rather
      // than the fixture itself. That is the provider's own default placement
      // exercised honestly — and the case above is what proves the same code
      // works when the repository is the project and the tree is outside it.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        const before = await snapshot(ops, repo);

        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });

        assert(outcome.workspace.state === 'ready',
          `the row is ready once the provider returns, got ${JSON.stringify(outcome.workspace.state)}`);
        assert(outcome.workspace.root === location,
          `and says where the tree is, got ${JSON.stringify(outcome.workspace.root)}`);
        assert(outcome.workspace.meta?.branchCreatedByUs === true,
          `and records that the branch is ours to delete, got ${JSON.stringify(outcome.workspace.meta)}`);

        const listed = await mustRun(ops, `git -C ${repo} worktree list --porcelain`);
        assert(listed.stdout.includes(`branch refs/heads/${BRANCH}`),
          `git has it on the branch it was asked for, got ${JSON.stringify(listed.stdout)}`);
        const checkedOut = await shell(ops, `ls ${tree}/greeting.txt`);
        assert(checkedOut.success === true,
          'and the tree holds the commit rather than being an empty directory');

        // Undo after success is the same stack a cancel runs, which is why "I
        // picked the wrong thing" costs nothing: the repository has to come back
        // to what it was, not merely lose the directory.
        await outcome.undo();
        outcome = null;
        assert(await snapshot(ops, repo) === before,
          'undoing left the repository as it was found');
        const gone = await shell(ops, `ls ${tree}`);
        assert(gone.success === false, 'and took the tree with it');
      } finally {
        if (outcome) await outcome.undo().catch(() => {});
        await shell(ops, `rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('a repository named in Windows\' own terms is worked in relatively', async () => {
      // The provider is handed `C:\src\app` on Windows and `/src/app`
      // everywhere else, and every command it builds is relative so that the
      // difference never reaches a shell. Asking that on the platform itself
      // would mean owning a Windows runner; asking it here means driving a
      // provision against a Windows-shaped repository with the shell replaced
      // by a recorder, and reading back what was really run.
      const provider = new GitWorktreeWorkspaceProvider({ session });
      /** @type {string[]} */
      const ran = [];
      const ctx = {
        session: { workspaceRoot: () => 'C:\\src\\app' },
        ops: {
          /**
           * @param {any} request - What the provider wants run.
           * @returns {Promise<any>} A shell result.
           */
          shell: async (request) => {
            const command = String(request.command);
            ran.push(command);
            // Every probe answers no: nothing at the location, no branch of
            // that name, no setup hook. That is the path through a provision
            // which makes a tree and runs nothing else.
            const probe = command.startsWith('test ') || command.includes('--verify');
            return { success: !probe, stdout: '', stderr: '', exitCode: probe ? 1 : 0 };
          }
        },
        baseWorkspaceId: '',
        signal: new AbortController().signal,
        rollback: { push: () => {} },
        checkpoint: async () => {},
        progress: () => {}
      };

      const built = await provider.provision({ branch: BRANCH, base: 'main' }, ctx);
      assert(built.workspace.root === 'C:\\src\\app-feat-tunnels',
        `the tree is registered beside the repository in the server's own terms, got ${JSON.stringify(built.workspace.root)}`);
      assert(ran.some(command => command.includes('git worktree add -q -b "feat/tunnels" "../app-feat-tunnels"')),
        `and git is asked for it by a path relative to the repository, got ${JSON.stringify(ran)}`);
      const absolute = ran.filter(command => /[A-Za-z]:[/\\]/.test(command));
      assert(absolute.length === 0,
        `while no command carries an absolute Windows path, got ${JSON.stringify(absolute)}`);
    });

  });
}
