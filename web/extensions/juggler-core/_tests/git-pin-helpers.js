//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What the git pin suites share: canned repositories, manifests and patches,
 * and a mount against a hand-built PinContext whose `git` and `review`
 * services a case drives, so it can state a tree and a draft exactly rather
 * than arranging for git to be in that state.
 * @module _tests/git-pin-helpers
 */

import { nextTask } from '../../../js-tests/utilities/test-helpers.js';
import { __holdToasts } from '../pins/git/toast.js';
import GitWorktreeWorkspaceProvider from '../workspaces/git-worktree-workspace-provider.js';
import { gitClient, __scriptGitClients } from '../lib/git-client.js';

/** @typedef {import('../pins/git-pin.js').default} GitPin */

// The pin is handed the scripted client these services carry as `git`; one
// built on services that carry none is the real one.
__scriptGitClients((services, signal) => services.git ?? gitClient(services, signal));

/**
 * The choices one of the pin's pickers offers, read off the menu it opens, as
 * a user would see them; the menu is closed again.
 * @param {Element|null} picker - The picker's button.
 * @returns {{value: string, label: string, title: string, group: string}[]} The choices, in order.
 */
export function pickerChoices(picker) {
  const button = /** @type {HTMLElement} */ (picker);
  button.click();
  const menu = document.querySelector('.git-select-menu');
  /** @type {{value: string, label: string, title: string, group: string}[]} */
  const choices = [];
  let group = '';
  for (const el of menu ? menu.children : []) {
    if (el.classList.contains('menu-header-plain')) {
      group = el.textContent || '';
      continue;
    }
    // Says more are still being found; not a choice.
    if (el.classList.contains('git-select-menu__pending')) continue;
    const row = /** @type {HTMLElement} */ (el);
    choices.push({ value: row.dataset.value || '', label: row.textContent || '', title: row.title, group });
  }
  if (menu) button.click();
  return choices;
}

/**
 * Pick a choice from one of the pin's pickers: open its menu and click the row.
 * @param {Element|null} picker - The picker's button.
 * @param {string} value - The choice.
 */
export function pick(picker, value) {
  const button = /** @type {HTMLElement} */ (picker);
  button.click();
  const row = /** @type {HTMLElement|null} */ (document.querySelector(`.git-select-menu [data-value="${CSS.escape(value)}"]`));
  if (!row) {
    button.click();
    throw new Error(`the picker offers no ${value}`);
  }
  row.click();
}

/**
 * @param {Element|null} picker - One of the pin's pickers.
 * @returns {string} What it has chosen.
 */
export const pickerValue = (picker) => /** @type {HTMLElement|null} */ (picker)?.dataset.value ?? '';

/**
 * Press the head's Refresh, and wait until what it asked has been answered:
 * the button is `aria-busy` until then (its spin outlasts that, to finish a turn).
 * @param {{body: HTMLElement}} m - The mounted pin.
 * @returns {Promise<void>} Once it has settled.
 */
export async function refreshPin(m) {
  const button = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__refresh'));
  button.click();
  while (button.getAttribute('aria-busy') === 'true') await nextTask();
}

/**
 * Answer yes to the yes-or-no dialog a write asks before it goes ahead
 * (`confirmAction`), which must be open.
 * @returns {string} What it asked.
 */
export function confirmPop() {
  const ok = /** @type {HTMLElement|null} */ (document.querySelector('.git-pop .git-pop__ok'));
  if (!ok) throw new Error('no question open to answer');
  const text = document.querySelector('.git-pop .git-pop__text')?.textContent || '';
  ok.click();
  return text;
}

/**
 * A repo with everything filled in, so a case overrides only what it is about.
 * @param {Partial<import('../lib/git-client.js').GitReviewRepo>} [overrides] - What this case cares about.
 * @returns {any} The repo.
 */
export const repo = (overrides = {}) => ({
  path: '',
  changed: 0,
  staged: 0,
  total: 0,
  branch: 'develop',
  upstream: '',
  head: '1111111111111111111111111111111111111111',
  initial: false,
  ahead: 0,
  behind: 0,
  stashes: 0,
  conflicted: 0,
  added: 0,
  removed: 0,
  detached: false,
  files: [],
  truncated: false,
  complete: true,
  ...overrides,
});

/**
 * A review manifest with one root repository holding these files.
 * @param {any[]} files - The changed files.
 * @param {object} [overrides] - Manifest-level overrides.
 * @returns {any} The manifest.
 */
export const manifestOf = (files, overrides = {}) => ({
  root: '/tmp/proj',
  complete: true,
  warnings: [],
  repos: [repo({ changed: files.length, total: files.length, files })],
  ...overrides,
});

/**
 * A server patch for one file, with one context line and one addition.
 * @param {string} path - The file.
 * @param {object} [overrides] - What this case cares about.
 * @returns {any} The patch.
 */
export const patchOf = (path, overrides = {}) => ({
  repo: '',
  path,
  status: 'modified',
  binary: false,
  conflicted: false,
  truncated: false,
  added: 1,
  removed: 0,
  revision: 'rev1',
  hunks: [{
    oldStart: 84,
    oldLines: 1,
    newStart: 84,
    newLines: 2,
    heading: '',
    lines: [
      { kind: 'context', oldLine: 84, newLine: 84, text: 'const hunks = computeDiff();' },
      { kind: 'add', newLine: 85, text: 'this.renderComments(hunks);' },
    ],
  }],
  ...overrides,
});

