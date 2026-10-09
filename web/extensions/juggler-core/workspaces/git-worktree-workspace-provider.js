//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A workspace that is a git worktree: another branch of the same repository,
 * checked out somewhere else, so a conversation can work on it without
 * disturbing the tree you are looking at.
 *
 * ## Everything is relative, on purpose
 *
 * Commands run through a POSIX shell — `sh` on Unix, WSL or Git-for-Windows on
 * Windows — while the roots this provider registers are the server's own native
 * paths. On Windows those two disagree about what an absolute path looks like
 * (`C:\src\app` against `/c/src/app` or `/mnt/c/src/app`), and which of the two
 * is right depends on which shell happens to be installed. So no absolute path
 * is ever put in a command: the repository is named relative to the operations'
 * root, the tree is named relative to the repository, and the absolute location
 * is computed here, for registration and for display only.
 *
 * ## What it does not do
 *
 * It does not pretend a worktree is an isolated machine. The filesystem is
 * separate; ports, databases, GPUs and everything else on the box are not. The
 * setup hook is the escape hatch for the per-tree part of that, not a feature.
 * @module workspaces/git-worktree-workspace-provider
 */

import WorkspaceProvider from 'juggler/workspace-provider';
import api from '../../../js/services/api.js';
import { branchPhrase, countsPhrase, divergencePhrase, fileStatusWords } from '../lib/git-status.js';
import { baseName, join, parentOf, relativePath } from '../lib/workspace-paths.js';
import { choice, field, nextFormSequence, showNote } from '../lib/setup-fields.js';

/**
 * How long a setup hook may take before it is killed.
 *
 * The default of thirty seconds is right for a command someone is waiting on and
 * wrong for the hook, whose entire reason for existing is the fifteen-minute
 * dependency install. Cancel remains the way to stop it early — the signal is
 * threaded through, and the backend kills the process group.
 * @type {number}
 */
const HOOK_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The hook a repository may carry to finish off a new tree, run with the new
 * tree as its working directory.
 * @type {string}
 */
const SETUP_HOOK = '.juggler/worktree-setup';

/**
 * How long a commit may take.
 *
 * Not the operations' thirty-second default, which is a figure for a command
 * somebody is watching. A commit runs the repository's hooks, and a pre-commit
 * hook that formats and lints the staged files is ordinary and routinely slower
 * than that — and the deadline does not fail the commit politely, it kills
 * git's process group with everything already staged.
 * @type {number}
 */
const COMMIT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long to let a branch name settle before asking git what it makes of it.
 *
 * One command per keystroke is one round trip per letter, and git's opinion of
 * half a name is not worth having.
 * @type {number}
 */
const BRANCH_CHECK_DELAY_MS = 200;

/**
 * Characters that would not survive being quoted into a command.
 * @type {RegExp}
 */
