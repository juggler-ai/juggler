//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What a provision leaves behind when it does not simply succeed.
 *
 * A provision that stops half way — cancelled during the setup hook, or killed
 * with the tab it was running in — must leave the repository exactly as it was
 * found, and `git worktree list` and `git branch` are asked before and after to
 * say so. So must one refused because the location is taken, and the undo of
 * one that checked out a branch someone else made. Split from git-worktree-test
 * so each suite fits a unit suite's budget when every shell is a `wsl.exe`.
 * @module _tests/git-worktree-provision-test
 */

import { assert } from '../../../js-tests/utilities/test-helpers.js';
import { registerWorkspace, patchWorkspace, unregisterWorkspace, listWorkspaces } from '../../../js/services/workspaces.js';
import { provisionWorkspace } from '../../../js/services/workspace-provisioning.js';
import workspaceProviderRegistry from '../../../js/registries/workspace-provider-registry.js';
import { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';
import {
  runWorktreeSuite,
  PROVIDER_ID,
  BRANCH,
  uniqueTag,
  mustRun,
  buildRepo,
  snapshot,
  pathTurnsUp,
  giveRepoASlowHook,
  shell,
  chain
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
 * Run the git-worktree-provision tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  return runWorktreeSuite('git-worktree-provision-test', async ({ run, ops, session, projectPath, separator }) => {
    await run('the setup hook says what it is doing, rather than that it is running', async () => {
      // The hook is where the minutes go — a submodule clone, an `npm ci` — and
      // it is the one step of a provision that can sit there for ten of them.
      // "Running .juggler/worktree-setup" for the whole of that says only that
      // nothing has crashed yet; the hook's own output is the sole account of
      // what is actually happening, and it costs nothing to relay.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        await mustRun(ops, chain(
          `mkdir -p ${repo}/.juggler`,
          `printf 'echo fetching the submodules\\nsleep 0.3\\necho linked node_modules\\n' > ${repo}/.juggler/worktree-setup`
        ));

        /** @type {{step: string, detail?: string}[]} */
        const said = [];
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location },
          onProgress: (step, detail) => { said.push({ step, detail }); }
        });

        const heard = said.filter(line => /fetching the submodules|linked node_modules/.test(line.detail || ''));
        assert(heard.length >= 2,
          `what the hook printed is what the panel is told, got ${JSON.stringify(said)}`);
        const steps = new Set(heard.map(line => line.step));
        assert(steps.size === 1,
          `all of it under one step, so a panel showing it updates a line rather than growing a list, got ${JSON.stringify([...steps])}`);
        assert(!/worktree-setup/.test([...steps][0] ?? ''),
          `and the step is what is happening rather than the file it is happening in, got ${JSON.stringify([...steps])}`);
      } finally {
        if (outcome) await outcome.undo().catch(() => {});
        await shell(ops, `rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('a cancel during the setup hook leaves the repository as it was', async () => {
      // The cancel a user actually reaches: the tree is made in a second and the
      // hook after it takes a quarter of an hour, so the middle of the hook is
      // where Cancel gets pressed. What must survive it is the repository —
      // an abandoned worktree registration or a stray branch would both make the
      // next attempt at the same name fail for a reason the user did not cause.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        await giveRepoASlowHook(ops, repo, 30);
        const before = await snapshot(ops, repo);

        const controller = new AbortController();
        const running = provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location },
          signal: controller.signal
        });
        /** @type {any[]} */
        const rejections = [];
        const settled = running.then(() => {}, (error) => { rejections.push(error); });

        // Aborting before the hook is really running would prove nothing: the
        // tree would be gone because it had barely been made, not because the
        // compensation took it away.
        assert(await pathTurnsUp(ops, `${tree}/hook-ran.txt`, 10000),
          'the setup hook never started, so there was nothing for the cancel to interrupt');
        controller.abort();
        await settled;

        assert(rejections.length === 1,
          `cancelling rejects the provision rather than completing it, got ${rejections.length} rejections`);
        assert(await snapshot(ops, repo) === before,
          'and the repository is exactly as it was found — no worktree registered, no branch left behind');
        const gone = await shell(ops, `ls ${tree}`);
        assert(gone.success === false,
          'and the half-built tree is gone, hook output and all');
      } finally {
        await shell(ops, `git -C ${repo} worktree remove --force ../${tree}; rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('an interrupted provision is undone from its checkpoints alone', async () => {
      // The restart path, reproduced without restarting anything: drop the
      // closures the way a dead tab drops them, then hand `cleanupPartial` the
      // row the server kept. It must remove exactly what the compensation would
      // have — which is the whole reason the two are written separately, since a
      // provider whose undo paths agree only by sharing code cannot be caught
      // when they stop agreeing.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let row = null;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        await giveRepoASlowHook(ops, repo, 30);
        const before = await snapshot(ops, repo);

        const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
        if (!provider) throw new Error('the provider is not registered');
        row = await registerWorkspace({
          kind: 'local',
          root: location,
          providerId: PROVIDER_ID,
          state: 'provisioning'
        });
        const controller = new AbortController();
        const dying = provider.provision(
          { repo, branch: BRANCH, base: 'main', location },
          {
            session,
            ops,
            baseWorkspaceId: '',
            signal: controller.signal,
            // The tab is about to die. Everything it was holding in memory goes
            // with it, which is what makes the checkpoints the only record.
            rollback: { push: () => {} },
            checkpoint: async (/** @type {any} */ patch) => { await patchWorkspace(row.id, { meta: patch }); },
            progress: () => {}
          }
        ).catch(() => {});

        assert(await pathTurnsUp(ops, `${tree}/hook-ran.txt`, 10000),
          'the setup hook never started, so nothing was half-built to recover from');
        controller.abort();
        await dying;

        const abandoned = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === row.id);
        if (!abandoned?.meta?.treeRel) {
          throw new Error(`the row carries what was checkpointed, got ${JSON.stringify(abandoned?.meta)}`);
        }

        const outcome = await provider.cleanupPartial(abandoned, {
          session,
          ops,
          baseWorkspaceId: '',
          signal: new AbortController().signal,
          rollback: { push: () => {} },
          checkpoint: async () => {},
          progress: () => {}
        });
        assert(outcome.removed === true,
          `cleanup says it removed the provision, got ${JSON.stringify(outcome)}`);
        assert(await snapshot(ops, repo) === before,
          'and the repository is as it was found, reconstructed from meta alone');
      } finally {
        if (row) await unregisterWorkspace(row.id).catch(() => {});
        await shell(ops, `git -C ${repo} worktree remove --force ../${tree}; rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('a location that is already occupied is refused, and left untouched', async () => {
      // The guard that makes the compensation safe to run unconditionally.
      // Without it the sequence is: `worktree add` fails because the path is
      // taken, the host unwinds, and the compensation removes the tree that was
      // already there — someone else's work, deleted by a failed provision.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        await mustRun(ops, chain(`mkdir -p ${tree}`, `echo someone-elses-work > ${tree}/precious.txt`));
        const before = await snapshot(ops, repo);

        /** @type {any} */
        let refusal = null;
        await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        }).catch((error) => { refusal = error; });

        assert(refusal !== null, 'provisioning onto an occupied path was allowed');
        // This assertion first, and deliberately: git refuses the `worktree add`
        // by itself, so a provider without the guard still fails — it just fails
        // AFTER registering a compensation, which then `rm -rf`s the directory
        // on the way out. The refusal is not what saves the files; refusing
        // before anything is recorded is.
        const survived = await shell(ops, `cat ${tree}/precious.txt`);
        assert(survived.success === true && survived.stdout.includes('someone-elses-work'),
          `what was already there is still there, got ${JSON.stringify(survived.stdout)}`);
        assert(/already something there/.test(String(refusal?.message)),
          `and the refusal names the reason rather than quoting git at the user, got ${JSON.stringify(String(refusal?.message))}`);
        assert(await snapshot(ops, repo) === before,
          'and the repository is untouched');
      } finally {
        await shell(ops, `rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('a branch that already exists is checked out, and outlives the undo', async () => {
      // Deleting a branch we did not create is the other way this loses work,
      // and it is one `git branch -D` away in the compensation. So the branch is
      // made first, by someone else, and has to be there afterwards.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, 'keep/me');
      const tree = `${repo}-keep-me`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, 'hello-from-the-worktree');
        await mustRun(ops, `git -C ${repo} branch keep/me main`);
        const before = await snapshot(ops, repo);

        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: 'keep/me', base: 'main', location }
        });
        assert(outcome.workspace.meta?.branchCreatedByUs === false,
          `the provider knows the branch was not its to make, got ${JSON.stringify(outcome.workspace.meta)}`);
        const listed = await mustRun(ops, `git -C ${repo} worktree list --porcelain`);
        assert(listed.stdout.includes('branch refs/heads/keep/me'),
          `and checked it out rather than making another, got ${JSON.stringify(listed.stdout)}`);

        await outcome.undo();
        outcome = null;
        assert(await snapshot(ops, repo) === before,
          'and undoing removed the tree while leaving the branch someone else made');
      } finally {
        if (outcome) await outcome.undo().catch(() => {});
        await shell(ops, `rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

  });
}