/**
 * One repository's changes, as `git.changes()` answers.
 * @param {any[]} files - The changed files.
 * @param {object} [overrides] - What this case cares about.
 * @returns {any} The changes.
 */
export const changesOf = (files, overrides = {}) => ({
  repo: '',
  branch: 'develop',
  upstream: '',
  ahead: 0,
  behind: 0,
  detached: false,
  initial: false,
  head: { sha: '1111111111111111111111111111111111111111', message: 'Last commit', pushed: false },
  wrapsBody: true,
  files,
  truncated: false,
  ...overrides,
});

/**
 * A repository's refs, as `git.read('refs')` answers.
 * @param {object} [overrides] - What this case cares about.
 * @returns {any} The refs.
 */
export const refsOf = (overrides = {}) => ({
  repo: '',
  branches: [],
  remotes: [],
  tags: [],
  stashes: [],
  fetchedAt: 0,
  truncated: false,
  ...overrides,
});

/**
 * One worktree, as `git.read('worktrees')` lists it.
 * @param {object} [overrides] - What this case cares about.
 * @returns {any} The tree.
 */
export const treeOf = (overrides = {}) => ({
  path: '/tmp/proj',
  head: '1111111111111111111111111111111111111111',
  branch: 'develop',
  dirty: 0,
  ahead: 0,
  behind: 0,
  tree: '',
  rows: [],
  ...overrides,
});

/**
 * A commit id made from a number, so a case can name the commit at a position.
 * @param {number} n - The number.
 * @param {string} [lead] - Its first character, to keep families of ids apart.
 * @returns {string} Forty hex digits.
 */
export const shaOf = (n, lead = 'a') => lead + n.toString(16).padStart(39, '0');

/**
 * The server's lane layout (gitview/graph.go `laneLayout`), so the synthetic
 * histories below are cut into pages exactly as a real one is.
 * @returns {{place: (sha: string, parents: string[]) => {lane: number, out: number[]}, occupied: () => number[]}} The layout.
 */
function laneLayout() {
  /** @type {string[]} */
  const lanes = [];
  /** @type {Map<string, number>} */
  const waiting = new Map();
  const free = () => {
    const at = lanes.indexOf('');
    if (at >= 0) return at;
    lanes.push('');
    return lanes.length - 1;
  };
  return {
    place: (sha, parents) => {
      let lane = waiting.get(sha);
      if (lane !== undefined) {
        waiting.delete(sha);
        lanes[lane] = '';
      } else {
        lane = free();
      }
      /** @type {number[]} */
      const out = [];
      parents.forEach((p, i) => {
        const j0 = waiting.get(p);
        if (j0 !== undefined) {
          out.push(j0);
          return;
        }
        const j = i > 0 || lanes[/** @type {number} */ (lane)] !== '' ? free() : /** @type {number} */ (lane);
        lanes[j] = p;
        waiting.set(p, j);
        out.push(j);
      });
      while (lanes.length && lanes[lanes.length - 1] === '') lanes.pop();
      return { lane: /** @type {number} */ (lane), out };
    },
    occupied: () => lanes.flatMap((sha, i) => (sha ? [i] : [])),
  };
}

/**
 * A synthetic history, answered a page at a time as `git.read('log')` does.
 *
 * Its `n` commits come in blocks of five: a merge whose first parent runs down
 * the main line and whose second is a two-commit side branch forking from the
 * block's last commit, which the side branch then joins. Commit `p` (from the
 * top of the base history) is `shaOf(p)` whatever is put on top of it, so a
 * case can follow one commit across generations. `top` commits more, `shaOf(i,
 * 'f')`, sit on top in a straight line: what a refresh finds. A query asking
 * for the working tree's row (`worktree`) has it as the server does: right
 * above `shaOf(0)`, HEAD, under whatever is on top, laid out with the rest.
 *
 * The rows are laid out lazily, only as far down as a page asks, and the lane
 * state is remembered where each page starts — 100k commits cost what is read.
 * @param {number} n - The base history's commits.
 * @param {{gen?: number, graph?: string, top?: number, counting?: boolean, subject?: string}} [options] -
 *   Its generation and session id, the commits on top, whether the total is still
 *   being counted (-1), and a word every subject starts with.
 * @returns {(query: any) => any} Answers one LogQuery.
 */
export function historyOf(n, options = {}) {
  const top = options.top || 0;
  /** @type {Map<boolean, (query: any) => any>} By whether it has the working tree's row. */
  const variants = new Map();
  // As the server's session: the row is taken on the first read and on a
  // refresh, which moves the generation on when it comes or goes.
  /** @type {boolean|null} */
  let shown = null;
  let gen = options.gen || 0;
  return (query = {}) => {
    const flat = Boolean(query.message || query.author || query.path);
    const asked = Boolean(query.worktree) && !flat;
    if (shown === null || !query.graph) shown = asked;
    else if (query.refresh && asked !== shown) {
      shown = asked;
      gen++;
    }
    const has = shown && !flat;
    let answer = variants.get(has);
    if (!answer) {
      answer = historyVariant(n, top, has, options);
      variants.set(has, answer);
    }
    return { ...answer(query), gen };
  };
}

/**
 * `historyOf`'s history, with or without the working tree's row.
 * @param {number} n - The base history's commits.
 * @param {number} top - The commits on top.
 * @param {boolean} worktree - Whether the working tree's row is above HEAD's.
 * @param {{gen?: number, graph?: string, counting?: boolean, subject?: string}} options - As `historyOf` takes them.
 * @returns {(query: any) => any} Answers one LogQuery.
 */