const UNQUOTABLE = /["'`$\\\n\r]/;

/**
 * Whether a changed path is Juggler's own rather than the user's work.
 *
 * Nothing of ours is written into a workspace root — spill and the CLI's resume
 * sidecars were moved to the project's `.juggler/` when workspaces were built —
 * so this is defensive. A tree made by an older build may still hold one, and a
 * status that read it as the user's work would send them down the
 * commit-before-discard path over a directory they never made.
 * @param {string} path - A path git reported, relative to the repository.
 * @returns {boolean} Whether to leave it out of the counts.
 */
function isOurs(path) {
  return path === '.juggler' || path.startsWith('.juggler/');
}

/**
 * A branch name as a directory name: `feat/tunnels` becomes `feat-tunnels`.
 * @param {string} branch - The branch.
 * @returns {string} Something that can be a single path segment.
 */
function slug(branch) {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
}

/**
 * Refuse a value that would not survive being quoted into a command.
 *
 * Every path and branch name below is interpolated into a shell string inside
 * double quotes. These values come from a form rather than from the model, so
 * this is not the boundary the app's safety rests on — but a provider that
 * builds shell commands should still decline to be talked out of its own
 * quoting, and the refusal costs one line.
 * @param {string} value - What is about to be quoted.
 * @param {string} what - What to call it if it is refused.
 * @returns {string} The value, when it is safe.
 * @throws {Error} When it is not.
 */
function shellSafe(value, what) {
  if (UNQUOTABLE.test(value)) {
    throw new Error(`Couldn't use that ${what}: ${JSON.stringify(value)} contains a character that cannot appear in a command.`);
  }
  return value;
}

/**
 * One worktree as `git worktree list --porcelain` describes it.
 * @typedef {object} ListedWorktree
 * @property {string} path - Where it is, in the shell's terms rather than the server's
 * @property {string} branch - The branch it is on, '' when there is none
 * @property {boolean} detached - Whether it is on no branch at all
 * @property {boolean} bare - Whether it is the bare repository itself
 */

/**
 * Read what git says about a repository's worktrees.
 *
 * The porcelain format is blocks of `key value` lines separated by blank lines,
 * the first block being the main worktree. Its paths are ABSOLUTE and in the
 * shell's terms — which on Windows is not the server's — so nothing here
 * compares them with anything the workspace table holds. They are only ever
 * measured against each other.
 * @param {string} text - The command's output.
 * @returns {ListedWorktree[]} What it listed, main worktree first.
 */
function parseWorktrees(text) {
  /** @type {ListedWorktree[]} */
  const trees = [];
  for (const block of String(text ?? '').split(/\r?\n\s*\r?\n/)) {
    /** @type {ListedWorktree} */
    const tree = { path: '', branch: '', detached: false, bare: false };
    for (const line of block.split(/\r?\n/)) {
      const said = line.trim();
      if (said.startsWith('worktree ')) tree.path = said.slice('worktree '.length).trim();
      else if (said.startsWith('branch ')) tree.branch = said.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      else if (said === 'detached') tree.detached = true;
      else if (said === 'bare') tree.bare = true;
    }
    if (tree.path) trees.push(tree);
  }
  return trees;
}

/**
 * A value wrapped in single quotes for a POSIX shell, with any single quotes in
 * it escaped the only way that works.
 *
 * Used for a commit message and nothing else. The values everywhere else in this
 * file are branch names and paths, which go in double quotes and are refused
 * outright if they hold anything awkward — but a commit message is prose, and
 * refusing an apostrophe would be absurd.
 * @param {string} value - Anything at all.
 * @returns {string} A single shell word.
 */
function singleQuoted(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * A plain lead, and under it whatever git said about it.
 *
 * Above rather than instead of: the lead says which command refused, which is
 * the part a reader needs to know what they are being told, and git's own text
 * is the part that says what to do about it. Dropping either leaves a message
 * that cannot be acted on.
 *
 * The shell operation merges both streams into `stdout` and answers with an
 * empty `stderr`, so `stdout` is read first — a message built from `stderr`
 * alone reaches for a field that is always empty and reports the lead by itself
 * every time.
 * @param {string} lead - What could not be done, in plain words.
 * @param {any} result - What the shell answered with.
 * @returns {string} The two, or the lead alone when git said nothing at all.
 */
function gitSaid(lead, result) {
  const said = String(result?.stdout || result?.stderr || '').trim();
  return said ? `${lead}\n\n${said}` : lead;
}

/**
 * Where a worktree for this branch goes by default: beside the repository,
 * named after it and the branch.
 *
 * Siblings are the common layout rather than the only one — a bare repository
 * with its trees as children is just as usual — which is why the setup form
 * shows this and lets it be changed. Nothing below assumes it.
 *
 * What "beside" means is the third argument, and it is the repository itself
 * for the repository that stands on its own. A nested one — a submodule, or a
 * repository that is one of several under a project — has an enclosing
 * repository, and beside it is *inside* that: a tree put there is reported as
 * untracked by the outer repository and discovered as a third by anything
 * scanning for them. So a nested repository is placed beside the tree it is
 * nested in, and keeps its own name.
 * @param {string} repoRoot - The repository's absolute path.
 * @param {string} branch - The branch the tree is for.
 * @param {string} [beside] - What to put it next to; the repository, when nothing else is nested around it.
 * @returns {string} An absolute path.
 */
export function defaultLocation(repoRoot, branch, beside = repoRoot) {
  return join(parentOf(beside), `${baseName(repoRoot)}-${slug(branch)}`);
}

/**
 * A git worktree, as a place a conversation can work.
 */
class GitWorktreeWorkspaceProvider extends WorkspaceProvider {
  static MANIFEST = {
    id: 'git-worktree',
    name: 'Git Worktree',
    version: '1.0.0',
    description: 'Another branch of this repository, checked out in a worktree of its own',
    setupLabel: 'New git worktree',
    icon: 'icon-git-branch',
    recommendations: {
      bestFor: 'work on a branch that should not disturb the checkout you are looking at',
      avoidFor: 'a quick edit to the branch you are already on',
      notes: [
        'The files are separate; ports, databases and anything else on this machine are not.',
        'A fresh tree is empty of build output, so the first build is a full one.'
      ]
    }
  };

  /**
   * @param {{session?: any}} [context] - What is known before any hook runs.
   */
  constructor(context = {}) {
    super(context);

    /** @type {any} The rendered form, while there is one. */
    this._form = null;
  }

  // ==========================================================================
  // The setup form
  // ==========================================================================

  /**
   * Three fields: where to branch from, what to call the branch, and where the
   * tree goes — a fourth when there is more than one repository to make a tree
   * of, and a fifth when the one chosen is a submodule and so can be made a tree
   * of from either end.
   *
   * Only the branch is normally touched. The base fills itself in from wherever
   * the repository is standing, and the location is derived from the branch —
   * but it is **shown**, and it is editable, because placement is a convention
   * rather than a constant: trees beside the repository are usual and a bare
   * repository with its trees as children is just as usual. Deriving it silently
   * would be deciding that for everyone.
   *
   * The location follows the branch only until somebody types in it. From then
   * on it is theirs; emptying it hands the decision back, since an empty
   * location provisions to the derived default.
   * @param {HTMLElement} container - The panel section's body.
   * @param {any} ctx - Session, operations pinned to the base workspace, and the rest.
   */
  renderSetup(container, ctx) {
    const seq = nextFormSequence();
    const ids = {
      repo: `git-worktree-repo-${seq}`,
      scope: `git-worktree-scope-${seq}`,
      base: `git-worktree-base-${seq}`,
      branch: `git-worktree-branch-${seq}`,
      location: `git-worktree-location-${seq}`
    };

    container.replaceChildren();
    const base = field(container, ids.base, 'base', 'Base', 'HEAD');
    const branch = field(container, ids.branch, 'branch', 'Branch', 'feat/tunnels');
    const location = field(container, ids.location, 'location', 'Location', 'beside the repository');

    // What the section last reported, when there is any: a provision that was
    // cancelled or failed puts the form back, and re-filling it by hand is a
    // poor reward for a typo in one field of it.
    const restored = ctx?.values ?? {};
    base.input.value = String(restored?.base ?? '');
    branch.input.value = String(restored?.branch ?? '');
    location.input.value = String(restored?.location ?? '');

    const repoRel = String(restored?.repo ?? '');
    const scopeWanted = String(restored?.scope ?? '');
    const { repoRoot, beside, subjectRel } = this._formPlaces(ctx, repoRel, scopeWanted);
    const form = {
      ctx,
      container,
      ids,
      repoRel,
      repoRoot,
      beside,
      /** @type {string} The repository the tree is OF, which is not the chosen one when the whole project is. */
      subjectRel,
      /** @type {string} Which end of a submodule was asked for: 'project', 'repo', or '' when nothing is. */
      scopeWanted,
      /** @type {Set<string>} The base workspace's submodules, once they have been asked for. */
      submodules: new Set(),
      /** @type {boolean} Whether that set is an answer yet, rather than the absence of one. */
      submodulesKnown: false,
      /** @type {boolean} Whether the base workspace is itself a repository, which is what makes a project-wide tree possible. */
      baseIsRepo: false,
      /** @type {boolean} Whether the base workspace carries a setup hook. */
      hasSetupHook: false,
      /** @type {HTMLSelectElement|null} The repository field, once there is a reason for one. */
      repo: null,
      /** @type {HTMLSelectElement|null} The scope field, once a submodule is chosen. */
      scope: null,
      /** @type {HTMLElement|null} The scope field's row, hidden while the choice is not a real one. */
      scopeRow: null,
      /** @type {HTMLElement|null} The line under the scope field. */
      scopeNote: null,
      base: base.input,
      branch: branch.input,
      location: location.input,
      branchNote: branch.note,
      baseEdited: base.input.value !== '',
      // A restored location that is not the one the branch would have derived is
      // one the user chose, and it must not start following the branch again.
      locationEdited: location.input.value !== ''
        && location.input.value !== defaultLocation(repoRoot, branch.input.value.trim(), beside),
      /** @type {Map<string, boolean>} What git said about a name, once it has said it. */
      verdicts: new Map(),
      timer: 0
    };
    this._form = form;

    base.input.addEventListener('input', () => { form.baseEdited = true; });
    location.input.addEventListener('input', () => { form.locationEdited = true; });
    branch.input.addEventListener('input', () => {
      this._deriveLocation();
      this._showBranchVerdict();
      this._scheduleBranchCheck();
    });

    // Nobody waits for any of these: the form is usable without them, and a
    // repository that cannot say what it is standing on is one the provision
    // will refuse anyway, with its own words.
    void this._offerRepositories();
    void this._fillBaseFromHead();
  }

  /**
   * Offer a repository to choose, when choosing is a thing the user can usefully
   * do — and say nothing at all when it is not.
   *
   * The base workspace is usually the repository, and then there is one answer
   * and a field asking for it is a field in the way. Two things make it worth
   * asking: more than one repository under the base workspace, and a single one
   * that is not the base workspace itself — a project holding a checkout, or the
   * submodule of a project whose own root is not a repository. That second case
   * is not cosmetic: without the field, the provision runs against the base
   * workspace and refuses.
   *
   * The list is the one the git surfaces already discover, so a repository
   * offered here is a repository the status card is already reporting on, and
   * neither has to learn what the other means by a repository.
   * @returns {Promise<void>} When the field is there, or has been decided against.
   */
  async _offerRepositories() {
    const form = this._form;
    if (!form) return;

    let found;
    try {
      found = await api.getGitStatus(form.ctx?.baseWorkspaceId ?? '', { signal: form.ctx?.signal });
    } catch {
      return; // A form without the field is the form as it has always been.
    }
    const repos = (found?.repos ?? []).map((/** @type {any} */ repo) => String(repo?.path ?? ''));
    if (this._form !== form || form.repo || repos.length === 0) return;
    if (repos.length === 1 && repos[0] === '') return;

    // Each is named the way it was found, relative to the base workspace — and
    // the one that IS the base workspace has no such name, so it borrows the
    // directory's.
    const baseRoot = this._formPlaces(form.ctx, '').repoRoot;
    const { select } = choice(form.container, form.ids.repo, 'repo', 'Repository',
      repos.map(path => ({ value: path, label: path || baseName(baseRoot) || '.' })));
    // Above the three fields it scopes, which means moving it: the rest of the
    // form was built while this was still being asked about.
    form.container.prepend(/** @type {HTMLElement} */ (select.parentElement));
    form.repo = select;

    // What was restored, when it is still on offer; otherwise the repository at
    // the base workspace, and failing that the first one found.
    select.value = repos.includes(form.repoRel) ? form.repoRel : (repos.includes('') ? '' : repos[0]);
    select.addEventListener('change', () => { this._repositoryChosen(); });
    // Only when it lands somewhere other than where the form already was: the
    // rest of it was built, and a base already asked for, against `form.repoRel`.
    if (select.value !== form.repoRel) this._repositoryChosen();

    // What makes the scope question answerable: a base workspace that is itself
    // a repository, and a chosen repository that is one of its submodules.
    form.baseIsRepo = repos.includes('');
    const submodules = await this._submodulePaths(form.ctx);
    if (this._form !== form) return;
    if (submodules.size > 0 && form.baseIsRepo) {
      form.hasSetupHook = await this._hasSetupHook(form.ctx);
      if (this._form !== form) return;
    }
    form.submodules = submodules;
    form.submodulesKnown = true;
    this._offerScope();
    Object.assign(form, this._formPlaces(form.ctx, form.repoRel, form.scopeWanted));
    this._deriveLocation();
    this._report();
  }

  /**
   * Offer the two ways to make a tree of a submodule, when the chosen repository
   * is one — and stay out of the way when it is not.
   *
   * A tree of the submodule alone is the submodule alone: the project's
   * Makefile, its scripts and whatever else the submodule is built by are in the
   * enclosing repository, and none of that is in the tree. A tree of the project
   * has all of it, and the submodule inside it can sit on its own branch. Which
   * of those is wanted is not something to be guessed silently, so it is asked.
   *
   * The field is built once and hidden while the question does not arise, rather
   * than added and removed: a control that appears and vanishes as the
   * repository above it changes is a form that moves under the pointer.
   */
  _offerScope() {
    const form = this._form;
    if (!form) return;

    // Nothing is known about submodules until they have been asked for, and a
    // repository chosen before the answer arrives must not be read as evidence
    // that the question does not arise — that would throw away a restored scope
    // on the way past.
    if (!form.submodulesKnown) return;

    const applies = form.baseIsRepo && form.submodules.has(form.repoRel);
    if (!applies) {
      if (form.scopeRow) form.scopeRow.hidden = true;
      form.scopeWanted = '';
      return;
    }

    const projectName = baseName(this._formPlaces(form.ctx, '').repoRoot) || 'the project';
    if (!form.scope) {
      const { select, note } = choice(form.container, form.ids.scope, 'scope', 'Worktree', [
        { value: 'project', label: '' },
        { value: 'repo', label: '' }
      ]);
      form.scope = select;
      form.scopeNote = note;
      form.scopeRow = /** @type {HTMLElement} */ (select.parentElement);
      // Under the repository it qualifies, which means moving it: the rest of
      // the form was built before there was any reason to ask this.
      form.repo?.parentElement?.after(form.scopeRow);
      select.addEventListener('change', () => { this._scopeChosen(); });
    }

    form.scope.options[0].textContent = `${projectName}, with ${form.repoRel} in it`;
    form.scope.options[1].textContent = `${form.repoRel} on its own`;
    form.scopeRow.hidden = false;

    // A restored answer is the user's and stands. Otherwise the hook decides:
    // see {@link _hasSetupHook}.
    if (form.scopeWanted !== 'project' && form.scopeWanted !== 'repo') {
      form.scopeWanted = form.hasSetupHook ? 'project' : 'repo';
    }
    form.scope.value = form.scopeWanted;
    this._showScopeNote();
  }

  /**
   * Say what the scope on offer will actually leave in the tree.
   *
   * `git worktree add` does not populate submodules, so a project-wide tree
   * arrives with an empty directory where the submodule is unless the project's
   * hook fills it. That is worth saying plainly at the moment it is chosen, and
   * not worth apologising for: the hook is where a project says what its trees
   * need.
   */
  _showScopeNote() {
    const form = this._form;
    if (!form?.scopeNote) return;
    if (form.scopeWanted === 'repo') {
      showNote(form.scopeNote, `Only ${form.repoRel}. Nothing of the project around it comes with it.`);
      return;
    }
    showNote(form.scopeNote, form.hasSetupHook
      ? `${form.repoRel} starts uninitialised; ${SETUP_HOOK} runs in the new tree.`
      : `${form.repoRel} starts uninitialised — there is no ${SETUP_HOOK} to fill it in.`);
  }

  /**
   * Follow the scope being changed: it moves which repository the tree is of, so
   * the base and the location are both about something else now.
   */
  _scopeChosen() {
    const form = this._form;
    if (!form?.scope) return;

    form.scopeWanted = form.scope.value;
    Object.assign(form, this._formPlaces(form.ctx, form.repoRel, form.scopeWanted));
    this._deriveLocation();
    this._showScopeNote();
    // The same reasoning as choosing a repository: the base names a commit in
    // whichever repository was the subject a moment ago, and the submodule and
    // the project around it do not share a history.
    if (!form.baseEdited) {
      form.base.value = '';
      void this._fillBaseFromHead();
    }
    this._report();
  }

  /**
   * Follow a repository being chosen: everything below the field is about that
   * repository, and the fields below were filled in for another one.
   */
  _repositoryChosen() {
    const form = this._form;
    if (!form?.repo) return;

    form.repoRel = form.repo.value;
    // Before the places are worked out: whether this repository is a submodule
    // decides whether `scopeWanted` means anything, and the places are built
    // from it.
    this._offerScope();
    Object.assign(form, this._formPlaces(form.ctx, form.repoRel, form.scopeWanted));
    this._deriveLocation();
    // The base names a commit in the repository that was chosen before, which is
    // not a commit in this one. A base the user typed is theirs and stays; one
    // that filled itself in is cleared, so that it can fill itself in again —
    // and the fill in flight for the old repository lands on a `repoRel` that
    // has moved, and drops what it was carrying.
    if (!form.baseEdited) {
      form.base.value = '';
      void this._fillBaseFromHead();
    }
    this._report();
  }

  /**
   * What the form currently says, and whether Create may be pressed.
   *
   * A name git has not been asked about yet counts as usable. The check exists
   * to catch a bad name a moment earlier than `git worktree add` would, not to
   * be the only thing that catches it — so a fast typist pressing Create is
   * answered by git rather than made to wait for us to ask it.
   * @returns {any} Validity, values, and which field to go back to.
   */
  getSetupValue() {
    const form = this._form;
    if (!form) return { valid: false, values: {}, invalidFieldId: '' };

    const branch = form.branch.value.trim();
    const values = {
      // '' when the base workspace is the repository, which is the usual case
      // and the one the field is left out of altogether.
      repo: form.repoRel,
      // '' unless a submodule is chosen and the question arose, which keeps a
      // provision run from literal values exactly as it was.
      scope: form.scopeWanted,
      base: form.base.value.trim(),
      branch,
      location: form.location.value.trim()
    };
    return branch !== '' && form.verdicts.get(branch) !== false
      ? { valid: true, values }
      : { valid: false, values, invalidFieldId: form.ids.branch };
  }

  /**
   * Keep the location under the branch, while the location is still ours to set.
   */
  _deriveLocation() {
    const form = this._form;
    if (!form || form.locationEdited) return;
    const named = form.branch.value.trim();
    form.location.value = named && form.repoRoot
      ? defaultLocation(form.repoRoot, named, form.beside)
      : '';
  }

  /**
   * Fill the base in from where the repository is standing.
   *
   * A detached HEAD has no branch name to offer, so it offers the commit
   * instead — which is what `git worktree add` wants either way.
   * @returns {Promise<void>} When it has an answer, or has given up on having one.
   */
  async _fillBaseFromHead() {
    const form = this._form;
    if (!form) return;
    // The repository the tree will be OF, which is the project rather than the
    // chosen submodule when the whole project was asked for.
    const asked = form.subjectRel;
    const head = await this._inRepo(form.ctx, asked, 'git rev-parse --abbrev-ref HEAD');
    if (!head?.success) return;
    let named = String(head?.stdout ?? '').trim();
    if (named === 'HEAD') {
      const detached = await this._inRepo(form.ctx, asked, 'git rev-parse --short HEAD');
      named = String(detached?.stdout ?? '').trim();
    }
    // Asked again on the way back: the user may have typed a base of their own
    // while this was in flight, may have chosen a different repository — for
    // which this answer is a commit that does not exist — and may have closed
    // the form altogether.
    if (!named || this._form !== form || form.subjectRel !== asked) return;
    if (form.baseEdited || form.base.value) return;
    form.base.value = named;
    this._report();
  }

  /**
   * Ask git about the branch name, once the typing has stopped.
   */
  _scheduleBranchCheck() {
    const form = this._form;
    if (!form) return;
    clearTimeout(form.timer);
    form.timer = setTimeout(() => { void this._checkBranch(); }, BRANCH_CHECK_DELAY_MS);
  }

  /**
   * What git makes of the name in the branch field.
   *
   * `git check-ref-format` rather than a regular expression of our own: the
   * rules for a ref name are git's, they are longer than they look, and a second
   * set of them here would be a second set to keep up to date.
   * @returns {Promise<void>} When git has answered, and the form has been told.
   */
  async _checkBranch() {
    const form = this._form;
    if (!form) return;
    const named = form.branch.value.trim();
    if (!named || form.verdicts.has(named)) return;

    const usable = UNQUOTABLE.test(named)
      ? false
      : Boolean((await this._inRepo(form.ctx, '', `git check-ref-format "refs/heads/${named}"`))?.success);
    if (this._form !== form) return;
    form.verdicts.set(named, usable);
    this._showBranchVerdict();
    this._report();
  }

  /**
   * Say what is wrong with the branch name, when git has said there is something.
   */
  _showBranchVerdict() {
    const form = this._form;
    if (!form) return;
    const named = form.branch.value.trim();
    showNote(
      form.branchNote,
      named && form.verdicts.get(named) === false ? 'git will not take that as a branch name.' : '',
      { error: true }
    );
  }

  /**
   * Tell the host the form has moved without anyone having typed in it — the
   * base that filled itself in, the name git has just turned down. The host
   * listens for `input` and `change` on the container it handed over and reads
   * the form when it hears either.
   */
  _report() {
    this._form?.container.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Where the repository is and what a tree of it goes beside, for a form that
   * is being filled in rather than a provision that is being run.
   *
   * Answers with empty paths rather than throwing: a form whose base workspace
   * cannot be resolved still renders, and the provision is what refuses. It asks
   * {@link _repoRoot}, which is what the provision asks, so the location the
   * user is shown and the location the command builds cannot be two places.
   * @param {any} ctx - The form's context.
   * @param {string} repoRel - The repository chosen, relative to the base workspace.
   * @param {string} [scope] - Which end of a submodule was asked for, when one was chosen.
   * @returns {{repoRoot: string, beside: string, subjectRel: string}} Where it is, what a tree of it sits next to, and which repository it is a tree OF.
   */
  _formPlaces(ctx, repoRel, scope = '') {
    try {
      const places = this._repoRoot({ repo: repoRel, scope }, ctx);
      return { repoRoot: places.repoRoot, beside: places.beside, subjectRel: places.repoRel };
    } catch {
      return { repoRoot: '', beside: '', subjectRel: '' };
    }
  }

  /**
   * Which of the repositories under the base workspace are its submodules.
   *
   * Read from `.gitmodules` at the base workspace, so these are its DIRECT
   * submodules and nothing deeper: a submodule of a submodule is listed in a
   * `.gitmodules` this never opens, and is treated as the plain nested
   * repository it otherwise resembles.
   *
   * A base workspace that is not a repository, or a repository with no
   * submodules, answers with an empty set and the form is the form it has always
   * been.
   * @param {any} ctx - The form's context, for operations pinned to the base workspace.
   * @returns {Promise<Set<string>>} Submodule paths, relative to the base workspace.
   */
  async _submodulePaths(ctx) {
    /** @type {Set<string>} */
    const paths = new Set();
    const listed = await this._inRepo(ctx, '', 'git config -f .gitmodules --list');
    if (!listed?.success) return paths;
    for (const line of String(listed?.stdout ?? '').split(/\r?\n/)) {
      const said = /^submodule\..+\.path=(.+)$/.exec(line.trim())?.[1];
      // `.gitmodules` writes a path with forward slashes wherever it was made;
      // the repository list is the server's own, which on Windows is not. They
      // are compared here, so they are spelled the same way here.
      if (said) paths.add(said.trim().replace(/\\/g, '/'));
    }
    return paths;
  }

  /**
   * Whether the base workspace carries a setup hook.
   *
   * It decides which way round the scope field starts, and it is a fair thing to
   * read it from: a project that has written a hook has said what a tree of it
   * needs in order to be usable, and a submodule is the usual reason for saying
   * so. A project with no hook gets the placement it got before there was a
   * choice.
   * @param {any} ctx - The form's context.
   * @returns {Promise<boolean>} Whether there is a hook to run.
   */
  async _hasSetupHook(ctx) {
    const found = await this._inRepo(ctx, '', `test -f "${SETUP_HOOK}"`);
    return Boolean(found?.success);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Where the tree will be, before anything has been built.
   *
   * The host registers the row before running a single command and a row must
   * have a root, so the destination has to be known up front. The form works it
   * out (it shows the user the same answer); a caller that supplies values
   * literally and names no location gets '' and a row registered at the base
   * root, which is harmless because a provisioning row refuses every operation.
   * @param {any} values - What the setup form collected.
   * @returns {string} The intended root, or '' when nothing named one.
   */
  plannedRoot(values) {
    return values?.location ?? '';
  }

  /**
   * Which repository this is about, and how to reach it from where commands run.
   *
   * The base workspace usually IS the repository, and then `repo` is ''. It
   * exists for the project that holds several — which is not exotic here, since
   * the git surfaces already discover repositories under a root rather than
   * assuming the root is one. The form and the provision ask this the same way
   * so that the path shown and the path built cannot be two different places.
   * @param {any} values - What the setup form collected; only `repo` and `scope` are read.
   * @param {any} ctx - The hook's context, for the session and the base workspace.
   * @returns {{repoRel: string, repoRoot: string, beside: string}} The repository, relative and absolute, and what a tree of it goes next to.
   * @throws {Error} When the base workspace cannot be resolved.
   */
  _repoRoot(values, ctx) {
    const baseRoot = ctx?.session?.workspaceRoot?.(ctx?.baseWorkspaceId ?? '');
    if (!baseRoot) throw new Error("Couldn't make a worktree: the base workspace has no root.");
    const chosen = shellSafe(String(values?.repo ?? '').trim(), 'repository path');
    // A submodule can be worked on from either end, and `scope` says which was
    // asked for. `project` makes the enclosing repository the subject: the tree
    // is a tree of that, and the submodule arrives inside it as a submodule —
    // which is to say uninitialised, until a setup hook sees to it.
    const repoRel = String(values?.scope ?? '') === 'project' ? '' : chosen;
    const repoRoot = join(baseRoot, repoRel);
    // A repository under the base workspace rather than at it is nested in
    // something, and a tree beside it would land inside whatever that is. The
    // base workspace is as far out as this knows how to go, which is far enough:
    // it is the tree the conversation was working in when it asked.
    return { repoRel, repoRoot, beside: repoRel ? baseRoot : repoRoot };
  }

  /**
   * Work out where everything is, from values and the base workspace.
   *
   * Shared by `provision` and the setup form so that the path the user is shown
   * and the path the command builds cannot drift apart.
   * @param {any} values - repo, branch, base, location.
   * @param {any} ctx - The hook's context, for the session and the base workspace.
   * @returns {{repoRoot: string, repoRel: string, location: string, treeRel: string, branch: string, base: string}} Everywhere involved.
   */
  _places(values, ctx) {
    const branch = shellSafe(String(values?.branch ?? '').trim(), 'branch name');
    if (!branch) throw new Error("Couldn't make a worktree: no branch was named.");
    const base = shellSafe(String(values?.base ?? 'HEAD').trim() || 'HEAD', 'base');

    const { repoRel, repoRoot, beside } = this._repoRoot(values, ctx);
    const location = String(values?.location ?? '').trim() || defaultLocation(repoRoot, branch, beside);
    const treeRel = relativePath(repoRoot, location);
    if (!treeRel) {
      throw new Error(`Couldn't make a worktree at ${location}: it is not on the same drive as ${repoRoot}.`);
    }
    // The relative path is what the commands below are given, and so it is the
    // one that has to survive being quoted. The absolute location is checked by
    // nothing here because it reaches no command — and a Windows one is written
    // `C:\src\app`, so refusing a backslash would refuse every path on the
    // platform.
    shellSafe(treeRel, 'location');
    return { repoRoot, repoRel, location, treeRel, branch, base };
  }

  /**
   * Run a command as though standing in the repository.
   *
   * `git -C` would do for git alone, but the hook has to run in the new tree and
   * the probes have to look at paths relative to the repository, so one wrapper
   * serves all three. The operations' own root is the boundary; where a command
   * goes from there is the command's business.
   * @param {any} ctx - The hook's context, for `ops` and `signal`.
   * @param {string} repoRel - The repository, relative to the operations' root.
   * @param {string} command - What to run there.
   * @param {object} [params] - Anything else for the shell operation, e.g. a timeout.
   * @returns {Promise<any>} The shell result, success or not.
   */
  _inRepo(ctx, repoRel, command, params = {}) {
    const full = repoRel && repoRel !== '.' ? `cd "${repoRel}" && ${command}` : command;
    return ctx.ops.shell({ command: full, ...params }, ctx.signal);
  }

  /**
   * Run a command there and insist it worked, quoting git's own words when it
   * did not: `fatal: invalid reference: develop` is the whole of what the user
   * needs, and anything we would write instead is worse.
   * @param {any} ctx - The hook's context.
   * @param {string} repoRel - The repository, relative to the operations' root.
   * @param {string} command - What to run.
   * @param {object} [params] - Anything else for the shell operation.
   * @returns {Promise<any>} The result, once it has succeeded.
   * @throws {Error} With the command's own error text.
   */
  async _mustRun(ctx, repoRel, command, params = {}) {
    const result = await this._inRepo(ctx, repoRel, command, params);
    if (!result?.success) {
      const said = String(result?.stderr || result?.stdout || '').trim();
      throw new Error(said || `\`${command}\` failed with no output (exit ${result?.exitCode}).`);
    }
    return result;
  }

  /**
   * Run a command there and insist it worked, saying what it says while it says
   * it.
   *
   * For the one step that is slow enough to need it. The command's latest line
   * of output is handed to `report` as it arrives, so the panel shows the work
   * rather than the wait — and carriage returns count as line ends, because that
   * is how everything that draws a percentage draws it.
   * @param {any} ctx - The hook's context.
   * @param {string} repoRel - The repository, relative to the operations' root.
   * @param {string} command - What to run.
   * @param {(line: string) => void} report - Told each line as it lands.
   * @param {object} [params] - Anything else for the shell operation.
   * @returns {Promise<any>} The result, once it has succeeded.
   * @throws {Error} With the command's own error text.
   */
  async _mustStream(ctx, repoRel, command, report, params = {}) {
    const full = repoRel && repoRel !== '.' ? `cd "${repoRel}" && ${command}` : command;
    let rest = '';
    const result = await ctx.ops.shellStreaming({ command: full, ...params }, (/** @type {any} */ chunk) => {
      if (!chunk?.data) return;
      // A chunk is bytes, not lines: it can carry several, or half of one. The
      // half is kept for the chunk that finishes it, and only the last whole
      // line is worth reporting — the ones before it were true for a moment
      // each and are already gone.
      const parts = `${rest}${chunk.data}`.split(/[\r\n]+/);
      rest = parts.pop() ?? '';
      const latest = parts.map(part => part.trim()).filter(Boolean).pop();
      if (latest) report(latest);
    }, ctx.signal);

    if (!result?.success) {
      const said = String(result?.error || result?.stdout || '').trim();
      throw new Error(said || `\`${command}\` failed with no output (exit ${result?.exitCode}).`);
    }
    return result;
  }

  /**
   * Make the tree.
   *
   * Two irreversible steps, and only the first has an inverse: the hook's
   * effects live inside the tree that removing the worktree takes away with it,
   * so a second compensation would have nothing left to undo by the time it ran.
   * @param {any} values - repo, branch, base, location.
   * @param {any} ctx - Operations pinned to the base workspace, signal, rollback, checkpoint, progress.
   * @returns {Promise<any>} The workspace that now exists.
   */
  async provision(values, ctx) {
    const { repoRoot, repoRel, location, treeRel, branch, base } = this._places(values, ctx);

    const isRepo = await this._inRepo(ctx, repoRel, 'git rev-parse --git-dir');
    if (!isRepo?.success) {
      throw new Error(`Couldn't make a worktree: ${repoRoot} is not a git repository.`);
    }

    // Refuse rather than write into something that is already there. This is
    // what makes the compensation below safe to run unconditionally: it removes
    // a path that did not exist a moment ago, so it can never take away a tree
    // somebody else made and we merely failed to add to.
    const occupied = await this._inRepo(ctx, repoRel, `test -e "${treeRel}"`);
    if (occupied?.success) {
      throw new Error(`Couldn't make a worktree at ${location}: there is already something there.`);
    }

    // A branch that already exists is checked out rather than created, and is
    // never deleted when undoing — it was the user's before we touched it.
    const existing = await this._inRepo(ctx, repoRel, `git rev-parse --verify --quiet "refs/heads/${branch}"`);
    const branchCreatedByUs = !existing?.success;

    const meta = {
      repoDir: repoRoot,
      dir: location,
      treeRel,
      branch,
      base,
      branchCreatedByUs
    };

    ctx.progress('Creating the worktree', location);
    // Both records of how to undo this go in before the step, so there is no
    // instant in which a tree exists that nothing knows how to remove. The cost
    // is that this compensation routinely runs for a tree that was never made,
    // which is why every command in it tolerates absence.
    await ctx.checkpoint(meta);
    ctx.rollback.push(async () => {
      await this._inRepo(ctx, repoRel, `git worktree remove --force "${treeRel}"`);
      await this._inRepo(ctx, repoRel, `rm -rf "${treeRel}"`);
      await this._inRepo(ctx, repoRel, 'git worktree prune');
      if (branchCreatedByUs) {
        await this._inRepo(ctx, repoRel, `git branch -D "${branch}"`);
      }
    });
    const create = branchCreatedByUs ? `-b "${branch}" "${treeRel}" "${base}"` : `"${treeRel}" "${branch}"`;
    await this._mustRun(ctx, repoRel, `git worktree add -q ${create}`);

    // The hook is the repository's, not the tree's: it usually lives under a
    // gitignored `.juggler/`, so a fresh checkout would not have a copy of it.
    const hasHook = await this._inRepo(ctx, repoRel, `test -f "${SETUP_HOOK}"`);
    if (hasHook?.success) {
      const backToRepo = relativePath(location, repoRoot) ?? '..';
      // Every other step of this takes a second and is worth a line. This one
      // clones submodules and installs dependencies, and is the whole of the
      // wait — so it is one step that keeps talking, saying what the hook itself
      // is saying. The step names the work; the hook's own output, which is the
      // only thing that knows how far along it is, is the detail under it.
      const step = 'Setting the worktree up';
      ctx.progress(step, SETUP_HOOK);
      await this._mustStream(
        ctx,
        repoRel,
        `cd "${treeRel}" && sh "${backToRepo}/${SETUP_HOOK}"`,
        (line) => ctx.progress(step, line),
        { timeout: HOOK_TIMEOUT_MS }
      );
    }

    return {
      workspace: {
        root: location,
        label: branch,
        meta
      }
    };
  }

  /**
   * How the tree is doing: which branch it is on, whether it holds work, and how
   * far that branch has drifted from what it tracks.
   *
   * Answered by `GET /api/git/status?workspace=`, not by parsing porcelain here.
   * That endpoint already resolves any ready workspace through the same four
   * refusals an operation makes, and returns branch, divergence and counts in one
   * round trip — which is what makes this cheap enough for a place list to ask
   * it of every row it lists, including ones the user has not selected.
   * @param {any} workspace - The row to report on.
   * @param {any} ctx - Operations pinned to that workspace, and a signal.
   * @returns {Promise<any>} What to show for it.
   */
  async status(workspace, ctx) {
    const repoDir = String(workspace?.meta?.repoDir ?? '');
    if (workspace.available === false) {
      return { detail: 'The worktree directory is missing.', available: false };
    }

    const answer = await api.getGitStatus(workspace.id, { signal: ctx.signal });
    const repo = /** @type {any} */ ((answer?.repos ?? []).find(candidate => !candidate.path));
    if (!repo) {
      // A registered root that is no longer a repository: removed by hand, or
      // never one. Worth saying rather than reporting a clean tree.
      return { detail: 'No git repository there.', available: true };
    }

    let changed = repo.changed;
    let staged = repo.staged;
    let total = repo.total;
    for (const file of repo.files ?? []) {
      if (!isOurs(file.path)) continue;
      if (file.worktree && file.worktree !== '.') changed--;
      if (file.index && file.index !== '.') staged--;
      total--;
    }
    const mine = { ...repo, changed: Math.max(0, changed), staged: Math.max(0, staged) };
    const dirty = Math.max(0, total) > 0;

    return {
      // What the commit is about to take, for the dialog that asks for a message
      // to put on it. The same filter as the counts above, so the list and the
      // number over it are one answer — and free, because the round trip that
      // produced the counts brought the paths with it. The server caps how many
      // it names, which is what `fileCount` is for.
      files: (repo.files ?? [])
        .filter((/** @type {any} */ file) => !isOurs(file.path))
        .map((/** @type {any} */ file) => ({ path: file.path, state: fileStatusWords(file) })),
      fileCount: Math.max(0, total),
      // "branch feat/x · clean" rather than "feat/x · clean": read on its own,
      // in a chip's menu or a row of a list, a bare name is a word with no job.
      // A detached head or no branch at all is already a phrase and says itself.
      //
      // The repository leads it, because a branch name is only half an address:
      // somebody with three checkouts open needs to know which repository they
      // are about to commit into, and every other line about this place — the
      // root, the branch, the counts — is true of a worktree of any of them.
      detail: [
        repoDir ? `repo ${baseName(repoDir)}` : '',
        repo.detached || !repo.branch ? branchPhrase(repo) : `branch ${repo.branch}`,
        countsPhrase(mine) || 'clean',
        divergencePhrase(repo)
      ].filter(Boolean).join(' · '),
      badge: dirty ? 'dirty' : '',
      dirty,
      available: true
    };
  }

  /**
   * The project, when the tree is of a repository the project merely holds.
   *
   * A worktree of the project itself needs nothing here: it is a checkout of the
   * same repository and carries its own copy of every instruction file, on the
   * branch being worked on, so seeding the main checkout's alongside would put
   * two answers to the same question in front of the model. A worktree of a
   * subrepo is the opposite case — the project's own instructions are house
   * rules that a tree of one of its repositories never had a copy of, and
   * nothing below that tree will ever mention them.
   * @param {any} workspace - The row about to be seeded for.
   * @param {any} ctx - The hook's context, for the session.
   * @returns {string[]} The project, or nothing.
   */
  instructionRoots(workspace, ctx) {
    const project = String(ctx?.session?.projectPath ?? '');
    const repoDir = String(workspace?.meta?.repoDir ?? '');
    if (!project || !repoDir) return [];
    // `.` is the repository the project IS; null is another drive, where nothing
    // here stands above anything there.
    const fromProject = relativePath(project, repoDir);
    if (fromProject === null || fromProject === '.') return [];
    return [project];
  }

  /**
   * Committing, and the two ways to be done with a worktree.
   *
   * Committing is not one of the endings and says so: it is the thing you do
   * *while* working here, several times, and the workspace is still in use
   * afterwards. It sat among the endings once, where it both closed the
   * workspace and did not, depending on whether a message had been typed into
   * the box — one field, two unrelated outcomes, neither of them stated.
   *
   * The same rule governs the message itself. Handing the writing of it to this
   * conversation is a second answer, so it is a second button that says as much,
   * and the field means only what its label says it means.
   *
   * The fast-forward sits beside it, and is `git merge --ff-only` and nothing
   * else. It is named in git's own words, down to the command it runs: anybody
   * with a worktree has those words already, and a friendlier paraphrase only
   * hides which of git's several ways of moving work this one is. A worktree
   * shares the repository's object store and refs, so a commit made here is
   * already in the repository — what is missing is that the main checkout's
   * branch does not point at it, and moving that pointer is an act with no
   * failure mode: it works, or git says the branch has moved on and nothing has
   * happened. Rebasing and opening a pull request are still absent, and so is a
   * real merge: resolving a conflict is a flow, and a flow is its own feature
   * rather than a fourth line in a menu.
   *
   * The two endings say "close the workspace" in the same words because that
   * half is the same act, and differ only in the tree's fate, which is the
   * whole of the choice. Each description leads with that difference and closes
   * with the consequence they share, so the eye lands on the part that varies.
   * The workspace is closed rather than deleted because that is what happens:
   * the row is tombstoned, so a conversation that was elsewhere at the time is
   * told it was closed rather than met with an id that means nothing.
   * @param {any} workspace - The row being finished with.
   * @returns {any[]} What can be done, the endings last and safest first.
   */
  finishOptions(workspace) {
    const meta = workspace?.meta ?? {};
    const branch = String(meta?.branch ?? '');
    const repo = baseName(String(meta?.repoDir ?? '')) || 'the repository';
    return [
      {
        id: 'commit',
        label: 'Commit the changes',
        keepsWorkspace: true,
        description: `Commits everything here onto ${branch || 'its branch'}. You carry on working in this workspace.`,
        prompt: {
          label: 'Message',
          placeholder: 'What this work does',
          confirmLabel: 'Commit',
          multiline: true,
          requiresWork: true,
          hint: 'What changed and why, in the words you would use to someone who has not read it.',
          alternative: {
            label: 'Let this conversation write it',
            hint: 'It has read the work; the commit happens on its next turn.'
          }
        }
      },
      {
        id: 'land',
        label: `Fast-forward ${repo} to ${branch || 'this branch'}`,
        keepsWorkspace: true,
        description: `Runs git merge --ff-only ${branch || 'this branch'} in ${repo}, moving the branch it has checked out to this one. Git refuses it if that branch has diverged. The worktree is untouched.`
      },
      {
        id: 'unbind',
        label: 'Close the workspace, keep the worktree',
        description: `The worktree and ${branch || 'its branch'} stay on disk, ready to be adopted again. Conversations here go to the bin, which they can be restored from.`
      },
      {
        id: 'discard',
        label: 'Close the workspace and delete the worktree',
        danger: true,
        description: meta.branchCreatedByUs && branch
          ? `Deletes the worktree and the branch ${branch}, with every commit on it. Conversations here go to the bin, which they can be restored from.`
          : 'Deletes the worktree and everything in it, committed or not. The branch was not ours to make, so it stays. Conversations here go to the bin, which they can be restored from.'
      }
    ];
  }

  /**
   * Carry one of them out.
   *
   * These operations are pinned to the workspace itself, which is the tree —
   * right for a commit, and the reason discarding is written the way it is.
   * @param {any} workspace - The row being finished with.
   * @param {string} actionId - One of {@link finishOptions}.
   * @param {any} ctx - Operations pinned to the tree, the conversation, and whatever the host collected.
   * @returns {Promise<any>} Whether the workspace is finished with, and what to say.
   */
  async finish(workspace, actionId, ctx) {
    const meta = workspace?.meta ?? {};
    const branch = String(meta?.branch ?? '');

    if (actionId === 'unbind') {
      return {
        done: true,
        // What happened to the tree. Where the conversations that were working
        // in it have gone is the host's to say — it is the host that moves
        // them, and how many there were is not a thing a provider knows.
        message: `Stopped using ${meta.dir ?? 'the worktree'}. It and ${branch || 'its branch'} are still there.`
      };
    }
    if (actionId === 'commit') return this._commit(workspace, ctx);
    if (actionId === 'land') return this._land(workspace, ctx);
    if (actionId === 'discard') return this._discard(workspace, ctx);
    return { done: false, message: `${this.getManifest().name} has no action "${actionId}".` };
  }

  /**
   * Commit everything in the tree.
   *
   * With no message, the conversation is asked to write one — it is the only
   * thing here that has read the work — and the commit happens in its next turn.
   * Either way the workspace is left in use: being done with the place is a
   * second, deliberate act, chosen from the endings below this row.
   * @param {any} workspace - The row being finished with.
   * @param {any} ctx - Operations pinned to the tree, and the conversation.
   * @returns {Promise<any>} Whether it is committed.
   */
  async _commit(workspace, ctx) {
    const meta = workspace?.meta ?? {};
    const branch = String(meta?.branch ?? '');
    const message = String(ctx?.input?.message ?? '').trim();

    if (!message) {
      const conversation = ctx?.conversation;
      if (!conversation?.sendMessage) {
        return { done: false, message: 'There is no message to commit under, and nobody here to write one.' };
      }
      await conversation.sendMessage(
        `Commit the work in this worktree${branch ? ` (branch ${branch})` : ''}, with a message describing it.`,
        null,
        conversation.rootMessageThread,
        { consumeComposer: false }
      );
      return { done: false, message: 'Asked this conversation to write the commit.' };
    }

    // No identity of ours is passed: this is the user's commit, in the user's
    // repository, and git's own complaint about an unconfigured one is a better
    // thing to read than a commit authored by a tool they did not choose.
    const staged = await ctx.ops.shell(
      { command: 'git add -A', timeout: COMMIT_TIMEOUT_MS }, ctx.signal);
    if (!staged?.success) {
      return { done: false, message: gitSaid('Couldn’t stage the changes.', staged) };
    }

    const committed = await ctx.ops.shell(
      { command: `git commit -q -m ${singleQuoted(message)}`, timeout: COMMIT_TIMEOUT_MS }, ctx.signal);
    if (!committed?.success) {
      const said = String(committed?.stdout || committed?.stderr || '');
      // Not a failure: it is what a second press lands on, and what a tree
      // already committed from a terminal answers. Told as the fact it is.
      if (/nothing to commit/i.test(said)) {
        return { done: false, message: 'Nothing had changed here, so nothing was committed.' };
      }
      return { done: false, message: gitSaid('Couldn’t make the commit.', committed) };
    }
    // Never `done`: a commit is not a way of being finished with the place it
    // was made in. The workspace stays in use, which is what the menu promised
    // when it put this row outside the endings.
    return { done: false, message: `Committed on ${branch || 'its branch'}.` };
  }

  /**
   * The repository, named the way the BASE operations can reach it.
   *
   * Everything that acts on the repository rather than on the tree goes through
   * here: the workspace's own operations are pinned to the tree and refuse a
   * path outside it, so the repository is named relative to the base workspace,
   * exactly as the provision named it when it made the tree.
   * @param {any} workspace - The row being acted on.
   * @param {any} ctx - The context, for the session and the base workspace.
   * @param {string} why - What cannot be done from here, for the refusal.
   * @returns {{repoRel: string, problem: string}} Where it is, or why not.
   */
  _repoFromBase(workspace, ctx, why) {
    const meta = workspace?.meta ?? {};
    const baseRoot = String(ctx?.session?.workspaceRoot?.(ctx?.baseWorkspaceId ?? '') ?? '');
    const repoRel = meta.repoDir && baseRoot ? relativePath(baseRoot, String(meta.repoDir)) : null;
    if (!repoRel) {
      return {
        repoRel: '',
        problem: `${meta.repoDir || 'The repository'} cannot be reached from ${baseRoot || 'the base workspace'}, so ${why}.`
      };
    }
    return { repoRel, problem: '' };
  }

  /**
   * Run a command in the repository, through the base operations.
   * @param {any} ctx - The context, for `baseOps` and `signal`.
   * @param {string} repoRel - The repository, relative to the base workspace.
   * @param {string} command - What to run there.
   * @returns {Promise<any>} The shell result, success or not.
   */
  _inRepoFromBase(ctx, repoRel, command) {
    const full = repoRel && repoRel !== '.' ? `cd "${repoRel}" && ${command}` : command;
    return ctx.baseOps.shell({ command: full }, ctx.signal);
  }

  /**
   * Put the work onto the branch the repository itself has checked out.
   *
   * This is what "get it back into the repository" actually means for a
   * worktree. Nothing is pushed: a worktree shares the repository's object store
   * and its refs, so the commit is in the repository the instant it is made, and
   * what is missing is only that the main checkout's branch does not point at
   * it. Moving that pointer is the whole act.
   *
   * Fast-forward only, and that is the feature rather than a limitation. A
   * fast-forward cannot conflict, cannot lose a commit, and cannot leave the
   * repository in a state anybody has to be walked out of: either the branch has
   * not moved and it lands, or it has and git declines. A real merge is a flow
   * with conflict resolution in it, which is its own feature and not a button.
   * @param {any} workspace - The row being landed from.
   * @param {any} ctx - Operations pinned to the tree, the base's beside them.
   * @returns {Promise<any>} What happened. Never `done`: the workspace stays in use.
   */
  async _land(workspace, ctx) {
    const meta = workspace?.meta ?? {};
    const branch = String(meta?.branch ?? '');
    if (!branch) {
      return { done: false, message: 'There is no record of which branch this worktree is on, so there is nothing to merge.' };
    }

    const where = this._repoFromBase(workspace, ctx, 'there is nowhere to merge it into');
    if (where.problem) return { done: false, message: where.problem };

    // Uncommitted work stays where it is — landing moves commits — so it is
    // said up front rather than discovered afterwards by a reader wondering
    // where their changes went. Ours is not theirs, the same distinction the
    // status makes.
    const held = await ctx.ops.shell({ command: 'git status --porcelain' }, ctx.signal);
    const uncommitted = String(held?.stdout ?? '')
      .split(/\r?\n/)
      .map(line => line.slice(3).trim())
      .filter(path => path && !isOurs(path));
    if (uncommitted.length) {
      return {
        done: false,
        message: `This worktree has ${uncommitted.length === 1 ? 'an uncommitted change' : `${uncommitted.length} uncommitted changes`}. Commit them first — a fast-forward moves commits, and these would be left behind.`
      };
    }

    const head = await this._inRepoFromBase(ctx, where.repoRel, 'git rev-parse --abbrev-ref HEAD');
    if (!head?.success) {
      return { done: false, message: gitSaid('Couldn’t ask the repository which branch it has out.', head) };
    }
    const into = String(head?.stdout ?? '').trim();
    if (!into || into === 'HEAD') {
      return {
        done: false,
        message: `${baseName(String(meta.repoDir))} has a detached HEAD, so there is no branch to fast-forward to ${branch}.`
      };
    }

    const merged = await this._inRepoFromBase(ctx, where.repoRel, `git merge --ff-only "${branch}"`);
    if (!merged?.success) {
      return {
        done: false,
        message: gitSaid(`${into} has moved on since this worktree was made, so it cannot be fast-forwarded to ${branch}. A merge or a rebase is a job for you and git.`, merged)
      };
    }
    if (/already up to date/i.test(String(merged?.stdout ?? ''))) {
      return { done: false, message: `${into} is already up to date with ${branch}.` };
    }
    return { done: false, message: `Fast-forwarded ${into} to ${branch}.` };
  }

  /**
   * Remove the tree, and the branch when it was ours to make.
   *
   * Run from the REPOSITORY, through the base operations, which is the same
   * ground and the same four commands the provision's own rollback uses. The
   * workspace's own operations are pinned to the tree, and a shell started
   * there stands in the directory this is about to delete: a POSIX shell can
   * step out and carry on, but on Windows the directory cannot be removed while
   * any process holds it, and the shell there is a launcher that holds it for
   * the whole command while the real shell it spawned does the stepping out.
   * Nothing would be removed and nothing would say why.
   *
   * One shell, ending with a question whose answer is the only one the host
   * needs: is there anything left. The steps are separated by `;` rather than
   * `&&` deliberately — each tolerates the one before it having failed, because
   * a tree may be half-there in more ways than there are commands here — so the
   * `cd` that must NOT be tolerated exits instead, rather than leaving the rest
   * to name a `../` path from somewhere nobody intended.
   * @param {any} workspace - The row being finished with.
   * @param {any} ctx - Operations pinned to the tree, and the base's beside them.
   * @returns {Promise<any>} Whether anything is left.
   */
  async _discard(workspace, ctx) {
    const meta = workspace?.meta ?? {};
    const treeRel = String(meta?.treeRel ?? '');
    const branch = String(meta?.branch ?? '');
    if (!meta.repoDir || !treeRel) {
      return {
        done: false,
        message: 'There is no record of where this worktree came from, so it is not ours to remove.'
      };
    }

    const where = this._repoFromBase(workspace, ctx, 'the worktree is not ours to remove from here');
    if (where.problem) return { done: false, message: where.problem };
    const repoRel = where.repoRel;

    const steps = [
      repoRel === '.' ? '' : `cd "${repoRel}" || exit 1`,
      `git worktree remove --force "${treeRel}"`,
      `rm -rf "${treeRel}"`,
      'git worktree prune',
      meta.branchCreatedByUs && branch ? `git branch -D "${branch}"` : '',
      `test -e "${treeRel}" && echo STILL-THERE || echo REMOVED`
    ].filter(Boolean).join('; ');

    const result = await ctx.baseOps.shell({ command: steps }, ctx.signal);
    if (/REMOVED/.test(String(result?.stdout ?? ''))) {
      return {
        done: true,
        message: `Removed ${meta.dir}${meta.branchCreatedByUs && branch ? ` and ${branch}` : ''}.`
      };
    }
    // Why git could not remove it matters more than the fact, and the shell op
    // merges the two streams: it answers with everything the command said on
    // `stdout` and an empty `stderr`. Reading only `stderr` would reach for a
    // field that is always empty and report the bare fallback every time.
    return {
      done: false,
      message: String(result?.stderr || result?.stdout || '').trim() || `${meta.dir} is still there.`
    };
  }

  /**
   * Square the rows against what git actually has, and report both kinds of
   * orphan without touching anything.
   *
   * It looks in the project and in every repository the rows came from, and
   * matches by each tree's path **relative to its own main worktree** — which is
   * the one comparison that holds on Windows, where git reports `/c/src/app` for
   * a root the server calls `C:\src\app`. Everything compared here comes out of
   * the same listing, so the two path worlds never meet.
   *
   * Three findings, and one of them is the reason this exists at all. A tree
   * that has moved to another branch is the only failure nothing downstream
   * catches: the directory is there, every operation succeeds, and the work goes
   * onto a branch the conversation never chose. That one asks to be tombstoned.
   * A tree that is simply gone does not — the server's own `stat` marks it
   * unavailable and the conversation is told, and a tree can come back.
   * @param {any[]} workspaces - This provider's rows.
   * @param {any} ctx - Operations rooted at the project, and a signal.
   * @returns {Promise<any>} What matches, what does not, and what has no row.
   */
  async reconcile(workspaces, ctx) {
    const projectPath = ctx?.session?.projectPath ?? '';
    if (!projectPath) return { orphanedWorkspaces: [], orphanedArtifacts: [], confirmed: [] };

    // The project is always looked in — it is where a pooled tree's repository
    // usually is, and the rows that would name it may not exist yet.
    /** @type {Map<string, string>} repository relative to the project → its absolute path */
    const repos = new Map([['', projectPath]]);
    for (const workspace of workspaces) {
      const repoDir = workspace?.meta?.repoDir;
      if (typeof repoDir !== 'string' || !repoDir) continue;
      const rel = relativePath(projectPath, repoDir);
      if (rel !== null) repos.set(rel === '.' ? '' : rel, repoDir);
    }

    /** @type {string[]} */
    const confirmed = [];
    /** @type {any[]} */
    const orphanedWorkspaces = [];
    /** @type {any[]} */
    const orphanedArtifacts = [];

    for (const [repoRel, repoDir] of repos) {
      const listed = await this._inRepo(ctx, repoRel, 'git worktree list --porcelain');
      if (!listed?.success) continue;
      const trees = parseWorktrees(listed.stdout);
      const main = trees[0];
      if (!main) continue;

      /** @type {Map<string, ListedWorktree>} */
      const found = new Map();
      for (const tree of trees.slice(1)) {
        const rel = relativePath(main.path, tree.path);
        if (rel) found.set(rel, tree);
      }

      for (const workspace of workspaces) {
        if (workspace?.meta?.repoDir !== repoDir) continue;
        // A row that has been finished with contributed its repository to the
        // scan above and nothing else. It claims no tree, so the tree it used to
        // be about stays in `found` and is offered again — and it is reported as
        // no kind of orphan, because a parked row is not a fault.
        if (workspace.state === 'closed') continue;
        const treeRel = String(workspace?.meta?.treeRel ?? '');
        const tree = found.get(treeRel);
        if (!tree) {
          orphanedWorkspaces.push({
            ...workspace,
            reason: `${workspace.meta?.dir ?? workspace.root} is not a worktree of ${repoDir} any more.`
          });
          continue;
        }
        found.delete(treeRel);
        const expected = String(workspace?.meta?.branch ?? '');
        if (expected && tree.branch !== expected) {
          orphanedWorkspaces.push({
            ...workspace,
            tombstone: true,
            reason: `${workspace.meta?.dir ?? workspace.root} is on ${tree.branch || 'no branch'} now, not ${expected}.`
          });
          continue;
        }
        confirmed.push(workspace.id);
      }

      // Whatever git still has and the table does not: somebody else's trees,
      // and the pool a heavy user lives in. Offered, never taken.
      for (const [rel, tree] of found) {
        if (tree.bare) continue;
        const dir = join(repoDir, rel);
        orphanedArtifacts.push({
          id: `${repoDir}\u0000${rel}`,
          label: tree.branch || baseName(dir),
          detail: `${dir} — a worktree of ${baseName(repoDir)} with no workspace`,
          workspace: {
            root: dir,
            label: tree.branch || baseName(dir),
            meta: {
              repoDir,
              dir,
              treeRel: rel,
              branch: tree.branch,
              base: '',
              // Adopting a tree is not making one. Its branch was somebody
              // else's before we ever saw it, so finishing with it can never be
              // a reason to delete that branch.
              branchCreatedByUs: false
            }
          }
        });
      }
    }

    return { orphanedWorkspaces, orphanedArtifacts, confirmed };
  }

  /**
   * Undo a provision that died with the tab it was running in.
   *
   * Written out separately from the compensation above rather than sharing an
   * implementation with it: the two run in different places — that one from the
   * base workspace with paths it computed, this one from the project with
   * nothing but what reached `meta` — and a provider whose two undo paths drift
   * apart is exactly the fault the tests exist to catch. A fixture that could
   * not drift could not catch it.
   *
   * Everything here tolerates absence, because a checkpoint is written before
   * the step it describes: `meta` routinely names a tree that was never made.
   * @param {any} workspace - The half-built row.
   * @param {any} ctx - Operations rooted at the project, and a signal.
   * @returns {Promise<any>} Whether anything is left.
   */
  async cleanupPartial(workspace, ctx) {
    const meta = workspace?.meta ?? {};
    if (!meta.repoDir || !meta.treeRel) {
      return { removed: false, message: 'Nothing was checkpointed, so there is nothing to undo.' };
    }

    const projectPath = ctx.session?.projectPath ?? '';
    const repoRel = (projectPath && relativePath(projectPath, meta.repoDir)) || meta.repoDir;
    const treeRel = String(meta?.treeRel);

    await this._inRepo(ctx, repoRel, `git worktree remove --force "${treeRel}"`);
    await this._inRepo(ctx, repoRel, `rm -rf "${treeRel}"`);
    await this._inRepo(ctx, repoRel, 'git worktree prune');
    if (meta.branchCreatedByUs && meta.branch) {
      await this._inRepo(ctx, repoRel, `git branch -D "${String(meta?.branch)}"`);
    }

    // Asked rather than assumed: `remove` fails for a tree that was never made
    // and for a tree that will not go, and those are opposite answers to the one
    // question the host has — is there anything left to worry about.
    const left = await this._inRepo(ctx, repoRel, `test -e "${treeRel}"`);
    return left?.success
      ? { removed: false, message: `${meta.dir} is still there and could not be removed.` }
      : { removed: true, message: `Removed ${meta.dir}.` };
  }
}

export default GitWorktreeWorkspaceProvider;
