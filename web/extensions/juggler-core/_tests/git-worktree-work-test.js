//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Working in a worktree: committing what is in it, landing it on the
 * repository's own branch, what its status says along the way, and that all of
 * it is translated.
 *
 * Split from git-worktree-lifecycle-test so each suite fits a unit suite's
 * budget where every git command is a process launch through WSL.
 * @module _tests/git-worktree-work-test
 */

import { waitFor, assert, withTimeout } from '../../../js-tests/utilities/test-helpers.js';
import { unregisterWorkspace, listWorkspaces } from '../../../js/services/workspaces.js';
import { provisionWorkspace, workspaceStatus, finishWorkspace } from '../../../js/services/workspace-provisioning.js';
import GitWorktreeWorkspaceProvider, { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';
import api from '../../../js/services/api.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import {
  runWorktreeSuite,
  PROVIDER_ID,
  BRANCH,
  uniqueTag,
  makeConversation,
  mustRun,
  buildRepo,
  SHELL_WAIT_MS,
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

/** juggler-core's English for what the worktree says once it exists, standing in for its catalogue. */
const CORE_TEXT = [
  "Couldn't make a worktree: {repoRoot} is not a git repository.",
  "Couldn't make a worktree at {location}: there is already something there.",
  'Creating the worktree',
  'Setting the worktree up',
  'The worktree directory is missing.',
  'No git repository there.',
  'repo {name}',
  'branch {branch}',
  'clean',
  '{count} changed',
  '{count} ahead',
  'Detached head',
  'Untracked',
  'Commit the changes',
  '{target, select, named {Commits everything here onto {branch}. You carry on working in this workspace.} other {Commits everything here onto its branch. You carry on working in this workspace.}}',
  'Message',
  'What this work does',
  'Commit',
  'What changed and why, in the words you would use to someone who has not read it.',
  'Let this conversation write it',
  'It has read the work; the commit happens on its next turn.',
  'Fast-forward {repoTarget, select, named {{repo}} other {the repository}} to {branchTarget, select, named {{branch}} other {this branch}}',
  "{branchTarget, select, named {Runs git merge --ff-only {branch}} other {Runs git merge --ff-only with this worktree's branch}} in {repoTarget, select, named {{repo}} other {the repository}}, moving the branch it has checked out to this one. Git refuses it if that branch has diverged. The worktree is untouched.",
  'Close the workspace, keep the worktree',
  '{target, select, named {The worktree and {branch} stay on disk, ready to be adopted again. Conversations here go to the bin, which they can be restored from.} other {The worktree and its branch stay on disk, ready to be adopted again. Conversations here go to the bin, which they can be restored from.}}',
  'Close the workspace and delete the worktree',
  'Deletes the worktree and the branch {branch}, with every commit on it. Conversations here go to the bin, which they can be restored from.',
  "Deletes the worktree and everything in it, committed or not. The branch wasn't made by Juggler, so it stays. Conversations here go to the bin, which they can be restored from.",
  "Closed the workspace. {dirTarget, select, named {{dir}} other {The worktree}} and {branchTarget, select, named {{branch}} other {its branch}} are still on disk.",
  '{name} has no action "{actionId}".',
  "Enter a commit message — there is no conversation here to write one.",
  "The conversation will write the commit message and commit on its next turn.",
  "Couldn't stage the changes.",
  "Couldn't stage the changes.\n\n{detail}",
  "Nothing to commit — there are no changes.",
  "Couldn't make the commit.",
  "Couldn't make the commit.\n\n{detail}",
  '{target, select, named {Committed on {branch}.} other {Committed on its branch.}}',
  "Can't fast-forward: {repoTarget, select, named {{repo}} other {the repository}} can't be reached from {baseTarget, select, named {{base}} other {the base workspace}}.",
  "Can't remove the worktree: {repoTarget, select, named {{repo}} other {the repository}} can't be reached from {baseTarget, select, named {{base}} other {the base workspace}}.",
  "Can't fast-forward: there's no record of which branch this worktree is on.",
  '{count, plural, one {This worktree has an uncommitted change. Commit it first — a fast-forward moves commits, and it would be left behind.} other {This worktree has {count} uncommitted changes. Commit them first — a fast-forward moves commits, and these would be left behind.}}',
  "Couldn't find out which branch the repository has checked out.",
  "Couldn't find out which branch the repository has checked out.\n\n{detail}",
  "Can't fast-forward: {repo} isn't on a branch (its HEAD is detached).",
  "{into} has moved on since this worktree was made, so it can't be fast-forwarded to {branch}. Merge or rebase it yourself.",
  "{into} has moved on since this worktree was made, so it can't be fast-forwarded to {branch}. Merge or rebase it yourself.\n\n{detail}",
  '{into} is already up to date with {branch}.',
  'Fast-forwarded {into} to {branch}.',
  "Can't remove the worktree: there's no record of which repository it belongs to.",
  '{target, select, branch {Removed {dir} and {branch}.} other {Removed {dir}.}}',
  '{dir} is still there.',
  '{dir} is not a worktree of {repo} any more.',
  '{target, select, named {{dir} is on {branch} now, not {expected}.} other {{dir} is on no branch now, not {expected}.}}',
  '{dir} — a worktree of {repo} with no workspace',
  'Nothing was checkpointed, so there is nothing to undo.',
  '{dir} is still there and could not be removed.',
  'Removed {dir}.'
];

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run the git-worktree-work tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  return runWorktreeSuite('git-worktree-work-test', async ({ run, ops, session, projectPath, separator, release }) => {
    await run('committing puts what is in the tree onto its branch', async () => {
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      /** @type {any} */
      let conversation = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });
        await mustRun(ops, `echo the-work > ${tree}/done.txt`);

        conversation = await makeConversation(session, 'commits-its-work');
        release(conversation);

        // No message: the conversation is the one thing here that has read the
        // work, so it is asked to write one. Nothing is finished by that — the
        // commit happens in its next turn.
        const asked = await finishWorkspace({
          session,
          workspace: outcome.workspace,
          conversation,
          actionId: 'commit'
        });
        assert(asked.done === false,
          `a commit nobody has written a message for does not finish anything, got ${JSON.stringify(asked)}`);
        await waitFor(() => conversation.rootMessageThread.items.some(
          (/** @type {any} */ item) => item?.get?.('type') === 'user'
            && /commit/i.test(String(item?.get?.('content') ?? ''))),
        { description: 'the conversation to be asked to write the commit' });
        assert((await mustRun(ops, `git -C ${tree} status --porcelain`)).stdout.includes('done.txt'),
          'with the work still uncommitted, waiting for that turn');

        const written = await withTimeout(finishWorkspace({
          session,
          workspace: outcome.workspace,
          conversation,
          actionId: 'commit',
          input: { message: 'Did the thing' }
        }), SHELL_WAIT_MS, 'the commit with a message to be made');
        // Committing is not a way of being finished with the place the commit
        // was made in, and it does not report itself as one: the workspace is
        // still in use, the conversation is still working here, and being done
        // is a separate row in a separate group of the menu. It once returned
        // `done` here and not on the path above — one field in one dialog,
        // deciding whether the workspace closed, and saying so nowhere.
        assert(written.done === false,
          `a commit leaves the workspace in use, got ${JSON.stringify(written)}`);
        assert(/committed/i.test(String(written.message ?? '')),
          `while still saying it happened, got ${JSON.stringify(written.message)}`);
        const still = (await listWorkspaces()).find((/** @type {any} */ w) => w.id === outcome.workspace.id);
        assert(still?.state === 'ready',
          `with the workspace still there to go on working in, got ${JSON.stringify(still?.state)}`);
        const subject = await mustRun(ops, `git -C ${tree} log -1 --pretty=%s`);
        assert(subject.stdout.trim() === 'Did the thing',
          `under the message that was typed, got ${JSON.stringify(subject.stdout)}`);
        const left = await mustRun(ops, `git -C ${tree} status --porcelain`);
        assert(left.stdout.trim() === '',
          `and the tree is clean afterwards, got ${JSON.stringify(left.stdout)}`);
        const branchOf = await mustRun(ops, `git -C ${tree} rev-parse --abbrev-ref HEAD`);
        assert(branchOf.stdout.trim() === BRANCH,
          `on its own branch, not the one the repository is standing on, got ${JSON.stringify(branchOf.stdout)}`);
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `git -C ${repo} worktree remove --force ../${tree}; rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('landing moves the repository’s own branch onto the work', async () => {
      // What "push it back to the repository" really is for a worktree. The
      // commit is already IN the repository the moment it exists — a worktree
      // shares the object store and the refs — so nothing is pushed anywhere.
      // What is missing is the branch the main checkout has out, and moving it
      // is a fast-forward: the one way of landing work that cannot conflict and
      // therefore needs no flow around it.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });
        await mustRun(ops, `echo the-work > ${tree}/done.txt`);

        // Uncommitted work stays where it is: landing moves commits, and a tree
        // that quietly left its changes behind would be the worst kind of
        // success.
        const early = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'land' });
        assert(early.done === false && /commit/i.test(String(early.message)),
          `a tree still holding work is told to commit it first, got ${JSON.stringify(early.message)}`);
        const untouched = await mustRun(ops, `git -C ${repo} log -1 --pretty=%s`);
        assert(!untouched.stdout.includes('the-work'),
          'and nothing was landed while it said so');

        await finishWorkspace({
          session,
          workspace: outcome.workspace,
          actionId: 'commit',
          input: { message: 'Did the thing' }
        });

        const landed = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'land' });
        assert(landed.done === false,
          `landing is something you do while working here, not a way of being finished with it, got ${JSON.stringify(landed)}`);
        assert(/main/.test(String(landed.message)) && /fast-forward/i.test(String(landed.message)),
          `and it says which branch moved, and how, got ${JSON.stringify(landed.message)}`);

        const onMain = await mustRun(ops, `git -C ${repo} log -1 --pretty=%s`);
        assert(onMain.stdout.trim() === 'Did the thing',
          `the repository's own branch now has the work, which is the whole point, got ${JSON.stringify(onMain.stdout)}`);
        const here = await mustRun(ops, `git -C ${repo} rev-parse main`);
        const there = await mustRun(ops, `git -C ${tree} rev-parse HEAD`);
        assert(here.stdout.trim() === there.stdout.trim(),
          'with the two exactly level, because a fast-forward is all this does');

        // Nothing left to move, and that is not a failure either.
        const again = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'land' });
        assert(/already/i.test(String(again.message)),
          `landing what is already landed says so plainly, got ${JSON.stringify(again.message)}`);
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `git -C ${repo} worktree remove --force ../${tree}; rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('landing refuses what a fast-forward cannot do, and says what git said', async () => {
      // The two refusals worth having. A main checkout that has moved on cannot
      // be fast-forwarded at all — that is a merge, with conflicts in it, which
      // is a flow rather than a button — and a main checkout on no branch has
      // nothing to move.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });
        await mustRun(ops, `echo the-work > ${tree}/done.txt`);
        await finishWorkspace({
          session,
          workspace: outcome.workspace,
          actionId: 'commit',
          input: { message: 'Did the thing' }
        });

        // The repository carries on while the worktree works, which is what
        // having a worktree is for — and it is what makes a fast-forward
        // impossible.
        await mustRun(ops, chain(
          `echo meanwhile > ${repo}/other.txt`,
          `git -C ${repo} add -A`,
          `git -C ${repo} commit -q -m "Meanwhile, on main"`
        ));

        const diverged = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'land' });
        assert(diverged.done === false,
          `a land that could not happen is not reported as one that did, got ${JSON.stringify(diverged)}`);
        assert(/moved on/i.test(String(diverged.message)),
          `it says why in words before git's own, got ${JSON.stringify(diverged.message)}`);
        assert(/fast-forward/i.test(String(diverged.message)),
          `and keeps git's text under them, got ${JSON.stringify(diverged.message)}`);
        const stillThere = await mustRun(ops, `git -C ${repo} log -1 --pretty=%s`);
        assert(stillThere.stdout.trim() === 'Meanwhile, on main',
          `with the repository exactly as it was, got ${JSON.stringify(stillThere.stdout)}`);

        // On no branch at all: there is nothing to land onto, and a merge here
        // would move a detached HEAD, which is nobody's idea of landing work.
        await mustRun(ops, `git -C ${repo} checkout -q --detach`);
        const detached = await finishWorkspace({ session, workspace: outcome.workspace, actionId: 'land' });
        assert(/branch/i.test(String(detached.message)) && detached.done === false,
          `a repository on no branch is told as that, got ${JSON.stringify(detached.message)}`);
      } finally {
        if (outcome) await unregisterWorkspace(outcome.workspace.id).catch(() => {});
        await shell(ops, `git -C ${repo} worktree remove --force ../${tree}; rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('a commit that will not go through says which half refused, in git’s own words', async () => {
      // Every one of these is ordinary — a lock left by a crashed git, a
      // pre-commit hook that fails the lint, a tree somebody already committed
      // from a terminal — and the only thing the user gets is the sentence this
      // returns. Two things it must do: keep git's own text, which is the half
      // that says what to do about it, and put a plain lead above it saying
      // which of the two commands refused, because `git add` failing and `git
      // commit` failing want opposite reactions.
      const provider = new GitWorktreeWorkspaceProvider({ session });
      /** @type {any[]} */
      const asked = [];
      /**
       * @param {(command: string) => any} answer - What git says to each command.
       * @returns {any} Operations that record what they were asked and answer for git.
       */
      const recorder = (answer) => ({
        /**
         * @param {any} request - What the provider wants run.
         * @returns {Promise<any>} What git said about it.
         */
        shell: async (request) => {
          asked.push(request);
          // Both streams merged into `stdout` with an empty `stderr`, which is
          // what the shell operation really answers with.
          return { stderr: '', exitCode: 1, ...answer(String(request.command)) };
        }
      });
      /**
       * @param {(command: string) => any} answer - What git says.
       * @returns {Promise<any>} What the commit reported.
       */
      const commit = (answer) => provider.finish(
        { meta: { branch: BRANCH, dir: 'the-tree' } },
        'commit',
        {
          session,
          ops: recorder(answer),
          baseOps: recorder(answer),
          input: { message: 'Did the thing' },
          signal: new AbortController().signal
        });

      const locked = await commit((command) => (command.startsWith('git add')
        ? { success: false, stdout: 'fatal: Unable to create \'.git/index.lock\': File exists.', exitCode: 128 }
        : { success: true, stdout: '', exitCode: 0 }));
      assert(locked.done === false && /Couldn't stage/.test(String(locked.message)),
        `staging refused is said as staging refused, got ${JSON.stringify(locked.message)}`);
      assert(/index\.lock/.test(String(locked.message)),
        `with git's own reason under it rather than in place of it, got ${JSON.stringify(locked.message)}`);

      const hooked = await commit((command) => (command.startsWith('git commit')
        ? { success: false, stdout: '.husky/pre-commit: 3 problems (3 errors)', exitCode: 1 }
        : { success: true, stdout: '', exitCode: 0 }));
      assert(/Couldn't make the commit/.test(String(hooked.message)),
        `and a commit refused is said as the commit refusing, which is a different thing to go and fix, got ${JSON.stringify(hooked.message)}`);
      assert(/pre-commit/.test(String(hooked.message)),
        `carrying what the hook printed, got ${JSON.stringify(hooked.message)}`);

      // Not a failure at all, and reported as the fact it is. It is what a
      // second press lands on, and what a tree somebody committed from a
      // terminal answers — neither of them is anything gone wrong.
      const idle = await commit((command) => (command.startsWith('git commit')
        ? { success: false, stdout: 'nothing to commit, working tree clean', exitCode: 1 }
        : { success: true, stdout: '', exitCode: 0 }));
      assert(/nothing/i.test(String(idle.message)) && !/Couldn't/.test(String(idle.message)),
        `a tree with nothing in it to commit is told plainly, not reported as a failure, got ${JSON.stringify(idle.message)}`);

      // The deadline. A repository whose pre-commit hook runs the linter takes
      // longer than the operations' 30s default, and what that default does is
      // kill git's process group with everything already staged and nothing on
      // screen to say so.
      assert(asked.length > 0 && asked.every((request) => Number(request.timeout) > 30000),
        `every command a commit runs outlives the default deadline, got ${JSON.stringify(asked.map((r) => r.timeout))}`);
    });

    await run('a new tree reports itself clean, and says so again once it is not', async () => {
      // What the chip and the panel both read. The tree is asked through the
      // host's own `workspaceStatus`, which is how a surface asks — so a provider
      // that threw, or that answered nothing, comes back with no `dirty` at all
      // and fails these assertions rather than passing them.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const location = defaultLocation(`${projectPath}${separator}${repo}`, BRANCH);
      const tree = `${repo}-feat-tunnels`;
      /** @type {any} */
      let outcome = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        outcome = await provisionWorkspace({
          session,
          providerId: PROVIDER_ID,
          values: { repo, branch: BRANCH, base: 'main', location }
        });

        const fresh = await workspaceStatus(session, outcome.workspace);
        assert(fresh.dirty === false,
          `a tree nobody has touched holds no work of the user's, got ${JSON.stringify(fresh)}`);
        assert(outcome.workspace.label === BRANCH,
          `and is named by its branch, got ${JSON.stringify(outcome.workspace.label)}`);
        assert((fresh.detail ?? '').includes('clean') && (fresh.detail ?? '').includes(BRANCH),
          `which is what it says, along with the branch it says it of, got ${JSON.stringify(fresh.detail)}`);
        // And which repository that branch is in. A branch name is half an
        // address: someone with three checkouts open is deciding which of them
        // they are about to commit into, and the root, the branch and the counts
        // would read the same for a worktree of any of them.
        assert((fresh.detail ?? '').includes(repo),
          `and the repository it is a worktree of, got ${JSON.stringify(fresh.detail)}`);

        // Ours, not theirs. Nothing of Juggler's is written into a workspace
        // root any more, but a tree made by an older build may still hold one,
        // and reading it as the user's work would offer to commit a directory
        // they never made.
        await mustRun(ops, chain(`mkdir -p ${tree}/.juggler`, `echo leftovers > ${tree}/.juggler/spill.json`));
        const ours = await workspaceStatus(session, outcome.workspace);
        assert(ours.dirty === false,
          `a stray .juggler/ is not the user's work, got ${JSON.stringify(ours)}`);

        await mustRun(ops, `echo scribble > ${tree}/notes.txt`);
        const theirs = await workspaceStatus(session, outcome.workspace);
        assert(theirs.dirty === true,
          `a file they wrote is, got ${JSON.stringify(theirs)}`);
        assert((theirs.detail ?? '').includes('1 changed'),
          `and it is counted once, not twice, got ${JSON.stringify(theirs.detail)}`);
      } finally {
        if (outcome) await outcome.undo().catch(() => {});
        await shell(ops, `rm -rf ${tree} ${repo}`).catch(() => {});
      }
    });

    await run('everything the worktree says once it is being made, used and finished is translated under en-XA', async () => {
      /** @type {Record<string, string>} */
      const shown = {};
      /** @type {string[]} What the conversation was sent, which the model reads. */
      const sent = [];
      const provider = new GitWorktreeWorkspaceProvider({});
      /** @type {any} The private hooks, which a test may reach. */
      const hooks = provider;
      // The manifest's name is English by decision; it is data here.
      const manifestName = String(provider.getManifest().name);
      /**
       * A shown line with its data mapped to digits.
       * @param {any} text - What was shown.
       * @returns {string} The line, ready for the check.
       */
      const scrub = (text) => String(text).split(manifestName).join('9');

      // The status endpoint is the server's; this case owns its answer.
      const realStatus = Object.prototype.hasOwnProperty.call(api, 'getGitStatus')
        ? /** @type {any} */ (api).getGitStatus : null;
      /** @type {any} */
      let gitStatus = { repos: [] };
      /** @type {any} */ (api).getGitStatus = async () => gitStatus;
      try {
        await underPseudoLocale('git-worktree-lifecycle-test', async () => {
          // Every shell command stubbed: nothing on disk is made, changed or looked at.
          /** @type {(command: string) => any} */
          let respond = () => ({ success: false, stdout: '', stderr: '', exitCode: 1 });
          const shell = async (/** @type {any} */ { command }) => respond(String(command));
          const ops = {
            shell,
            shellStreaming: async (/** @type {any} */ { command }) => respond(String(command))
          };
          /** @type {string[]} */
          const steps = [];
          let root = '/1';
          const ctx = {
            session: { projectPath: '/1', workspaceRoot: () => root },
            baseWorkspaceId: '',
            ops,
            baseOps: ops,
            signal: new AbortController().signal,
            rollback: { push: () => {} },
            checkpoint: async () => {},
            progress: (/** @type {string} */ step) => { if (!steps.includes(step)) steps.push(step); }
          };
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
          const values = { branch: '4', location: '/1/5' };

          // Provision: both refusals, then all the way through with a hook.
          shown['not a repository'] = await thrown(() => provider.provision(values, ctx));
          respond = () => ({ success: true, stdout: '' });
          shown['occupied'] = await thrown(() => provider.provision(values, ctx));
          respond = (command) => ({
            success: !command.startsWith('test -e') && !command.includes('rev-parse --verify'),
            stdout: ''
          });
          await provider.provision(values, ctx);
          assert(steps.length === 2, `two progress steps, got ${JSON.stringify(steps)}`);
          steps.forEach((step, i) => { shown[`progress ${i}`] = step; });

          // Status: missing, not a repository, a dirty named tree, a clean detached one.
          shown['status missing'] = (await provider.status({ id: '1', available: false, meta: {} }, ctx)).detail;
          gitStatus = { repos: [] };
          shown['status no repository'] = (await provider.status({ id: '1', meta: {} }, ctx)).detail;
          gitStatus = {
            repos: [{
              path: '', branch: '4', upstream: '6', ahead: 1, behind: 0,
              changed: 1, staged: 0, total: 1, files: [{ path: '6', worktree: '?', index: '?' }]
            }]
          };
          const dirty = await provider.status({ id: '1', meta: { repoDir: '/1/3' } }, ctx);
          const dirtyPieces = String(dirty.detail).split(' · ');
          assert(dirtyPieces.length === 4, `repository, branch, counts and divergence, got ${JSON.stringify(dirty.detail)}`);
          dirtyPieces.forEach((piece, i) => { shown[`dirty status ${i}`] = piece; });
          shown['file state'] = dirty.files?.[0]?.state;
          gitStatus = { repos: [{ path: '', detached: true, changed: 0, staged: 0, total: 0, files: [] }] };
          const clean = await provider.status({ id: '1', meta: {} }, ctx);
          const cleanPieces = String(clean.detail).split(' · ');
          assert(cleanPieces.length === 2, `head and clean, got ${JSON.stringify(clean.detail)}`);
          cleanPieces.forEach((piece, i) => { shown[`clean status ${i}`] = piece; });

          // Finish options, with every fallback and without.
          const named = { meta: { branch: '4', repoDir: '/1/3', dir: '/1/5', treeRel: '5', branchCreatedByUs: true } };
          const unnamed = { meta: {} };
          /**
           * Every string an option shows, wherever in it.
           * @param {string} prefix - Which workspace.
           * @param {any} value - An option, or part of one.
           * @param {string} path - Where in it.
           */
          const collect = (prefix, value, path) => {
            if (typeof value === 'string') {
              if (/(label|description|placeholder|confirmLabel|hint)$/.test(path)) shown[`${prefix} ${path}`] = value;
            } else if (value && typeof value === 'object') {
              for (const [key, inner] of Object.entries(value)) collect(prefix, inner, `${path}.${key}`);
            }
          };
          provider.finishOptions(named).forEach((option) => collect('named', option, option.id));
          provider.finishOptions(unnamed).forEach((option) => collect('unnamed', option, option.id));

          // Finish: unbind both ways, and an action there is not.
          shown['unbind named'] = (await provider.finish(named, 'unbind', ctx)).message;
          shown['unbind unnamed'] = (await provider.finish(unnamed, 'unbind', ctx)).message;
          shown['no action'] = (await provider.finish(named, '8', ctx)).message;

          // Commit: nobody to write it, the conversation asked, and every git outcome.
          shown['commit nobody'] = (await provider.finish(named, 'commit', { ...ctx, input: {}, conversation: null })).message;
          const conversation = {
            rootMessageThread: null,
            sendMessage: async (/** @type {string} */ text) => { sent.push(text); }
          };
          shown['commit asked'] = (await provider.finish(named, 'commit', { ...ctx, input: {}, conversation })).message;
          await provider.finish(unnamed, 'commit', { ...ctx, input: {}, conversation });
          const commitCtx = { ...ctx, input: { message: '7' } };
          for (const detail of ['1', '']) {
            respond = (command) => ({ success: command !== 'git add -A', stdout: detail });
            shown[`stage failed (${detail || 'silent'})`] = (await provider.finish(named, 'commit', commitCtx)).message;
            respond = (command) => ({ success: !command.startsWith('git commit'), stdout: detail });
            shown[`commit failed (${detail || 'silent'})`] = (await provider.finish(named, 'commit', commitCtx)).message;
          }
          respond = (command) => ({ success: !command.startsWith('git commit'), stdout: 'nothing to commit' });
          shown['commit nothing'] = (await provider.finish(named, 'commit', commitCtx)).message;
          respond = () => ({ success: true, stdout: '' });
          shown['committed named'] = (await provider.finish(named, 'commit', commitCtx)).message;
          shown['committed unnamed'] = (await provider.finish({ meta: {} }, 'commit', commitCtx)).message;

          // Land: no branch, the repository out of reach both ways, uncommitted
          // work, git refusing each step with and without saying why, and success.
          shown['land no branch'] = (await provider.finish(unnamed, 'land', ctx)).message;
          shown['land no repository'] = (await provider.finish({ meta: { branch: '4' } }, 'land', ctx)).message;
          root = '';
          shown['land no base'] = (await provider.finish(named, 'land', ctx)).message;
          shown['discard no base'] = (await provider.finish(named, 'discard', ctx)).message;
          root = '/1';
          for (const porcelain of [' M 6\n', ' M 6\n M 7\n']) {
            respond = () => ({ success: true, stdout: porcelain });
            shown[`land uncommitted ${porcelain.length}`] = (await provider.finish(named, 'land', ctx)).message;
          }
          /**
           * Answer each command the land runs.
           * @param {any} head - What `rev-parse --abbrev-ref` says.
           * @param {any} merge - What `merge --ff-only` says.
           * @returns {(command: string) => any} The responder.
           */
          const landing = (head, merge) => (command) => {
            if (command.includes('rev-parse --abbrev-ref')) return head;
            if (command.includes('merge --ff-only')) return merge;
            return { success: true, stdout: '' };
          };
          const out = { success: true, stdout: '2' };
          for (const detail of ['1', '']) {
            respond = landing({ success: false, stdout: detail }, out);
            shown[`land head failed (${detail || 'silent'})`] = (await provider.finish(named, 'land', ctx)).message;
            respond = landing(out, { success: false, stdout: detail });
            shown[`land refused (${detail || 'silent'})`] = (await provider.finish(named, 'land', ctx)).message;
          }
          respond = landing({ success: true, stdout: 'HEAD' }, out);
          shown['land detached'] = (await provider.finish(named, 'land', ctx)).message;
          respond = landing(out, { success: true, stdout: 'Already up to date.' });
          shown['land up to date'] = (await provider.finish(named, 'land', ctx)).message;
          respond = landing(out, { success: true, stdout: '' });
          shown['landed'] = (await provider.finish(named, 'land', ctx)).message;

          // Discard: no record, removed with and without the branch, still there.
          shown['discard no record'] = (await provider.finish(unnamed, 'discard', ctx)).message;
          respond = () => ({ success: true, stdout: 'REMOVED' });
          shown['discarded with branch'] = (await provider.finish(named, 'discard', ctx)).message;
          shown['discarded'] = (await provider.finish({ meta: { ...named.meta, branchCreatedByUs: false } }, 'discard', ctx)).message;
          respond = () => ({ success: true, stdout: '', stderr: '' });
          shown['discard left'] = (await provider.finish(named, 'discard', ctx)).message;

          // Reconcile: a tree gone, a tree on another branch, one on none, and one with no row.
          respond = (command) => (command === 'git worktree list --porcelain'
            ? {
              success: true,
              stdout: 'worktree /1\nbranch refs/heads/1\n\nworktree /1/2\nbranch refs/heads/2\n\nworktree /1/3\ndetached\n\nworktree /1/6\nbranch refs/heads/6\n'
            }
            : { success: false, stdout: '' });
          /**
           * A row of this provider's.
           * @param {string} tree - Its tree, relative to the repository.
           * @returns {any} The row.
           */
          const row = (tree) => ({ id: tree, root: `/1/${tree}`, meta: { repoDir: '/1', treeRel: tree, dir: `/1/${tree}`, branch: '4' } });
          const report = await provider.reconcile([row('7'), row('2'), row('3')], ctx);
          assert(report.orphanedWorkspaces.length === 3 && report.orphanedArtifacts.length === 1,
            `three orphans and one unclaimed tree, got ${JSON.stringify(report)}`);
          report.orphanedWorkspaces.forEach((/** @type {any} */ orphan) => { shown[`reconcile ${orphan.id}`] = orphan.reason; });
          shown['unclaimed'] = report.orphanedArtifacts[0].detail;

          // Cleanup: nothing checkpointed, a tree that would not go, one that did.
          assert((await hooks.cleanupPartial(unnamed, ctx)).removed === false, 'nothing checkpointed is not removed');
          respond = () => ({ success: true, stdout: '' });
          assert((await hooks.cleanupPartial(named, ctx)).removed === false, 'a tree that would not go is not removed');
          respond = () => ({ success: false, stdout: '' });
          assert((await hooks.cleanupPartial(named, ctx)).removed === true, 'a tree that went is removed');
        }, { '@juggler/core': CORE_TEXT });
      } finally {
        if (realStatus) /** @type {any} */ (api).getGitStatus = realStatus;
        else delete (/** @type {any} */ (api)).getGitStatus;
      }

      // The model reads what the conversation is sent, so it stays English.
      assert(JSON.stringify(sent) === JSON.stringify([
        'Commit the work in this worktree (branch 4), with a message describing it.',
        'Commit the work in this worktree, with a message describing it.'
      ]), `the conversation is asked in English, got ${JSON.stringify(sent)}`);

      const english = Object.entries(shown).filter(([, text]) => !isPseudoLocalized(scrub(text)));
      assert(english.length === 0, `still English under en-XA: ${JSON.stringify(english)}`);
    });

  });
}