function historyVariant(n, top, worktree, options) {
  const wt = worktree ? 1 : 0;
  const total = n + top + wt;
  /**
   * @param {number} i - A row.
   * @returns {{sha: string, parents: string[], worktree?: boolean}} Its commit, or the working tree.
   */
  const commitAt = (i) => {
    if (wt && i === top) return { sha: '', parents: [shaOf(0)], worktree: true };
    if (wt && i > top) i--;
    if (i < top) return { sha: shaOf(i, 'f'), parents: [i + 1 < top ? shaOf(i + 1, 'f') : shaOf(0)] };
    const p = i - top;
    const next = p + 5 - (p % 5);
    const below = next < n ? [shaOf(next)] : [];
    switch (p % 5) {
      case 0: return { sha: shaOf(p), parents: p + 4 < n ? [shaOf(p + 1), shaOf(p + 2)] : below };
      case 1: return { sha: shaOf(p), parents: p + 3 < n ? [shaOf(p + 3)] : below };
      case 2: return { sha: shaOf(p), parents: p + 1 < n ? [shaOf(p + 1)] : below };
      case 3: return { sha: shaOf(p), parents: p + 1 < n ? [shaOf(p + 1)] : below };
      default: return { sha: shaOf(p), parents: below };
    }
  };
  const layout = laneLayout();
  /** @type {any[]} */
  const rows = [];
  /** @type {Map<number, number[]>} */
  const enteringAt = new Map();
  /**
   * @param {number} end - Lay out every row before it.
   */
  const layTo = (end) => {
    while (rows.length < Math.min(end, total)) {
      const i = rows.length;
      enteringAt.set(i, layout.occupied());
      const c = commitAt(i);
      const { lane, out } = layout.place(c.sha, c.parents);
      rows.push(c.worktree
        ? { sha: '', parents: c.parents, author: '', email: '', date: 0, subject: '', lane, out, worktree: true }
        : {
          sha: c.sha, parents: c.parents, author: 'Ada', email: 'ada@example.com', date: 1_700_000_000 - i * 60,
          subject: `${options.subject || 'Commit'} ${i}`, lane, out,
        });
      if (i > 0 && i % 200 !== 0) enteringAt.delete(i);
    }
  };
  return (query = {}) => {
    const offset = Math.max(0, query.offset || 0);
    const limit = Math.min(query.limit || 200, 1000);
    let found = -1;
    if (query.find) {
      const m = /^([af])(.*)$/.exec(query.find);
      const at = m ? parseInt(m[2] || '', 16) : -1;
      if (m && m[1] === 'f' && at < top) found = at;
      else if (m && m[1] === 'a' && at < n) found = at + top + wt;
    }
    layTo(offset + limit);
    if (!enteringAt.has(offset)) {
      // A page that starts off the 200-row grid: replay from the nearest start.
      const replay = laneLayout();
      for (let i = 0; i < offset; i++) {
        const c = commitAt(i);
        replay.place(c.sha, c.parents);
      }
      enteringAt.set(offset, replay.occupied());
    }
    const graphed = !query.message && !query.author && !query.path;
    const page = rows.slice(offset, offset + limit).map((r) => (graphed ? { ...r } : { ...r, lane: 0, out: [] }));
    return {
      graph: query.graph || options.graph || 'g1',
      gen: options.gen || 0,
      offset,
      rows: page,
      lanes: graphed ? [...(enteringAt.get(offset) || [])] : [],
      more: offset + page.length < total,
      total: options.counting ? -1 : total,
      graphed,
      found,
    };
  };
}

/**
 * One commit, as `git.read('commit')` answers: a subject and body that name it,
 * and one modified file.
 * @param {string} sha - The commit.
 * @param {object} [overrides] - What this case cares about.
 * @returns {any} The commit.
 */
export const commitOf = (sha, overrides = {}) => ({
  repo: '',
  sha,
  parents: [],
  author: { name: 'Ada', email: 'ada@example.com', date: 1_700_000_000 },
  committer: { name: 'Grace', email: 'grace@example.com', date: 1_700_000_100 },
  subject: `Subject of ${sha.slice(-4)}`,
  body: `Body of ${sha.slice(-4)}`,
  scope: `${sha}^!`,
  base: `${sha}^`,
  target: sha,
  files: [{ path: 'src/a.go', index: '.', worktree: 'M', added: 1, removed: 0 }],
  total: 1,
  truncated: false,
  ...overrides,
});

/**
 * A job, as the server reports one.
 * @param {object} [overrides] - What this case cares about.
 * @returns {any} The job.
 */
const jobOf = (overrides = {}) => ({
  id: 'job_1',
  workspace: '',
  repo: '',
  kind: 'stage',
  commands: [],
  state: 'running',
  output: '',
  errorKind: '',
  result: {},
  ...overrides,
});

/** How many pins this page has mounted, so each gets an id of its own. */
let mounts = 0;

