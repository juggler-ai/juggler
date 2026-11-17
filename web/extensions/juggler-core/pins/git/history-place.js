//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's History place: the repository's commits as a graph, a page at
 * a time (pins/git/history-list), marked with where every branch, remote
 * branch, tag and worktree stands (pins/git/history-model), and the selected
 * commit's detail beside it.
 *
 * **Reads.** The list reads `log` in a graph session the server keeps, in the
 * scope the picker names — every ref (the default), what HEAD reaches, or one
 * ref — and a new scope is a new session. `refs` and `worktrees` are read for the chips
 * when the place is first shown, each time it is shown again, and on a
 * `git-change` naming `refs` or `head` for its repository, which also has the
 * session catch up (the commits new on top arrive without the list starting
 * again). A `git-resync`, or another tree or repository, starts it again.
 * While another place is shown those events are only noted, and showing this
 * one catches up once. The chips and the picker are drawn once both `refs` and
 * `worktrees` have answered, and then only the rows whose chips changed.
 *
 * **The filter** narrows the list to commits whose message, author or path
 * holds its text — a flat list, since a filtered history has no graph — once
 * typing pauses, or at once on Enter. Text that could be a commit id is tried
 * as one first: one that names a commit selects it rather than filtering, and
 * one outside the list is shown by itself, with a way to look among all refs.
 *
 * **Comparing.** Shift-click, or `x` on the selected row, marks a second
 * commit; the detail then offers to review the two in the Review place, older
 * (lower in the list) first. A plain click, or Escape, lets the mark go.
 *
 * **The detail** follows the selection at once from the list's row, and reads
 * the selected commit (`commit`) once the selection settles; moving it aborts a
 * read still out, so a user walking the list never waits on the server. Its parents are links that select
 * them, asking the server where one is when the list does not hold it. Its
 * files are a review panel in the commit's own scope, so a file's diff is that
 * commit's change to it, and a comment on it goes to the conversation like any
 * other. Keys in that panel are its own: only Escape reaches the place.
 *
 * **Actions at a commit** (pins/git/history-model) are its row's ⋯ and
 * right-click menu, and in the detail its first group as buttons with the rest
 * behind a ⋯ (`detailActions`): checkout detached, a branch, tag
 * or worktree there, a pick or revert onto the branch in view, a rewrite of
 * that branch at it, a reset of that branch to it, and its id copied — which
 * the detail also offers beside the id in its facts. Writes go
 * through pins/git/actions. A reset toasts with an Undo that resets back from
 * where it left the branch; a hard one asks first, and its Undo writes back the
 * changes it saved, though not what was staged.
 *
 * **Rewrites** are the verbs of an interactive rebase, one at a time: reword
 * (the message asked for, prefilled), fix up with what is staged, drop, and —
 * from a marked pair — squash the run between them. One of a commit already
 * pushed asks first and goes again with `force`; local changes in the way are
 * offered a stash. Each toasts an Undo that resets the branch back to its old
 * tip: softly, since a reword, squash or fixup leaves the files as they were,
 * and for a drop keeping local changes, since it brings the dropped files back.
 *
 * **The reflog** is a scope: where the tree's HEAD has been, each row led by
 * git's words for the move, so every commit action — the resets above all — is
 * a way back to any of them.
 *
 * **Layout** is the other places': list and detail side by side from 34rem,
 * one at a time below it, the place's `data-level` saying which. The detail's
 * crumb is the way back to the list, so it is drawn only in the stack. The graph is
 * at most `--git-history-lanes` lanes wide.
 * @module pins/git/history-place
 */

import { formatDate, markForTranslation, translator } from 'juggler/i18n';
import { contextMenuFor, copyToClipboard, createElement, createReviewPanel, errorText, openMenuAt } from 'juggler/ui';
import { createActions, menuRows } from './actions.js';
import { graphCell } from './graph-cell.js';
import { createHistoryList, ROW_PX } from './history-list.js';
import { createMenuSelect } from './menu-select.js';
import { chipIndex, detailActions, menuFor, scopeGroups, scopeQuery } from './history-model.js';
import { icon } from './icons.js';
import { measureMode } from './layout.js';
import { commitManifest } from './manifest.js';
import { askText, closePopover, confirmAction } from './popover.js';
import { createReader } from './reader.js';
import { currentBranch, refsState, viewedTree } from './refs-model.js';

const t = translator('@juggler/core');

/** @type {import('./history-model.js').ScopeKey} The scope a History starts in: every ref, so other branches and worktrees are in view. */
const DEFAULT_SCOPE = 'all';

/** The graph's width, in lanes, when the stylesheet does not say. */
const DEFAULT_LANES = 6;

/** How long typing in the filter pauses before it is applied, in ms. */
const FILTER_IDLE_MS = 350;

/** Filter text that may be a commit id, jumped to as well as filtered by. */
const SHA_LIKE = /^[0-9a-f]{4,40}$/i;

/**
 * What the filter can search, in the picker's order (English source text): the
 * menu's words, the picker's own while it is chosen, its tooltip, and the
 * filter's placeholder.
 */
const FILTER_FIELDS = /** @type {const} */ ([
  {
    id: 'message',
    label: markForTranslation('Commit messages'),
    button: markForTranslation('in messages'),
    title: markForTranslation('The filter matches commit messages, and a commit id'),
    placeholder: markForTranslation('Filter by message or commit id (/)'),
  },
  {
    id: 'author',
    label: markForTranslation('Authors'),
    button: markForTranslation('in authors'),
    title: markForTranslation('The filter matches author names and emails'),
    placeholder: markForTranslation('Filter by author (/)'),
  },
  {
    id: 'path',
    label: markForTranslation('Changed paths'),
    button: markForTranslation('in paths'),
    title: markForTranslation('The filter shows commits that changed a path holding it'),
    placeholder: markForTranslation('Filter by changed path (/)'),
  },
]);

/**
 * @typedef {import('juggler/pinboard-item-type').PinGitService} PinGitService
 * @typedef {import('juggler/pinboard-item-type').PinWorkspaces} PinWorkspaces
 * @typedef {import('juggler/pinboard-item-type').PinGitLogRow} PinGitLogRow
 * @typedef {import('juggler/pinboard-item-type').PinGitCommit} PinGitCommit
 * @typedef {import('./history-model.js').Chip} Chip
 */

