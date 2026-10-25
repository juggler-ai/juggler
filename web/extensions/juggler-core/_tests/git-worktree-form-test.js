//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The setup form the panel renders for the worktree provider.
 *
 * A form is where a provision is described before anything is built, so every
 * case here is about what the form works out on the user's behalf and what it
 * refuses outright: where the tree goes, which repository it comes from, and
 * what a form put back still holds. A submodule's choice of tree is
 * git-worktree-form-scope-test's; what the form refuses, what Create builds,
 * and the form under en-XA are git-worktree-form-create-test's.
 * @module _tests/git-worktree-form-test
 */

import { waitFor, assert } from '../../../js-tests/utilities/test-helpers.js';
import { registerWorkspace, unregisterWorkspace } from '../../../js/services/workspaces.js';
import { defaultLocation } from '../workspaces/git-worktree-workspace-provider.js';
import {
  runWorktreeSuite,
  BRANCH,
  uniqueTag,
  mustRun,
  buildRepo,
  typeInto,
  pick,
  waitForRepoField,
  offered,
  openForm
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
 * Run the git-worktree-form tests.
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests() {
  return runWorktreeSuite('git-worktree-form-test', async ({ run, ops, session, projectPath, separator }) => {
    await run('the form derives where the tree goes, and stops when the user says otherwise', async () => {
      // Placement is a convention rather than a constant, which is why the form
      // shows it rather than deciding it quietly. So it has to do both things:
      // follow the branch while nobody minds where the tree lands, and get out
      // of the way for good the moment somebody does.
      const tag = uniqueTag();
      const repo = `wt-repo-${tag}`;
      const repoRoot = `${projectPath}${separator}${repo}`;
      const saved = session.workspaces;
      /** @type {any} */
      let base = null;
      try {
        await buildRepo(ops, repo, `hello-${tag}`);
        // The repository as the base workspace, which is what the form assumes:
        // its commands run where the provision's will, and the location it
        // derives is relative to the same place.
        base = await registerWorkspace({
          kind: 'local', root: repoRoot, label: repo, state: 'ready'
        });
        session.workspaces = [...saved, base];

        const form = openForm(session, base.id);
        assert(form.base && form.branch && form.location,
          'the form asks for a base, a branch and somewhere to put the tree');

        const empty = form.provider.getSetupValue();
        assert(empty.valid === false,
          `a form with no branch in it may not be submitted, got ${JSON.stringify(empty)}`);
        assert(empty.invalidFieldId === form.branch.id && Boolean(form.branch.id),
          `and names the field to go back to, got ${JSON.stringify(empty.invalidFieldId)}`);

        typeInto(form.branch, BRANCH);
        assert(form.location.value === defaultLocation(repoRoot, BRANCH),
          `the location follows the branch, got ${JSON.stringify(form.location.value)}`);
        typeInto(form.branch, 'other/thing');
        assert(form.location.value === defaultLocation(repoRoot, 'other/thing'),
          `and keeps following it, got ${JSON.stringify(form.location.value)}`);

        const elsewhere = `${repoRoot}-somewhere-else`;
        typeInto(form.location, elsewhere);
        typeInto(form.branch, BRANCH);
        assert(form.location.value === elsewhere,
          `once the user has said where it goes, the branch stops moving it, got ${JSON.stringify(form.location.value)}`);

        const filled = form.provider.getSetupValue();
        assert(filled.valid === true,
          `a named branch and a place to put it is a form that may be submitted, got ${JSON.stringify(filled)}`);
        assert(filled.values.branch === BRANCH && filled.values.location === elsewhere,
          `and it hands on what is on screen, got ${JSON.stringify(filled.values)}`);

        // The base is the one field nobody normally touches, so it fills itself
        // in from where the repository is standing — `main` here, which no
        // default in the provider mentions.
        await waitFor(() => form.base.value === 'main',
          { description: 'the form to fill the base in from the repository\'s HEAD' });
        assert(form.provider.getSetupValue().values.base === 'main',
          `and hands that on too, got ${JSON.stringify(form.provider.getSetupValue().values)}`);
      } finally {
        session.workspaces = saved;
        if (base) await unregisterWorkspace(base.id).catch(() => {});
        await ops.shell({ command: `rm -rf ${repo}` }).catch(() => {});
      }
    });

    await run('the repository is asked about only when there is more than one answer', async () => {
      // The base workspace is usually the repository, and a field with one
      // possible answer is a field in the way. So the question is asked only
      // where it can be answered two ways — and the form has to still be the
      // three-field form everywhere else, which is the half of this that every
      // ordinary project depends on.
      const tag = uniqueTag();
      const [first, second] = [`wt-one-${tag}`, `wt-two-${tag}`];
      const saved = session.workspaces;
      /** @type {any} */
      let base = null;
      try {
        await buildRepo(ops, first, `hello-${tag}`);
        await buildRepo(ops, second, `goodbye-${tag}`);

        // The repository as the base workspace: one repository under it, which
        // is itself, so there is nothing to ask.
        base = await registerWorkspace({
          kind: 'local', root: `${projectPath}${separator}${first}`, label: first, state: 'ready'
        });
        session.workspaces = [...saved, base];
        const alone = openForm(session, base.id);
        await waitFor(() => alone.base.value === 'main',
          { description: 'the form to settle against the repository it was opened on' });
        assert(!alone.container.querySelector('[data-field="repo"]'),
          'a base workspace that is the only repository under it is not worth asking about');
        assert(alone.provider.getSetupValue().values.repo === '',
          `and the form still names no repository, got ${JSON.stringify(alone.provider.getSetupValue().values.repo)}`);

        // The project as the base workspace: two repositories under it, neither
        // of them it, so both are offered.
        const choosing = openForm(session, '');
        const select = await waitForRepoField(choosing);
        const options = offered(select);
        assert(options.includes(first) && options.includes(second),
          `both repositories under the project are offered, got ${JSON.stringify(options)}`);

        // And it is dressed as the field below it rather than as the operating
        // system. A native select left alone keeps its own chrome and ignores
        // the border, the radius and the font it is given — which looks like
        // nothing else in the app, and is invisible to every assertion above.
        // This is the one case here that needs the form on the page, since none
        // of it is computed for a container that will never be laid out.
        document.body.appendChild(choosing.container);
        try {
          const dressed = getComputedStyle(select);
          const neighbour = getComputedStyle(choosing.base);
          assert(dressed.appearance === 'none',
            `the platform's own control is turned off, got ${JSON.stringify(dressed.appearance)}`);
          for (const property of ['fontFamily', 'fontSize', 'borderRadius', 'borderTopWidth', 'backgroundColor', 'color']) {
            assert(dressed[property] === neighbour[property],
              `its ${property} is the Base field's, got ${JSON.stringify(dressed[property])} rather than ${JSON.stringify(neighbour[property])}`);
          }
          assert(dressed.backgroundImage.includes('svg'),
            `and it draws a chevron of its own, got ${JSON.stringify(dressed.backgroundImage)}`);
          // Same height, or the rows are different heights and the labels beside
          // them stop lining up — `.setup-field` aligns on the baseline, which
          // is the sort of thing a control with its own chrome moves.
          assert(select.offsetHeight === choosing.base.offsetHeight,
            `and stands the same height as it, got ${select.offsetHeight} against ${choosing.base.offsetHeight}`);
        } finally {
          choosing.container.remove();
        }
      } finally {
        session.workspaces = saved;
        if (base) await unregisterWorkspace(base.id).catch(() => {});
        await ops.shell({ command: `rm -rf ${first} ${second}` }).catch(() => {});
      }
    });

    await run('choosing a repository takes the base and the location with it', async () => {
      // The three fields below the choice are all about one repository, and two
      // of them were filled in for whichever one was chosen before. The base is
      // the one that matters: it names a commit, and a commit in the repository
      // that was chosen a moment ago is not a commit in this one — `git worktree
      // add` would refuse with `invalid reference` over a field nobody touched.
      const tag = uniqueTag();
      const [first, second] = [`wt-one-${tag}`, `wt-two-${tag}`];
      try {
        await buildRepo(ops, first, `hello-${tag}`);
        await buildRepo(ops, second, `goodbye-${tag}`);
        // A different HEAD in the second, so that the base filling itself in
        // again is visible rather than a coincidence: both start on `main`, and
        // a base that never moved would read `main` either way.
        await mustRun(ops, `git -C ${second} checkout -q -b trunk`);

        const form = openForm(session, '');
        const select = await waitForRepoField(form);

        pick(select, first);
        typeInto(form.branch, BRANCH);
        await waitFor(() => form.base.value === 'main',
          { description: "the base to fill in from the first repository's HEAD" });

        pick(select, second);
        await waitFor(() => form.base.value === 'trunk',
          { description: 'the base to be asked again, of the repository now chosen' });

        const chosen = form.provider.getSetupValue();
        assert(chosen.values.repo === second,
          `the form hands on the repository that was chosen, got ${JSON.stringify(chosen.values.repo)}`);

        // Beside the project, not beside the repository. `wt-two-<tag>` is
        // nested in the project, so a tree beside IT would land inside the
        // project — untracked in whatever repository the project is, and found
        // as a third repository by everything that goes looking for them.
        const beside = defaultLocation(`${projectPath}${separator}${second}`, BRANCH, projectPath);
        assert(form.location.value === beside,
          `a nested repository's tree is placed beside the project, got ${JSON.stringify(form.location.value)} rather than ${JSON.stringify(beside)}`);
        assert(!form.location.value.startsWith(`${projectPath}${separator}`),
          `which is to say outside the project altogether, got ${JSON.stringify(form.location.value)}`);
      } finally {
        await ops.shell({ command: `rm -rf ${first} ${second}` }).catch(() => {});
      }
    });

    await run('a form that is put back comes back filled in', async () => {
      // A provision that was cancelled, or that failed, returns the panel to the
      // choice state — which rebuilds this form from nothing. What the section
      // last reported comes back with it, so a cancel over a typo in one field
      // costs one edit rather than a re-fill.
      const mine = '/somewhere/of/my/own';
      const chosen = openForm(session, '', { base: 'develop', branch: BRANCH, location: mine });
      assert(chosen.base.value === 'develop' && chosen.branch.value === BRANCH && chosen.location.value === mine,
        `every field is as it was left, got ${JSON.stringify([chosen.base.value, chosen.branch.value, chosen.location.value])}`);
      assert(chosen.provider.getSetupValue().valid === true,
        'and it may be submitted again without being touched');

      typeInto(chosen.branch, 'second/thoughts');
      assert(chosen.location.value === mine,
        `a location the user chose is still theirs after the rebuild, got ${JSON.stringify(chosen.location.value)}`);

      // Whereas one that was merely derived goes on being derived: the rule is
      // about who chose it, and being handed it back does not make it a choice.
      const derived = openForm(session, '', {
        branch: BRANCH,
        location: defaultLocation(session.projectPath, BRANCH)
      });
      typeInto(derived.branch, 'second/thoughts');
      assert(derived.location.value === defaultLocation(session.projectPath, 'second/thoughts'),
        `a location nobody chose keeps following the branch, got ${JSON.stringify(derived.location.value)}`);
    });
  });
}
