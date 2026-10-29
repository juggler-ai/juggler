//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What every git-worktree suite is built out of.
 *
 * The provider's tests are split across several files because one file is one
 * suite, and a suite that runs for twenty seconds on an idle machine has no
 * headroom left on a loaded one. What they share — a real repository built in
 * the fixture, the shell helpers that build it, and the form helpers that
 * drive its setup panel — lives here so that splitting them costs no
 * duplication.
 * @module _tests/git-worktree-helpers
 */

import {
  initializeRegistries,
  createTestSession,
  releaseTestConversation,
  waitForWorkerReady,
  waitFor,
  withTimeout
} from '../../../js-tests/utilities/test-helpers.js';
import { budgetFor } from '../../../js-tests/utilities/test-deadline.js';
import { fetchJson } from '../../../js/services/http.js';
import { createBoundOps } from '../../../sdk/ops.js';
import workspaceProviderRegistry from '../../../js/registries/workspace-provider-registry.js';
import contextItemRegistry from '../../../js/registries/context-item-registry.js';
import GitWorktreeWorkspaceProvider from '../workspaces/git-worktree-workspace-provider.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/** @type {string} The provider under test, as the registry knows it. */
export const PROVIDER_ID = GitWorktreeWorkspaceProvider.MANIFEST.id;

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
export function registerProvider() {
  if (workspaceProviderRegistry.get(PROVIDER_ID)) return '';
  const registration = workspaceProviderRegistry.registerClass(GitWorktreeWorkspaceProvider, {
    extensionId: '@juggler/core',
    modulePath: '(test)'
  });
  return registration.registered ? '' : String(registration.reason);
}

/**
 * The branch most cases ask for. It carries a slash deliberately: a branch name
 * is not a directory name, and the provider has to turn one into the other.
 * @type {string}
 */
export const BRANCH = 'feat/tunnels';

/**
 * A name nothing else in this run will choose.
 *
 * The lanes of a pool share one project, and this suite writes a directory
 * beside that project — which no fixture reset ever clears, since the reset only
 * wipes inside it. Every artifact is therefore stamped and removed by the case
 * that made it.
 * @returns {string} A short unique tag.
 */
export function uniqueTag() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The directory holding a path, in the separator the path itself uses.
 *
 * Registration wants an absolute root in the server's own terms, so this keeps
 * whatever `projectPath` came back as rather than imposing POSIX on Windows.
 * @param {string} path - An absolute path.
 * @returns {{parent: string, separator: string}} Its parent, and the separator in use.
 */
function parentOf(path) {
  const separator = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  return { parent: path.replace(/[/\\][^/\\]*$/, ''), separator };
}

/**
 * A conversation, ready to be sent to: model configured and its worker up.
 * @param {any} session - The test session.
 * @param {string} name - Conversation name.
 * @param {object} [options] - Passed through to createConversation.
 * @returns {Promise<any>} The conversation.
 */