/**
 * Mount the pin against canned review answers and a canned draft.
 *
 * The write side is scripted too. `git.run()` resolves at once with a done job
 * unless `holdRuns(true)`, after which each run waits in `runs()` until the case
 * settles it with `finishRun` or `failRun`. `git.watch()` listeners are reached
 * with `emitChange`, `emitJob` and `emitResync`.
 * @param {GitPin} pin - The pin type to mount.
 * @param {object} [options] - What this case needs.
 * @param {any} [options.manifest] - What `git.review()` answers with.
 * @param {any} [options.reviewError] - What `git.review()` fails with from the
 *   outset, for a read that never succeeded once.
 * @param {any} [options.draft] - What `review.draft()` answers with; null for
 *   a board with no conversation to keep comments on.
 * @param {(repo: string, path: string) => any} [options.patch] - What
 *   `git.diff()` answers with, per file.
 * @param {Record<string, any>} [options.config] - The pin's config.
 * @param {any} [options.changes] - What `git.changes()` answers with, or a
 *   function of the repo returning it (an Error rejects).
 * @param {string} [options.place] - The place the pin opens in, put in its
 *   config unless the config names one: 'review' unless a case asks otherwise,
 *   since the suites that came before the Changes place are about the review.
 * @param {string} [options.width] - The body's width (default 60rem: split mode).
 * @param {string} [options.height] - The body's height (default 40rem).
 * @param {any} [options.status] - What `git.status()` answers with.
 * @param {any} [options.refs] - What `git.read('refs')` answers with, or a
 *   function of its options returning it (an Error rejects).
 * @param {any} [options.worktrees] - What `git.read('worktrees')` answers
 *   with, likewise; the default is the project tree alone.
 * @param {any} [options.submodules] - What `git.read('submodules')` answers
 *   with, likewise; the default is none.
 * @param {{rows?: any[], followed?: string, conversations?: Record<string, any[]>,
 *   finishOptions?: Record<string, any>, adopt?: any}} [options.workspaces] -
 *   What the `workspaces` stub answers with. `forTree` asks the provider a
 *   row names, as the host does; only the git-worktree provider is known here.
 * @param {any} [options.log] - What `git.read('log')` answers with: a
 *   function of the LogQuery (an Error rejects), such as {@link historyOf}.
 * @param {any} [options.commit] - What `git.read('commit')` answers with, or a
 *   function of the revision.
 * @param {any} [options.blame] - What `git.read('blame')` answers with, or a
 *   function of its `{path, rev}`.
 * @param {any} [options.attribution] - What `git.read('attribution')` answers
 *   with, or a function of its options; the default credits nobody.
 * @param {any} [options.commitContext] - What `git.read('commit-context')`
 *   answers with, or a function of its options.
 * @param {any} [options.digest] - What `git.digest()` answers with, or a
 *   function of the conversation and paths.
 * @param {any} [options.stranded] - What `git.read('stranded')` answers with,
 *   or a function of its ref; the default strands nothing.
 * @param {string} [options.pinId] - The pin's id, for a case that remounts the
 *   same pin; each mount is otherwise a pin of its own.
 * @param {boolean} [options.holdFetches] - Hold each `git.fetchOnShow()` in
 *   `fetches()` until the case settles it with `settleFetch`; otherwise each
 *   answers at once that the repository was fetched before (null).
 * @returns {any} The body, controller and the levers a test needs.
 */
