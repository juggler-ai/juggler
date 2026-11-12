//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Landing a worktree's work where the base is not simply checked out beside
 * it: closing once landed, a base branch nobody has out, and a submodule whose
 * commits exist only in the tree's own store.
 *
 * Split from git-worktree-land-test so each fits a unit suite's budget.
 * @module _tests/git-worktree-land-targets-test
 */

import { assert, withTimeout } from '../../../js-tests/utilities/test-helpers.js';
import { unregisterWorkspace } from '../../../js/services/workspaces.js';
import { provisionWorkspace, workspaceTrack, finishWorkspace } from '../../../js/services/workspace-provisioning.js';
import { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';
import {
  runWorktreeSuite,
  PROVIDER_ID,
  BRANCH,
  uniqueTag,
  mustRun,
  buildRepo,
  buildSuperproject,
  SHELL_WAIT_MS,
  shell,
  chain
} from './git-worktree-helpers.js';

/**
 * Builds real repositories in the shared fixture project, so no sibling lane
 * may be in flight while it runs.
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
 * Run the git-worktree-land-targets tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  return runWorktreeSuite('git-worktree-land-targets-test', async ({ run, ops, session, projectPath, separator }) => {
    /**
     * A worktree of a fresh repository, on {@link BRANCH} from `main`.
     * @param {string} repo - The repository, relative to the project.
     * @returns {Promise<any>} The provision's outcome.
     */
    const provisioned = (repo) => provisionWorkspace({
      session,
      providerId: PROVIDER_ID,
      values: { repo, branch: BRANCH, base: 'main', location: defaultLocation(`${projectPath}${separator}${repo}`, BRANCH) }
    });
    /**
     * Commit everything in a tree under a message, the way the track's commit does.
     * @param {any} workspace - The row.
     * @param {string} message - The message.
     * @returns {Promise<any>} What the commit reported.
     */
    const commitIn = (workspace, message) => withTimeout(finishWorkspace({
      session, workspace, actionId: 'commit', input: { message }
    }), SHELL_WAIT_MS, 'the commit to be made');
    /**
     * @param {any} workspace - The row.
     * @param {string} actionId - Which action.
     * @returns {Promise<any>} What it reported.
     */
    const act = (workspace, actionId) => withTimeout(finishWorkspace({ session, workspace, actionId }),
      SHELL_WAIT_MS * 2, `${actionId} to finish`);
    /**
     * @param {any} track - A track.
     * @param {string} id - A step id.
     * @returns {any} That step.
     */
    const stepOf = (track, id) => (track?.steps ?? []).find((/** @type {any} */ s) => s.id === id);
    await run('land-and-close deletes the tree only once the landing has worked', async () => {
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisioned(repo);
        const ws = outcome.workspace;
        await mustRun(ops, `echo the-work > ${tree}/done.txt`);

        const refused = await act(ws, 'land-close');
        assert(refused.done === false && (await shell(ops, `test -e ${tree}/done.txt`)).success,
          `a landing that cannot happen closes nothing, got ${JSON.stringify(refused)}`);

        await commitIn(ws, 'Did the thing');
        const closed = await act(ws, 'land-close');
        assert(closed.done === true, `one that can lands and closes, got ${JSON.stringify(closed)}`);
        assert(!(await shell(ops, `test -e ${tree}`)).success, 'and the tree is gone');
        const onMain = await mustRun(ops, `git -C ${repo} log -1 --format=%s main`);
        assert(onMain.stdout.trim() === 'Did the thing', `with its work on main, got ${JSON.stringify(onMain.stdout)}`);
        outcome = null;
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `git -C ${repo} worktree remove --force ../${tree}; rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('landing into a base the main checkout does not have out moves the ref and nothing else', async () => {
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisioned(repo);
        const ws = outcome.workspace;
        await mustRun(ops, `git -C ${repo} checkout -q -b elsewhere`);
        await mustRun(ops, `echo the-work > ${tree}/done.txt`);
        await commitIn(ws, 'Did the thing');

        const landed = await act(ws, 'land');
        assert(landed.done === false, `got ${JSON.stringify(landed)}`);
        const after = await mustRun(ops, chain(
          `git -C ${repo} rev-parse main`,
          `git -C ${tree} rev-parse HEAD`,
          `git -C ${repo} symbolic-ref --short HEAD`,
          `test ! -e ${repo}/done.txt && echo untouched`
        ));
        const [main, head, checkedOut, files] = after.stdout.trim().split('\n');
        assert(main === head, `main is moved to the work, got ${JSON.stringify(after.stdout)} (${JSON.stringify(landed)})`);
        assert(checkedOut === 'elsewhere' && files === 'untouched',
          `while the checkout stays on its own branch with its own files, got ${JSON.stringify(after.stdout)}`);
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `git -C ${repo} worktree remove --force ../${tree}; rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('a submodule’s commits land in the base checkout’s submodule, and the pointer follows them', async () => {
      // A tree of the whole project, whose submodule was cloned into the tree's
      // own store, as a setup hook does it. The commits made there exist nowhere
      // the base checkout's submodule can see, and that submodule has moved on
      // meanwhile, with the base repointing at it.
      const tag = uniqueTag();
      const outer = `wt-outer-${tag}`;
      const inner = `wt-inner-${tag}`;
      const tree = `${outer}-feat-tunnels`;
      const ident = '-c user.name=Juggler -c user.email=tests@juggler.invalid -c commit.gpgsign=false';
      /** @type {any} */
      let outcome = null;
      try {
        await buildSuperproject(ops, outer, inner, 'held');
        outcome = await provisioned(outer);
        const ws = outcome.workspace;
        await mustRun(ops, chain(
          `git -C ${tree} -c protocol.file.allow=always submodule update --init -q`,
          // The identity a user's global config would give the clone.
          `git -C ${tree}/held config user.name Juggler`,
          `git -C ${tree}/held config user.email tests@juggler.invalid`,
          `git -C ${tree}/held config commit.gpgsign false`,
          `echo sub-work > ${tree}/held/work.txt`,
          `git -C ${tree}/held add -A`,
          `git -C ${tree}/held commit -q -m "Sub work"`,
          `echo base-sub > ${outer}/held/base.txt`,
          `git -C ${outer}/held add -A`,
          `git -C ${outer}/held ${ident} commit -q -m "Base sub moved"`,
          `git -C ${outer} ${ident} commit -q -am "Base bumped held"`
        ));
        await commitIn(ws, 'Bumped held');

        const ahead = await workspaceTrack(session, ws);
        const group = stepOf(ahead, 'land')?.groups?.find((/** @type {any} */ g) => g.name === 'held');
        assert(group?.commits?.[0]?.subject === 'Sub work' && group.commitCount === 1,
          `the track lists the submodule's own commit, got ${JSON.stringify(stepOf(ahead, 'land'))}`);

        const landed = await act(ws, 'land');
        assert(landed.done === false, `got ${JSON.stringify(landed)}`);
        const after = await mustRun(ops, chain(
          `git -C ${outer}/held log --format=%s main`,
          'echo ---',
          `git -C ${outer}/held rev-parse main`,
          `git -C ${outer} rev-parse main:held`,
          `git -C ${outer} rev-parse main`,
          `git -C ${tree} rev-parse HEAD`,
          'echo ---',
          `git -C ${outer} status --porcelain`,
          'echo ---',
          `git -C ${tree} status --porcelain`
        ));
        const [subLog, pointers, baseStatus, treeStatus] = after.stdout.split('---\n');
        assert(subLog.trim().split('\n').join('|') === 'Sub work|Base sub moved|first',
          `the base submodule has the work on top of its own, got ${JSON.stringify(subLog)} (${JSON.stringify(landed.message)})`);
        const [subMain, pointer, main, head] = pointers.trim().split('\n');
        assert(pointer === subMain, `the base's pointer is the rebased submodule commit, got ${JSON.stringify(pointers)}`);
        assert(main === head, `and main is level with the branch, got ${JSON.stringify(pointers)}`);
        assert(baseStatus.trim() === '' && treeStatus.trim() === '',
          `with neither checkout left showing a moved submodule, got ${JSON.stringify({ baseStatus, treeStatus })}`);
        assert(stepOf(await workspaceTrack(session, ws), 'land')?.state === 'done',
          'and the track says everything is in main');
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `git -C ${outer} worktree remove --force ../${tree}; rm -rf ${tree} ${outer} ${inner}`).catch(() => {});
      }
    });
  });
}
