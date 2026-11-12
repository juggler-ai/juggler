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
import {
  provisionWorkspace,
  workspaceStatus,
  finishWorkspace
} from '../../../js/services/workspace-provisioning.js';
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
  "Can't remove the worktree: {repoTarget, select, named {{repo}} other {the repository}} can't be reached from {baseTarget, select, named {{base}} other {the base workspace}}.",
  "Can't remove the worktree: there's no record of which repository it belongs to.",
  '{target, select, branch {Removed {dir} and {branch}.} other {Removed {dir}.}}',
  '{dir} is still there.',
  '{dir} is not a worktree of {repo} any more.',
  '{target, select, named {{dir} is on {branch} now, not {expected}.} other {{dir} is on no branch now, not {expected}.}}',
  '{dir} — a worktree of {repo} with no workspace',
  '{dir} is still there and could not be removed.',
  'Removed {dir}.',
  "A submodule this branch repoints can't be landed in the base checkout.",
  "Can't land {name}: its copy in the base checkout has uncommitted changes.",
  "Can't land {name}: this branch repoints it, and its copy in the base checkout has no branch to land those commits on.",
  "Can't land: there's no record of which branch this worktree is on.",
  "Can't land: {base} is checked out in another worktree, {dir}, which would be left behind.",
  "Can't land: {repoTarget, select, named {{repo}} other {the repository}} can't be reached from {baseTarget, select, named {{base}} other {the base workspace}}.",
  "Can't merge: {base} isn't checked out in {repo}, and a merge needs a checkout to happen in. Land instead.",
  "Can't merge: {name} has moved on in the base checkout, so its commits have to be rebased. Land instead, which rebases them.",
  "Close and delete",
  "Close and delete the worktree",
  "Continue",
  "Couldn't merge {name} into {base}, so nothing was changed.",
  "Couldn't merge {name} into {base}, so nothing was changed.\n\n{detail}",
  "Couldn't move {base} to the work. {name} has been rebased onto it, so nothing is lost.",
  "Couldn't move {base} to the work. {name} has been rebased onto it, so nothing is lost.\n\n{detail}",
  "Couldn't read how the worktree stands against its base.",
  "Couldn't read how the worktree stands against its base.\n\n{detail}",
  "Couldn't stop it.",
  "Couldn't stop it.\n\n{detail}",
  "Deletes the worktree, and with it what exists only here: {lost}. Conversations here go to the bin, which they can be restored from.",
  "Everything is committed",
  "Everything is in {base}",
  "Have the conversation resolve it",
  "Land and close",
  "Land in {base}",
  "Landed in {base}, but {name} couldn't be moved in the base checkout.",
  "Landed in {base}, but {name} couldn't be moved in the base checkout.\n\n{detail}",
  "Merge into {base}",
  "Merged {name} into {base}.",
  "No branch to land in",
  "Nothing here is lost: every commit is in the base branch. Deletes the worktree and the branch {branch}. Conversations here go to the bin, which they can be restored from.",
  "Nothing here is lost: every commit is in the base branch. Deletes the worktree. Conversations here go to the bin, which they can be restored from.",
  "Nothing is lost: everything here is in {base}. The branch wasn't made by Juggler, so it stays. Conversations here go to the bin.",
  "Nothing is lost: {name} and its commits are all in {base}. Conversations here go to the bin.",
  "Nothing to land: everything here is already in {base}.",
  "Once everything is in {base}.",
  "Rebased {name} onto {base}.",
  "Rebasing {name} onto {onto} stopped. {base} hasn't been touched.",
  "Rebasing {name} onto {onto} stopped. {base} hasn't been touched.\n\n{detail}",
  "Submodules that moved on in the base checkout are rebased onto it first.",
  "The conversation will resolve the conflicts on its next turn.",
  "The worktree is in the middle of a rebase or a merge. Continue or abort it first.",
  "There is no conversation here to hand the conflicts to.",
  "There is no rebase or merge in progress here.",
  "Update from {base}",
  "What this work does, and why",
  "{count, plural, =0 {Submodule commits not yet in {base}} one {# commit not yet in {base}} other {# commits not yet in {base}}}",
  "{count, plural, one {# commit in a submodule} other {# commits in submodules}}",
  "{count, plural, one {# commit not in the base branch} other {# commits not in the base branch}}",
  "{count, plural, one {# file changed, not committed} other {# files changed, not committed}}",
  "{count, plural, one {# uncommitted file} other {# uncommitted files}}",
  "{count, plural, one {After the commit: {name} will have # commit not in {base}.} other {After the commit: {name} will have # commits not in {base}.}}",
  "{count, plural, one {Including the submodule {names}.} other {Including the submodules {names}.}}",
  "{count, plural, one {Landed # commit in {base}} other {Landed # commits in {base}}}{subs, plural, =0 {.} one {, and # in a submodule.} other {, and # in submodules.}}",
  "{count, plural, one {Rebasing {name} onto {onto} stopped: {files} conflicts. {base} hasn't been touched.} other {Rebasing {name} onto {onto} stopped: # files conflict ({files}). {base} hasn't been touched.}}",
  "{count, plural, one {Submodule, # commit not in its {branch}} other {Submodule, # commits not in its {branch}}}",
  "{count, plural, one {This worktree has an uncommitted change. Commit it first — landing moves commits, and it would be left behind.} other {This worktree has # uncommitted changes. Commit them first — landing moves commits, and these would be left behind.}}",
  "{count, plural, one {{base} has # commit {name} doesn't have, so {name} is rebased onto it first.} other {{base} has # commits {name} doesn't have, so {name} is rebased onto it first.}}",
  "{count, plural, one {{base} has # commit {name} doesn't have, so {name} is rebased onto it first: submodules, then this repository.} other {{base} has # commits {name} doesn't have, so {name} is rebased onto it first: submodules, then this repository.}}",
  "{kind, select, rebase {Abort the rebase} other {Abort the merge}}",
  "{kind, select, rebase {Finished rebasing {name} onto {onto}.} other {Finished the merge into {name}.}}",
  "{kind, select, rebase {Stopped the rebase: {name} is back where it was.} other {Stopped the merge: {name} is back where it was.}}",
  "{kind, select, rebase {{base} hasn't been touched. The worktree is mid-rebase.} other {The worktree is mid-merge.}}",
  "{kind, select, rebase {{count, plural, =0 {Rebasing {name} onto {onto} stopped} one {Rebasing {name} onto {onto} stopped: # file conflicts} other {Rebasing {name} onto {onto} stopped: # files conflict}}} other {{count, plural, =0 {Merging into {name} stopped} one {Merging into {name} stopped: # file conflicts} other {Merging into {name} stopped: # files conflict}}}}",
  "{name} already has everything in {base}.",
  "{repo} isn't on a branch, and this worktree has no record of the branch it came from.",
  "{target, select, none {Can't land {name}: its copy in the base checkout isn't on a branch any more.} other {Can't land {name}: its copy in the base checkout is on {found} now, not {branch}.}}",
  "{why, select, detached {Submodule, repointed here, but its copy in the base checkout isn't on a branch to land on.} nobase {Submodule, repointed here, but the base checkout has no copy of it to land in.} other {Submodule, repointed here, but its copy in the base checkout couldn't be read.}}",
  "{status, select, modified {Modified} added {Added} deleted {Deleted} renamed {Renamed} copied {Copied} typechange {Type changed} other {Conflicted}}"
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

          // The track, landing and its neighbours: every step in every state,
          // every refusal and every outcome, against scripted git. A reading is
          // what the track's one command prints; `answer` scripts the rest by
          // the first fragment each command contains.
          /**
           * What the track's command prints, from rows of fields.
           * @param {...string[]} rows - `kind, scope, value…` each.
           * @returns {string} Its output.
           */
          const reading = (...rows) => rows.map((row) => row.join('\t')).join('\n');
          const base6 = ['base', '', '6'];
          const sub3 = (/** @type {string} */ behind, /** @type {string} */ ahead) => [
            ['head', '3', '9'], ['sub', '3', 'ok', '0', '5'], ['counts', '3', behind, ahead], ['commit', '3', '1', '2']
          ];
          const readings = {
            dirty: reading(base6, ['file', '', '?? 7'], ['counts', '', '0', '1'], ['commit', '', '1', '2']),
            ahead: reading(base6, ['counts', '', '1', '1'], ['commit', '', '1', '2'], ...sub3('0', '1')),
            plain: reading(base6, ['counts', '', '1', '1'], ['commit', '', '1', '2']),
            diverged: reading(base6, ['counts', '', '0', '1'], ['commit', '', '1', '2'], ...sub3('1', '1')),
            subOnly: reading(base6, ['counts', '', '0', '0'], ...sub3('0', '1')),
            landed: reading(base6, ['counts', '', '1', '0'], ...sub3('0', '0')),
            rebase: reading(base6, ['state', '', 'rebase'], ['unmerged', '', '7']),
            merge: reading(base6, ['state', '', 'merge']),
            subRebase: reading(base6, ...sub3('1', '1'), ['state', '3', 'rebase'], ['unmerged', '3', '8']),
            noBase: reading(['base', '', '']),
            unreachable: reading(base6, ['counts', '', '0', '1'],
              ['sub', '3', 'detached', '1', ''], ['sub', '7', 'nobase', '1', ''], ['sub', '8', 'unfetched', '1', '5'])
          };
          /**
           * A responder: the reading for the track's command, then the first
           * answer whose fragment the command contains, then success.
           * @param {string} read - What the track's command prints.
           * @param {[string, any][]} [answers] - Fragment and result.
           * @returns {(command: string) => any} The responder.
           */
          const answer = (read, answers = []) => (command) => {
            if (command.startsWith('b=')) return { success: true, stdout: read };
            const found = answers.find(([fragment]) => command.includes(fragment));
            return found ? found[1] : { success: true, stdout: '' };
          };
          const fail = (/** @type {string} */ stdout) => ({ success: false, stdout });
          const handOff = { rootMessageThread: null, sendMessage: async (/** @type {string} */ text) => { sent.push(text); } };
          /** @type {Record<string, any>} */
          const tracks = {};
          for (const [state, read] of Object.entries(readings)) {
            respond = answer(read);
            for (const [who, conversation] of [['alone', null], ['handed', handOff]]) {
              const track = await provider.track(named, { ...ctx, conversation });
              tracks[`${state} ${who}`] = track;
              (track?.steps ?? []).forEach((/** @type {any} */ step) => {
                const walk = (/** @type {any} */ value, /** @type {string} */ path) => {
                  if (typeof value === 'string') {
                    if (/(label|placeholder|hint|title|note)$/.test(path) || /files\.\d+\.state$/.test(path)) shown[`track ${state} ${who} ${path}`] = value;
                  } else if (value && typeof value === 'object') {
                    for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
                  }
                };
                walk(step, step.id);
              });
            }
          }
          respond = answer(readings.landed);
          tracks['landed theirs'] = await provider.track({ meta: { ...named.meta, branchCreatedByUs: false } }, ctx);
          tracks['landed theirs'].steps.forEach((/** @type {any} */ step) => { if (step.note) shown[`theirs ${step.id} note`] = step.note; });
          for (const detail of ['1', '']) {
            respond = () => fail(detail);
            shown[`read failed (${detail || 'silent'})`] = await thrown(() => provider.track(named, ctx));
          }

          // Deleting, as each track prices it.
          const theirs = { meta: { ...named.meta, branchCreatedByUs: false } };
          for (const [which, track] of [['dirty', tracks['dirty alone']], ['ahead', tracks['ahead alone']], ['landed', tracks['landed alone']]]) {
            for (const [whose, row] of [['ours', named], ['theirs', theirs]]) {
              const option = provider.finishOptions(row, { track }).find((/** @type {any} */ o) => o.id === 'discard');
              shown[`discard ${which} ${whose}`] = option?.description;
            }
          }

          // Refusals before anything is touched.
          shown['land no branch'] = (await provider.finish(unnamed, 'land', ctx)).message;
          for (const [state, read] of Object.entries({ noBase: readings.noBase, stuck: readings.rebase, dirty: readings.dirty, unreachable: readings.unreachable })) {
            respond = answer(read);
            shown[`land ${state}`] = (await provider.finish(named, 'land', ctx)).message;
          }
          respond = answer(reading(base6, ['file', '', '?? 7'], ['file', '', '?? 8']));
          shown['land dirty 2'] = (await provider.finish(named, 'land', ctx)).message;
          respond = answer(readings.plain);
          shown['land no repository'] = (await provider.finish({ meta: { branch: '4' } }, 'land', ctx)).message;
          root = '';
          shown['discard no base'] = (await provider.finish(named, 'discard', ctx)).message;
          root = '/1';
          respond = answer(readings.landed.replace('counts\t\t1\t0', 'counts\t\t0\t0'));
          shown['land nothing'] = (await provider.finish(named, 'land', ctx)).message;
          respond = answer(readings.diverged);
          shown['merge diverged'] = (await provider.finish(named, 'land-merge', ctx)).message;
          const side = (/** @type {string} */ subs) => ['@@subs', { success: true, stdout: `worktree /1\nbranch refs/heads/6\n@@subs\n${subs}` }];
          const away = ['@@subs', { success: true, stdout: 'worktree /1\nbranch refs/heads/1\n\nworktree /2\nbranch refs/heads/6\n@@subs\n' }];
          respond = answer(readings.plain, [/** @type {any} */ (away)]);
          shown['land elsewhere'] = (await provider.finish(named, 'land', ctx)).message;
          respond = answer(readings.plain, [['@@subs', { success: true, stdout: 'worktree /1\nbranch refs/heads/1\n@@subs\n' }]]);
          shown['merge not here'] = (await provider.finish(named, 'land-merge', ctx)).message;
          for (const [what, line] of [['other branch', '3\t1\t0'], ['no branch', '3\t\t0'], ['dirty', '3\t5\t2']]) {
            respond = answer(readings.ahead, [/** @type {any} */ (side(String(line)))]);
            shown[`land sub ${what}`] = (await provider.finish(named, 'land', ctx)).message;
          }

          // Stops on the way, and git refusing the last steps.
          const ready = side('3\t5\t0');
          for (const [what, said] of [['conflict', 'stopped\nconflict 8'], ['said', 'stopped\nsaid 1'], ['silent', 'stopped']]) {
            respond = answer(readings.diverged, [/** @type {any} */ (ready), ['patch-id', { success: true, stdout: said }]]);
            shown[`sub stopped ${what}`] = (await provider.finish(named, 'land', ctx)).message;
          }
          respond = answer(readings.plain, [/** @type {any} */ (ready), ['git rebase -q', fail('1')], ['ls-files -u', { success: true, stdout: '100644 1 1\t7\n100644 2 2\t7\n100644 3 3\t7\n100644 2 2\t8\n100644 3 3\t8' }]]);
          shown['tree stopped'] = (await provider.finish(named, 'land', ctx)).message;
          for (const detail of ['1', '']) {
            respond = answer(readings.plain, [/** @type {any} */ (ready), ['--ff-only', fail(detail)]]);
            shown[`base refused (${detail || 'silent'})`] = (await provider.finish(named, 'land', ctx)).message;
            respond = answer(readings.plain, [/** @type {any} */ (ready), ['--no-ff', fail(detail)]]);
            shown[`merge refused (${detail || 'silent'})`] = (await provider.finish(named, 'land-merge', ctx)).message;
            respond = answer(readings.subOnly, [/** @type {any} */ (ready), ["printf 'link", { success: true, stdout: 'link\t3\t9\nhead\t\t1' }], ['fetch -q "$t"', fail(detail)]]);
            shown[`sub refused (${detail || 'silent'})`] = (await provider.finish(named, 'land', ctx)).message;
          }
          respond = answer(readings.plain, [/** @type {any} */ (ready)]);
          shown['merged'] = (await provider.finish(named, 'land-merge', ctx)).message;
          respond = answer(readings.ahead, [/** @type {any} */ (ready), ["printf 'link", { success: true, stdout: 'link\t3\t9\nhead\t\t1' }]]);
          shown['landed'] = (await provider.finish(named, 'land', ctx)).message;

          // Updating, carrying on, giving up and handing it over.
          respond = answer(readings.subOnly);
          shown['update nothing'] = (await provider.finish(named, 'update', ctx)).message;
          respond = answer(readings.plain);
          shown['updated'] = (await provider.finish(named, 'update', ctx)).message;
          respond = answer(readings.plain);
          shown['continue none'] = (await provider.finish(named, 'continue', ctx)).message;
          shown['abort none'] = (await provider.finish(named, 'abort', ctx)).message;
          shown['resolve none'] = (await provider.finish(named, 'resolve', { ...ctx, conversation: handOff })).message;
          shown['resolve nobody'] = (await provider.finish(named, 'resolve', { ...ctx, conversation: null })).message;
          for (const [state, read] of [['rebase', readings.rebase], ['merge', readings.merge]]) {
            respond = answer(String(read));
            shown[`continued ${state}`] = (await provider.finish(named, 'continue', ctx)).message;
            shown[`aborted ${state}`] = (await provider.finish(named, 'abort', ctx)).message;
          }
          respond = answer(readings.rebase);
          shown['resolve asked'] = (await provider.finish(named, 'resolve', { ...ctx, conversation: handOff })).message;
          respond = answer(readings.subRebase, [['--continue', fail('1')]]);
          shown['continue stopped'] = (await provider.finish(named, 'continue', ctx)).message;
          for (const detail of ['1', '']) {
            respond = answer(readings.rebase, [['--abort', fail(detail)]]);
            shown[`abort failed (${detail || 'silent'})`] = (await provider.finish(named, 'abort', ctx)).message;
          }

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
        'Commit the work in this worktree, with a message describing it.',
        'The rebase in this worktree (branch 4) stopped on conflicts: 7. Resolve each one, keeping what both sides meant, and stage the result. Then run `GIT_EDITOR=true git rebase --continue`; if it stops again, resolve that too. Do not abort it.'
      ]), `the conversation is asked in English, got ${JSON.stringify(sent)}`);

      const english = Object.entries(shown).filter(([, text]) => !isPseudoLocalized(scrub(text)));
      assert(english.length === 0, `still English under en-XA: ${JSON.stringify(english)}`);
    });

  });
}