export function mountPin(pin, options = {}) {
  const body = document.createElement('div');
  body.style.width = options.width || '60rem';
  body.style.height = options.height || '40rem';
  body.style.position = 'absolute';
  body.style.left = '-9999px';
  document.body.appendChild(body);
  // A case reads the toast whenever its work lands, not within the toast's
  // wall-clock lifetime.
  __holdToasts(true);
  const abort = new AbortController();
  // A pin of its own: the pin keeps per-pin state (the commit message draft)
  // for the life of the page, and a lane runs suite after suite in one page.
  const pinId = options.pinId || `pin_test_${++mounts}`;

  let manifest = options.manifest === undefined ? manifestOf([]) : options.manifest;
  /** @type {any} */
  let reviewFailure = options.reviewError || null;
  let reviews = 0;
  /** @type {any[]} */
  const reviewOptions = [];
  /** @type {any[]} */
  const configs = [];
  /** @type {{config: any, options: any}[]} */
  const configWrites = [];
  /** @type {{repo: string, path: string, options?: any}[]} */
  const diffs = [];
  /** @type {{resolve: (patch: any) => void, reject: (e: any) => void, repo: string, path: string}[]} */
  const pending = [];
  let holdDiffs = false;

  let draft = options.draft === undefined ? { version: 1, base: 'head', comments: [] } : options.draft;
  /** @type {(() => void)[]} */
  const draftListeners = [];
  /** @type {any[]} */
  const saves = [];
  let clears = 0;
  let composes = 0;
  /** @type {any} */
  let saveFailure = null;
  /** @type {any} */
  let composeFailure = null;

  /** @type {any} */
  let changes = options.changes === undefined ? changesOf([]) : options.changes;
  /** @type {any[]} */
  const changesAsked = [];
  let holdChanges = false;
  /** @type {{index: number, settled: boolean, opts: any, resolve: (v: any) => void, reject: (e: any) => void}[]} */
  const heldChanges = [];
  /**
   * Every run, in order: the op, its options, the job it started, and — while
   * it is held — how to settle it.
   * @type {{op: any, options: any, job: any, settled: boolean, resolve: (job: any) => void, reject: (e: any) => void}[]}
   */
  const runs = [];
  let holdRuns = false;
  let jobCount = 0;
  /** @type {{id: string, options: any}[]} */
  const cancels = [];
  /** @type {{id: string, reply: any, options: any}[]} */
  const answers = [];
  /** @type {any} */
  let answerFailure = null;
  /** @type {{options: any, settled: boolean, resolve: (v: any) => void, reject: (e: any) => void}[]} */
  const fetches = [];
  /** @type {{listener: (event: any) => void, options: any}[]} */
  const watchers = [];
  /** @type {any} */
  let refs = options.refs === undefined ? refsOf() : options.refs;
  /** @type {any} */
  let worktrees = options.worktrees === undefined
    ? { repo: '', trees: [treeOf({ main: true, current: true })] } : options.worktrees;
  /** @type {any} */
  const submodules = options.submodules === undefined
    ? { repo: '', submodules: [], truncated: false } : options.submodules;
  /** @type {any} */
  let log = options.log === undefined ? historyOf(0) : options.log;
  /** @type {any} */
  let commit = options.commit === undefined ? null : options.commit;
  /** @type {any} */
  const blame = options.blame === undefined ? null : options.blame;
  /** @type {any} */
  const attribution = options.attribution === undefined ? { staged: 0, conversations: [] } : options.attribution;
  /** @type {any} */
  const commitContext = options.commitContext === undefined
    ? { repo: '', amend: false, files: [], stat: '', diff: '', truncated: false, subjects: [], rules: '', wrapsBody: true }
    : options.commitContext;
  /** @type {any} */
  const stranded = options.stranded === undefined ? null : options.stranded;
  /** @type {{conv: string, paths: string[], options: any}[]} */
  const digests = [];
  /** @type {{kind: string, options: any}[]} */
  const reads = [];
  /** @type {Set<string>} */
  const heldKinds = new Set();
  /**
   * Held reads; one whose `options.signal` is aborted rejects at once with an
   * AbortError and is marked `aborted`.
   * @type {{kind: string, options: any, settled: boolean, aborted: boolean, answer: () => void, resolve: (v: any) => void, reject: (e: any) => void}[]}
   */
  const heldReads = [];
  /** @type {any} */
  let status = options.status || null;
  let scanning = false;
  /** @type {Set<() => void>} */
  const statusListeners = new Set();
  const ws = options.workspaces || {};
  /** @type {{call: string, args: any[]}[]} */
  const workspaceCalls = [];
  /** @type {(() => void)[]} */
  const workspaceListeners = [];

  /**
   * Hand an event to every `watch` listener.
   * @param {any} event - The event.
   */
  const emit = (event) => {
    for (const w of [...watchers]) w.listener(event);
  };

  /**
   * The run a lever names: by index, by job id, or the oldest unsettled.
   * @param {number|string} [which] - Which run.
   * @returns {any} The run.
   */
  const runAt = (which) => {
    const found = typeof which === 'number' ? runs[which]
      : typeof which === 'string' ? runs.find((r) => r.job.id === which)
        : runs.find((r) => !r.settled);
    if (!found) throw new Error(`no run ${JSON.stringify(which)} to settle`);
    return found;
  };

  /**
   * Settle a held run as done.
   * @param {number|string} [which] - Which run (see `runAt`).
   * @param {object} [overrides] - What the finished job carries (a `result`, say).
   * @returns {any} The finished job.
   */
  const finishRun = (which, overrides = {}) => {
    const r = runAt(which);
    r.job = { ...r.job, state: 'done', ...overrides };
    r.settled = true;
    r.resolve(r.job);
    return r.job;
  };

  /**
   * Settle a held run as failed, rejecting it the way the host does: an Error
   * carrying the job and its `errorKind` as `kind`.
   * @param {number|string} [which] - Which run (see `runAt`).
   * @param {{kind?: string, message?: string, state?: string, job?: object}} [how] - The failure.
   * @returns {Error} The rejection.
   */
  const failRun = (which, how = {}) => {
    const r = runAt(which);
    const message = how.message || 'git failed';
    r.job = { ...r.job, state: how.state || 'failed', error: message, errorKind: how.kind || '', ...how.job };
    const err = /** @type {any} */ (new Error(message));
    err.job = r.job;
    err.kind = r.job.errorKind;
    r.settled = true;
    r.reject(err);
    return err;
  };

  const services = {
    files: { onChange: () => () => {} },
    contextItems: { find: () => null, onChange: () => () => {}, reveal: () => {} },
    git: {
      status: () => status,
      error: () => '',
      scanning: () => scanning,
      onChange: (/** @type {() => void} */ listener) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      refresh: async () => {},
      review: async (/** @type {any} */ opts) => {
        reviews++;
        reviewOptions.push(opts || {});
        if (reviewFailure) throw reviewFailure;
        return manifest;
      },
      /**
       * @param {string} repoPath - The repository.
       * @param {string} filePath - The file within it.
       * @param {any} [opts] - What else was asked.
       * @returns {Promise<any>} Its patch.
       */
      diff: (repoPath, filePath, opts) => {
        diffs.push({ repo: repoPath, path: filePath, options: opts });
        if (!holdDiffs) {
          const made = options.patch ? options.patch(repoPath, filePath) : patchOf(filePath);
          return made instanceof Error ? Promise.reject(made) : Promise.resolve(made);
        }
        return new Promise((resolve, reject) => {
          pending.push({ resolve, reject, repo: repoPath, path: filePath });
        });
      },
      /**
       * @param {any} [opts] - The repo, workspace and signal.
       * @returns {Promise<any>} The repository's changes.
       */
      changes: async (opts) => {
        changesAsked.push(opts || {});
        if (holdChanges) {
          return new Promise((resolve, reject) => {
            heldChanges.push({ index: heldChanges.length, settled: false, opts: opts || {}, resolve, reject });
          });
        }
        const made = typeof changes === 'function' ? changes(opts?.repo || '') : changes;
        if (made instanceof Error) throw made;
        return made;
      },
      /**
       * @param {string} kind - 'refs' or 'worktrees'.
       * @param {any} [opts] - The repo, workspace and signal.
       * @returns {Promise<any>} The read.
       */
      read: async (kind, opts) => {
        reads.push({ kind, options: opts || {} });
        const answer = () => {
          if (kind === 'log') return log((opts || {}).log || {});
          if (kind === 'commit') return typeof commit === 'function' ? commit((opts || {}).commit) : commit;
          if (kind === 'blame') return typeof blame === 'function' ? blame((opts || {}).blame || {}) : blame;
          if (kind === 'attribution') return typeof attribution === 'function' ? attribution(opts || {}) : attribution;
          if (kind === 'commit-context') return typeof commitContext === 'function' ? commitContext(opts || {}) : commitContext;
          if (kind === 'stranded') {
            if (typeof stranded === 'function') return stranded((opts || {}).ref);
            return stranded || { ref: (opts || {}).ref, count: 0 };
          }
          const source = kind === 'refs' ? refs : kind === 'submodules' ? submodules : worktrees;
          return typeof source === 'function' ? source(opts || {}) : source;
        };
        const signal = /** @type {AbortSignal|undefined} */ (opts?.signal);
        const aborted = () => new DOMException('The read was aborted.', 'AbortError');
        if (heldKinds.has(kind)) {
          return new Promise((resolve, reject) => {
            const entry = { kind, options: opts || {}, settled: false, aborted: false, answer, resolve, reject };
            heldReads.push(entry);
            // As fetch does: an aborted read rejects, and is not there to answer.
            const abort = () => {
              if (entry.settled) return;
              entry.settled = true;
              entry.aborted = true;
              reject(aborted());
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          });
        }
        if (signal?.aborted) throw aborted();
        const made = answer();
        if (made instanceof Error) throw made;
        return JSON.parse(JSON.stringify(made));
      },
      /**
       * @param {string} conv - The conversation.
       * @param {string[]} paths - The files asked about.
       * @param {any} [opts] - The repo, workspace and signal.
       * @returns {Promise<any>} Its digest.
       */
      digest: async (conv, paths, opts) => {
        digests.push({ conv, paths, options: opts || {} });
        const made = typeof options.digest === 'function' ? options.digest(conv, paths)
          : options.digest || { conv, title: '', userMessages: [], turns: [], truncated: false };
        if (made instanceof Error) throw made;
        return JSON.parse(JSON.stringify(made));
      },
      /**
       * @param {any} op - The write.
       * @param {any} [opts] - Its workspace.
       * @returns {Promise<any>} The job, once settled.
       */
      run: (op, opts) => new Promise((resolve, reject) => {
        const job = jobOf({ id: `job_${++jobCount}`, repo: op?.repo || '', kind: op?.kind, workspace: opts?.workspace || '' });
        const entry = { op, options: opts || {}, job, settled: false, resolve, reject };
        runs.push(entry);
        if (!holdRuns) finishRun(runs.length - 1);
      }),
      /**
       * @param {string} id - The job.
       * @param {any} [opts] - Its workspace.
       * @returns {Promise<any>} The job as it stood once asked.
       */
      cancel: async (id, opts) => {
        cancels.push({ id, options: opts || {} });
        const r = runs.find((x) => x.job.id === id);
        if (r && !r.settled) failRun(id, { state: 'cancelled', message: 'cancelled' });
        return r ? r.job : jobOf({ id, state: 'cancelled' });
      },
      jobs: async () => runs.map((r) => r.job).reverse(),
      /**
       * @param {string} id - The job.
       * @param {any} reply - The question answered, and the answer or decline.
       * @param {any} [opts] - Its workspace.
       * @returns {Promise<any>} The job, its question gone.
       */
      answer: async (id, reply, opts) => {
        answers.push({ id, reply, options: opts || {} });
        if (answerFailure) throw answerFailure;
        const r = runs.find((x) => x.job.id === id);
        return { ...(r ? r.job : jobOf({ id })), prompt: undefined };
      },
      /**
       * @param {any} [opts] - The repo and workspace.
       * @returns {Promise<any>} The fetch once settled, or null.
       */
      fetchOnShow: (opts) => new Promise((resolve, reject) => {
        const entry = { options: opts || {}, settled: false, resolve, reject };
        fetches.push(entry);
        if (!options.holdFetches) {
          entry.settled = true;
          resolve(null);
        }
      }),
      /**
       * @param {(event: any) => void} listener - Called with each event.
       * @param {any} [opts] - The workspace.
       * @returns {() => void} Unsubscribe.
       */
      watch: (listener, opts) => {
        const entry = { listener, options: opts || {} };
        watchers.push(entry);
        return () => {
          const at = watchers.indexOf(entry);
          if (at >= 0) watchers.splice(at, 1);
        };
      },
    },
    workspaces: {
      list: () => ws.rows || [],
      followed: () => ws.followed || '',
      /**
       * @param {() => void} listener - Called when the table may have changed.
       * @returns {() => void} Unsubscribe.
       */
      onChange: (listener) => {
        workspaceListeners.push(listener);
        return () => {
          const at = workspaceListeners.indexOf(listener);
          if (at >= 0) workspaceListeners.splice(at, 1);
        };
      },
      forTree: (/** @type {{path: string, branch?: string, rows?: string[]}} */ tree) => {
        const worktrees = new GitWorktreeWorkspaceProvider();
        const held = (ws.rows || []).find((/** @type {any} */ r) => (tree.rows || []).includes(r.id)
          && r.state !== 'closed' && r.providerId === 'git-worktree' && worktrees.holdsTree(r, tree));
        return held ? held.id : '';
      },
      conversationsOf: (/** @type {string} */ id) => ws.conversations?.[id] || [],
      showConversation: async (/** @type {string} */ id) => {
        workspaceCalls.push({ call: 'showConversation', args: [id] });
        return true;
      },
      create: async (/** @type {any} */ request) => {
        workspaceCalls.push({ call: 'create', args: [request] });
        return { created: false };
      },
      finishOptions: (/** @type {string} */ id) => ws.finishOptions?.[id] || { options: [] },
      finish: async (/** @type {string} */ id, /** @type {string} */ optionId) => {
        workspaceCalls.push({ call: 'finish', args: [id, optionId] });
        return {};
      },
      adopt: async (/** @type {any} */ tree) => {
        workspaceCalls.push({ call: 'adopt', args: [tree] });
        return ws.adopt === undefined ? {} : ws.adopt;
      },
      startConversation: async (/** @type {any} */ request) => {
        workspaceCalls.push({ call: 'startConversation', args: [request] });
        return 'c_new';
      },
    },
    review: {
      draft: () => (draft ? JSON.parse(JSON.stringify(draft)) : null),
      /**
       * @param {() => void} listener - Called when the draft may have changed.
       * @returns {() => void} Unsubscribe.
       */
      onChange: (listener) => {
        draftListeners.push(listener);
        return () => {
          const at = draftListeners.indexOf(listener);
          if (at >= 0) draftListeners.splice(at, 1);
        };
      },
      /**
       * @param {any} next - The draft to write.
       * @returns {Promise<void>} Resolved once written.
       */
      save: async (next) => {
        if (saveFailure) throw saveFailure;
        saves.push(next);
        draft = { version: 1, base: 'head', comments: next.comments };
        for (const listener of [...draftListeners]) listener();
      },
      clear: async () => {
        clears++;
        draft = { version: 1, base: 'head', comments: [] };
        for (const listener of [...draftListeners]) listener();
      },
      // The host puts the review in the prompt and leaves the comments alone,
      // so this stub records the call and changes no draft.
      compose: async () => {
        composes++;
        if (composeFailure) throw composeFailure;
      },
    },
  };

  // The host's say on whether the pin is in sight: in sight until a case says
  // otherwise with `setVisible`.
  let inSight = true;
  /** @type {Set<(visible: boolean) => void>} */
  const sightListeners = new Set();
  const visibility = {
    isVisible: () => inSight,
    /**
     * @param {(visible: boolean) => void} listener - Told each change.
     * @returns {() => void} Stop.
     */
    onChange: (listener) => {
      sightListeners.add(listener);
      return () => { sightListeners.delete(listener); };
    },
  };

  /**
   * The PinContext for a pin with this config.
   * @param {Record<string, any>} config - The pin's config.
   * @returns {any} The context.
   */
  const contextFor = (config) => ({
    pin: { id: pinId, type: 'git', config },
    active: {
      project: { path: '/tmp/proj', displayName: 'proj' },
      conversation: draft === null ? null : { id: 'c1', title: 'Conv' },
      thread: { id: null },
    },
    services,
    signal: abort.signal,
    visibility,
    updateConfig: async (/** @type {any} */ next, /** @type {any} */ writeOptions) => {
      configs.push(next);
      configWrites.push({ config: next, options: writeOptions || {} });
    },
  });
  const controller = /** @type {any} */ (pin.mount(body,
    contextFor({ place: options.place || 'review', ...(options.config || {}) })));

  /** @returns {Element} The Review place, or the whole pin before there is one. */
  const reviewScope = () => body.querySelector('.git-pin__place--review') || body;

  return {
    body,
    controller,
    services,
    /**
     * Say whether the host has the pin in sight, telling its listeners on a change.
     * @param {boolean} visible - In sight.
     */
    setVisible: (visible) => {
      if (visible === inSight) return;
      inSight = visible;
      for (const listener of [...sightListeners]) listener(visible);
    },
    // The review suites read the Review place alone: the head line and the
    // place switcher above it are the Changes suite's business.
    text: () => (body.querySelector('.git-pin__place--review') || body).textContent || '',
    reviews: () => reviews,
    reviewOptions: () => reviewOptions,
    configs: () => configs,
    /** @returns {{config: any, options: any}[]} Every `updateConfig`, with the options it was written with. */
    configWrites: () => configWrites,
    diffs: () => diffs,
    pending: () => pending,
    saves: () => saves,
    clears: () => clears,
    composes: () => composes,
    draft: () => draft,
    holdDiffs: (/** @type {boolean} */ hold) => { holdDiffs = hold; },
    setManifest: (/** @type {any} */ next) => { manifest = next; },
    failReview: (/** @type {any} */ e) => { reviewFailure = e; },
    failSave: (/** @type {any} */ e) => { saveFailure = e; },
    failCompose: (/** @type {any} */ e) => { composeFailure = e; },
    setChanges: (/** @type {any} */ next) => { changes = next; },
    changesAsked: () => changesAsked,
    holdChanges: (/** @type {boolean} */ hold) => { holdChanges = hold; },
    /** @returns {any[]} Every held `changes()` read, in the order asked. */
    pendingChanges: () => heldChanges,
    /**
     * Answer a held `changes()` read.
     * @param {number} index - Which, by its place in `pendingChanges()`.
     * @param {any} value - The answer; an Error rejects.
     */
    releaseChanges: (index, value) => {
      const held = heldChanges[index];
      if (!held || held.settled) throw new Error(`no held read ${index}`);
      held.settled = true;
      if (value instanceof Error) held.reject(value);
      else held.resolve(value);
    },
    /** @returns {{kind: string, options: any}[]} Every `git.read()`, in order. */
    reads: () => reads,
    /** @returns {{conv: string, paths: string[], options: any}[]} Every `git.digest()`, in order. */
    digests: () => digests,
    setRefs: (/** @type {any} */ next) => { refs = next; },
    setWorktrees: (/** @type {any} */ next) => { worktrees = next; },
    setLog: (/** @type {any} */ next) => { log = next; },
    setCommit: (/** @type {any} */ next) => { commit = next; },
    /**
     * Hold every `git.read` of one kind in `heldReads()` until the case answers it.
     * @param {string} kind - 'log', 'commit', 'refs' or 'worktrees'.
     * @param {boolean} hold - Hold, or answer at once again.
     */
    holdReads: (kind, hold) => { if (hold) heldKinds.add(kind); else heldKinds.delete(kind); },
    /** @returns {any[]} Every held read, in the order asked, aborted ones included. */
    heldReads: () => heldReads,
    /**
     * Answer a held read: with `value`, or with what its source answers now.
     * @param {number} index - Which, by its place in `heldReads()`.
     * @param {any} [value] - The answer; an Error rejects.
     */
    releaseRead: (index, value) => {
      const held = heldReads[index];
      if (!held || held.settled) throw new Error(`no held read ${index}`);
      held.settled = true;
      const made = value === undefined ? held.answer() : value;
      if (made instanceof Error) held.reject(made);
      else held.resolve(JSON.parse(JSON.stringify(made)));
    },
    /** @returns {{call: string, args: any[]}[]} Every recorded `workspaces` call. */
    workspaceCalls: () => workspaceCalls,
    emitWorkspaces: () => { for (const listener of [...workspaceListeners]) listener(); },
    runs: () => runs,
    holdRuns: (/** @type {boolean} */ hold) => { holdRuns = hold; },
    finishRun,
    failRun,
    cancels: () => cancels,
    /** @returns {{id: string, reply: any, options: any}[]} Every `git.answer`, in order. */
    answers: () => answers,
    /** @param {any} e - What the next `git.answer` rejects with; null for none. */
    failAnswers: (e) => { answerFailure = e; },
    /** @returns {any[]} Every `fetchOnShow` asked, in order. */
    fetches: () => fetches,
    /**
     * Settle a held `fetchOnShow`.
     * @param {number} index - Which, by its place in `fetches()`.
     * @param {any} value - The finished job, null for skipped, or an Error to reject with.
     */
    settleFetch: (index, value) => {
      const f = fetches[index];
      if (!f || f.settled) throw new Error(`no held fetch ${index}`);
      f.settled = true;
      if (value instanceof Error) f.reject(value);
      else f.resolve(value);
    },
    watchers: () => watchers.length,
    /** @returns {any[]} The options of every live `watch` subscription. */
    watchOptions: () => watchers.map((w) => w.options),
    /**
     * Hand the pin a new config, as a board update does (`controller.update`).
     * @param {Record<string, any>} config - The pin's config as it now is.
     */
    reconfigure: (config) => { controller.update?.(contextFor(config)); },
    /**
     * Hand the pin's followed tree a new status, as the window's status cache
     * does when a read starts or answers (`git.onChange`).
     * @param {any} next - What `git.status()` answers now; null for nothing yet.
     * @param {boolean} [isScanning] - What `git.scanning()` answers now.
     */
    setStatus: (next, isScanning = false) => {
      status = next;
      scanning = isScanning;
      for (const listener of [...statusListeners]) listener();
    },
    /**
     * Tell every `watch` listener the tree changed.
     * @param {any[]} [repos] - Which repositories, and which parts.
     * @param {string} [workspace] - The tree.
     */
    emitChange: (repos = [{ path: '', kinds: ['worktree'] }], workspace = '') => {
      emit({ type: 'git-change', workspace, repos });
    },
    /**
     * Tell every `watch` listener a job moved.
     * @param {any} job - The job as it now stands.
     */
    emitJob: (job) => { emit({ type: 'git-job', workspace: job.workspace || '', job }); },
    /**
     * Tell every `watch` listener to read everything again.
     * @param {string} [workspace] - The tree.
     */
    emitResync: (workspace = '') => { emit({ type: 'git-resync', workspace }); },
    setDraft: (/** @type {any} */ next) => {
      draft = next;
      for (const listener of [...draftListeners]) listener();
    },
    /** @returns {any[]} The file rows, in order. */
    rows: () => [...body.querySelectorAll('.review-panel__file')],
    /** @returns {any} The active file row. */
    active: () => body.querySelector('.review-panel__file[aria-current="true"]'),
    /** @returns {any} The Review place's diff viewer, if there is one. */
    viewer: () => reviewScope().querySelector('diff-viewer'),
    /** @returns {any[]} Every diff viewer in the Review place, to be counted. */
    viewers: () => [...reviewScope().querySelectorAll('diff-viewer')],
    /** @returns {any} The open comment editor, if there is one. */
    editor: () => body.querySelector('.review-panel__editor'),
    teardown: () => {
      controller.teardown?.();
      abort.abort();
      body.remove();
      __holdToasts(false);
    },
  };
}

/**
 * Mount, and wait for the manifest and the first file's patch to land.
 * @param {GitPin} pin - The pin type to mount.
 * @param {object} [options] - Passed to `mountPin`.
 * @returns {Promise<any>} The mounted pin.
 */
export async function mountedPin(pin, options = {}) {
  const m = mountPin(pin, options);
  await nextTask();
  await nextTask();
  return m;
}
