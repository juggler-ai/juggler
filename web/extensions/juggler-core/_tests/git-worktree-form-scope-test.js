//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The worktree setup form, when the repository chosen is a submodule.
 *
 * A tree of a submodule can be made of the submodule alone or of the whole
 * project around it, and the form asks which only once it knows the choice is
 * a submodule. A project that carries a setup hook starts on the whole
 * project. Split from git-worktree-form-test so each suite fits a unit suite's
 * budget when every shell is a `wsl.exe`.
 * @module _tests/git-worktree-form-scope-test
 */

import { waitFor, assert } from '../../../js-tests/utilities/test-helpers.js';
import { registerWorkspace, unregisterWorkspace } from '../../../js/services/workspaces.js';
import { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';
import {
  runWorktreeSuite,
  BRANCH,
  uniqueTag,
  mustRun,
  typeInto,
  pick,
  waitForRepoField,
  waitForScopeField,
  buildSuperproject,
  openForm,
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
 * Run the git-worktree-form-scope tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  return runWorktreeSuite('git-worktree-form-scope-test', async ({ run, ops, session, projectPath, separator }) => {
    await run('a submodule can be made a tree of from either end', async () => {
      // A tree of a submodule holds the submodule and nothing else — not the
      // Makefile that builds it, not the scripts around it, none of which are in
      // that repository. A tree of the project holds all of it with the
      // submodule inside. Both are reasonable and they are different trees, so
      // the form asks rather than picking one.
      const tag = uniqueTag();
      const [outer, inner] = [`wt-super-${tag}`, `wt-inner-${tag}`];
      const outerRoot = `${projectPath}${separator}${outer}`;
      const saved = session.workspaces;
      /** @type {any} */
      let base = null;
      try {
        await buildSuperproject(ops, outer, inner, 'held');
        // A branch of its own in the superproject, so that the base following
        // the subject from one repository to the other is visible rather than
        // the same word twice.
        await mustRun(ops, `git -C ${outer} checkout -q -b trunk`);

        base = await registerWorkspace({
          kind: 'local', root: outerRoot, label: outer, state: 'ready'
        });
        session.workspaces = [...saved, base];

        const form = openForm(session, base.id);
        const select = await waitForRepoField(form);
        pick(select, 'held');
        const scope = await waitForScopeField(form);

        // Nothing in this project says a whole-project tree is usable, so the
        // form stays where it has always been and offers the other way.
        assert(scope.value === 'repo',
          `a project with no setup hook starts on the submodule alone, got ${JSON.stringify(scope.value)}`);
        typeInto(form.branch, BRANCH);
        const alone = defaultLocation(`${outerRoot}${separator}held`, BRANCH, outerRoot);
        assert(form.location.value === alone,
          `which is placed beside the project as it always was, got ${JSON.stringify(form.location.value)} rather than ${JSON.stringify(alone)}`);
        await waitFor(() => form.base.value === 'main',
          { description: "the base to fill in from the submodule's HEAD" });

        // The other end: the tree becomes a tree of the project, named after the
        // project, based on the project's HEAD rather than the submodule's.
        pick(scope, 'project');
        const whole = defaultLocation(outerRoot, BRANCH, outerRoot);
        assert(form.location.value === whole,
          `the whole project is a tree named for the project, got ${JSON.stringify(form.location.value)} rather than ${JSON.stringify(whole)}`);
        await waitFor(() => form.base.value === 'trunk',
          { description: "the base to be asked again, of the project it is now a tree of" });

        const chosen = form.provider.getSetupValue().values;
        assert(chosen.scope === 'project' && chosen.repo === 'held',
          `and the form hands on both the scope and the repository it is about, got ${JSON.stringify(chosen)}`);

        // The question only arises for a submodule. Choosing the project itself
        // in the field above is not a submodule, so there is nothing to ask and
        // the form says nothing.
        pick(select, '');
        assert(/** @type {any} */ (scope).parentElement.hidden === true,
          'a repository that is not a submodule is not asked which end to make a tree of');
        assert(form.provider.getSetupValue().values.scope === '',
          `and no scope is handed on, got ${JSON.stringify(form.provider.getSetupValue().values.scope)}`);
      } finally {
        session.workspaces = saved;
        if (base) await unregisterWorkspace(base.id).catch(() => {});
        await shell(ops, `rm -rf ${outer} ${inner}`).catch(() => {});
      }
    });

    await run('a project that carries a setup hook starts on the whole project', async () => {
      // `git worktree add` does not populate submodules, so a whole-project tree
      // arrives with an empty directory where the submodule is. The hook is
      // where a project says what a new tree of it needs — so a project that has
      // written one has said that a tree of the whole thing is the usable kind,
      // and that is the only evidence worth defaulting on.
      const tag = uniqueTag();
      const [outer, inner] = [`wt-hooked-${tag}`, `wt-held-${tag}`];
      const saved = session.workspaces;
      /** @type {any} */
      let base = null;
      try {
        await buildSuperproject(ops, outer, inner, 'held');
        await mustRun(ops, chain(`mkdir -p ${outer}/.juggler`, `echo exit 0 > ${outer}/.juggler/worktree-setup`));

        base = await registerWorkspace({
          kind: 'local', root: `${projectPath}${separator}${outer}`, label: outer, state: 'ready'
        });
        session.workspaces = [...saved, base];

        const form = openForm(session, base.id);
        pick(await waitForRepoField(form), 'held');
        const scope = await waitForScopeField(form);
        assert(scope.value === 'project',
          `the hook is what turns the default round, got ${JSON.stringify(scope.value)}`);
      } finally {
        session.workspaces = saved;
        if (base) await unregisterWorkspace(base.id).catch(() => {});
        await shell(ops, `rm -rf ${outer} ${inner}`).catch(() => {});
      }
    });
  });
}