/**
 * @typedef {object} HistoryHost
 * @property {() => PinGitService} git - The pin's git service, as it now is.
 * @property {() => PinWorkspaces|undefined} workspaces - The session's workspaces.
 * @property {() => {workspace?: string}} workspaceOption - The tree option for every call.
 * @property {() => string} root - The tree's root on disk.
 * @property {any} review - Where comments live, as the review panel takes it.
 * @property {HTMLElement} rootElement - The pin's root.
 * @property {() => string} repo - The repository the pin shows.
 * @property {import('./toast.js').PinToast} toast - The pin's toast.
 * @property {() => number|null} dirtyCount - The viewed tree's changed files, null before they are read.
 * @property {() => boolean} following - Whether the pin follows the conversation's workspace.
 * @property {() => boolean} logOpen - Whether the command log is open.
 * @property {(scope: string) => void} showScope - Review this scope.
 * @property {(tree: import('./refs-model.js').TreeView) => void} viewTree - Show that tree.
 * @property {() => void} showChanges - Bring Changes forward.
 * @property {() => void} levelChanged - The place's `data-level` changed.
 * @property {(e: any) => boolean} treeGone - A read failed: true when it was the
 *   pinned tree going away, which the pin has handled.
 */

/**
 * @typedef {object} HistoryPlace
 * @property {HTMLElement} element - The place.
 * @property {() => void} shown - It was brought forward.
 * @property {() => void} refresh - Read again.
 * @property {() => void} setTree - Another tree or repository: start again.
 * @property {() => void} dirtyChanged - The tree's count of changed files moved.
 * @property {(target: {sha: string, stash?: string}) => Promise<void>} reveal - Select a
 *   commit: in the scope shown, or among all refs when that does not reach it; a
 *   stash, which no other scope holds, as a history of its own.
 * @property {(path: string) => void} showPath - Show one file's history: the
 *   list filtered to the path, followed across renames.
 * @property {(event: KeyboardEvent) => boolean} handleKey - A key outside a text field; true when used.
 * @property {() => void} focus - Focus the list.
 * @property {() => void} teardown - Stop.
 */

/**
 * A commit's date and time, for its row, as short as says it: today's by the
 * minute alone, this year's by the day and the minute — commits on one day are
 * told apart by the time — and an earlier year's by the day alone. The row's
 * tooltip and the detail pane give it in full.
 *
 * The day and the time are formatted apart and joined by a message of their
 * own: asked for together, `Intl` may join them with a word ("Nov 17 at
 * 9:34 PM"), which is width the column has no room for.
 * @param {number} seconds - Unix seconds.
 * @returns {string} The date and time.
 */
function rowDate(seconds) {
  const when = new Date(seconds * 1000);
  const now = new Date();
  const time = formatDate(when, { hour: 'numeric', minute: '2-digit' });
  if (when.toDateString() === now.toDateString()) return time;
  if (when.getFullYear() !== now.getFullYear()) return formatDate(when, { year: 'numeric', month: 'short', day: 'numeric' });
  return t('{date} {time}', { date: formatDate(when, { month: 'short', day: 'numeric' }), time });
}

/**
 * @param {number} seconds - Unix seconds.
 * @returns {string} The date and time, in full.
 */
function longDate(seconds) {
  return formatDate(new Date(seconds * 1000), { dateStyle: 'full', timeStyle: 'medium' });
}

/**
 * @param {HistoryHost} host - What the place works through.
 * @returns {HistoryPlace} The place.
 */
