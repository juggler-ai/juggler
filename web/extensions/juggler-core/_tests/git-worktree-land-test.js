//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Landing a worktree's work in its base checkout: the track that says where
 * the work is, rebasing and merging it in, and stopping on a conflict. The
 * other places work lands are in git-worktree-land-targets-test.
 *
 * Its own suite, apart from git-worktree-work-test, so each fits a unit
 * suite's budget where every git command is a process launch through WSL.
 * @module _tests/git-worktree-land-test
 */

import { assert, withTimeout } from '../../../js-tests/utilities/test-helpers.js';
import { unregisterWorkspace } from '../../../js/services/workspaces.js';
import {
  provisionWorkspace,
  workspaceTrack,
  workspaceFinishOptions,
  finishWorkspace
} from '../../../js/services/workspace-provisioning.js';
import { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';
import {
  runWorktreeSuite,
  PROVIDER_ID,
  BRANCH,
  uniqueTag,
  mustRun,
  buildRepo,
  SHELL_WAIT_MS,
  shell,
  chain
} from './git-worktree-helpers.js';

/**
 * This suite builds real git repositories inside the shared fixture project and
 * removes them again, so no sibling lane may be in flight while it runs: a lane
 * walking the project would read a file a case here is in the middle of
 * deleting.
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
 * Run the git-worktree-land tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  return runWorktreeSuite('git-worktree-land-test', async ({ run, ops, session, projectPath, separator }) => {
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
    /**
     * @param {any} step - A step.
     * @returns {string[]} Its action ids.
     */
    const actionsOf = (step) => (step?.actions ?? []).map((/** @type {any} */ a) => a.id);
    /**
     * The three steps' states, for a message.
     * @param {any} track - A track.
     * @returns {string} e.g. `commit:done land:now close:wait`.
     */
    const states = (track) => (track?.steps ?? []).map((/** @type {any} */ s) => `${s.id}:${s.state}`).join(' ');

    await run('the track follows the work from uncommitted to landed, rebasing onto a base that moved', async () => {
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

        // Uncommitted: committing is the thing to do, and landing waits on it.
        const dirty = await workspaceTrack(session, ws);
        assert(states(dirty) === 'commit:now land:wait close:wait',
          `uncommitted work makes committing the step, got ${states(dirty)} ${JSON.stringify(dirty)}`);
        const commitStep = stepOf(dirty, 'commit');
        assert(commitStep.files?.some((/** @type {any} */ f) => f.path === 'done.txt'),
          `and the step lists what it will take, got ${JSON.stringify(commitStep.files)}`);
        const commitAction = commitStep.actions?.[0];
        assert(commitAction?.id === 'commit' && commitAction.primary && commitAction.input,
          `through a primary commit action with a field, got ${JSON.stringify(commitStep.actions)}`);
        assert(!commitAction.alternative,
          `and no "let the conversation write it" with no conversation here, got ${JSON.stringify(commitAction)}`);
        const early = await act(ws, 'land');
        assert(early.done === false && /commit/i.test(String(early.message)),
          `a land asked for anyway is refused until the work is committed, got ${JSON.stringify(early)}`);

        await commitIn(ws, 'Did the thing');
        const ahead = await workspaceTrack(session, ws);
        assert(states(ahead) === 'commit:done land:now close:wait',
          `committed work makes landing the step, got ${states(ahead)}`);
        const land = stepOf(ahead, 'land');
        assert(land.commits?.[0]?.subject === 'Did the thing' && land.commitCount === 1,
          `listing the commit that main lacks, got ${JSON.stringify(land)}`);
        const offered = actionsOf(land);
        assert(['land', 'land-merge', 'land-close'].every(id => offered.includes(id)) && !offered.includes('update'),
          `offering the landings, and no update from a base that has not moved, got ${JSON.stringify(offered)}`);
        assert(land.actions.find((/** @type {any} */ a) => a.id === 'land')?.primary === true,
          `with landing itself the primary, got ${JSON.stringify(land.actions)}`);
        const risky = workspaceFinishOptions(session, ws, { track: ahead }).options.find(o => o.id === 'discard');
        assert(risky?.danger === true,
          `deleting the tree now would lose a commit, and says so in red, got ${JSON.stringify(risky)}`);

        await mustRun(ops, chain(
          `echo meanwhile > ${repo}/other.txt`,
          `git -C ${repo} add -A`,
          `git -C ${repo} commit -q -m "Meanwhile, on main"`
        ));
        const behind = await workspaceTrack(session, ws);
        const moved = stepOf(behind, 'land');
        assert(moved.state === 'now' && actionsOf(moved).includes('update'),
          `a base that moved on still lands, and offers an update from it, got ${JSON.stringify(moved)}`);
        assert(/rebase/i.test(String(moved.note)),
          `saying the branch will be rebased onto it, got ${JSON.stringify(moved.note)}`);

        const landed = await act(ws, 'land');
        assert(landed.done === false, `landing leaves the workspace in use, got ${JSON.stringify(landed)}`);
        const history = await mustRun(ops, `git -C ${repo} log --format=%s main`);
        assert(history.stdout.trim().split('\n').join('|') === 'Did the thing|Meanwhile, on main|first',
          `main has the work on top of what it had, in a line, got ${JSON.stringify(history.stdout)}`);
        const level = await mustRun(ops, chain(`git -C ${repo} rev-parse main`, `git -C ${tree} rev-parse HEAD`));
        const [here, there] = level.stdout.trim().split('\n');
        assert(here === there, `and the branch and main are level, got ${JSON.stringify(level.stdout)}`);
        const checkout = await mustRun(ops, `git -C ${repo} status --porcelain`);
        assert(checkout.stdout.trim() === '', `with the base checkout's files moved along, got ${JSON.stringify(checkout.stdout)}`);

        const done = await workspaceTrack(session, ws);
        assert(states(done) === 'commit:done land:done close:now',
          `everything landed makes closing the step, got ${states(done)}`);
        assert(stepOf(done, 'close').actions?.[0]?.id === 'discard',
          `by deleting the tree, got ${JSON.stringify(stepOf(done, 'close'))}`);
        const safe = workspaceFinishOptions(session, ws, { track: done }).options.find(o => o.id === 'discard');
        assert(Boolean(safe) && !safe?.danger, `which loses nothing now and is not red, got ${JSON.stringify(safe)}`);
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `git -C ${repo} worktree remove --force ../${tree}; rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('a landing that conflicts stops in the worktree, and abort puts the branch back', async () => {
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisioned(repo);
        const ws = outcome.workspace;
        await mustRun(ops, `echo ours > ${tree}/greeting.txt`);
        await commitIn(ws, 'Ours');
        await mustRun(ops, chain(`echo theirs > ${repo}/greeting.txt`, `git -C ${repo} commit -q -am Theirs`));
        const before = await mustRun(ops, chain(`git -C ${repo} rev-parse main`, `git -C ${tree} rev-parse HEAD`));
        const [mainBefore, branchBefore] = before.stdout.trim().split('\n');

        const stopped = await act(ws, 'land');
        assert(stopped.done === false && /greeting\.txt/.test(String(stopped.message)),
          `it says which file conflicts, got ${JSON.stringify(stopped)}`);
        const mainAfter = await mustRun(ops, `git -C ${repo} rev-parse main`);
        assert(mainAfter.stdout.trim() === mainBefore, 'and main has not been touched');

        const blocked = await workspaceTrack(session, ws);
        const land = stepOf(blocked, 'land');
        assert(land?.state === 'blocked' && land.files?.some((/** @type {any} */ f) => f.path === 'greeting.txt'),
          `the track says the landing is stuck, on what, got ${JSON.stringify(blocked)}`);
        const offered = actionsOf(land);
        assert(offered.includes('continue') && offered.includes('abort') && !offered.includes('resolve'),
          `offering continue and abort, and no conversation to resolve it with none here, got ${JSON.stringify(offered)}`);
        assert(stepOf(blocked, 'commit')?.state === 'done',
          `and the conflict is not taken for uncommitted work, got ${states(blocked)}`);

        const aborted = await act(ws, 'abort');
        assert(aborted.done === false, `abort keeps the workspace, got ${JSON.stringify(aborted)}`);
        const after = await mustRun(ops, chain(`git -C ${tree} rev-parse HEAD`, `git -C ${tree} status --porcelain`));
        assert(after.stdout.trim() === branchBefore,
          `the branch is back where it was, and clean, got ${JSON.stringify(after.stdout)}`);
        assert(states(await workspaceTrack(session, ws)) === 'commit:done land:now close:wait',
          'with landing the next step again');
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `git -C ${repo} worktree remove --force ../${tree}; rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('merge-landing makes a merge commit in the base', async () => {
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
        await commitIn(ws, 'Did the thing');
        await mustRun(ops, chain(`echo meanwhile > ${repo}/other.txt`, `git -C ${repo} add -A`, `git -C ${repo} commit -q -m Meanwhile`));

        const merged = await act(ws, 'land-merge');
        assert(merged.done === false, `a merge leaves the workspace in use, got ${JSON.stringify(merged)}`);
        const shape = await mustRun(ops, chain(
          `git -C ${repo} rev-list --merges --count main`,
          `git -C ${repo} merge-base --is-ancestor ${BRANCH} main && echo contains`,
          `git -C ${repo} status --porcelain`
        ));
        assert(shape.stdout.trim() === '1\ncontains',
          `main gains one merge commit holding the branch, and a clean checkout, got ${JSON.stringify(shape.stdout)}`);
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `git -C ${repo} worktree remove --force ../${tree}; rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

  });
}