export async function makeConversation(session, name, options = {}) {
  const id = await session.createConversation(name, options);
  const conversation = session.conversations.get(id);
  if (!conversation) throw new Error(`conversation ${id} was created but is not in the session`);
  conversation.setModelConfig({ provider: 'test-provider', model: 'test-model' });
  await waitForWorkerReady(id);
  return conversation;
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
export async function readIn(session, conversation, path) {
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
 * How long one git command in this suite is waited for. Each is a local
 * operation on a repository of a few files; the figure is a bound for a
 * report, not a cost anyone expects to pay.
 * @type {number}
 */
export const SHELL_WAIT_MS = 15000;

/**
 * Run a command in the project and hand back what it said, whether or not it
 * succeeded.
 *
 * For the commands whose failure is an answer — `test -e`, `ls` of a tree that
 * should be gone — and for cleanup. The command is a named wait, so one that
 * never returns is reported by name rather than as a silent suite timeout.
 * @param {any} ops - Project-pinned operations.
 * @param {string} command - What to run.
 * @returns {Promise<any>} The result.
 */
export function shell(ops, command) {
  return withTimeout(ops.shell({ command }), SHELL_WAIT_MS, `\`${command}\` to return`);
}

/**
 * Several steps as one command, each run only if the one before it worked.
 *
 * Every command is a process launch, and where commands go through WSL a launch
 * costs a large and unsteady share of a second. A suite's time is mostly its
 * fixtures, so a fixture is one launch however many steps it has: that keeps
 * the suite's cost a matter of what it tests rather than of how many lines its
 * setup was written in.
 * @param {...string} steps - The commands, in order.
 * @returns {string} One command running them all.
 */
export function chain(...steps) {
  return steps.join(' && ');
}

/**
 * Run a command in the project and insist it worked.
 *
 * Failures carry the command and git's own words: a worktree that could not be
 * made for a reason this suite never sees is a much longer afternoon than one
 * that says `fatal: invalid reference`. The command is a named wait, so one
 * that never returns is reported by name rather than as a silent suite timeout.
 * @param {any} ops - Project-pinned operations.
 * @param {string} command - What to run.
 * @returns {Promise<any>} The result, once it has succeeded.
 */
export async function mustRun(ops, command) {
  const result = await shell(ops, command);
  if (!result.success) {
    throw new Error(`\`${command}\` failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result;
}

/**
 * Build a real repository with one commit in it, inside the project.
 *
 * Every path is relative to the project root, which is where a project-pinned
 * command starts, so nothing here depends on the platform's separator. The
 * identity and the signing flag are stated per command rather than configured,
 * because the machine running this has a global git config of its own and a
 * developer who signs their commits must not be the reason the suite fails.
 *
 * It is one command ({@link chain}): every suite builds several of these, and
 * as one launch per step they were most of the suite's time.
 * @param {any} ops - Project-pinned operations.
 * @param {string} dir - Directory name for the repository, relative to the project.
 * @param {string} greeting - Contents of the committed discriminator file.
 * @returns {Promise<void>} When there is a repository with a commit on `main`.
 */
export async function buildRepo(ops, dir, greeting) {
  const git = `git -C ${dir} -c user.name=Juggler -c user.email=tests@juggler.invalid -c commit.gpgsign=false`;
  await mustRun(ops, chain(
    `mkdir -p ${dir}`,
    `git -C ${dir} init -q`,
    // Not `init -b main`, which wants git 2.28, and not the default branch
    // name, which depends on the machine: checking out an unborn branch names
    // it here.
    `git -C ${dir} checkout -q -b main`,
    // The same identity, written into the repository rather than passed per
    // command, because the provider's own commit is the user's commit and
    // carries no identity of ours. A repository with one is what every real one
    // has, and it is what lets this run on a machine that has none.
    `git -C ${dir} config user.name Juggler`,
    `git -C ${dir} config user.email tests@juggler.invalid`,
    `git -C ${dir} config commit.gpgsign false`,
    `echo ${greeting} > ${dir}/greeting.txt`,
    `${git} add -A`,
    `${git} commit -q -m first`
  ));
}


/**
 * What the repository looks like from the outside: its worktrees and its
 * branches, as two blocks of text.
 *
 * Taken before a provision and after the undo of one, because "left the
 * repository exactly as it was found" is a claim about both lists and about
 * nothing else — a tree still registered, a branch still lying around, and the
 * next `git worktree add` at that path fails for a reason the user did nothing
 * to cause.
 * @param {any} ops - Project-pinned operations.
 * @param {string} repo - The repository, relative to the project.
 * @returns {Promise<string>} The two lists, for comparing against each other.
 */
export async function snapshot(ops, repo) {
  const listed = await mustRun(ops, chain(
    'echo worktrees:',
    `git -C ${repo} worktree list --porcelain`,
    'echo branches:',
    `git -C ${repo} branch --format='%(refname:short)'`
  ));
  return String(listed.stdout);
}

/**
 * Wait for a path to appear, and say whether it did.
 *
 * It answers rather than throws because both answers are used: once to know a
 * hook has really started before cancelling it, and once to prove the tree it
 * was running in is gone. Absence is a result here, not a failure. The path is
 * a shell one and may be outside the project, which is why this looks through a
 * command rather than through `stat`.
 * @param {any} ops - Project-pinned operations.
 * @param {string} path - Path relative to the project root.
 * @param {number} nominalMs - How long to keep looking on an idle machine.
 * @returns {Promise<boolean>} Whether it turned up inside the budget.
 */
export async function pathTurnsUp(ops, path, nominalMs) {
  // The wait's probe is synchronous and this one is a command, so the probe
  // keeps one command in flight and answers from the last to come back. A
  // command that could not be run is thrown, not taken for an absence.
  /** @type {Promise<void>|null} */
  let looking = null;
  let found = false;
  /** @type {unknown} */
  let failed = null;
  const probe = () => {
    if (failed) throw failed;
    if (!found && !looking) {
      looking = shell(ops, `test -e ${path}`)
        .then((r) => { found = !!r.success; }, (err) => { failed = err; })
        .finally(() => { looking = null; });
    }
    return found;
  };
  try {
    // The budget rather than the nominal: nine lanes share this machine, and a
    // number chosen for an idle one measures the pool instead of the code.
    await waitFor(probe, `${path} to turn up`, budgetFor(nominalMs));
    return true;
  } catch {
    // Only the wait running out is an answer; a probe's own failure is not.
    if (failed) throw failed;
    return false;
  }
}

/**
 * A repository carrying a setup hook that announces itself and then waits.
 *
 * The waiting is what gives a cancel somewhere to land: a real hook's slow part
 * is an `npm ci`, and the interesting moment is the one in the middle of it.
 * The marker is how the test knows the hook is genuinely running rather than
 * aborting something that had not started, which would be a pass this case must
 * not be able to score.
 * @param {any} ops - Project-pinned operations.
 * @param {string} repo - The repository, relative to the project.
 * @param {number} seconds - How long the hook lingers.
 * @returns {Promise<void>} When the hook is in place.
 */
export async function giveRepoASlowHook(ops, repo, seconds) {
  await mustRun(ops, chain(
    `mkdir -p ${repo}/.juggler`,
    `printf 'touch hook-ran.txt\\nsleep ${seconds}\\n' > ${repo}/.juggler/worktree-setup`
  ));
}

/**
 * Put a value in a field the way a user does, so that everything listening to
 * the field hears about it. Assigning `value` on its own tells nobody, which is
 * also what lets the form set a field itself without being mistaken for the
 * user having typed in it.
 * @param {HTMLInputElement} input - The field.
 * @param {string} value - What to type into it.
 */
export function typeInto(input, value) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Choose in a field that is chosen from rather than typed into. A select tells
 * its listeners with `change`, and only when a person is the one moving it, so
 * an assignment alone reaches nobody.
 * @param {HTMLSelectElement} select - The field.
 * @param {string} value - Which option to land on.
 */
export function pick(select, value) {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Wait for the Repository field to turn up, and hand it back.
 *
 * It is the one field that is not there when the form is rendered: whether it
 * is worth having is a question for the server, and the form opens without
 * waiting for the answer.
 * @param {any} form - As `openForm` returned it.
 * @returns {Promise<HTMLSelectElement>} The field, once it is there.
 */
export async function waitForRepoField(form) {
  await waitFor(() => Boolean(form.container.querySelector('[data-field="repo"]')),
    { description: 'the form to offer a repository to choose' });
  form.repo = form.container.querySelector('[data-field="repo"]');
  return form.repo;
}

/**
 * Wait for the Worktree field to be asked, and hand it back.
 *
 * It arrives later than the Repository field above it and only for a submodule:
 * the form has to know which of the repositories on offer are submodules before
 * it can know whether there is anything to ask. It is built hidden and shown,
 * so being in the container is not the same as being asked.
 * @param {any} form - As `openForm` returned it.
 * @returns {Promise<HTMLSelectElement>} The field, once it is being asked.
 */
export async function waitForScopeField(form) {
  await waitFor(() => {
    const select = /** @type {any} */ (form.container.querySelector('[data-field="scope"]'));
    return Boolean(select) && select.parentElement?.hidden === false;
  }, { description: 'the form to ask which tree a submodule should be made of' });
  return form.container.querySelector('[data-field="scope"]');
}

/**
 * A repository with another one inside it as a submodule.
 *
 * Both are built in the project and the inner one is added by a relative path,
 * so nothing here depends on where the project is. `protocol.file.allow` is
 * stated because git refuses a submodule from a local path without it, and
 * stating it costs nothing on the versions that never minded.
 * @param {any} ops - Project-pinned operations.
 * @param {string} outer - Directory for the superproject, relative to the project.
 * @param {string} inner - Directory for the repository it will hold, relative to the project.
 * @param {string} at - Where the submodule sits inside the superproject.
 * @returns {Promise<void>} When the superproject has it committed.
 */
export async function buildSuperproject(ops, outer, inner, at) {
  await buildRepo(ops, outer, `outer-${at}`);
  await buildRepo(ops, inner, `inner-${at}`);
  await mustRun(ops, chain(
    `git -C ${outer} -c protocol.file.allow=always submodule add -q ../${inner} ${at}`,
    `git -C ${outer} commit -q -m submodule`
  ));
}

/**
 * What a Repository field is offering, in the order it offers it.
 * @param {HTMLSelectElement} select - The field.
 * @returns {string[]} The values, which are paths relative to the base workspace.
 */
export function offered(select) {
  return [...select.options].map(option => option.value);
}

/**
 * Open the provider's setup form the way the panel opens it.
 *
 * The container is deliberately left out of the document: nothing here needs
 * layout or focus, and a form attached to the page outlives the case that made
 * it. What the panel really does beyond this is listen for `input` on the
 * container and ask `getSetupValue()`, which is what each case does by hand.
 * @param {any} session - The test session.
 * @param {string} baseWorkspaceId - What the provision would be relative to; '' is the project.
 * @param {object} [values] - What the section last reported, for a form being rebuilt.
 * @returns {any} The provider, its container, and its fields — `repo` being null until the form decides to ask for one.
 */
export function openForm(session, baseWorkspaceId, values) {
  const provider = workspaceProviderRegistry.createProvider(PROVIDER_ID, session);
  if (!provider) throw new Error('the provider is not registered, so it has no form to render');
  const container = document.createElement('div');
  provider.renderSetup(container, {
    session,
    ops: createBoundOps(() => ({ workspaceId: baseWorkspaceId })),
    baseWorkspaceId,
    values,
    signal: new AbortController().signal,
    rollback: { push: () => {} },
    checkpoint: async () => {},
    progress: () => {}
  });
  /**
   * @param {string} name - Which field.
   * @returns {any} The input, or null when the form does not have one.
   */
  const field = (name) => container.querySelector(`[data-field="${name}"]`);
  return {
    provider,
    container,
    repo: field('repo'),
    base: field('base'),
    branch: field('branch'),
    location: field('location')
  };
}

/**
 * The context the host hands a reconcile: operations rooted at the project,
 * because what it is looking for is not in any one workspace.
 * @param {any} session - The test session.
 * @param {any} ops - Project-pinned operations.
 * @returns {any} A provider context.
 */
export function reconcileCtx(session, ops) {
  return {
    session,
    ops,
    baseWorkspaceId: '',
    signal: new AbortController().signal,
    rollback: { push: () => {} },
    checkpoint: async () => {},
    progress: () => {}
  };
}

/**
 * The preamble and teardown every worktree suite shares.
 *
 * Each suite is its own file because a file is a suite, and each one still
 * needs a session, project-pinned operations, and the project's own path
 * before it can do anything. Conversations are released at the end by the
 * suite that made them, because nothing else in the lane knows they exist.
 *
 * The provider is put in the registry here rather than by a case, because a
 * lane runs these suites in whatever order the runner picks and each one
 * provisions through the registry from its first case. Registering is
 * idempotent, so the suite that checks the registration still checks it.
 * @param {string} label - The suite, for the release audit trail.
 * @param {(kit: any) => Promise<void>} defineCases - Runs the suite's cases.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runWorktreeSuite(label, defineCases) {
  await initializeRegistries();
  registerProvider();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} caseLabel - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (caseLabel, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${caseLabel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const projectPath = (await fetchJson('/api/session')).projectPath;
  const { parent, separator } = parentOf(projectPath);
  const ops = createBoundOps(() => ({}));

  /** @type {any} */
  let session = null;
  /** @type {string[]} */
  const created = [];
  /** @param {any} conversation - The conversation to release at the end. */
  const release = (conversation) => { if (conversation) created.push(conversation.id); };

  try {
    session = await createTestSession();
    await defineCases({ run, ops, session, projectPath, parent, separator, release });
  } finally {
    if (session) {
      for (const id of created) {
        await releaseTestConversation(session, id, label);
      }
    }
  }

  return { passed, failed, errors };
}