export function createHistoryPlace(host) {
  let live = true;
  let opened = false;
  /** @type {import('juggler/pinboard-item-type').PinGitRefs|null} */
  let refs = null;
  /** @type {import('juggler/pinboard-item-type').PinGitWorktrees['trees']} */
  let trees = [];
  /** @type {Map<string, Chip[]>} */
  let chips = new Map();
  /** The viewed tree's HEAD, drawn as a ring. */
  let headSha = '';
  /** @type {import('./history-model.js').ScopeKey} */
  let scope = DEFAULT_SCOPE;
  let listError = '';
  /** @type {'list'|'detail'} */
  let level = 'list';
  /** The commit the detail is about, '' for none. */
  let wanted = '';
  /** Whether it is shown by id, outside the list. */
  let outside = false;
  /** @type {PinGitCommit|null} Its read, once it lands. */
  let commit = null;
  let commitError = '';
  /** @type {PinGitCommit|null} The commit the panel was last given. */
  let paneled = null;
  /** What the detail was last drawn from, so a read that changed none of it leaves it (and a click on it) alone. */
  let detailSig = '';
  /** @type {{field: string, text: string}} The filter the list is read with. */
  let applied = { field: 'message', text: '' };
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let idle;
  /** Counts filters asked for, so a commit lookup for one typed over is dropped. */
  let filterAsks = 0;
  /** @type {AbortController|null} The filter's commit lookup, aborted when another filter is asked. */
  let filterAbort = null;
  /** @type {AbortController|null} A reword's commit read, aborted by the next reword. */
  let rewordAbort = null;
  /** The commit marked to compare the selection with, '' for none. */
  let marked = '';
  /** @type {Map<string, string>} Words for scopes the picker does not list: a stash, by its message. */
  const scopeLabels = new Map();

  const git = () => host.git();
  const ws = () => host.workspaceOption();

  const element = createElement('div', 'git-history');
  element.dataset.level = 'list';
  const body = createElement('div', 'git-history__body');
  const listPane = createElement('section', 'git-history__list');
  const bar = createElement('div', 'git-history__bar');
  const scopeSelect = createMenuSelect({
    className: 'git-history__scope',
    label: t('Which commits'),
    onChoose: (value) => setScope(/** @type {import('./history-model.js').ScopeKey} */ (value)),
    // Every ref, in a big repository thousands, is listed only when it is opened.
    expand: () => scopeChoices(true),
  });
  // The filter is one search box: what it searches is a picker inside it, which
  // says so ("in messages ▾"), and the placeholder says what to type.
  const search = createElement('div', 'git-history__search');
  const filterInput = /** @type {HTMLInputElement} */ (createElement('input', 'git-history__filter field-input field-input-xs'));
  filterInput.type = 'search';
  filterInput.spellcheck = false;
  filterInput.setAttribute('aria-label', t('Filter the history'));
  const fieldSelect = createMenuSelect({
    className: 'git-history__field',
    label: t('What the filter searches'),
    onChoose: () => {
      drawPlaceholder();
      if (filterInput.value.trim()) void applyFilter();
      filterInput.focus();
    },
  });
  fieldSelect.set(FILTER_FIELDS.map((field) => ({
    value: field.id, label: t(field.label), buttonLabel: t(field.button), title: t(field.title),
  })), 'message');
  const drawPlaceholder = () => {
    filterInput.placeholder = t(FILTER_FIELDS.find((f) => f.id === fieldSelect.value())?.placeholder || FILTER_FIELDS[0].placeholder);
  };
  drawPlaceholder();
  search.append(filterInput, fieldSelect.element);
  bar.append(scopeSelect.element, search);
  const note = createElement('div', 'git-history__note');
  note.hidden = true;
  const detail = createElement('section', 'git-history__detail');
  const crumb = createElement('div', 'git-history__crumb');
  const back = /** @type {HTMLButtonElement} */ (createElement('button', 'git-history__back btn btn-icon btn-xs', '‹'));
  back.type = 'button';
  const meta = createElement('div', 'git-history__meta');
  detail.append(crumb, meta);
  /** @type {ReturnType<typeof createReviewPanel>|null} The commit's files, made when the first commit is shown. */
  let panel = null;
  /** @returns {ReturnType<typeof createReviewPanel>} The files panel. */
  const filesPanel = () => {
    if (!panel) {
      panel = createReviewPanel({
        scopeLabel: '',
        loadPatch: (file, options) => git().diff(file.repo, file.path, { ...options, scope: paneled?.scope || '', ...ws() }),
        review: host.review,
        // The file as the commit left it: never '' for the rev, which is the working tree.
        loadBlame: (file, options) => (paneled
          ? git().read('blame', { repo: file.repo, ...ws(), blame: { path: file.path, rev: paneled.sha }, signal: options?.signal })
          : Promise.reject(new Error('no commit'))),
      });
      panel.element.classList.add('git-history__files');
      detail.append(panel.element);
    }
    return panel;
  };
  body.append(listPane, detail);
  element.append(body);

  /** @returns {import('./refs-model.js').RefsState} What the model is asked about. */
  const state = () => refsState({
    refs, trees, submodules: [], workspaces: host.workspaces(), dirty: host.dirtyCount(), following: host.following(), logOpen: host.logOpen(),
  });

  /** @returns {number} The most graph lanes drawn. */
  const cap = () => {
    const value = parseInt(getComputedStyle(list.element).getPropertyValue('--git-history-lanes'), 10);
    return value > 0 ? value : DEFAULT_LANES;
  };

  /**
   * @param {Chip} chip - The chip.
   * @returns {HTMLElement} Its element.
   */
  const chipEl = (chip) => {
    const el = createElement('span', 'git-history__chip');
    el.dataset.kind = chip.kind;
    if (chip.title) el.title = chip.title;
    if (chip.kind === 'wt' || chip.kind === 'detached') el.append(icon('wt'));
    if (chip.kind === 'tag') el.append(icon('tag'));
    el.append(document.createTextNode(chip.text));
    return el;
  };

  /**
   * @param {PinGitLogRow} row - The commit.
   * @param {number} _index - Its position.
   * @param {{entering: number[], columns: number, cap: number}} graph - Its lanes.
   * @returns {HTMLElement} Its row.
   */
  const buildRow = (row, _index, graph) => {
    const el = createElement('div', 'git-history__row');
    el.setAttribute('role', 'option');
    if (row.sha === marked) el.classList.add('git-history__row--marked');
    if (list.state().graphed) {
      el.append(graphCell(graph.entering, row, { cap: graph.cap, columns: graph.columns, height: ROW_PX, head: row.sha === headSha }));
    }
    const subject = createElement('span', 'git-history__subject text-truncate');
    // The commit checked out here: its branch's chip is the filled one, and
    // the row itself is marked so it can be found without reading chips.
    if (row.sha === headSha) el.classList.add('git-history__row--head');
    if (row.reflog) subject.append(createElement('span', 'git-history__reflog', row.reflog));
    for (const chip of chips.get(row.sha) || []) subject.append(chipEl(chip));
    subject.append(document.createTextNode(row.subject));
    const author = createElement('span', 'git-history__author text-truncate', row.author);
    const sha = createElement('span', 'git-history__sha', row.sha.slice(0, 7));
    sha.title = row.sha;
    const when = createElement('span', 'git-history__when text-truncate', rowDate(row.date));
    when.title = longDate(row.date);
    const more = /** @type {HTMLButtonElement} */ (createElement('button', 'git-history__more btn btn-icon btn-xs', '⋯'));
    more.type = 'button';
    more.title = t('More');
    el.append(subject, author, sha, when, more);
    return el;
  };

  const list = createHistoryList({
    fetch: (query, signal) => /** @type {Promise<any>} */ (git().read('log', {
      repo: host.repo(), ...ws(), log: { ...scopeQuery(scope), ...(applied.text ? { [applied.field]: applied.text } : {}), ...query }, signal,
    })),
    buildRow,
    cap,
    onSelect: (row) => showCommit(row?.sha || ''),
    onError: (e) => {
      if (!live || host.treeGone(e)) return;
      listError = errorText(e);
      renderNote();
    },
    onPage: () => {
      listError = '';
      renderNote();
    },
  });
  list.element.setAttribute('aria-label', t('History'));
  // The rows' height, for the columns whose dividers run the row's full height.
  list.element.style.setProperty('--git-history-row', `${ROW_PX}px`);

  // The working tree's changes, as the row above the list: shown while it is
  // every ref or what HEAD reaches, unfiltered — the lists the checked-out
  // commit is in, near the top.
  const wip = /** @type {HTMLButtonElement} */ (createElement('button', 'git-history__wip'));
  wip.type = 'button';
  wip.hidden = true;
  wip.addEventListener('click', () => host.showChanges());
  const renderWip = () => {
    const count = host.dirtyCount() || 0;
    wip.hidden = !count || (scope !== 'head' && scope !== 'all') || Boolean(applied.text);
    if (wip.hidden) return;
    wip.replaceChildren(createElement('span', 'git-history__wip-dot'),
      createElement('span', 'git-history__wip-text', t('Uncommitted changes')),
      createElement('span', 'git-history__wip-count', t('{count, plural, one {# file} other {# files}}', { count })),
      createElement('span', 'git-history__wip-go', t('Show in Changes')));
    wip.title = t('{count, plural, one {# changed file} other {# changed files}} in the working tree, on top of the checked-out commit', { count });
  };
  listPane.append(bar, wip, list.element, note);

  const renderNote = () => {
    const s = list.state();
    const text = listError ? t("Couldn't read the history. {error}", { error: listError })
      : s.loaded && s.total === 0 ? (applied.text ? t('No commits match “{text}”.', { text: applied.text }) : t('No commits.')) : '';
    note.textContent = text;
    note.hidden = !text;
  };

  // --- the scope picker --------------------------------------------------

  // The picker's ref choices — thousands, in a big repository — are built only
  // when it is opened; the button needs only the fixed scopes and the one chosen.
  /**
   * @param {boolean} full - With every ref, rather than the fixed scopes alone.
   * @returns {import('./menu-select.js').MenuChoice[]} The choices, grouped.
   */
  const scopeChoices = (full) => {
    /** @type {import('./menu-select.js').MenuChoice[]} */
    const choices = [];
    const groups = scopeGroups(state());
    for (const group of full ? groups : groups.slice(0, 1)) {
      for (const o of group.options) choices.push({ value: o.value, label: o.label, ...(group.label ? { group: group.label } : {}) });
    }
    if (!choices.some((c) => c.value === scope)) {
      // A ref that went away stays chosen until something else is.
      choices.push({ value: scope, label: scopeLabels.get(scope) || scopeQuery(scope).ref || scope });
    }
    return choices;
  };
  const renderScopes = () => scopeSelect.set(scopeChoices(false), scope);
  /**
   * Show another scope's commits, as a fresh list.
   * @param {import('./history-model.js').ScopeKey} next - The scope.
   */
  const setScope = (next) => {
    if (next === scope) return;
    scope = next;
    renderScopes();
    listError = '';
    renderNote();
    renderWip();
    list.reset();
    marked = '';
    showCommit('');
  };

  // --- the filter ----------------------------------------------------------

  /**
   * Read the list with this filter, unless it already is.
   * @param {string} text - The text, '' for none.
   * @param {string} field - What it is matched against.
   */
  const setFilter = (text, field) => {
    if (applied.text === text && (applied.field === field || !text)) return;
    applied = { field, text };
    listError = '';
    renderNote();
    renderWip();
    list.reset();
    marked = '';
    showCommit('');
  };

  /** Apply what the filter holds as a filter, and jump to the commit it names, if it names one. */
  const applyFilter = async () => {
    clearTimeout(idle);
    const text = filterInput.value.trim();
    const field = fieldSelect.value();
    const asked = ++filterAsks;
    filterAbort?.abort();
    filterAbort = null;
    if (field === 'message' && SHA_LIKE.test(text)) {
      const abort = new AbortController();
      filterAbort = abort;
      /** @type {PinGitCommit|null} */
      let named = null;
      try {
        named = /** @type {any} */ (await git().read('commit', { repo: host.repo(), ...ws(), commit: text, signal: abort.signal }));
      } catch (_) {
        // Names no commit: it is text to look for.
      }
      if (!live || asked !== filterAsks) return;
      if (named) {
        // The server lists the commits whose hash starts with it beside
        // those whose message holds it, so it is a filter as well as a jump.
        setFilter(text, field);
        await jump(named.sha);
        return;
      }
    }
    setFilter(text, field);
  };

  filterInput.addEventListener('input', () => {
    clearTimeout(idle);
    idle = setTimeout(() => { void applyFilter(); }, FILTER_IDLE_MS);
  });
  filterInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void applyFilter();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      filterInput.value = '';
      filterInput.blur();
      host.rootElement.focus({ preventScroll: true });
      void applyFilter();
    }
  });

  // --- reads -------------------------------------------------------------

  // The chips are drawn once per round of refs and worktrees reads, when both
  // have landed, and only the rows whose chips or HEAD ring changed are built
  // again.
  let rechipDue = false;
  const rechip = () => {
    if (!live || !rechipDue || refsReader.busy() || treesReader.busy()) return;
    rechipDue = false;
    const s = state();
    const next = chipIndex(s);
    const nextHead = viewedTree(s)?.tree.head || '';
    /** @type {Set<string>} */
    const changed = new Set();
    for (const sha of new Set([...chips.keys(), ...next.keys()])) {
      if (JSON.stringify(chips.get(sha) || []) !== JSON.stringify(next.get(sha) || [])) changed.add(sha);
    }
    if (nextHead !== headSha) for (const sha of [headSha, nextHead]) if (sha) changed.add(sha);
    chips = next;
    headSha = nextHead;
    renderScopes();
    if (changed.size) list.redraw(changed);
    renderDetail();
  };
  // A reader is still busy while it hands over its answer: the check waits until it is not.
  const rechipSoon = () => {
    rechipDue = true;
    queueMicrotask(rechip);
  };
  /** @param {any} e - A read's failure. */
  const refsFailed = (e) => {
    if (!live) return;
    host.treeGone(e);
    rechipSoon();
  };
  const refsReader = createReader(
    (signal) => git().read('refs', { repo: host.repo(), ...ws(), signal }),
    (value) => {
      if (!live) return;
      refs = /** @type {any} */ (value);
      rechipSoon();
    },
    refsFailed,
  );
  const treesReader = createReader(
    (signal) => git().read('worktrees', { repo: host.repo(), ...ws(), signal }),
    (value) => {
      if (!live) return;
      trees = /** @type {any} */ (value).trees || [];
      rechipSoon();
    },
    refsFailed,
  );
  /** @param {boolean} [fresh] - Drop what is out. */
  const readRefs = (fresh = false) => {
    if (fresh) {
      refsReader.replace();
      treesReader.replace();
    } else {
      refsReader.request();
      treesReader.request();
    }
  };

  // --- actions at a commit -------------------------------------------------

  const { run, runPastChanges, switchTo } = createActions({
    git,
    repo: () => host.repo(),
    workspaceOption: ws,
    toast: host.toast,
    element,
    live: () => live,
    reread: () => {
      if (!live) return;
      list.refresh();
      readRefs();
    },
    dirty: () => state().dirty,
    trees: () => state().trees,
    viewTree: (view) => host.viewTree(view),
    showChanges: () => host.showChanges(),
  });

  /**
   * Reset the branch in view, and offer to reset it back: from where the
   * reset left it to where it was, writing back what a hard one saved.
   * @param {{rev: string, mode: string, branch: string, expectHead: string}} a - The reset.
   */
  const reset = (a) => {
    void run({ kind: 'reset', rev: a.rev, mode: a.mode, expectHead: a.expectHead }).then((job) => {
      if (!job) return;
      const from = job.result?.sha || a.expectHead;
      const to = job.result?.head || a.rev;
      const saved = job.result?.saved || '';
      const sha = to.slice(0, 7);
      host.toast.show(a.mode === 'hard'
        ? t('Reset {branch} to {sha}. Undo puts back your changes, but not what was staged.', { branch: a.branch, sha })
        : t('Reset {branch} to {sha}', { branch: a.branch, sha }), () => {
        void run({ kind: 'reset', rev: from, mode: a.mode, expectHead: to, ...(saved ? { discard: saved } : {}) });
      });
    });
  };

  /**
   * Rewrite the branch in view, and offer to put it back: a reset from where
   * the rewrite left it to its old tip, which for a drop keeps local changes
   * (it brings the dropped files back) and otherwise is soft (the files are as
   * they were). A commit already pushed is rewritten only once the user says
   * so; changes in the way can be stashed first.
   * @param {Record<string, any>} op - The rewrite.
   * @param {Element} anchor - What asked, for the question.
   * @param {string} done - What the toast says once it has.
   */
  const rewrite = (op, anchor, done) => {
    void run(op, (e) => {
      if (e?.kind === 'published') {
        confirmAction(anchor, element, {
          text: t('{sha} is already pushed. Rewriting it means the branch can only be pushed by force afterwards.', { sha: String(op.rev).slice(0, 7) }),
          title: t('Rewrite a pushed commit'),
          ok: t('Rewrite anyway'),
          onConfirm: () => rewrite({ ...op, force: true }, anchor, done),
        });
        return true;
      }
      if (e?.kind === 'dirty') {
        host.toast.error(t('Your changes are in the way.'), {
          label: t('Stash them, then rewrite'),
          run: () => rewrite({ ...op, dirty: 'stash' }, anchor, done),
        });
        return true;
      }
      return false;
    }).then((job) => {
      if (!job) return;
      const from = job.result?.sha || op.expectHead;
      const to = job.result?.head || '';
      host.toast.show(done, to ? () => {
        void run({ kind: 'reset', rev: from, mode: op.kind === 'drop' ? 'keep' : 'soft', expectHead: to });
      } : undefined);
    });
  };

  /**
   * Ask for a commit's new message, starting from the one it has.
   * @param {string} rev - The commit.
   * @param {string} expectHead - Where the branch was seen.
   * @param {Element} anchor - What asked.
   */
  const reword = async (rev, expectHead, anchor) => {
    /** @type {PinGitCommit|null} */
    let known = commit?.sha === rev ? commit : null;
    if (!known) {
      rewordAbort?.abort();
      const abort = new AbortController();
      rewordAbort = abort;
      try {
        known = /** @type {any} */ (await git().read('commit', { repo: host.repo(), ...ws(), commit: rev, signal: abort.signal }));
      } catch (e) {
        if (live && !abort.signal.aborted) host.toast.error(errorText(e));
        return;
      }
      if (abort.signal.aborted) return;
    }
    if (!live || !known) return;
    askText(anchor, element, {
      label: t('New message for {sha}', { sha: rev.slice(0, 7) }),
      value: known.body ? `${known.subject}\n\n${known.body}` : known.subject,
      ok: t('Reword'),
      multiline: true,
      onSubmit: (message) => rewrite({ kind: 'reword', rev, message, expectHead }, anchor, t('Reworded {sha}', { sha: rev.slice(0, 7) })),
    });
  };

  /**
   * Carry out one of the model's actions.
   * @param {{type: string, [field: string]: any}} a - The action.
   * @param {Element} anchor - The control it came from, for what it asks.
   */
  const act = (a, anchor) => {
    switch (a.type) {
      case 'switch': switchTo(a.op, a.name, anchor); break;
      case 'branch-here':
        askText(anchor, element, {
          label: t('New branch at {sha}', { sha: a.rev.slice(0, 7) }),
          placeholder: t('branch name'),
          ok: t('Create'),
          onSubmit: (name) => { void run({ kind: 'branch-create', name, rev: a.rev }); },
        });
        break;
      case 'tag-here':
        askText(anchor, element, {
          label: t('Tag {sha}', { sha: a.rev.slice(0, 7) }),
          placeholder: t('tag name'),
          ok: t('Tag'),
          secondary: { label: t('Message (optional — makes an annotated tag)'), multiline: true },
          onSubmit: (name, _checked, message) => { void run({ kind: 'tag-create', name, rev: a.rev, ...(message ? { message } : {}) }); },
        });
        break;
      case 'new-worktree':
        void Promise.resolve(host.workspaces()?.create({ providerId: 'git-worktree', values: a.values }))
          .then(() => readRefs()).catch((e) => host.toast.error(errorText(e)));
        break;
      case 'cherry-pick':
        confirmAction(anchor, element, {
          text: t('Cherry-pick {sha} onto {branch}? Its change is committed again there.', { sha: a.rev.slice(0, 7), branch: a.branch }),
          ok: t('Cherry-pick'),
          tone: 'primary',
          onConfirm: () => { void runPastChanges({ kind: 'cherry-pick', rev: a.rev }, t('Stash them, then cherry-pick')); },
        });
        break;
      case 'reword': void reword(a.rev, a.expectHead, anchor); break;
      case 'rewrite': {
        const sha = String(a.op.rev).slice(0, 7);
        rewrite(a.op, anchor, a.op.kind === 'drop' ? t('Dropped {sha}', { sha }) : t('Folded the staged changes into {sha}', { sha }));
        break;
      }
      case 'revert':
        confirmAction(anchor, element, {
          text: t('Revert {sha}? A new commit undoing its change is made on the checked-out branch.', { sha: a.rev.slice(0, 7) }),
          ok: t('Revert'),
          tone: 'primary',
          onConfirm: () => { void runPastChanges({ kind: 'revert', rev: a.rev }, t('Stash them, then revert')); },
        });
        break;
      case 'reset':
        if (a.mode !== 'hard') {
          reset(/** @type {any} */ (a));
          break;
        }
        confirmAction(anchor, element, {
          text: t('Reset {branch} to {sha}, throwing away the changes to tracked files? They are saved first, so Undo can put them back.',
            { branch: a.branch, sha: a.rev.slice(0, 7) }),
          title: t('Reset {branch}', { branch: a.branch }),
          ok: t('Reset'),
          onConfirm: () => reset(/** @type {any} */ (a)),
        });
        break;
      case 'copy-sha':
        copyToClipboard(a.sha).then(() => host.toast.show(t('Copied {sha}', { sha: a.sha.slice(0, 10) })),
          (e) => host.toast.error(errorText(e)));
        break;
      default: break;
    }
  };

  /**
   * @param {string} sha - The commit.
   * @param {number} x - Where.
   * @param {number} y - Where.
   * @param {Element} anchor - What it hangs off.
   */
  const openMenu = (sha, x, y, anchor) => {
    openMenuAt(menuRows(menuFor('commit', sha, state()), (a) => act(a, anchor)), x, y, anchor);
  };

  // --- the detail ----------------------------------------------------------

  // The fetch carries the commit it asked for, so an answer — or a failure —
  // for one no longer wanted is told apart and dropped. Latest-wins: the
  // selection leaving a commit aborts its read.
  const commitReader = createReader(
    (signal) => {
      const sha = wanted;
      return git().read('commit', { repo: host.repo(), ...ws(), commit: sha, signal })
        .then((value) => ({ sha, value }), (error) => ({ sha, error }));
    },
    (/** @type {{sha: string, value?: any, error?: any}} */ answer) => {
      if (!live || answer.sha !== wanted) return;
      if (answer.error) {
        if (host.treeGone(answer.error)) return;
        commitError = errorText(answer.error);
      } else {
        commit = answer.value;
        commitError = '';
      }
      renderDetail();
    },
    () => {},
  );

  // The selection settles before its commit is read: the row and the detail's
  // head (from the list row) follow every move at once, but the read — and the
  // files, diff and blame its answer builds — waits for the moves to stop. Moves
  // made in one task are one; while an arrow is held (key repeat) the read
  // waits for the key to be let go, or for focus to leave.
  /** Whether a held arrow is moving the selection. */
  let holding = false;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let settling;
  const settle = () => {
    settling = undefined;
    if (live && !holding && wanted) commitReader.replace();
  };
  const readSettled = () => {
    if (!holding && settling === undefined) settling = setTimeout(settle, 0);
  };
  const letGo = () => {
    if (!holding) return;
    holding = false;
    readSettled();
  };
  host.rootElement.addEventListener('keyup', letGo);
  host.rootElement.addEventListener('focusout', letGo);
  window.addEventListener('blur', letGo);

  /**
   * Show a commit in the detail, and read it once the selection settles.
   * @param {string} sha - The commit, '' for none.
   * @param {boolean} [byId] - Shown by id, outside the list.
   */
  const showCommit = (sha, byId = false) => {
    outside = byId && Boolean(sha);
    if (sha !== wanted) {
      wanted = sha;
      commit = null;
      commitError = '';
      commitReader.cancel();
      panel?.cancel();
      if (sha) readSettled();
    }
    renderDetail();
  };

  /**
   * Mark a commit to compare the selection with, or let the mark go.
   * @param {string} sha - The commit, '' for none.
   */
  const mark = (sha) => {
    if (sha === marked) return;
    const was = marked;
    marked = sha;
    list.redraw([was, sha].filter(Boolean));
    renderDetail();
  };

  /**
   * The marked commit and the shown one as a range, older first: the one
   * further down the list is the older. One the list does not hold counts as
   * the older.
   * @returns {string} The range, '' when there is not a pair.
   */
  const compareRange = () => {
    if (!marked || !wanted || marked === wanted) return '';
    const a = list.indexOf(marked);
    const b = list.indexOf(wanted);
    const markedOlder = a < 0 || (b >= 0 && a > b);
    return markedOlder ? `${marked}..${wanted}` : `${wanted}..${marked}`;
  };

  /**
   * The commits HEAD reaches, as far as the list holds them.
   * @param {string} head - The checked-out commit.
   * @returns {Set<string>} Their ids.
   */
  const reachedFrom = (head) => {
    /** @type {Set<string>} */
    const seen = new Set();
    const stack = [head];
    while (stack.length) {
      const sha = /** @type {string} */ (stack.pop());
      if (seen.has(sha)) continue;
      const row = list.rowAt(list.indexOf(sha));
      if (!row) continue;
      seen.add(sha);
      stack.push(...row.parents);
    }
    return seen;
  };

  /**
   * The run a squash of the marked pair would make one commit: both in the
   * list, on the branch in view, the older end and the newer, and how many
   * commits from one to the other — the rows between them in the branch's own
   * unfiltered history; among every ref, those of them HEAD reaches, since
   * other branches' commits sit between. Whether they are one line of commits
   * is the server's to check.
   * @returns {{older: string, newer: string, count: number, head: string}|null} The run, null when there is none to squash.
   */
  const squashRun = () => {
    const s = state();
    const head = viewedTree(s)?.tree.head || '';
    if (!currentBranch(s) || !head || (scope !== 'head' && scope !== 'all') || applied.text) return null;
    const a = list.indexOf(marked);
    const b = list.indexOf(wanted);
    if (a < 0 || b < 0 || a === b) return null;
    let count = Math.abs(a - b) + 1;
    if (scope === 'all') {
      const reached = reachedFrom(head);
      if (!reached.has(marked) || !reached.has(wanted)) return null;
      count = 0;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        const row = list.rowAt(i);
        if (!row) return null;
        if (reached.has(row.sha)) count++;
      }
    }
    return a > b ? { older: marked, newer: wanted, count, head } : { older: wanted, newer: marked, count, head };
  };

  /**
   * Select a commit: its row, or the commit alone when the list does not hold it.
   * @param {string} sha - A full commit id.
   */
  const jump = async (sha) => {
    const at = await list.selectSha(sha);
    // null: a later selection came first, and is the one to show.
    if (live && at === -1) showCommit(sha, true);
  };

  /**
   * @param {[string, string|Node][]} pairs - Terms and what they say.
   * @returns {HTMLElement} A description list.
   */
  const facts = (pairs) => {
    const dl = createElement('dl', 'git-history__facts');
    for (const [term, value] of pairs) {
      const dd = createElement('dd');
      dd.append(value);
      dl.append(createElement('dt', '', term), dd);
    }
    return dl;
  };

  const renderDetail = () => {
    back.title = t('Back (esc)');
    if (!wanted) {
      crumb.replaceChildren(back);
      meta.replaceChildren(createElement('div', 'git-history__placeholder', t('Select a commit.')));
      if (panel) panel.element.hidden = true;
      detailSig = '';
      return;
    }
    // The selected row, without walking every held page, unless the commit is not it.
    const selected = list.selected().row;
    const row = selected?.sha === wanted ? selected : list.rowAt(list.indexOf(wanted));
    const items = menuFor('commit', wanted, state());
    const sig = JSON.stringify([wanted, outside, scope, marked, commit?.sha ?? null, commitError, row?.subject ?? null, chips.get(wanted) || [], items]);
    if (sig === detailSig) return;
    detailSig = sig;
    crumb.replaceChildren(back, createElement('span', 'git-history__crumb-title git-history__mono text-truncate', wanted.slice(0, 10)));
    /** @type {HTMLElement[]} */
    const parts = [];
    if (outside) {
      const away = createElement('div', 'git-history__outside', t('Not in this scope.'));
      if (scope !== 'all') {
        const widen = /** @type {HTMLButtonElement} */ (createElement('button', 'git-history__widen btn btn-xs btn-neutral', t('All refs')));
        widen.type = 'button';
        away.append(widen);
      }
      parts.push(away);
    }
    // What the commit is, as one group; what can be done with it, after a section gap.
    const about = createElement('div', 'git-history__about');
    about.append(createElement('div', 'git-history__title', commit?.subject ?? row?.subject ?? ''));
    const marks = createElement('div', 'git-history__marks');
    for (const chip of chips.get(wanted) || []) marks.append(chipEl(chip));
    if (marks.firstChild) about.append(marks);
    if (commit?.body) about.append(createElement('div', 'git-history__message', commit.body));
    parts.push(about);
    const author = commit ? commit.author : row ? { name: row.author, date: row.date } : null;
    const id = createElement('span', 'git-history__id');
    const idText = createElement('span', 'git-history__mono', wanted.slice(0, 10));
    idText.title = wanted;
    const copy = /** @type {HTMLButtonElement} */ (createElement('button', 'git-history__copy btn btn-icon'));
    copy.type = 'button';
    copy.title = t('Copy SHA');
    copy.setAttribute('aria-label', t('Copy SHA'));
    copy.append(icon('copy'));
    copy.addEventListener('click', () => act({ type: 'copy-sha', sha: wanted }, copy));
    id.append(idText, copy);
    /** @type {[string, string|Node][]} */
    const pairs = [[t('Commit ID'), id]];
    if (author) pairs.push([t('Author'), t('{author} · {date}', { author: author.name, date: longDate(author.date) })]);
    if (commit && (commit.committer.name !== commit.author.name || commit.committer.date !== commit.author.date)) {
      pairs.push([t('Committer'), t('{author} · {date}', { author: commit.committer.name, date: longDate(commit.committer.date) })]);
    }
    const parents = commit?.parents ?? row?.parents;
    if (parents) {
      const links = createElement('span', 'git-history__parents');
      for (const p of parents) {
        const link = /** @type {HTMLButtonElement} */ (createElement('button', 'git-history__parent git-history__mono', p.slice(0, 7)));
        link.type = 'button';
        link.dataset.sha = p;
        link.title = t('Select {sha}', { sha: p.slice(0, 10) });
        links.append(link);
      }
      pairs.push([t('Parents'), parents.length ? links : t('none')]);
    }
    about.append(facts(pairs));
    const range = compareRange();
    if (range) {
      const across = createElement('div', 'git-history__acts');
      const [older = '', newer = ''] = range.split('..');
      const compare = /** @type {HTMLButtonElement} */ (createElement('button', 'git-history__compare btn btn-xs btn-neutral',
        t('Compare {range}', { range: `${older.slice(0, 7)}..${newer.slice(0, 7)}` })));
      compare.type = 'button';
      compare.dataset.range = range;
      compare.title = t('Review what changed between the marked commit and this one');
      across.append(compare);
      const pair = squashRun();
      if (pair) {
        const squash = /** @type {HTMLButtonElement} */ (createElement('button', 'git-history__squash btn btn-xs btn-neutral',
          t('Squash {count} commits', { count: pair.count })));
        squash.type = 'button';
        squash.title = t('Make the commits from the marked one to this one a single commit, their messages joined');
        squash.addEventListener('click', () => rewrite({ kind: 'squash', rev: pair.older, sha: pair.newer, expectHead: pair.head }, squash,
          t('Squashed {count} commits', { count: pair.count })));
        across.append(squash);
      }
      parts.push(across);
    }
    const acts = createElement('div', 'git-history__acts');
    const { buttons, more } = detailActions(items);
    for (const item of buttons) {
      if (!item.action) continue;
      const action = item.action;
      const b = /** @type {HTMLButtonElement} */ (createElement('button',
        `git-history__act btn btn-xs ${item.danger ? 'btn-danger-quiet' : 'btn-neutral'}`, item.label || ''));
      b.type = 'button';
      b.dataset.action = action.type;
      if (item.hint) b.title = item.hint;
      b.addEventListener('click', () => act(action, b));
      acts.append(b);
    }
    if (more.some((item) => item.action)) {
      const rest = /** @type {HTMLButtonElement} */ (createElement('button', 'git-history__act-more btn btn-icon btn-xs btn-neutral', '⋯'));
      rest.type = 'button';
      rest.title = t('More');
      rest.setAttribute('aria-label', t('More'));
      rest.addEventListener('click', () => {
        const rect = rest.getBoundingClientRect();
        openMenuAt(menuRows(more, (a) => act(a, rest)), rect.left, rect.bottom, rest);
      });
      acts.append(rest);
    }
    parts.push(acts);
    if (commitError) parts.push(createElement('div', 'git-history__error', t("Couldn't read the commit. {error}", { error: commitError })));
    meta.replaceChildren(...parts);
    if (commit !== paneled) {
      paneled = commit;
      if (commit) filesPanel().setManifest(commitManifest(commit, host.root()));
    }
    if (panel) panel.element.hidden = !commit;
  };

  /** @param {'list'|'detail'} next - The pane stack mode shows. */
  const setLevel = (next) => {
    level = next;
    if (element.dataset.level !== level) {
      element.dataset.level = level;
      host.levelChanged();
    }
  };

  list.element.addEventListener('click', (event) => {
    const row = /** @type {Element} */ (event.target).closest('.git-history__row');
    if (!(row instanceof HTMLElement)) return;
    const more = /** @type {Element} */ (event.target).closest('.git-history__more');
    if (more) {
      const rect = more.getBoundingClientRect();
      if (row.dataset.sha) openMenu(row.dataset.sha, rect.left, rect.bottom, more);
      return;
    }
    if (event.shiftKey) {
      if (row.dataset.sha && row.dataset.sha !== wanted) mark(row.dataset.sha);
      return;
    }
    mark('');
    list.select(Number(row.dataset.index));
    setLevel('detail');
  });
  const dropMenu = contextMenuFor(list.element, (target) => {
    const row = target.closest('.git-history__row');
    if (!(row instanceof HTMLElement) || !row.dataset.sha) return null;
    return menuRows(menuFor('commit', row.dataset.sha, state()), (a) => act(a, row));
  });
  detail.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest('.git-history__back')) {
      setLevel('list');
      return;
    }
    const compare = target.closest('.git-history__compare');
    if (compare instanceof HTMLElement && compare.dataset.range) {
      host.showScope(compare.dataset.range);
      return;
    }
    if (target.closest('.git-history__widen')) {
      const sha = wanted;
      setScope('all');
      void jump(sha);
      return;
    }
    const parent = target.closest('.git-history__parent');
    if (parent instanceof HTMLElement && parent.dataset.sha) void jump(parent.dataset.sha);
  });
  detail.addEventListener('diff-blame-select', (event) => {
    const sha = /** @type {CustomEvent} */ (event).detail?.sha;
    if (sha) void jump(sha);
  });

  // --- the watch -----------------------------------------------------------

  // While another place is shown, a change is only noted; showing this one
  // again catches up once, however many came meanwhile.
  /** @type {''|'change'|'resync'} What came while the place was hidden. */
  let missed = '';
  const resync = () => {
    list.reset();
    marked = '';
    showCommit('');
    readRefs(true);
  };
  const watchTree = () => git().watch((event) => {
    if (!live || !opened) return;
    if (event.type === 'git-change') {
      const mine = event.repos.find((r) => (r.path || '') === host.repo());
      if (!mine || !mine.kinds.some((k) => k === 'refs' || k === 'head')) return;
      if (element.hidden) {
        if (!missed) missed = 'change';
        return;
      }
      list.refresh();
      readRefs();
    } else if (event.type === 'git-resync') {
      if (element.hidden) missed = 'resync';
      else resync();
    }
  }, ws());
  let unwatch = watchTree();

  renderScopes();
  renderDetail();
  renderWip();

  return {
    element,
    dirtyChanged: () => renderWip(),
    shown: () => {
      opened = true;
      const caught = missed;
      missed = '';
      if (caught === 'resync') {
        resync();
        return;
      }
      list.render();
      if (caught === 'change') list.refresh();
      readRefs();
    },
    refresh: () => {
      list.refresh();
      readRefs();
    },
    setTree: () => {
      if (!live) return;
      unwatch?.();
      unwatch = watchTree();
      refs = null;
      trees = [];
      chips = new Map();
      headSha = '';
      scope = DEFAULT_SCOPE;
      listError = '';
      clearTimeout(idle);
      filterAsks++;
      filterAbort?.abort();
      filterInput.value = '';
      applied = { field: 'message', text: '' };
      fieldSelect.setValue('message');
      drawPlaceholder();
      marked = '';
      missed = '';
      renderScopes();
      setLevel('list');
      if (opened) {
        list.reset();
        readRefs(true);
      }
      renderNote();
      renderWip();
      showCommit('');
    },
    reveal: async ({ sha, stash }) => {
      if (!live) return;
      if (stash !== undefined) {
        const key = `ref:${sha}`;
        scopeLabels.set(key, t('Stash: {message}', { message: stash }));
        setScope(key);
        await jump(sha);
        return;
      }
      let at = await list.selectSha(sha);
      if (!live || at === null) return;
      if (at < 0 && scope !== 'all') {
        setScope('all');
        at = await list.selectSha(sha);
      }
      if (live && at === -1) showCommit(sha, true);
    },
    showPath: (path) => {
      if (!live) return;
      clearTimeout(idle);
      filterAsks++;
      filterAbort?.abort();
      fieldSelect.setValue('path');
      drawPlaceholder();
      filterInput.value = path;
      setFilter(path, 'path');
      setLevel('list');
    },
    handleKey: (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.review-panel') && event.key !== 'Escape') return false;
      switch (event.key) {
        case 'j': case 'ArrowDown':
          holding = event.repeat;
          list.move(1);
          return true;
        case 'k': case 'ArrowUp':
          holding = event.repeat;
          list.move(-1);
          return true;
        case '/': filterInput.focus(); return true;
        case 'x': {
          const sha = list.selected().row?.sha || '';
          mark(sha === marked ? '' : sha);
          return Boolean(sha);
        }
        case 'Enter':
          if (!list.selected().row) return false;
          if (measureMode(host.rootElement) === 'stack') setLevel('detail');
          return true;
        case 'Escape':
          if (marked) {
            mark('');
            return true;
          }
          if (level === 'detail') {
            setLevel('list');
            return true;
          }
          return false;
        default:
          return false;
      }
    },
    focus: () => list.element.focus(),
    teardown: () => {
      live = false;
      closePopover();
      dropMenu();
      clearTimeout(idle);
      clearTimeout(settling);
      commitReader.cancel();
      filterAbort?.abort();
      rewordAbort?.abort();
      host.rootElement.removeEventListener('keyup', letGo);
      host.rootElement.removeEventListener('focusout', letGo);
      window.removeEventListener('blur', letGo);
      unwatch?.();
      panel?.destroy();
    },
  };
}
