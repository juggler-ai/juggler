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
import { formatList, markUntranslated, translator } from 'juggler/i18n';

const t = translator('@juggler/core');

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
 * Every value this file puts into a command goes through here: paths, branch
 * names, the commit message. Inside single quotes the shell expands nothing, so
 * a name holding `$(…)` or a backtick is passed to git as the name it is. That
 * matters most for the values nobody typed — an adopted tree's path and branch
 * come straight from `git worktree list`, and git allows both characters in
 * either.
 * @param {string} value - Anything at all.
 * @returns {string} A single shell word.
 */
function singleQuoted(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * What git said about a command that refused, to go under a plain lead.
 *
 * Under rather than instead of: the lead says which command refused, which is
 * the part a reader needs to know what they are being told, and git's own text
 * is the part that says what to do about it. Dropping either leaves a message
 * that cannot be acted on. Each caller has two whole messages, the lead with
 * `{detail}` under it and the lead alone, and picks by whether this is empty.
 *
 * The shell operation merges both streams into `stdout` and answers with an
 * empty `stderr`, so `stdout` is read first — a message built from `stderr`
 * alone reaches for a field that is always empty and reports the lead by itself
 * every time.
 * @param {any} result - What the shell answered with.
 * @returns {string} Git's own text, or '' when it said nothing at all.
 */
function gitSaid(result) {
  return String(result?.stdout || result?.stderr || '').trim();
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
 * How many commits a track lists for one repository; past that it counts them.
 * @type {number}
 */
const TRACK_COMMITS = 20;

/**
 * How many uncommitted files a track names; past that it counts them.
 * @type {number}
 */
const TRACK_FILES = 50;

/**
 * The shell loop over the tree's submodules, one `read -r k p` per entry, with
 * `$p` the submodule's path. Read from the tree's own `.gitmodules`, so these
 * are its direct submodules, as {@link GitWorktreeWorkspaceProvider#_submodulePaths}
 * reads them for the form.
 * @type {string}
 */
const EACH_SUBMODULE = "git config -f .gitmodules --get-regexp '^submodule\\..*\\.path$' 2>/dev/null | while read -r k p; do";

/**
 * A path as `git status --porcelain` or `git ls-files` prints it, as the path
 * it is: the new name of a rename, and a name git quoted for holding a space or
 * a quote unquoted again.
 * @param {string} raw - What git printed after the status letters.
 * @returns {string} The path, relative to the repository.
 */
function porcelainPath(raw) {
  const named = raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw;
  if (named.length >= 2 && named.startsWith('"') && named.endsWith('"')) {
    return named.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return named;
}

/**
 * One repository's standing against what it lands in, as {@link trackScript}
 * reports it: the tree itself, or one of its submodules.
 * @typedef {object} RepoReading
 * @property {string} path - '' for the tree; a submodule's path within it otherwise
 * @property {string} branch - What it is measured against: the base branch for
 *   the tree, the base checkout's submodule's branch for a submodule, '' when
 *   there is nothing to measure against
 * @property {'none'|'rebase'|'merge'} state - What git is in the middle of there
 * @property {string[]} unmerged - Files a stopped rebase or merge left in conflict
 * @property {boolean} known - Whether the counts were read at all
 * @property {number} ahead - Commits here that `branch` lacks
 * @property {number} behind - Commits on `branch` that are not here
 * @property {{sha: string, subject: string}[]} commits - The first of those `ahead`, newest first
 * @property {string} head - Its HEAD, for a submodule
 * @property {string} status - For a submodule: 'ok'; 'uninit' when the tree
 *   never cloned it; 'nobase' when the base checkout has no copy of it;
 *   'detached' when that copy is on no branch; 'unfetched' when its branch
 *   could not be fetched from there
 * @property {boolean} moved - For a submodule: whether this branch points it
 *   somewhere the base branch does not
 */

/**
 * The whole of a tree's standing: its own, its uncommitted files, and its
 * submodules'.
 * @typedef {RepoReading & {files: {path: string, state: string}[], fileCount: number, subs: RepoReading[]}} TreeReading
 */

/**
 * A reading with nothing in it yet.
 * @param {string} path - Which repository it is of.
 * @returns {RepoReading} Empty counts, no state.
 */
function emptyReading(path) {
  return { path, branch: '', state: 'none', unmerged: [], known: false, ahead: 0, behind: 0, commits: [], head: '', status: 'ok', moved: false };
}

/**
 * The command that reads where a tree stands, run in the tree.
 *
 * One process for everything, because a launch is the cost that matters where
 * commands go through WSL. Each line is `kind<TAB>scope<TAB>value…`, the scope
 * being '' for the tree and a submodule's path for one of its submodules.
 *
 * The base is the branch the tree was made from when that is still a branch,
 * and otherwise whatever the repository's main checkout has out. The base
 * checkout's copy of each submodule is reached through that checkout's path as
 * `git worktree list` gives it, in the shell's own terms, so no path of the
 * server's is put in the command.
 * @param {string} base - The branch the tree was made from, as its row records it.
 * @returns {string} The command.
 */
function trackScript(base) {
  return [
    `b=${singleQuoted(base)}`,
    `main=$(git worktree list --porcelain | awk 'NR==1{sub(/^worktree /,""); print; exit}')`,
    'if [ -z "$b" ] || ! git rev-parse -q --verify "refs/heads/$b" >/dev/null; then b=$(git -C "$main" symbolic-ref -q --short HEAD); fi',
    "printf 'base\\t\\t%s\\n' \"$b\"",
    'st() { if [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; then echo rebase; elif git rev-parse -q --verify MERGE_HEAD >/dev/null; then echo merge; else echo none; fi; }',
    'rep() {',
    "  printf 'state\\t%s\\t%s\\n' \"$1\" \"$(st)\"",
    "  git -c core.quotepath=off diff --name-only --diff-filter=U | while IFS= read -r f; do printf 'unmerged\\t%s\\t%s\\n' \"$1\" \"$f\"; done",
    '  [ -n "$2" ] || return 0',
    "  c=$(git rev-list --left-right --count \"$2...HEAD\" 2>/dev/null) && printf 'counts\\t%s\\t%s\\n' \"$1\" \"$c\"",
    `  git log -n ${TRACK_COMMITS} --format='%h%x09%s' "$2..HEAD" 2>/dev/null | while IFS= read -r l; do printf 'commit\\t%s\\t%s\\n' "$1" "$l"; done`,
    '}',
    "git -c core.quotepath=off status --porcelain | while IFS= read -r l; do printf 'file\\t\\t%s\\n' \"$l\"; done",
    'rep "" "$b"',
    EACH_SUBMODULE,
    "  if [ ! -e \"$p/.git\" ]; then printf 'sub\\t%s\\tuninit\\t0\\t\\n' \"$p\"; continue; fi",
    '  mv=0; if [ -n "$b" ] && ! git diff --quiet "$b" HEAD -- "$p" 2>/dev/null; then mv=1; fi',
    "  printf 'head\\t%s\\t%s\\n' \"$p\" \"$(git -C \"$p\" rev-parse -q --verify HEAD)\"",
    "  if [ ! -e \"$main/$p/.git\" ]; then printf 'sub\\t%s\\tnobase\\t%s\\t\\n' \"$p\" \"$mv\"; continue; fi",
    '  sb=$(git -C "$main/$p" symbolic-ref -q --short HEAD)',
    "  if [ -z \"$sb\" ]; then printf 'sub\\t%s\\tdetached\\t%s\\t\\n' \"$p\" \"$mv\"; continue; fi",
    // The tree's copy of a submodule is a store of its own, which has never
    // seen the commits of the base checkout's copy, so those are fetched into
    // it to be compared with. Under a private ref, in a local store: nothing
    // is pushed anywhere and no branch of anybody's moves, and the next read
    // overwrites it.
    "  if ! git -C \"$p\" fetch -q \"$main/$p\" \"+refs/heads/$sb:refs/juggler/base/$sb\" </dev/null 2>/dev/null; then printf 'sub\\t%s\\tunfetched\\t%s\\t%s\\n' \"$p\" \"$mv\" \"$sb\"; continue; fi",
    "  printf 'sub\\t%s\\tok\\t%s\\t%s\\n' \"$p\" \"$mv\" \"$sb\"",
    '  (cd "$p" && rep "$p" "refs/juggler/base/$sb") </dev/null',
    'done'
  ].join('\n');
}

/**
 * Read what {@link trackScript} printed.
 * @param {string} text - Its output.
 * @returns {TreeReading} Where the tree stands.
 */
function parseReading(text) {
  /** @type {TreeReading} */
  const tree = { ...emptyReading(''), files: [], fileCount: 0, subs: [] };
  /** @type {Map<string, RepoReading>} */
  const subs = new Map();
  /** @type {Map<string, string>} */
  const heads = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const [kind, scope = '', ...rest] = line.split('\t');
    const value = rest.join('\t');
    if (kind === 'base') {
      tree.branch = value.trim();
    } else if (kind === 'file') {
      const path = porcelainPath(value.slice(3));
      if (!path || isOurs(path)) continue;
      tree.fileCount++;
      if (tree.files.length < TRACK_FILES) {
        const side = (/** @type {string} */ letter) => (letter === ' ' ? '.' : letter);
        tree.files.push({ path, state: fileStatusWords({ path, index: side(value[0] ?? ' '), worktree: side(value[1] ?? ' ') }) });
      }
    } else if (kind === 'head') {
      heads.set(scope, value.trim());
    } else if (kind === 'sub') {
      const sub = { ...emptyReading(scope), status: rest[0] ?? '', moved: rest[1] === '1', branch: rest.slice(2).join('\t'), head: heads.get(scope) ?? '' };
      subs.set(scope, sub);
      tree.subs.push(sub);
    } else {
      const repo = scope ? subs.get(scope) : tree;
      if (!repo) continue;
      if (kind === 'state') repo.state = value === 'rebase' || value === 'merge' ? value : 'none';
      else if (kind === 'unmerged' && value) repo.unmerged.push(value);
      else if (kind === 'counts') {
        repo.behind = Number(rest[0]) || 0;
        repo.ahead = Number(rest[1]) || 0;
        repo.known = true;
      } else if (kind === 'commit') repo.commits.push({ sha: rest[0] ?? '', subject: rest.slice(1).join('\t') });
    }
  }
  return tree;
}

/**
 * What to run after each commit of a rebase so that every submodule pointer it
 * carries is moved to where that commit now is.
 *
 * A submodule rebased onto the base checkout's copy has new commits for the
 * old ones, and the tree's commits that pointed at the old ones would land
 * pointing at commits the base checkout's copy never gets. So each commit,
 * once picked, is amended to point at the rebased commit instead — only when
 * it points at one of the old ones, and with no hooks, since nothing about it
 * but the pointer changes.
 * @param {Map<string, Map<string, string>>} moves - Submodule path → old commit → new commit.
 * @returns {string} The command for `git rebase --exec`, or '' when nothing moved.
 */
function repointScript(moves) {
  const cases = [...moves].filter(([, moved]) => moved.size > 0).map(([path, moved]) => {
    const arms = [...moved].map(([from, to]) => `${from}) git update-index --cacheinfo ${singleQuoted(`160000,${to},${path}`)} && c=1;;`);
    return `case "$(git rev-parse -q --verify ${singleQuoted(`HEAD:${path}`)})" in ${arms.join(' ')} esac`;
  });
  if (!cases.length) return '';
  return ['c=', ...cases, 'if [ -n "$c" ]; then git commit -q --amend --no-edit --no-verify --allow-empty; fi'].join('; ');
}

/**
 * The repository a reading says is in the middle of a rebase or merge, a
 * submodule before the tree: the tree's rebase cannot finish while one of its
 * submodules' is stopped.
 * @param {TreeReading} reading - Where the tree stands.
 * @returns {RepoReading|null} The one to resolve first, or null when none is.
 */
function stuckRepo(reading) {
  return reading.subs.find(sub => sub.state !== 'none') ?? (reading.state !== 'none' ? reading : null);
}

/**
 * What `git ls-files -u` says is in conflict, by path.
 * @param {string} text - Its output: `mode sha stage<TAB>path` per line.
 * @returns {Map<string, {gitlink: boolean, theirs: string}>} Each conflicted
 *   path, whether every side of it is a submodule pointer, and the side being
 *   replayed (stage 3) where there is one.
 */
function parseUnmerged(text) {
  /** @type {Map<string, {gitlink: boolean, theirs: string}>} */
  const found = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t(.+)$/.exec(line.trim());
    if (!match) continue;
    const path = porcelainPath(match[4] ?? '');
    const entry = found.get(path) ?? { gitlink: true, theirs: '' };
    if (match[1] !== '160000') entry.gitlink = false;
    if (match[3] === '3') entry.theirs = match[2] ?? '';
    found.set(path, entry);
  }
  return found;
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
    // i18n-ignore: git's own name for where the repository is standing
    const base = field(container, ids.base, 'base', t('Base'), 'HEAD');
    // i18n-ignore: an example branch name, which is git's to read
    const branch = field(container, ids.branch, 'branch', t('Branch'), 'feat/my-change');
    const location = field(container, ids.location, 'location', t('Location'), t('beside the repository'));

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
    const { select } = choice(form.container, form.ids.repo, 'repo', t('Repository'),
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

    const projectName = baseName(this._formPlaces(form.ctx, '').repoRoot);
    if (!form.scope) {
      const { select, note } = choice(form.container, form.ids.scope, 'scope', t('Worktree'), [
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

    form.scope.options[0].textContent = t('{target, select, named {{project}, with {repo} in it} other {the project, with {repo} in it}}',
      { target: projectName ? 'named' : 'unnamed', project: projectName, repo: form.repoRel });
    form.scope.options[1].textContent = t('{repo} on its own', { repo: form.repoRel });
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
      showNote(form.scopeNote, t('Only {repo}. Nothing of the project around it comes with it.', { repo: form.repoRel }));
      return;
    }
    showNote(form.scopeNote, form.hasSetupHook
      ? t('{repo} starts uninitialised; {hook} runs in the new tree.', { repo: form.repoRel, hook: SETUP_HOOK })
      : t('{repo} starts uninitialised — there is no {hook} to fill it in.', { repo: form.repoRel, hook: SETUP_HOOK }));
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

    const usable = Boolean((await this._inRepo(form.ctx, '', `git check-ref-format ${singleQuoted(`refs/heads/${named}`)}`))?.success);
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
      named && form.verdicts.get(named) === false ? t('git will not take that as a branch name.') : '',
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
    const found = await this._inRepo(ctx, '', `test -f ${singleQuoted(SETUP_HOOK)}`);
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
    if (!baseRoot) throw new Error(t("Couldn't make a worktree: the base workspace has no root."));
    const chosen = String(values?.repo ?? '').trim();
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
    const branch = String(values?.branch ?? '').trim();
    if (!branch) throw new Error(t("Couldn't make a worktree: no branch was named."));
    const base = String(values?.base ?? 'HEAD').trim() || 'HEAD';

    const { repoRel, repoRoot, beside } = this._repoRoot(values, ctx);
    const location = String(values?.location ?? '').trim() || defaultLocation(repoRoot, branch, beside);
    const treeRel = relativePath(repoRoot, location);
    if (!treeRel) {
      throw new Error(t("Couldn't make a worktree at {location}: it is not on the same drive as {repoRoot}.", { location, repoRoot }));
    }
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
    const full = repoRel && repoRel !== '.' ? `cd ${singleQuoted(repoRel)} && ${command}` : command;
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
      throw new Error(said || t('`{command}` failed with no output (exit {code}).', { command, code: String(result?.exitCode) }));
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
    const full = repoRel && repoRel !== '.' ? `cd ${singleQuoted(repoRel)} && ${command}` : command;
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
      throw new Error(said || t('`{command}` failed with no output (exit {code}).', { command, code: String(result?.exitCode) }));
    }
    return result;
  }

  /**
   * Point the new tree's `.git` file at its repository by a relative path.
   *
   * `git worktree add` writes an absolute `gitdir:` in the shell's own idea of
   * an absolute path, and on Windows the server reads the tree with a different
   * git: one made through WSL says `/mnt/c/…`, which the native git behind the
   * status endpoint cannot open, so the tree reads as no repository at all. A
   * relative gitdir means the same thing to every git of every version. Only the
   * ordinary shape is rewritten — `<repo>/.git/worktrees/<name>` — and the result
   * is checked with git before it stands; anything else is left as git wrote it.
   *
   * The repository's own pointer back to the tree is git's, and stays absolute.
   * @param {any} ctx - The hook's context.
   * @param {string} repoRel - The repository, relative to the operations' root.
   * @param {string} treeRel - The tree, relative to the repository.
   * @param {string} location - The tree's absolute path, as the server has it.
   * @param {string} repoRoot - The repository's absolute path, as the server has it.
   * @returns {Promise<void>} Once the file says what it should, or is left alone.
   */
  async _relativeGitfile(ctx, repoRel, treeRel, location, repoRoot) {
    const gitfile = singleQuoted(`${treeRel}/.git`);
    const read = await this._inRepo(ctx, repoRel, `cat ${gitfile}`);
    const written = /^gitdir:\s*(.+?)\s*$/m.exec(String(read?.stdout ?? ''))?.[1];
    if (!read?.success || !written) return;
    const target = written.replace(/\\/g, '/');
    if (!/^(\/|[A-Za-z]:\/)/.test(target)) return;
    const name = /\/\.git\/worktrees\/([A-Za-z0-9._-]+)$/.exec(target)?.[1];
    const back = relativePath(location, repoRoot);
    if (!name || !back) return;

    await this._inRepo(ctx, repoRel, `printf 'gitdir: %s\\n' ${singleQuoted(`${back}/.git/worktrees/${name}`)} > ${gitfile}`);
    const holds = await this._inRepo(ctx, repoRel, `git -C ${singleQuoted(treeRel)} rev-parse --git-dir`);
    if (!holds?.success) {
      await this._inRepo(ctx, repoRel, `printf 'gitdir: %s\\n' ${singleQuoted(written)} > ${gitfile}`);
    }
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
      throw new Error(t("Couldn't make a worktree: {repoRoot} is not a git repository.", { repoRoot }));
    }

    // Refuse rather than write into something that is already there. This is
    // what makes the compensation below safe to run unconditionally: it removes
    // a path that did not exist a moment ago, so it can never take away a tree
    // somebody else made and we merely failed to add to.
    const occupied = await this._inRepo(ctx, repoRel, `test -e ${singleQuoted(treeRel)}`);
    if (occupied?.success) {
      throw new Error(t("Couldn't make a worktree at {location}: there is already something there.", { location }));
    }

    // A branch that already exists is checked out rather than created, and is
    // never deleted when undoing — it was the user's before we touched it.
    const existing = await this._inRepo(ctx, repoRel, `git rev-parse --verify --quiet ${singleQuoted(`refs/heads/${branch}`)}`);
    const branchCreatedByUs = !existing?.success;

    const meta = {
      repoDir: repoRoot,
      dir: location,
      treeRel,
      branch,
      base,
      branchCreatedByUs
    };

    ctx.progress(t('Creating the worktree'), location);
    // Both records of how to undo this go in before the step, so there is no
    // instant in which a tree exists that nothing knows how to remove. The cost
    // is that this compensation routinely runs for a tree that was never made,
    // which is why every command in it tolerates absence.
    await ctx.checkpoint(meta);
    ctx.rollback.push(async () => {
      await this._inRepo(ctx, repoRel, `git worktree remove --force ${singleQuoted(treeRel)}`);
      await this._inRepo(ctx, repoRel, `rm -rf ${singleQuoted(treeRel)}`);
      await this._inRepo(ctx, repoRel, 'git worktree prune');
      if (branchCreatedByUs) {
        await this._inRepo(ctx, repoRel, `git branch -D ${singleQuoted(branch)}`);
      }
    });
    const create = branchCreatedByUs ? `-b ${singleQuoted(branch)} ${singleQuoted(treeRel)} ${singleQuoted(base)}` : `${singleQuoted(treeRel)} ${singleQuoted(branch)}`;
    await this._mustRun(ctx, repoRel, `git worktree add -q ${create}`);
    await this._relativeGitfile(ctx, repoRel, treeRel, location, repoRoot);

    // The hook is the repository's, not the tree's: it usually lives under a
    // gitignored `.juggler/`, so a fresh checkout would not have a copy of it.
    const hasHook = await this._inRepo(ctx, repoRel, `test -f ${singleQuoted(SETUP_HOOK)}`);
    if (hasHook?.success) {
      const backToRepo = relativePath(location, repoRoot) ?? '..';
      // Every other step of this takes a second and is worth a line. This one
      // clones submodules and installs dependencies, and is the whole of the
      // wait — so it is one step that keeps talking, saying what the hook itself
      // is saying. The step names the work; the hook's own output, which is the
      // only thing that knows how far along it is, is the detail under it.
      const step = t('Setting the worktree up');
      ctx.progress(step, SETUP_HOOK);
      await this._mustStream(
        ctx,
        repoRel,
        `cd ${singleQuoted(treeRel)} && sh ${singleQuoted(`${backToRepo}/${SETUP_HOOK}`)}`,
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
      return { detail: t('The worktree directory is missing.'), available: false };
    }

    const answer = await api.getGitStatus(workspace.id, { signal: ctx.signal });
    const repo = /** @type {any} */ ((answer?.repos ?? []).find(candidate => !candidate.path));
    if (!repo) {
      // A registered root that is no longer a repository: removed by hand, or
      // never one. Worth saying rather than reporting a clean tree.
      return { detail: t('No git repository there.'), available: true };
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
        repoDir ? t('repo {name}', { name: baseName(repoDir) }) : '',
        repo.detached || !repo.branch ? branchPhrase(repo) : t('branch {branch}', { branch: repo.branch }),
        countsPhrase(mine) || t('clean'),
        divergencePhrase(repo)
      ].filter(Boolean).join(' · '),
      badge: dirty ? 'dirty' : '',
      dirty,
      available: true
    };
  }

  // ==========================================================================
  // The track
  // ==========================================================================

  /**
   * Where the tree stands against its base, read in one command through the
   * tree's own operations.
   * @param {any} workspace - The row.
   * @param {any} ctx - Operations pinned to the tree, and a signal.
   * @returns {Promise<TreeReading>} What the command found.
   * @throws {Error} With git's own text, when the command could not run.
   */
  async _read(workspace, ctx) {
    const result = await ctx.ops.shell({ command: trackScript(String(workspace?.meta?.base ?? '')) }, ctx.signal);
    if (!result?.success) {
      const detail = gitSaid(result);
      throw new Error(detail
        ? t("Couldn't read how the worktree stands against its base.\n\n{detail}", { detail })
        : t("Couldn't read how the worktree stands against its base."));
    }
    return parseReading(result.stdout);
  }

  /**
   * The three steps from here to done: commit, land in the base, close.
   *
   * Measured against the base branch rather than an upstream, because landing
   * in the base is what finishing with a worktree means, and "clean against the
   * upstream" says nothing about whether the work got there. Each submodule is
   * measured against the branch the base checkout's copy of it has out.
   * @param {any} workspace - The row.
   * @param {any} ctx - Operations pinned to the tree, the conversation actions
   *   would be carried out for, and a signal.
   * @returns {Promise<any>} The steps, or null for a tree that is not there.
   */
  async track(workspace, ctx) {
    if (workspace?.available === false) return null;
    const reading = await this._read(workspace, ctx);
    return { steps: this._steps(workspace, reading, Boolean(ctx?.conversation?.sendMessage)) };
  }

  /**
   * The steps, from a reading.
   * @param {any} workspace - The row.
   * @param {TreeReading} reading - Where the tree stands.
   * @param {boolean} handOff - Whether there is a conversation to hand work to.
   * @returns {any[]} The commit, land and close steps.
   */
  _steps(workspace, reading, handOff) {
    const meta = workspace?.meta ?? {};
    const name = String(meta.branch || workspace?.label || '');
    const base = reading.branch;
    const stuck = stuckRepo(reading);
    const dirty = !stuck && reading.fileCount > 0;
    const landing = reading.subs.filter(sub => sub.status === 'ok' && sub.ahead > 0);
    const unreachable = reading.subs.filter(sub => sub.status !== 'ok' && sub.status !== 'uninit' && sub.moved);
    const landed = !stuck && !dirty && Boolean(base) && reading.known
      && reading.ahead === 0 && landing.length === 0 && unreachable.length === 0;

    /** @type {any} */
    const commitAction = {
      id: 'commit',
      label: t('Commit'),
      primary: true,
      input: {
        placeholder: t('What this work does, and why'),
        hint: t('What changed and why, in the words you would use to someone who has not read it.'),
        multiline: true
      }
    };
    if (handOff) {
      commitAction.alternative = {
        label: t('Let this conversation write it'),
        hint: t('It has read the work; the commit happens on its next turn.')
      };
    }
    const commit = dirty
      ? {
        id: 'commit',
        state: 'now',
        title: t('{count, plural, one {# file changed, not committed} other {# files changed, not committed}}', { count: reading.fileCount }),
        files: reading.files,
        fileCount: reading.fileCount,
        actions: [commitAction]
      }
      : { id: 'commit', state: 'done', title: t('Everything is committed') };

    const title = t('Close and delete the worktree');
    const close = landed
      ? {
        id: 'close',
        state: 'now',
        title,
        note: meta.branchCreatedByUs
          ? t('Nothing is lost: {name} and its commits are all in {base}. Conversations here go to the bin.', { name, base })
          : t("Nothing is lost: everything here is in {base}. The branch wasn't made by Juggler, so it stays. Conversations here go to the bin.", { base }),
        actions: [{ id: 'discard', label: t('Close and delete'), primary: true }]
      }
      : { id: 'close', state: 'wait', title, ...(base ? { note: t('Once everything is in {base}.', { base }) } : {}) };

    return [commit, this._landStep({ meta, name, base, reading, stuck, dirty, landing, unreachable, landed, handOff }), close];
  }

  /**
   * The middle step: landing in the base.
   * @param {{meta: any, name: string, base: string, reading: TreeReading, stuck: RepoReading|null, dirty: boolean,
   *   landing: RepoReading[], unreachable: RepoReading[], landed: boolean, handOff: boolean}} at - What {@link _steps} worked out.
   * @returns {any} The step.
   */
  _landStep(at) {
    const { meta, name, base, reading, stuck, dirty, landing, unreachable, landed, handOff } = at;
    if (stuck) {
      const kind = stuck.state;
      return {
        id: 'land',
        state: 'blocked',
        title: t('{kind, select, rebase {{count, plural, =0 {Rebasing {name} onto {onto} stopped} one {Rebasing {name} onto {onto} stopped: # file conflicts} other {Rebasing {name} onto {onto} stopped: # files conflict}}} other {{count, plural, =0 {Merging into {name} stopped} one {Merging into {name} stopped: # file conflicts} other {Merging into {name} stopped: # files conflict}}}}', {
          kind,
          count: stuck.unmerged.length,
          name: stuck.path || name,
          onto: (stuck.path ? stuck.branch : base) || 'HEAD'
        }),
        note: t("{kind, select, rebase {{base} hasn't been touched. The worktree is mid-rebase.} other {The worktree is mid-merge.}}", { kind, base: base || name }),
        files: stuck.unmerged.map(path => ({ path, state: fileStatusWords({ path, index: '.', worktree: 'U' }) })),
        actions: [
          ...(handOff ? [{ id: 'resolve', label: t('Have the conversation resolve it'), primary: true }] : []),
          { id: 'continue', label: t('Continue'), primary: !handOff },
          { id: 'abort', label: t('{kind, select, rebase {Abort the rebase} other {Abort the merge}}', { kind }) }
        ]
      };
    }
    if (!base) {
      return {
        id: 'land',
        state: 'blocked',
        title: t('No branch to land in'),
        note: t("{repo} isn't on a branch, and this worktree has no record of the branch it came from.", { repo: baseName(String(meta?.repoDir ?? '')) || name })
      };
    }

    const groups = [
      ...landing.map(sub => ({
        name: sub.path,
        note: t('{count, plural, one {Submodule, # commit not in its {branch}} other {Submodule, # commits not in its {branch}}}', { count: sub.ahead, branch: sub.branch }),
        commits: sub.commits,
        commitCount: sub.ahead
      })),
      ...unreachable.map(sub => ({
        name: sub.path,
        note: t("{why, select, detached {Submodule, repointed here, but its copy in the base checkout isn't on a branch to land on.} nobase {Submodule, repointed here, but the base checkout has no copy of it to land in.} other {Submodule, repointed here, but its copy in the base checkout couldn't be read.}}", { why: sub.status })
      }))
    ];
    const listed = {
      commits: reading.commits,
      commitCount: reading.ahead,
      ...(groups.length ? { groups } : {})
    };
    const update = reading.behind > 0 ? [{ id: 'update', label: t('Update from {base}', { base }) }] : [];

    if (dirty) {
      return {
        id: 'land',
        state: 'wait',
        title: t('Land in {base}', { base }),
        note: t('{count, plural, one {After the commit: {name} will have # commit not in {base}.} other {After the commit: {name} will have # commits not in {base}.}}', { count: reading.ahead + 1, name, base }),
        ...listed
      };
    }
    if (unreachable.length) {
      return {
        id: 'land',
        state: 'blocked',
        title: t('Land in {base}', { base }),
        note: t("A submodule this branch repoints can't be landed in the base checkout."),
        ...listed
      };
    }
    if (landed) {
      const subs = reading.subs.filter(sub => sub.status === 'ok').map(sub => sub.path);
      return {
        id: 'land',
        state: 'done',
        title: t('Everything is in {base}', { base }),
        ...(subs.length ? { note: t('{count, plural, one {Including the submodule {names}.} other {Including the submodules {names}.}}', { count: subs.length, names: formatList(subs) }) } : {}),
        ...(update.length ? { actions: update } : {})
      };
    }

    const diverged = landing.some(sub => sub.behind > 0);
    let note = '';
    if (reading.behind > 0) {
      note = landing.length
        ? t("{count, plural, one {{base} has # commit {name} doesn't have, so {name} is rebased onto it first: submodules, then this repository.} other {{base} has # commits {name} doesn't have, so {name} is rebased onto it first: submodules, then this repository.}}", { count: reading.behind, name, base })
        : t("{count, plural, one {{base} has # commit {name} doesn't have, so {name} is rebased onto it first.} other {{base} has # commits {name} doesn't have, so {name} is rebased onto it first.}}", { count: reading.behind, name, base });
    } else if (diverged) {
      note = t('Submodules that moved on in the base checkout are rebased onto it first.');
    }
    return {
      id: 'land',
      state: 'now',
      title: t('{count, plural, =0 {Submodule commits not yet in {base}} one {# commit not yet in {base}} other {# commits not yet in {base}}}', { count: reading.ahead, base }),
      ...(note ? { note } : {}),
      ...listed,
      actions: [
        { id: 'land', label: t('Land in {base}', { base }), primary: true },
        ...(diverged ? [] : [{ id: 'land-merge', label: t('Merge into {base}', { base }) }]),
        { id: 'land-close', label: t('Land and close') },
        ...update
      ]
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
   * The two ways to be done with a worktree, and committing while the panel
   * has no track to offer it from.
   *
   * Landing is not here: it lives in the track, where it is offered only when
   * there is something to land and the steps around it say what it waits on.
   * Committing is here only for a caller that has read no track, and not when
   * the status it read says the tree is clean — a commit offered there opens a
   * dialog whose only button cannot be pressed.
   *
   * The two endings say "close the workspace" in the same words because that
   * half is the same act, and differ only in the tree's fate, which is the
   * whole of the choice. Deleting is red only when the track says it would lose
   * something, and then it says what; with no track read, it describes the
   * worst case and is red. The workspace is closed rather than deleted because
   * that is what happens: the row is tombstoned, so a conversation that was
   * elsewhere at the time is told it was closed rather than met with an id that
   * means nothing.
   * @param {any} workspace - The row being finished with.
   * @param {any} [known] - Its last status and track, where the caller has them.
   * @returns {any[]} What can be done, the endings last and safest first.
   */
  finishOptions(workspace, known = {}) {
    const meta = workspace?.meta ?? {};
    const branch = String(meta?.branch ?? '');
    // Named when the record says which; a phrase standing in for it otherwise.
    const branchTarget = branch ? 'named' : 'none';
    const options = [];
    if (!known?.track && known?.status?.dirty !== false) {
      options.push({
        id: 'commit',
        label: t('Commit the changes'),
        keepsWorkspace: true,
        description: t('{target, select, named {Commits everything here onto {branch}. You carry on working in this workspace.} other {Commits everything here onto its branch. You carry on working in this workspace.}}', { target: branchTarget, branch }),
        prompt: {
          label: t('Message'),
          placeholder: t('What this work does'),
          confirmLabel: t('Commit'),
          multiline: true,
          requiresWork: true,
          hint: t('What changed and why, in the words you would use to someone who has not read it.'),
          alternative: {
            label: t('Let this conversation write it'),
            hint: t('It has read the work; the commit happens on its next turn.')
          }
        }
      });
    }
    options.push({
      id: 'unbind',
      label: t('Close the workspace, keep the worktree'),
      description: t('{target, select, named {The worktree and {branch} stay on disk, ready to be adopted again. Conversations here go to the bin, which they can be restored from.} other {The worktree and its branch stay on disk, ready to be adopted again. Conversations here go to the bin, which they can be restored from.}}', { target: branchTarget, branch })
    });
    options.push({
      id: 'discard',
      label: t('Close the workspace and delete the worktree'),
      ...this._discardCost(meta, branch, known?.track)
    });
    return options;
  }

  /**
   * What deleting the tree would cost, from the track when there is one.
   * @param {any} meta - The row's record.
   * @param {string} branch - Its branch.
   * @param {any} track - The last track read, or nothing.
   * @returns {{danger: boolean, description: string}} Whether it is red, and why.
   */
  _discardCost(meta, branch, track) {
    const ours = Boolean(meta.branchCreatedByUs && branch);
    const worst = {
      danger: true,
      description: ours
        ? t('Deletes the worktree and the branch {branch}, with every commit on it. Conversations here go to the bin, which they can be restored from.', { branch })
        : t("Deletes the worktree and everything in it, committed or not. The branch wasn't made by Juggler, so it stays. Conversations here go to the bin, which they can be restored from.")
    };
    const steps = Array.isArray(track?.steps) ? track.steps : [];
    const step = (/** @type {string} */ id) => steps.find((/** @type {any} */ s) => s.id === id);
    const commit = step('commit');
    const land = step('land');
    const close = step('close');
    if (!commit || !land || !close || land.state === 'blocked') return worst;

    if (close.state === 'now') {
      return {
        danger: false,
        description: ours
          ? t('Nothing here is lost: every commit is in the base branch. Deletes the worktree and the branch {branch}. Conversations here go to the bin, which they can be restored from.', { branch })
          : t('Nothing here is lost: every commit is in the base branch. Deletes the worktree. Conversations here go to the bin, which they can be restored from.')
      };
    }
    const files = commit.state === 'now' ? Number(commit.fileCount ?? commit.files?.length ?? 0) : 0;
    // A branch that was not ours stays, and keeps its commits; the tree's own
    // store for its submodules goes with the tree either way.
    const commits = ours ? Number(land.commitCount ?? 0) : 0;
    const subCommits = (land.groups ?? []).reduce((/** @type {number} */ sum, /** @type {any} */ group) => sum + Number(group.commitCount ?? 0), 0);
    const lost = [
      commits ? t('{count, plural, one {# commit not in the base branch} other {# commits not in the base branch}}', { count: commits }) : '',
      files ? t('{count, plural, one {# uncommitted file} other {# uncommitted files}}', { count: files }) : '',
      subCommits ? t('{count, plural, one {# commit in a submodule} other {# commits in submodules}}', { count: subCommits }) : ''
    ].filter(Boolean);
    if (!lost.length) return { ...worst, danger: false };
    return {
      danger: true,
      description: t('Deletes the worktree, and with it what exists only here: {lost}. Conversations here go to the bin, which they can be restored from.', { lost: formatList(lost) })
    };
  }

  /**
   * Carry one of them out, or one of the track's actions.
   *
   * These operations are pinned to the workspace itself, which is the tree —
   * right for a commit and a rebase, and the reason discarding and moving the
   * base's branches go through the base's.
   * @param {any} workspace - The row being finished with.
   * @param {string} actionId - One of {@link finishOptions}, or a track action.
   * @param {any} ctx - Operations pinned to the tree, the conversation, and whatever the host collected.
   * @returns {Promise<any>} Whether the workspace is finished with, and what to say.
   */
  async finish(workspace, actionId, ctx) {
    const meta = workspace?.meta ?? {};
    const branch = String(meta?.branch ?? '');

    if (actionId === 'unbind') {
      return {
        done: true,
        // What happened to the tree. Where the conversations went, the confirm
        // said before the user agreed to it.
        message: t('Closed the workspace. {dirTarget, select, named {{dir}} other {The worktree}} and {branchTarget, select, named {{branch}} other {its branch}} are still on disk.', {
          dirTarget: meta.dir === null || meta.dir === undefined ? 'none' : 'named',
          dir: meta.dir === null || meta.dir === undefined ? '' : String(meta.dir),
          branchTarget: branch ? 'named' : 'none',
          branch
        })
      };
    }
    if (actionId === 'commit') return this._commit(workspace, ctx);
    if (actionId === 'land' || actionId === 'land-merge') {
      const landed = await this._landInto(workspace, ctx, actionId === 'land' ? 'rebase' : 'merge');
      return { done: false, message: landed.message };
    }
    if (actionId === 'land-close') return this._landAndClose(workspace, ctx);
    if (actionId === 'update') return this._update(workspace, ctx);
    if (actionId === 'continue') return this._continue(workspace, ctx);
    if (actionId === 'abort') return this._abort(workspace, ctx);
    if (actionId === 'resolve') return this._resolve(workspace, ctx);
    if (actionId === 'discard') return this._discard(workspace, ctx);
    return { done: false, message: t('{name} has no action "{actionId}".', { name: this.getManifest().name, actionId }) };
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
        return { done: false, message: t('Enter a commit message — there is no conversation here to write one.') };
      }
      // The model reads this, so it stays English whatever the UI language.
      const request = `Commit the work in this worktree${branch ? ` (branch ${branch})` : ''}, with a message describing it.`;
      await conversation.sendMessage(
        markUntranslated(request),
        null,
        conversation.rootMessageThread,
        { consumeComposer: false }
      );
      return { done: false, message: t('The conversation will write the commit message and commit on its next turn.') };
    }

    // No identity of ours is passed: this is the user's commit, in the user's
    // repository, and git's own complaint about an unconfigured one is a better
    // thing to read than a commit authored by a tool they did not choose.
    const staged = await ctx.ops.shell(
      { command: 'git add -A', timeout: COMMIT_TIMEOUT_MS }, ctx.signal);
    if (!staged?.success) {
      const detail = gitSaid(staged);
      return {
        done: false,
        message: detail
          ? t("Couldn't stage the changes.\n\n{detail}", { detail })
          : t("Couldn't stage the changes.")
      };
    }

    const committed = await ctx.ops.shell(
      { command: `git commit -q -m ${singleQuoted(message)}`, timeout: COMMIT_TIMEOUT_MS }, ctx.signal);
    if (!committed?.success) {
      const said = String(committed?.stdout || committed?.stderr || '');
      // Not a failure: it is what a second press lands on, and what a tree
      // already committed from a terminal answers. Told as the fact it is.
      if (/nothing to commit/i.test(said)) {
        return { done: false, message: t('Nothing to commit — there are no changes.') };
      }
      const detail = gitSaid(committed);
      return {
        done: false,
        message: detail
          ? t("Couldn't make the commit.\n\n{detail}", { detail })
          : t("Couldn't make the commit.")
      };
    }
    // Never `done`: a commit is not a way of being finished with the place it
    // was made in. The workspace stays in use, which is what the menu promised
    // when it put this row outside the endings.
    return { done: false, message: t('{target, select, named {Committed on {branch}.} other {Committed on its branch.}}', { target: branch ? 'named' : 'none', branch }) };
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
   * @param {'merge' | 'remove'} why - What cannot be done from here, for the refusal.
   * @returns {{repoRel: string, problem: string}} Where it is, or why not.
   */
  _repoFromBase(workspace, ctx, why) {
    const meta = workspace?.meta ?? {};
    const baseRoot = String(ctx?.session?.workspaceRoot?.(ctx?.baseWorkspaceId ?? '') ?? '');
    const repoRel = meta.repoDir && baseRoot ? relativePath(baseRoot, String(meta.repoDir)) : null;
    if (!repoRel) {
      const params = {
        repoTarget: meta.repoDir ? 'named' : 'none',
        repo: meta.repoDir ? String(meta.repoDir) : '',
        baseTarget: baseRoot ? 'named' : 'none',
        base: baseRoot
      };
      return {
        repoRel: '',
        problem: why === 'merge'
          ? t("Can't land: {repoTarget, select, named {{repo}} other {the repository}} can't be reached from {baseTarget, select, named {{base}} other {the base workspace}}.", params)
          : t("Can't remove the worktree: {repoTarget, select, named {{repo}} other {the repository}} can't be reached from {baseTarget, select, named {{base}} other {the base workspace}}.", params)
      };
    }
    return { repoRel, problem: '' };
  }

  /**
   * Run a command in the repository, through the base operations.
   * @param {any} ctx - The context, for `baseOps` and `signal`.
   * @param {string} repoRel - The repository, relative to the base workspace.
   * @param {string} command - What to run there.
   * @param {object} [params] - Anything else for the shell operation, e.g. a timeout.
   * @returns {Promise<any>} The shell result, success or not.
   */
  _inRepoFromBase(ctx, repoRel, command, params = {}) {
    const full = repoRel && repoRel !== '.' ? `cd ${singleQuoted(repoRel)} && ${command}` : command;
    return ctx.baseOps.shell({ command: full, ...params }, ctx.signal);
  }

  /**
   * Read the tree and refuse what no landing or update can start from: no
   * branch on record, no base, a rebase or merge already under way, or
   * uncommitted work, which landing moves commits past and would leave behind.
   * @param {any} workspace - The row.
   * @param {any} ctx - Operations pinned to the tree.
   * @param {boolean} landing - Whether the base's submodules are to be moved
   *   too, which one repointed at a copy with no branch makes impossible.
   * @returns {Promise<{refusal: string} | {reading: TreeReading, name: string, base: string}>} The reading, or why not.
   */
  async _ready(workspace, ctx, landing) {
    const meta = workspace?.meta ?? {};
    const name = String(meta?.branch ?? '');
    if (!name) return { refusal: t("Can't land: there's no record of which branch this worktree is on.") };
    const reading = await this._read(workspace, ctx);
    if (!reading.branch) {
      return { refusal: t("{repo} isn't on a branch, and this worktree has no record of the branch it came from.", { repo: baseName(String(meta?.repoDir ?? '')) || name }) };
    }
    if (stuckRepo(reading)) {
      return { refusal: t('The worktree is in the middle of a rebase or a merge. Continue or abort it first.') };
    }
    if (reading.fileCount) {
      return { refusal: t('{count, plural, one {This worktree has an uncommitted change. Commit it first — landing moves commits, and it would be left behind.} other {This worktree has # uncommitted changes. Commit them first — landing moves commits, and these would be left behind.}}', { count: reading.fileCount }) };
    }
    const unreachable = reading.subs.find(sub => sub.status !== 'ok' && sub.status !== 'uninit' && sub.moved);
    if (landing && unreachable) {
      return { refusal: t("Can't land {name}: this branch repoints it, and its copy in the base checkout has no branch to land those commits on.", { name: unreachable.path }) };
    }
    return { reading, name, base: reading.branch };
  }

  /**
   * What to say about a rebase that stopped.
   * @param {string} name - What was being rebased.
   * @param {string} onto - What onto.
   * @param {string} base - The base branch, which nothing has touched.
   * @param {string[]} conflicts - What is in conflict.
   * @param {string} said - What git said, for a stop with no conflict to name.
   * @returns {string} The message.
   */
  _stopped(name, onto, base, conflicts, said) {
    if (conflicts.length) {
      return t("{count, plural, one {Rebasing {name} onto {onto} stopped: {files} conflicts. {base} hasn't been touched.} other {Rebasing {name} onto {onto} stopped: # files conflict ({files}). {base} hasn't been touched.}}", {
        count: conflicts.length, name, onto, base, files: formatList(conflicts.slice(0, 10))
      });
    }
    return said
      ? t("Rebasing {name} onto {onto} stopped. {base} hasn't been touched.\n\n{detail}", { name, onto, base, detail: said })
      : t("Rebasing {name} onto {onto} stopped. {base} hasn't been touched.", { name, onto, base });
  }

  /**
   * Drive a rebase of the tree to the end, settling every conflict that is
   * only a submodule pointer and stopping at the first that is not.
   *
   * A pointer in conflict is set to where the replayed commit's submodule
   * commit went when its submodule was rebased, and to the submodule's tip
   * otherwise: the tree's copy of it is what this branch was built against.
   * @param {any} ctx - Operations pinned to the tree.
   * @param {any} result - What starting or continuing the rebase answered.
   * @param {Map<string, Map<string, string>>} moves - Submodule path → old commit → new commit.
   * @param {Map<string, string>} tips - Submodule path → its HEAD in the tree.
   * @returns {Promise<{conflicts: string[], said: string} | null>} Why it stopped, or null once it is finished.
   */
  async _driveRebase(ctx, result, moves, tips) {
    // Each round settles one commit and moves the rebase on. A round that
    // meets the very conflict it settled has not moved it, and going round
    // again would only meet it again, so that is where it stops.
    let last = '';
    while (!result?.success) {
      const listed = await ctx.ops.shell({ command: 'git -c core.quotepath=off ls-files -u' }, ctx.signal);
      const unmerged = parseUnmerged(listed?.stdout);
      const seen = String(listed?.stdout ?? '');
      if (!unmerged.size || seen === last) return { conflicts: [...unmerged.keys()], said: gitSaid(result) };
      last = seen;
      const settle = [];
      for (const [path, entry] of unmerged) {
        const to = entry.gitlink ? (moves.get(path)?.get(entry.theirs) ?? tips.get(path) ?? '') : '';
        if (!to) return { conflicts: [...unmerged.keys()].filter(p => !unmerged.get(p)?.gitlink), said: '' };
        settle.push(`git update-index --cacheinfo ${singleQuoted(`160000,${to},${path}`)}`);
      }
      result = await ctx.ops.shell(
        { command: [...settle, 'GIT_EDITOR=true git rebase --continue'].join(' && '), timeout: COMMIT_TIMEOUT_MS }, ctx.signal);
    }
    return null;
  }

  /**
   * Check out each submodule of the tree at the commit the tree points it at,
   * where that is somewhere else and the submodule holds no work, so a tree
   * that has just been rebased or put back does not read as a moved
   * submodule. Then say where everything is.
   * @param {any} ctx - Operations pinned to the tree.
   * @returns {Promise<{head: string, links: Map<string, string>}>} The tree's HEAD, and each submodule pointer.
   */
  async _settleSubmodules(ctx) {
    const result = await ctx.ops.shell({
      command: [
        EACH_SUBMODULE,
        '  [ -e "$p/.git" ] || continue',
        '  gl=$(git rev-parse -q --verify "HEAD:$p") || continue',
        '  if [ "$gl" != "$(git -C "$p" rev-parse -q --verify HEAD)" ] && [ -z "$(git -C "$p" status --porcelain)" ] && git -C "$p" cat-file -e "$gl^{commit}" 2>/dev/null; then git -C "$p" checkout -q --detach "$gl" </dev/null; fi',
        "  printf 'link\\t%s\\t%s\\n' \"$p\" \"$gl\"",
        'done',
        "printf 'head\\t\\t%s\\n' \"$(git rev-parse HEAD)\""
      ].join('\n')
    }, ctx.signal);
    /** @type {Map<string, string>} */
    const links = new Map();
    let head = '';
    for (const line of String(result?.stdout ?? '').split(/\r?\n/)) {
      const [kind, scope = '', value = ''] = line.split('\t');
      if (kind === 'link') links.set(scope, value.trim());
      else if (kind === 'head') head = value.trim();
    }
    return { head, links };
  }

  /**
   * Put the tree on top of its base, without touching the base.
   *
   * Submodules first, each in the tree's own store, onto the copy of its base
   * branch the reading fetched — only those that have moved on there as well
   * as here, since the rest need nothing. Then the tree, onto the base branch,
   * with every pointer at a rebased submodule commit moved to where it went.
   * A conflict stops it in the tree, mid-rebase, for somebody to resolve.
   * @param {any} ctx - Operations pinned to the tree.
   * @param {TreeReading} reading - Where the tree stood.
   * @param {string} name - The tree's branch.
   * @returns {Promise<{ok: true, head: string, links: Map<string, string>} | {ok: false, message: string}>} Where it is now, or why it stopped.
   */
  async _bringUp(ctx, reading, name) {
    const base = reading.branch;
    /** @type {Map<string, Map<string, string>>} */
    const moves = new Map();
    /** @type {Map<string, string>} */
    const tips = new Map(reading.subs.filter(sub => sub.head).map(sub => [sub.path, sub.head]));

    for (const sub of reading.subs) {
      if (sub.status !== 'ok' || !(sub.ahead > 0 && sub.behind > 0)) continue;
      const result = await ctx.ops.shell({
        command: [
          `cd ${singleQuoted(sub.path)} || exit 1`,
          `ref=${singleQuoted(`refs/juggler/base/${sub.branch}`)}`,
          'git log -p "$ref..HEAD" | git patch-id --stable | sed "s/^/old /"',
          'if out=$(git rebase -q "$ref" 2>&1 </dev/null); then git log -p "$ref..HEAD" | git patch-id --stable | sed "s/^/new /"; echo "tip $(git rev-parse HEAD)"; else echo stopped; printf "%s\\n" "$out" | sed "s/^/said /"; git -c core.quotepath=off diff --name-only --diff-filter=U | sed "s/^/conflict /"; fi'
        ].join('\n'),
        timeout: COMMIT_TIMEOUT_MS
      }, ctx.signal);
      /** @type {Map<string, string>} */
      const before = new Map();
      /** @type {Map<string, string>} */
      const moved = new Map();
      /** @type {string[]} */
      const conflicts = [];
      /** @type {string[]} */
      const said = [];
      let stopped = !result?.success;
      for (const line of String(result?.stdout ?? '').split(/\r?\n/)) {
        const [word, ...rest] = line.split(' ');
        const [first = '', second = ''] = rest;
        if (word === 'old' && first && second) before.set(first, second);
        else if (word === 'new' && second && before.has(first)) moved.set(before.get(first) ?? '', second);
        else if (word === 'tip' && first) tips.set(sub.path, first);
        else if (word === 'stopped') stopped = true;
        else if (word === 'said') said.push(rest.join(' '));
        else if (word === 'conflict' && rest.length) conflicts.push(rest.join(' '));
      }
      if (stopped) {
        return { ok: false, message: this._stopped(sub.path, sub.branch, base, conflicts, said.join('\n').trim() || (result?.success ? '' : gitSaid(result))) };
      }
      moves.set(sub.path, moved);
    }

    if (reading.behind > 0 || [...moves.values()].some(moved => moved.size > 0)) {
      const exec = repointScript(moves);
      const started = await ctx.ops.shell({
        command: `git rebase -q ${singleQuoted(base)}${exec ? ` --exec ${singleQuoted(exec)}` : ''}`,
        timeout: COMMIT_TIMEOUT_MS
      }, ctx.signal);
      const stop = await this._driveRebase(ctx, started, moves, tips);
      if (stop) return { ok: false, message: this._stopped(name, base, base, stop.conflicts, stop.said) };
    }
    const settled = await this._settleSubmodules(ctx);
    return { ok: true, ...settled };
  }

  /**
   * What the base checkout says about landing there: where the base branch is
   * checked out, and whether each submodule's copy can take its commits.
   * @param {any} ctx - The context, for `baseOps`.
   * @param {string} repoRel - The repository, from the base workspace.
   * @param {string} base - The base branch.
   * @param {RepoReading[]} subs - The submodules with commits to land.
   * @returns {Promise<{here: boolean, refusal: string}>} Whether the main checkout has the base out, or why landing cannot go ahead.
   */
  async _baseSide(ctx, repoRel, base, subs) {
    const asked = await this._inRepoFromBase(ctx, repoRel, [
      'git worktree list --porcelain',
      'echo @@subs',
      ...subs.map((sub) => {
        const at = singleQuoted(sub.path);
        return `printf '%s\\t%s\\t%s\\n' ${at} "$(git -C ${at} symbolic-ref -q --short HEAD)" "$(git -C ${at} status --porcelain | wc -l | tr -d ' ')"`;
      })
    ].join('; '));
    const [listing, rest = ''] = String(asked?.stdout ?? '').split('@@subs');
    const trees = parseWorktrees(listing ?? '');
    const here = trees[0]?.branch === base;
    const elsewhere = trees.slice(1).find(tree => tree.branch === base);
    if (!here && elsewhere) {
      return { here, refusal: t("Can't land: {base} is checked out in another worktree, {dir}, which would be left behind.", { base, dir: elsewhere.path }) };
    }
    for (const line of rest.split(/\r?\n/)) {
      const [path, found = '', changes = '0'] = line.split('\t');
      const sub = subs.find(candidate => candidate.path === path);
      if (!sub) continue;
      if (found !== sub.branch) {
        return {
          here,
          refusal: t("{target, select, none {Can't land {name}: its copy in the base checkout isn't on a branch any more.} other {Can't land {name}: its copy in the base checkout is on {found} now, not {branch}.}}", {
            target: found ? 'named' : 'none', name: path, found, branch: sub.branch
          })
        };
      }
      if (Number(changes) > 0) {
        return { here, refusal: t("Can't land {name}: its copy in the base checkout has uncommitted changes.", { name: path }) };
      }
    }
    return { here, refusal: '' };
  }

  /**
   * Put the work into the base branch, and its submodules' work into theirs.
   *
   * Nothing is pushed: a worktree shares the repository's object store and
   * refs, so the commits are in the repository already, and what is missing is
   * that the base branch does not include them. By rebasing, the tree is put on
   * top of the base first ({@link _bringUp}), so the base moves by a
   * fast-forward and its history stays a line; by merging, the base checkout
   * gains a merge commit, and a conflict there is aborted rather than left in
   * a checkout the user is standing in.
   *
   * The base branch moves first, then each submodule's copy in the base
   * checkout: everything that can refuse has been asked before either, and the
   * branch is the half a failure there would leave the most to explain about.
   * Where the main checkout has the base branch out, it moves in that checkout
   * so its files move with it; where nothing has it out, the ref alone moves,
   * and only by a fast-forward.
   * @param {any} workspace - The row being landed from.
   * @param {any} ctx - Operations pinned to the tree, the base's beside them.
   * @param {'rebase' | 'merge'} how - Which way.
   * @returns {Promise<{ok: boolean, message: string}>} Whether it landed, and what to say.
   */
  async _landInto(workspace, ctx, how) {
    const ready = await this._ready(workspace, ctx, true);
    if ('refusal' in ready) return { ok: false, message: ready.refusal };
    const { reading, name, base } = ready;
    const meta = workspace?.meta ?? {};
    const where = this._repoFromBase(workspace, ctx, 'merge');
    if (where.problem) return { ok: false, message: where.problem };

    const landing = reading.subs.filter(sub => sub.status === 'ok' && sub.ahead > 0);
    if (!reading.ahead && !landing.length) {
      return { ok: true, message: t('Nothing to land: everything here is already in {base}.', { base }) };
    }
    if (how === 'merge') {
      const diverged = landing.find(sub => sub.behind > 0);
      if (diverged) {
        return { ok: false, message: t("Can't merge: {name} has moved on in the base checkout, so its commits have to be rebased. Land instead, which rebases them.", { name: diverged.path }) };
      }
    }
    const side = await this._baseSide(ctx, where.repoRel, base, landing);
    if (side.refusal) return { ok: false, message: side.refusal };
    if (how === 'merge' && !side.here) {
      return { ok: false, message: t("Can't merge: {base} isn't checked out in {repo}, and a merge needs a checkout to happen in. Land instead.", { base, repo: baseName(String(meta?.repoDir ?? '')) }) };
    }

    /** @type {Map<string, string>} */
    let links;
    if (how === 'rebase') {
      const up = await this._bringUp(ctx, reading, name);
      if (!up.ok) return { ok: false, message: up.message };
      links = up.links;
      const ref = singleQuoted(`refs/heads/${base}`);
      const head = singleQuoted(up.head);
      const moved = side.here
        ? await this._inRepoFromBase(ctx, where.repoRel, `git merge -q --ff-only ${head}`, { timeout: COMMIT_TIMEOUT_MS })
        : await ctx.ops.shell({ command: `o=$(git rev-parse -q --verify ${ref}) && git merge-base --is-ancestor "$o" ${head} && git update-ref ${ref} ${head} "$o"` }, ctx.signal);
      if (!moved?.success) {
        const detail = gitSaid(moved);
        return {
          ok: false,
          message: detail
            ? t("Couldn't move {base} to the work. {name} has been rebased onto it, so nothing is lost.\n\n{detail}", { base, name, detail })
            : t("Couldn't move {base} to the work. {name} has been rebased onto it, so nothing is lost.", { base, name })
        };
      }
    } else {
      links = (await this._settleSubmodules(ctx)).links;
      const merged = await this._inRepoFromBase(ctx, where.repoRel, `git merge -q --no-ff --no-edit ${singleQuoted(name)}`, { timeout: COMMIT_TIMEOUT_MS });
      if (!merged?.success) {
        await this._inRepoFromBase(ctx, where.repoRel, 'git merge --abort');
        const detail = gitSaid(merged);
        return {
          ok: false,
          message: detail
            ? t("Couldn't merge {name} into {base}, so nothing was changed.\n\n{detail}", { name, base, detail })
            : t("Couldn't merge {name} into {base}, so nothing was changed.", { name, base })
        };
      }
    }

    const treeRel = String(meta?.treeRel ?? '');
    for (const sub of landing) {
      const to = links.get(sub.path) ?? '';
      if (!to) continue;
      const at = singleQuoted(sub.path);
      const moved = await this._inRepoFromBase(ctx, where.repoRel,
        `t=$(cd ${singleQuoted(`${treeRel}/${sub.path}`)} && pwd) && git -C ${at} fetch -q "$t" HEAD && git -C ${at} merge -q --ff-only ${singleQuoted(to)}`);
      if (!moved?.success) {
        const detail = gitSaid(moved);
        return {
          ok: false,
          message: detail
            ? t("Landed in {base}, but {name} couldn't be moved in the base checkout.\n\n{detail}", { base, name: sub.path, detail })
            : t("Landed in {base}, but {name} couldn't be moved in the base checkout.", { base, name: sub.path })
        };
      }
    }

    if (how === 'merge') return { ok: true, message: t('Merged {name} into {base}.', { name, base }) };
    return {
      ok: true,
      message: t('{count, plural, one {Landed # commit in {base}} other {Landed # commits in {base}}}{subs, plural, =0 {.} one {, and # in a submodule.} other {, and # in submodules.}}', {
        count: reading.ahead,
        subs: landing.reduce((sum, sub) => sum + sub.ahead, 0),
        base
      })
    };
  }

  /**
   * Land, then delete the tree — but only once nothing is left that only the
   * tree has.
   * @param {any} workspace - The row.
   * @param {any} ctx - Operations pinned to the tree, the base's beside them.
   * @returns {Promise<any>} Done when the tree is gone.
   */
  async _landAndClose(workspace, ctx) {
    const landed = await this._landInto(workspace, ctx, 'rebase');
    if (!landed.ok) return { done: false, message: landed.message };
    const after = await this._read(workspace, ctx);
    const left = after.fileCount > 0 || after.ahead > 0 || after.subs.some(sub => sub.status === 'ok' && sub.ahead > 0);
    if (left) return { done: false, message: landed.message };
    const removed = await this._discard(workspace, ctx);
    return removed.done ? { done: true, message: `${landed.message} ${removed.message}` } : removed;
  }

  /**
   * Rebase the tree onto its base, submodules and all, without landing
   * anything: the base and the base checkout's submodules stay where they are.
   * @param {any} workspace - The row.
   * @param {any} ctx - Operations pinned to the tree.
   * @returns {Promise<any>} Never done.
   */
  async _update(workspace, ctx) {
    const ready = await this._ready(workspace, ctx, false);
    if ('refusal' in ready) return { done: false, message: ready.refusal };
    const { reading, name, base } = ready;
    if (reading.behind === 0 && !reading.subs.some(sub => sub.status === 'ok' && sub.ahead > 0 && sub.behind > 0)) {
      return { done: false, message: t('{name} already has everything in {base}.', { name, base }) };
    }
    const up = await this._bringUp(ctx, reading, name);
    return { done: false, message: up.ok ? t('Rebased {name} onto {base}.', { name, base }) : up.message };
  }

  /**
   * Carry on with the rebase or merge the tree is in the middle of, once its
   * conflicts are resolved — a submodule's first, since the tree's waits on it.
   * @param {any} workspace - The row.
   * @param {any} ctx - Operations pinned to the tree.
   * @returns {Promise<any>} Never done.
   */
  async _continue(workspace, ctx) {
    const name = String(workspace?.meta?.branch ?? '');
    const reading = await this._read(workspace, ctx);
    const stuck = stuckRepo(reading);
    if (!stuck) return { done: false, message: t('There is no rebase or merge in progress here.') };
    const onto = (stuck.path ? stuck.branch : reading.branch) || 'HEAD';
    const label = stuck.path || name;
    const cd = stuck.path ? `cd ${singleQuoted(stuck.path)} && ` : '';
    const result = await ctx.ops.shell({ command: `${cd}GIT_EDITOR=true git ${stuck.state} --continue`, timeout: COMMIT_TIMEOUT_MS }, ctx.signal);
    const stop = !stuck.path && stuck.state === 'rebase'
      ? await this._driveRebase(ctx, result, new Map(), new Map(reading.subs.filter(sub => sub.head).map(sub => [sub.path, sub.head])))
      : (result?.success ? null : { conflicts: [], said: gitSaid(result) });
    if (stop) {
      const again = stop.conflicts.length ? stop.conflicts : ((stuck.path ? (await this._read(workspace, ctx)).subs.find(sub => sub.path === stuck.path)?.unmerged : null) ?? []);
      return { done: false, message: this._stopped(label, onto, reading.branch || onto, again, stop.said) };
    }
    if (!stuck.path) await this._settleSubmodules(ctx);
    return { done: false, message: t('{kind, select, rebase {Finished rebasing {name} onto {onto}.} other {Finished the merge into {name}.}}', { kind: stuck.state, name: label, onto }) };
  }

  /**
   * Give up the rebase or merge the tree is in the middle of, in each
   * repository that is in one, and put its submodules back where its commits
   * point them.
   * @param {any} workspace - The row.
   * @param {any} ctx - Operations pinned to the tree.
   * @returns {Promise<any>} Never done.
   */
  async _abort(workspace, ctx) {
    const name = String(workspace?.meta?.branch ?? '');
    const reading = await this._read(workspace, ctx);
    const stuck = [...reading.subs, reading].filter(repo => repo.state !== 'none');
    if (!stuck.length) return { done: false, message: t('There is no rebase or merge in progress here.') };
    for (const repo of stuck) {
      const cd = repo.path ? `cd ${singleQuoted(repo.path)} && ` : '';
      const result = await ctx.ops.shell({ command: `${cd}git ${repo.state} --abort` }, ctx.signal);
      if (!result?.success) {
        const detail = gitSaid(result);
        return { done: false, message: detail ? t("Couldn't stop it.\n\n{detail}", { detail }) : t("Couldn't stop it.") };
      }
    }
    await this._settleSubmodules(ctx);
    return { done: false, message: t('{kind, select, rebase {Stopped the rebase: {name} is back where it was.} other {Stopped the merge: {name} is back where it was.}}', { kind: stuck[0]?.state ?? 'rebase', name }) };
  }

  /**
   * Hand a stopped rebase to the conversation, which has read the work and so
   * is the one thing here that can say what both sides of a conflict meant.
   * @param {any} workspace - The row.
   * @param {any} ctx - Operations pinned to the tree, and the conversation.
   * @returns {Promise<any>} Never done.
   */
  async _resolve(workspace, ctx) {
    const conversation = ctx?.conversation;
    if (!conversation?.sendMessage) {
      return { done: false, message: t('There is no conversation here to hand the conflicts to.') };
    }
    const branch = String(workspace?.meta?.branch ?? '');
    const reading = await this._read(workspace, ctx);
    const stuck = stuckRepo(reading);
    if (!stuck) return { done: false, message: t('There is no rebase or merge in progress here.') };
    const inSub = stuck.path ? ` in the submodule ${stuck.path}` : '';
    const files = stuck.unmerged.length ? `: ${stuck.unmerged.join(', ')}` : '';
    // The model reads this, so it stays English whatever the UI language.
    const request = `The ${stuck.state} in this worktree${branch ? ` (branch ${branch})` : ''} stopped on conflicts${inSub}${files}. `
      + 'Resolve each one, keeping what both sides meant, and stage the result. '
      + `Then run \`GIT_EDITOR=true git ${stuck.state} --continue\`${stuck.path ? ` in ${stuck.path}` : ''}; if it stops again, resolve that too. Do not abort it.`;
    await conversation.sendMessage(markUntranslated(request), null, conversation.rootMessageThread, { consumeComposer: false });
    return { done: false, message: t('The conversation will resolve the conflicts on its next turn.') };
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
        message: t("Can't remove the worktree: there's no record of which repository it belongs to.")
      };
    }

    const where = this._repoFromBase(workspace, ctx, 'remove');
    if (where.problem) return { done: false, message: where.problem };
    const repoRel = where.repoRel;

    const steps = [
      repoRel === '.' ? '' : `cd ${singleQuoted(repoRel)} || exit 1`,
      `git worktree remove --force ${singleQuoted(treeRel)}`,
      `rm -rf ${singleQuoted(treeRel)}`,
      'git worktree prune',
      meta.branchCreatedByUs && branch ? `git branch -D ${singleQuoted(branch)}` : '',
      `test -e ${singleQuoted(treeRel)} && echo STILL-THERE || echo REMOVED`
    ].filter(Boolean).join('; ');

    const result = await ctx.baseOps.shell({ command: steps }, ctx.signal);
    if (/REMOVED/.test(String(result?.stdout ?? ''))) {
      return {
        done: true,
        message: t('{target, select, branch {Removed {dir} and {branch}.} other {Removed {dir}.}}', {
          target: meta.branchCreatedByUs && branch ? 'branch' : 'tree',
          dir: String(meta.dir),
          branch
        })
      };
    }
    // Why git could not remove it matters more than the fact, and the shell op
    // merges the two streams: it answers with everything the command said on
    // `stdout` and an empty `stderr`. Reading only `stderr` would reach for a
    // field that is always empty and report the bare fallback every time.
    return {
      done: false,
      message: String(result?.stderr || result?.stdout || '').trim() || t('{dir} is still there.', { dir: String(meta.dir) })
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
            reason: t('{dir} is not a worktree of {repo} any more.', { dir: String(workspace.meta?.dir ?? workspace.root), repo: repoDir })
          });
          continue;
        }
        found.delete(treeRel);
        const expected = String(workspace?.meta?.branch ?? '');
        if (expected && tree.branch !== expected) {
          orphanedWorkspaces.push({
            ...workspace,
            tombstone: true,
            reason: t('{target, select, named {{dir} is on {branch} now, not {expected}.} other {{dir} is on no branch now, not {expected}.}}', {
              target: tree.branch ? 'named' : 'none',
              dir: String(workspace.meta?.dir ?? workspace.root),
              branch: tree.branch,
              expected
            })
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
          detail: t('{dir} — a worktree of {repo} with no workspace', { dir, repo: baseName(repoDir) }),
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
      return { removed: false };
    }

    const projectPath = ctx.session?.projectPath ?? '';
    const repoRel = (projectPath && relativePath(projectPath, meta.repoDir)) || meta.repoDir;
    const treeRel = String(meta?.treeRel);

    await this._inRepo(ctx, repoRel, `git worktree remove --force ${singleQuoted(treeRel)}`);
    await this._inRepo(ctx, repoRel, `rm -rf ${singleQuoted(treeRel)}`);
    await this._inRepo(ctx, repoRel, 'git worktree prune');
    if (meta.branchCreatedByUs && meta.branch) {
      await this._inRepo(ctx, repoRel, `git branch -D ${singleQuoted(String(meta?.branch))}`);
    }

    // Asked rather than assumed: `remove` fails for a tree that was never made
    // and for a tree that will not go, and those are opposite answers to the one
    // question the host has — is there anything left to worry about.
    const left = await this._inRepo(ctx, repoRel, `test -e ${singleQuoted(treeRel)}`);
    return { removed: !left?.success };
  }
}

export default GitWorktreeWorkspaceProvider;
