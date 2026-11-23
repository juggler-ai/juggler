//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's Changes place: the working tree and the index of one
 * repository, as a list to stage, discard and commit from, and the selected
 * file's diff to stage lines from — or, for an untracked file, which has
 * nothing to differ from, the file itself. It also tells the head line above the
 * places what to show, because that line is about the same repository, and
 * owns the head's primary (Commit) and repository picker.
 *
 * **Reads.** `changes()` is read when the place mounts, on every `git-change`
 * for this repository, on `git-resync`, and after each job it runs. One read is
 * out at a time: a change that lands while one is out marks the place dirty,
 * and the read that ends then starts exactly one more. A resync (the tree
 * changed under the pin) or a repository switch bumps the generation and reads
 * at once, and an answer from an older generation is dropped.
 *
 * **Optimistic writes.** Stage, unstage, stage all, unstage all, discard and
 * resolving a conflict move the row at once: the op is kept as an overlay, applied to the last read
 * and drawn pending. If the job fails the overlay goes, and the failure is
 * answered as every place's is (pins/git/actions `explain`). If it succeeds the overlay stays until the first read that
 * STARTED after the job finished — an older read cannot have seen the write.
 *
 * **Conflicts.** A file in conflict is resolved from its row (Ours, Theirs),
 * its detail (Take ours, Take theirs, Mark resolved, over its diff with the
 * markers) or its menu, and Undo puts the conflict back while the operation is
 * in progress. Marking a file that still has markers resolved is asked about.
 *
 * **Modes.** The layout is container queries on the pin (`git-pin`, stack below
 * 34rem). What the keys do also depends on the mode — Enter pushes the detail
 * in stack mode and focuses the diff in split mode — so the place reads the
 * pin's size (pins/git/layout), as the pin does for the root's `data-mode`.
 * Its own `data-level` says which pane stack mode shows; the pin copies the
 * shown place's onto the root. Tests read those attributes.
 *
 * **The draft.** The commit message is kept in memory per pin, tree and
 * repository (a module-level map), so it survives switching places, switching
 * repositories and back, and a remount; not a reload.
 *
 * **The filter** (`/`, pins/git/list-filter) narrows the list to the files
 * whose path or old path holds its text; a group with none left loses its
 * header, j/k walk only the rows shown, and the selection stays put. The group
 * actions still act on the whole group.
 * @module pins/git/changes-place
 */

import { formatList, translator, markForTranslation } from 'juggler/i18n';
import { openPath } from 'juggler/ops';
import { contextMenuFor, copyToClipboard, createDiffViewer, createElement, createFileActions, errorText, openMenuAt, pinFile } from 'juggler/ui';
import { measureMode as measurePin } from './layout.js';
import { wrapBody } from '../../lib/commit-message.js';
import { repoLabel } from '../../lib/git-status.js';
import {
  applyOp,
  groupsOf,
  isPartlyStaged,
  isToggleable,
  letterOf,
  signatureOf,
  statOf,
  toneOf,
} from './changes-model.js';
import { createCommitBox } from './commit-box.js';
import { createGenerateControl } from './generate-menu.js';
import { createListFilter } from './list-filter.js';
import { fetchLiveFile, renderLiveFileBody } from '../../lib/live-file.js';
import { closePopover, confirmAction, openPopover } from './popover.js';
import { createActions, updateSubmodule } from './actions.js';
import { inlineError } from './inline-error.js';
import { createVirtualList, remHeight, WINDOWED_ABOVE } from 'juggler/utils/virtual-list';

const t = translator('@juggler/core');

/**
 * What a failed commit says in the commit box: the hooks' output, then git's
 * reason — left out when the output already holds it, as it does when the
 * reason is the tail of what a hook printed.
 * @param {string} output - What the hooks printed.
 * @param {string} reason - Why the commit failed.
 * @returns {string} The text.
 */
function commitFailure(output, reason) {
  const flat = (/** @type {string} */ text) => text.replace(/\s+/g, ' ').trim();
  const out = output.trimEnd();
  if (!flat(reason) || flat(out).includes(flat(reason))) return out;
  if (flat(reason).includes(flat(out))) return reason.trim();
  return `${out}\n${reason.trim()}`;
}

/**
 * @typedef {import('./changes-model.js').ChangedFile} ChangedFile
 * @typedef {import('./changes-model.js').GroupId} GroupId
 * @typedef {import('../../lib/git-client.js').GitChanges} GitChanges
 * @typedef {import('../../lib/git-client.js').GitOp} GitOp
 * @typedef {import('../../lib/git-client.js').GitJob} GitJob
 * @typedef {import('../../lib/git-client.js').GitClient} GitClient
 */

/** Section titles, by group (English source text). */
const GROUP_TITLES = /** @type {Record<GroupId, string>} */ ({
  conflicts: markForTranslation('Conflicts'),
  staged: markForTranslation('Staged'),
  changes: markForTranslation('Changes'),
  untracked: markForTranslation('Untracked'),
});

/** The ids each letter's words select on. */
const LETTER_IDS = /** @type {Record<string, string>} */ ({
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', '?': 'untracked',
});

/** Each tree's draft commit message, by pin, tree and repository. */
const drafts = new Map();

/**
 * The words for a row's letter, for its tooltip and its label.
 * @param {string} letter - The letter.
 * @returns {string} The words.
 */
function letterWords(letter) {
  return t('{status, select, modified {Modified} added {Added} deleted {Deleted} renamed {Renamed} copied {Copied} typechange {Type changed} untracked {Untracked} other {Conflicted}}',
    { status: LETTER_IDS[letter] || 'conflicted' });
}

/**
 * @param {string} path - A repository-relative path.
 * @returns {{name: string, dir: string}} Its last part and the folder it is in.
 */
function splitPath(path) {
  const at = path.lastIndexOf('/');
  return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

/**
 * What taking each side of a conflict takes, for its tooltip. In a rebase,
 * git's "ours" is the branch being rebased onto and "theirs" the user's own
 * commit being replayed — the other way round from a merge, pick or revert.
 * @param {import('../../lib/git-client.js').GitStopped|undefined} stopped - The operation in progress.
 * @param {string} head - HEAD's sha.
 * @returns {{ours: string, theirs: string}} The tooltips.
 */
function sideTitles(stopped, head) {
  if (!stopped) return { ours: t('Take ours'), theirs: t('Take theirs') };
  const short = (/** @type {string|undefined} */ sha) => (sha || '').slice(0, 7);
  const other = (/** @type {string} */ name) => t('{kind, select, revert {Take the version without {name}} other {Take {name}’s version}}', { kind: stopped.kind, name });
  const yours = (/** @type {string} */ name) => t('Take yours ({name})', { name });
  switch (stopped.kind) {
    case 'rebase': return { ours: other(stopped.other || short(stopped.otherSha)), theirs: yours(short(stopped.commit?.sha)) };
    case 'merge': return { ours: yours(stopped.branch || short(head)), theirs: other(stopped.other || short(stopped.otherSha)) };
    default: return { ours: yours(stopped.branch || short(head)), theirs: other(short(stopped.commit?.sha)) };
  }
}

/**
 * @typedef {object} ChangesHost
 * @property {() => GitClient} git - The pin's git service, as it now is.
 * @property {() => {workspace?: string}} workspaceOption - The tree option for every call.
 * @property {() => string} treeKey - The tree's identity, for the draft.
 * @property {() => string} root - The tree's absolute path, for opening files.
 * @property {string} pinId - The pin, for the draft.
 * @property {HTMLElement} rootElement - The pin's root, which carries the mode.
 * @property {import('./head.js').Head} head - The head line, whose repository
 *   picker this place fills.
 * @property {(state: ChangesState) => void} stateChanged - What the head
 *   shows of this place changed.
 * @property {(job: GitJob) => void} jobChanged - A job of the tree moved.
 * @property {(jobs: GitJob[]) => void} jobsLoaded - The tree's jobs were read, newest first.
 * @property {() => void} levelChanged - The place's `data-level` changed.
 * @property {string} [initialRepo] - The repository to open at, by its path in
 *   the tree; the root repository when it is missing or the tree no longer holds it.
 * @property {(repo: string) => void} repoChanged - Another repository of the tree is shown.
 * @property {(e: any) => boolean} treeGone - A read failed: true when it was the
 *   pinned tree going away, which the pin has handled.
 * @property {() => import('juggler/pinboard-item-type').PinWorkspaces|undefined} workspaces - The session's
 *   workspaces, where Discuss starts its conversation.
 * @property {() => string} conversationId - The visible conversation, '' for none.
 * @property {import('./toast.js').PinToast} toast - The pin's toast.
 * @property {import('./command-log.js').CommandLog} log - The pin's command log.
 * @property {() => void} showChanges - Bring this place forward (the head's
 *   primary and `c` act on it).
 * @property {(target: {sha: string}) => void} showHistory - Show a commit in History.
 * @property {(path: string) => void} showFileHistory - Show one file's history.
 */

/**
 * What the head shows of the repository in view.
 * @typedef {object} ChangesState
 * @property {string} repo - The repository's path in the tree.
 * @property {string} repoName - Its name.
 * @property {GitChanges|null} read - Its last read.
 * @property {number} changed - Changed files.
 * @property {number} staged - Files with something staged.
 * @property {number} conflicts - Files still in conflict.
 * @property {boolean} committing - A commit is out.
 */

/**
 * @typedef {object} ChangesPlace
 * @property {HTMLElement} element - The place; its `data-level` says which pane stack mode shows.
 * @property {() => void} refresh - Read again.
 * @property {(repo?: string) => void} setTree - The host's `workspaceOption` names another
 *   tree: watch it instead, and read it afresh, at this repository in it ('' its root).
 * @property {(event: KeyboardEvent) => boolean} handleKey - A key the pin heard
 *   outside a text field; true when it was this place's.
 * @property {() => void} focusMessage - Put the caret in the commit message.
 * @property {(anchor?: Element) => void} commit - Commit, or ask for a message
 *   (the head's Commit): in a chip, on a popover off `anchor`.
 * @property {() => void} showFirstConflict - Select the first file in conflict and show it.
 * @property {() => void} focus - Focus the list.
 * @property {(repos: {path: string}[]) => void} setRepos - The repositories in the tree.
 * @property {(repo: string) => void} showRepo - Show one of them, by its path in the tree.
 * @property {() => string} repo - The repository shown.
 * @property {() => number|null} dirtyCount - Its changed files, null before the first read.
 * @property {() => void} teardown - Stop.
 */

/**
 * @param {ChangesHost} host - What the place works through.
 * @returns {ChangesPlace} The place.
 */
export function createChangesPlace(host) {
  const pinRoot = host.rootElement;
  let live = true;
  let repo = host.initialRepo || '';
  /** @type {{path: string}[]} */
  let repos = [];

  // --- reads ---------------------------------------------------------------
  /** @type {GitChanges|null} */
  let read = null;
  let readError = '';
  let generation = 0;
  let readsStarted = 0;
  /** @type {{generation: number, seq: number, abort: AbortController}|null} */
  let inFlight = null;
  let dirty = false;
  /** @type {{op: GitOp, done: boolean, finishedAfter: number}[]} */
  let overlays = [];

  // --- view state ----------------------------------------------------------
  /** @type {string|null} `group:path` of the selected row. */
  let selected = null;
  /** @type {'list'|'detail'} */
  let level = 'list';
  /** @type {string[]} The shown rows' keys, in order. */
  let order = [];
  /** @type {Map<string, {sig: string, row: HTMLElement}>} */
  const rowCache = new Map();
  /** @type {Map<string, number>} Each shown row's index among the windowed list's items, while it is windowed. */
  let itemIndex = new Map();
  let committing = false;

  const ws = () => host.workspaceOption();
  const git = () => host.git();
  const draftKey = () => `${host.pinId}\u0000${host.treeKey()}\u0000${repo}`;

  // --- DOM -----------------------------------------------------------------
  const head = host.head;
  const element = createElement('div', 'git-changes');
  const listPane = createElement('section', 'git-changes__list');
  const scroll = createElement('div', 'git-changes__scroll');
  scroll.setAttribute('role', 'listbox');
  scroll.setAttribute('aria-label', t('Changed files'));
  const commitBox = createCommitBox({
    onCommit: () => commit(),
    onInput: (message) => {
      if (message) drafts.set(draftKey(), message);
      else drafts.delete(draftKey());
    },
    onExpand: (expanded) => {
      if (expanded) element.dataset.big = 'true';
      else delete element.dataset.big;
    },
    onGenerate: (anchor) => generateControl.open(anchor),
    onStopGenerating: () => generateControl.stop(),
  });
  const generateControl = createGenerateControl({
    box: commitBox,
    git: () => host.git(),
    workspaceOption: () => host.workspaceOption(),
    repo: () => repo,
    root: () => host.root(),
    treeKey: () => host.treeKey(),
    conversationId: () => host.conversationId(),
    workspaces: () => host.workspaces(),
    toast: host.toast,
  });
  const filter = createListFilter({
    label: t('Filter the changed files'),
    placeholder: t('Filter by path (/)'),
    root: pinRoot,
    onChange: () => renderList(),
  });
  listPane.append(filter.element, scroll, commitBox.element);
  /** Over WINDOWED_ABOVE rows the list is drawn a window at a time. */
  const windowed = /** @type {import('juggler/utils/virtual-list').VirtualList<import('juggler/utils/virtual-list').SectionItem>} */ (createVirtualList({
    scroller: scroll,
    spacerClass: 'git-changes__spacer',
    rowHeight: remHeight(1.5),
    headerHeight: remHeight(2),
    isHeader: (item) => item.header,
    keyOf: (item) => item.key,
    build: (item) => item.build(),
    decorate: (el, item) => { if (item.row) el.setAttribute('aria-selected', String(item.row === selected)); },
  }));
  const detail = createElement('section', 'git-changes__detail');
  const crumb = createElement('div', 'git-changes__crumb');
  const note = createElement('div', 'git-changes__note');
  note.hidden = true;
  const viewerHost = createElement('div', 'git-changes__viewer');
  // An untracked file has nothing to diff against: it is shown whole, as the
  // file pin shows a file.
  const fileHost = createElement('div', 'git-changes__file');
  fileHost.hidden = true;
  const placeholder = createElement('div', 'git-changes__placeholder');
  detail.append(crumb, note, placeholder, viewerHost, fileHost);
  const body = createElement('div', 'git-changes__body');
  body.append(listPane, detail);
  element.append(body);

  const viewer = createDiffViewer({ readOnly: true, blame: true, fill: true });
  viewerHost.append(viewer);
  // The diff's own toolbar (blame, layout, context) is drawn in the crumb, and
  // its counts beside the file's name there, so the file has one bar.
  const viewOptions = createElement('span', 'git-changes__view-opts');
  viewer.setControlsHost(viewOptions);
  viewer.setStatsShown(false);

  // A failed write is answered as every place's is; this place reads the
  // tree it shows, and has no other tree to offer.
  const { explain } = createActions({
    git,
    repo: () => repo,
    workspaceOption: ws,
    toast: host.toast,
    element,
    live: () => live,
    reread: () => requestRead(),
    dirty: () => files().length,
    trees: () => [],
    viewTree: () => {},
    showChanges: () => host.showChanges(),
  });

  // --- the model -----------------------------------------------------------

  /** @returns {ChangedFile[]} The files as drawn: the last read, with the writes still out applied. */
  const files = () => overlays.reduce((acc, o) => applyOp(acc, o.op), /** @type {ChangedFile[]} */ (read?.files || []));

  /**
   * @param {string|null} key - `group:path`.
   * @returns {{group: GroupId, file: ChangedFile}|null} The row's file, when it is still listed.
   */
  const lookup = (key) => {
    if (!key) return null;
    const at = key.indexOf(':');
    const group = /** @type {GroupId} */ (key.slice(0, at));
    const path = key.slice(at + 1);
    const groups = groupsOf(files());
    const file = groups.find((g) => g.id === group)?.files.find((f) => f.path === path);
    return file ? { group, file } : null;
  };

  /** @returns {number} Files with something staged. */
  const stagedCount = () => groupsOf(files()).find((g) => g.id === 'staged')?.files.length || 0;

  /** @returns {number} Files still in conflict. */
  const conflictCount = () => groupsOf(files()).find((g) => g.id === 'conflicts')?.files.length || 0;

  /** @returns {import('./layout.js').PinMode} The mode the pin's size puts it in. */
  const measureMode = () => measurePin(pinRoot);

  const syncLevel = () => {
    if (element.dataset.level !== level) {
      element.dataset.level = level;
      host.levelChanged();
    }
  };

  /**
   * @param {'list'|'detail'} next - The pane stack mode shows.
   */
  const setLevel = (next) => {
    level = next;
    syncLevel();
  };

  // --- reads ---------------------------------------------------------------

  /**
   * Read the repository's changes, or note that another read is wanted.
   * @param {{fresh?: boolean}} [options] - `fresh` discards whatever is out:
   *   the tree or repository changed, so its answer would be about another one.
   */
  const requestRead = (options = {}) => {
    if (!live) return;
    if (options.fresh) {
      generation++;
      inFlight?.abort.abort();
      inFlight = null;
      dirty = false;
    }
    if (inFlight) {
      dirty = true;
      return;
    }
    void startRead();
  };

  const startRead = async () => {
    const mine = { generation, seq: ++readsStarted, abort: new AbortController() };
    inFlight = mine;
    try {
      const next = await git().changes({ repo, ...ws(), signal: mine.abort.signal });
      if (!live || mine.generation !== generation) return;
      adopt(next, mine.seq);
    } catch (e) {
      if (!live || mine.generation !== generation || host.treeGone(e)) return;
      readError = errorText(/** @type {any} */ (e));
      render();
    } finally {
      if (inFlight === mine) {
        inFlight = null;
        if (dirty && live) {
          dirty = false;
          void startRead();
        }
      }
    }
  };

  /** @type {string} The signature of the file whose diff is on screen. */
  let shownSig = '';

  /**
   * Take a read as the truth, keeping the writes it cannot have seen.
   * @param {GitChanges} next - The answer.
   * @param {number} seq - When it started.
   */
  const adopt = (next, seq) => {
    read = next;
    readError = '';
    overlays = overlays.filter((o) => !(o.done && seq > o.finishedAfter));
    render();
  };

  // --- writes --------------------------------------------------------------

  /**
   * Run one write. With `optimistic`, the list moves at once and moves back if
   * the write fails. A failure is explained unless `onError` takes it.
   * @param {GitOp} op - The write.
   * @param {{optimistic?: boolean, onError?: (e: any) => boolean}} [options] - How.
   * @returns {Promise<GitJob|null>} The finished job, or null when it failed.
   */
  const runOp = async (op, options = {}) => {
    // Another write: what the toast said about the last one has had its say.
    host.toast.userActed();
    const overlay = options.optimistic ? { op, done: false, finishedAfter: 0 } : null;
    if (overlay) {
      overlays.push(overlay);
      render();
    }
    try {
      const job = await git().run(op, ws());
      if (overlay) {
        overlay.done = true;
        overlay.finishedAfter = readsStarted;
      }
      return job;
    } catch (e) {
      if (overlay) overlays = overlays.filter((o) => o !== overlay);
      if (live && !options.onError?.(e)) explain(e);
      if (live) render();
      return null;
    } finally {
      requestRead();
    }
  };

  /**
   * Stage or unstage a row's file, whichever its group is not.
   * @param {string} key - The row.
   */
  const toggle = (key) => {
    const hit = lookup(key);
    if (!hit || !isToggleable(hit.file, hit.group)) return;
    const kind = hit.group === 'staged' ? 'unstage' : 'stage';
    // The selection follows the file to the group it is moving to.
    if (selected === key) selected = `${kind === 'stage' ? 'staged' : (hit.file.index === 'A' ? 'untracked' : 'changes')}:${hit.file.path}`;
    void runOp({ kind, repo, paths: [hit.file.path] }, { optimistic: true });
  };

  /**
   * A group's Stage all / Unstage all.
   * @param {GroupId} group - The group.
   */
  const groupAction = (group) => {
    const groupFiles = groupsOf(files()).find((g) => g.id === group)?.files || [];
    if (group === 'staged') {
      void runOp({ kind: 'unstage-all', repo }, { optimistic: true });
    } else if (group === 'changes') {
      const paths = groupFiles.filter((f) => isToggleable(f, 'changes')).map((f) => f.path);
      if (!paths.length) return;
      void runOp({ kind: 'stage-all', repo }, { optimistic: true }).then((job) => {
        if (job) host.toast.show(t('Staged {count, plural, one {# file} other {# files}}', { count: paths.length }), () => {
          void runOp({ kind: 'unstage', repo, paths }, { optimistic: true });
        });
      });
    } else if (group === 'untracked') {
      void runOp({ kind: 'stage', repo, paths: groupFiles.map((f) => f.path) }, { optimistic: true });
    }
  };

  /**
   * Discard a file's unstaged change, recoverably, and offer it back.
   * @param {string} key - The row.
   */
  const discard = (key) => {
    const hit = lookup(key);
    if (!hit) return;
    const path = hit.file.path;
    if (selected === key) {
      selected = null;
      setLevel('list');
    }
    void runOp({ kind: 'discard', repo, paths: [path] }, { optimistic: true }).then((job) => {
      if (!job) return;
      offerDiscardUndo(t('Discarded {name}', { name: splitPath(path).name }), job);
    });
  };

  /**
   * @param {string} text - What was discarded.
   * @param {GitJob} job - The discard, whose result names its recovery point.
   */
  const offerDiscardUndo = (text, job) => {
    const id = job.result?.discard;
    host.toast.show(text, id ? () => { void runOp({ kind: 'undo-discard', repo, discard: id }); } : undefined);
  };

  /**
   * @param {string} path - The file.
   * @param {'file'|'extension'|'folder'} pattern - What the ignore covers.
   */
  const ignore = (path, pattern) => {
    void runOp({ kind: 'ignore', repo, paths: [path], pattern });
  };

  /**
   * Resolve a file in conflict: with one side's version, or as it is. The row
   * moves to Staged at once, the selection with it, and the toast offers Undo.
   * One still holding conflict markers is asked about, then marked with force.
   * @param {string} key - The row.
   * @param {'ours'|'theirs'|'resolved'} mode - How.
   * @param {Element|null} anchor - What asked, for the question.
   * @param {boolean} [force] - Mark it resolved whatever it holds.
   */
  const resolveConflict = (key, mode, anchor, force = false) => {
    const hit = lookup(key);
    if (!hit || hit.group !== 'conflicts') return;
    const path = hit.file.path;
    const name = splitPath(path).name;
    const moved = `staged:${path}`;
    if (selected === key) selected = moved;
    void runOp({ kind: 'resolve', repo, path, mode, ...(force ? { force: true } : {}) }, {
      optimistic: true,
      onError: (e) => {
        if (selected === moved) selected = key;
        if (e?.kind !== 'markers') return false;
        render();
        confirmAction(anchor?.isConnected ? anchor : (rowCache.get(key)?.row || listPane), listPane, {
          text: t('{name} still has conflict markers. Mark it resolved anyway?', { name }),
          ok: t('Mark resolved'),
          tone: 'primary',
          onConfirm: () => resolveConflict(key, mode, anchor, true),
        });
        return true;
      },
    }).then((job) => {
      if (!job) return;
      const id = job.result?.discard;
      host.toast.show(t('{mode, select, ours {Took ours for {name}} theirs {Took theirs for {name}} other {Marked {name} resolved}}', { mode, name }),
        id ? () => unresolve(path, id) : undefined);
    });
  };

  /**
   * Put a resolved file back in conflict, and its working file back as the
   * resolve found it.
   * @param {string} path - The file.
   * @param {string} discard - The save the resolve named.
   */
  const unresolve = (path, discard) => {
    if (selected === `staged:${path}`) selected = `conflicts:${path}`;
    void runOp({ kind: 'unresolve', repo, path, discard }, { optimistic: true });
  };

  /** @type {HTMLElement|null} The popover the commit box is lent to, while it is open. */
  let commitPopover = null;

  /**
   * A chip has no list to type in, so the commit box itself comes out on a
   * popover off the control that asked — the same message, Amend, hook output
   * and ⌘↵ — and goes back to the list when the popover closes, however it
   * closes.
   * @param {Element} anchor - What asked.
   */
  const openCommitPopover = (anchor) => {
    const surface = createElement('div', 'git-pop__commit');
    surface.append(createElement('div', 'git-pop__title', read?.branch
      ? t('Commit to {branch}', { branch: read.branch }) : t('Commit')), commitBox.element);
    commitPopover = surface;
    openPopover(anchor, pinRoot, surface, () => {
      if (commitPopover === surface) commitPopover = null;
      listPane.append(commitBox.element);
    });
    surface.classList.add('git-pop--commit');
    commitBox.focus();
  };

  /**
   * @param {Element|null} [anchor] - What asked, for a chip's popover.
   */
  const commit = (anchor = null) => {
    if (committing || !read) return;
    const { message, amend, noVerify } = commitBox.request();
    if (!message.trim()) {
      if (!commitPopover && anchor && measureMode() === 'chip') {
        openCommitPopover(anchor);
        return;
      }
      host.showChanges();
      setLevel('list');
      commitBox.focus();
      return;
    }
    // Continue commits an operation in progress, with git's own message.
    if (read.detached || read.operation) return;
    if (!amend && stagedCount() === 0) return;
    const branch = read.branch;
    const amendedPushed = amend && Boolean(read.head?.pushed);
    /** @type {GitOp} */
    const op = {
      kind: 'commit',
      repo,
      message: read.wrapsBody === false ? message : wrapBody(message),
      ...(amend ? { amend: true } : {}),
      ...(noVerify ? { noVerify: true } : {}),
    };
    committing = true;
    commitBox.setRunning(true);
    void runOp(op, {
      // A failed commit is said in the commit box, under the message it was
      // for (pins/git/toast's rule 2): what the hooks printed, then git's
      // reason — once, when the hooks have not already said it.
      onError: (e) => {
        commitBox.setOutput(commitFailure(e?.job?.output || '', errorText(e)));
        return true;
      },
    }).then((job) => {
      committing = false;
      commitBox.setRunning(false);
      if (!job) return;
      commitBox.committed();
      commitBox.setOutput('');
      if (commitPopover) closePopover();
      drafts.delete(draftKey());
      const sha = job.result?.head || '';
      const text = t('Committed {sha} to {branch}', { sha: sha.slice(0, 7), branch });
      host.toast.show(text, sha && !amendedPushed ? () => {
        void runOp({ kind: 'undo-commit', repo, expectHead: sha }).then((undone) => {
          if (undone && !commitBox.request().message) commitBox.setMessage(message);
        });
      } : undefined);
    });
  };

  // --- drawing -------------------------------------------------------------

  /**
   * @param {ChangedFile} file - The file.
   * @param {GroupId} group - Its group.
   * @returns {HTMLElement} Its row.
   */
  const buildRow = (file, group) => {
    const key = `${group}:${file.path}`;
    const row = createElement('div', 'git-changes__row');
    row.dataset.key = key;
    row.setAttribute('role', 'option');
    if (file.pending) row.dataset.pending = 'true';
    const letter = letterOf(file, group);
    // The status letter and the name are the app's change-status pair, as the
    // review rail draws them, so a file reads the same in Changes and Review.
    const st = /** @type {HTMLButtonElement} */ (createElement('button', 'git-changes__st change-status'));
    st.type = 'button';
    const tone = toneOf(letter);
    st.dataset.tone = tone;
    const words = letterWords(letter);
    const toggles = isToggleable(file, group);
    st.title = group === 'conflicts' ? words
      : !toggles ? t('Changed inside the submodule: commit it there')
        : group === 'staged' ? t('{status}: unstage (space)', { status: words }) : t('{status}: stage (space)', { status: words });
    st.disabled = group !== 'conflicts' && !toggles;
    st.setAttribute('aria-label', st.title);
    st.append(createElement('span', file.pending ? 'git-pin__spin' : '', file.pending ? '◌' : letter));
    const pathEl = createElement('span', 'git-changes__path');
    const { name, dir } = splitPath(file.path);
    const shownName = file.oldPath ? t('{from} → {to}', { from: file.oldPath, to: name }) : name;
    const nameEl = createElement('span', 'git-changes__name change-status-name text-truncate', shownName);
    nameEl.dataset.tone = tone;
    pathEl.append(nameEl);
    if (dir && !file.oldPath) pathEl.append(createElement('span', 'git-changes__dir text-truncate', dir));
    row.append(st, pathEl);
    /** @type {string[]} */
    const badges = [];
    if (file.binary) badges.push(t('binary'));
    if (file.lfs) badges.push(t('LFS'));
    if (file.submodule) badges.push(t('submodule'));
    // What changed in it, in git status's words: only new commits can be staged.
    /** @type {string[]} */
    const inside = [];
    if (file.submodule && group === 'changes') {
      if (file.submoduleCommit) inside.push(t('new commits'));
      if (file.submoduleModified) inside.push(t('modified content'));
      if (file.submoduleUntracked) inside.push(t('untracked content'));
    }
    for (const badge of badges) row.append(createElement('span', 'git-changes__badge', badge));
    // What changed inside a submodule, in git status's words, takes the
    // directory's place: it gives way before the name does.
    if (inside.length) {
      const words = formatList(inside);
      pathEl.append(createElement('span', 'git-changes__inside text-truncate', words));
      row.title = words;
    }
    if (isPartlyStaged(file)) {
      const part = createElement('span', 'git-changes__part', '◐');
      part.title = t('Partly staged');
      row.append(part);
    }
    if (group === 'conflicts') {
      const titles = sideTitles(read?.stopped, read?.head?.sha || '');
      const sides = createElement('span', 'git-changes__sides');
      for (const [side, label] of /** @type {const} */ ([['ours', t('Ours')], ['theirs', t('Theirs')]])) {
        const b = /** @type {HTMLButtonElement} */ (createElement('button', 'git-changes__side btn btn-xs btn-neutral', label));
        b.type = 'button';
        b.dataset.side = side;
        b.title = titles[side];
        sides.append(b);
      }
      row.append(sides);
    } else {
      const stat = statOf(file, group);
      const nums = createElement('span', 'git-changes__nums');
      if (stat?.added) nums.append(createElement('span', 'git-changes__add', `+${stat.added}`));
      if (stat?.removed) nums.append(createElement('span', 'git-changes__del', `−${stat.removed}`));
      row.append(nums);
    }
    const more = /** @type {HTMLButtonElement} */ (createElement('button', 'git-changes__more btn btn-icon btn-xs', '⋯'));
    more.type = 'button';
    more.title = t('More');
    row.append(more);
    return row;
  };

  const renderList = () => {
    const groups = groupsOf(files());
    /** @type {{id: GroupId, total: number, shown: ChangedFile[], toggles: boolean}[]} */
    const sections = [];
    const seen = new Set();
    let shownCount = 0;
    for (const group of groups) {
      for (const file of group.files) seen.add(`${group.id}:${file.path}`);
      const shown = group.files.filter((file) => filter.matches(file.path, file.oldPath));
      if (!shown.length) continue;
      sections.push({ id: group.id, total: group.files.length, shown, toggles: group.files.some((file) => isToggleable(file, group.id)) });
      shownCount += shown.length;
    }
    for (const key of [...rowCache.keys()]) if (!seen.has(key)) rowCache.delete(key);
    /**
     * @param {GroupId} id - The group.
     * @param {number} total - Its files, shown or not.
     * @param {boolean} toggles - Whether any of them can be staged or unstaged.
     * @returns {HTMLElement} Its section header.
     */
    const buildSect = (id, total, toggles) => {
      const sect = createElement('div', 'git-changes__sect');
      sect.dataset.group = id;
      sect.append(createElement('span', 'git-changes__title caps-label', t(GROUP_TITLES[id])),
        createElement('span', 'git-changes__count', String(total)));
      if (id !== 'conflicts') {
        const act = /** @type {HTMLButtonElement} */ (createElement('button', 'git-changes__group-act',
          id === 'staged' ? t('Unstage all') : t('Stage all')));
        act.type = 'button';
        act.dataset.group = id;
        act.disabled = !toggles;
        sect.append(act);
      }
      return sect;
    };
    /**
     * @param {ChangedFile} file - The file.
     * @param {GroupId} id - Its group.
     * @returns {{key: string, sig: string}} Its row's key, and what its element is built from.
     */
    const rowSig = (file, id) => ({
      key: `${id}:${file.path}`,
      // A conflict's row names the operation's sides, which can change under it.
      sig: id === 'conflicts'
        ? `${signatureOf(file)}\u0000${JSON.stringify(sideTitles(read?.stopped, read?.head?.sha || ''))}` : signatureOf(file),
    });
    /**
     * @param {ChangedFile} file - The file.
     * @param {GroupId} id - Its group.
     * @param {string} key - Its row's key.
     * @param {string} sig - What its element is built from.
     * @returns {HTMLElement} Its row, built once per signature.
     */
    const rowFor = (file, id, key, sig) => {
      let cached = rowCache.get(key);
      if (!cached || cached.sig !== sig) {
        cached = { sig, row: buildRow(file, id) };
        rowCache.set(key, cached);
      }
      return cached.row;
    };
    /** @type {string[]} */
    const keys = [];
    /** @type {HTMLElement[]} */
    const children = [];
    if (shownCount > WINDOWED_ABOVE) {
      /** @type {import('juggler/utils/virtual-list').SectionItem[]} */
      const items = [];
      itemIndex = new Map();
      for (const { id, total, shown, toggles } of sections) {
        items.push({ key: `sect:${id}:${total}:${toggles}`, header: true, build: () => buildSect(id, total, toggles) });
        for (const file of shown) {
          const { key, sig } = rowSig(file, id);
          itemIndex.set(key, items.length);
          items.push({ key: `${key}\u0000${sig}`, header: false, row: key, build: () => rowFor(file, id, key, sig) });
          keys.push(key);
        }
      }
      order = keys;
      windowed.setItems(items);
      children.push(windowed.spacer);
    } else {
      itemIndex = new Map();
      windowed.clear();
      for (const { id, total, shown, toggles } of sections) {
        children.push(buildSect(id, total, toggles));
        for (const file of shown) {
          const { key, sig } = rowSig(file, id);
          const row = rowFor(file, id, key, sig);
          row.setAttribute('aria-selected', String(key === selected));
          keys.push(key);
          children.push(row);
        }
      }
      order = keys;
    }
    if (!keys.length && read && filter.active() && files().length) {
      children.push(createElement('div', 'git-changes__empty', t('Nothing matches')));
    } else if (!keys.length && read) {
      const empty = createElement('div', 'git-changes__empty');
      empty.append(createElement('div', 'git-changes__empty-title', t('Working tree clean')),
        createElement('div', 'git-changes__empty-sub', read.detached
          ? t('Detached HEAD · nothing to commit')
          : t('{branch} · nothing to commit', { branch: read.branch })));
      children.push(empty);
    } else if (!read) {
      children.push(readError
        ? inlineError('git-changes__error', t("Couldn't read the changes. {error}", { error: readError }), () => requestRead())
        : createElement('div', 'git-changes__empty', t('Checking…')));
    }
    if (read?.truncated) children.push(createElement('div', 'git-changes__more-files', t('More files changed than are listed here.')));
    if (readError && read) children.push(inlineError('git-changes__error', t("Couldn't refresh. {error}", { error: readError }), () => requestRead()));
    if (itemIndex.size && scroll.firstChild === windowed.spacer) {
      // The spacer stays put, so nothing drawn in it loses focus or hover.
      while (windowed.spacer.nextSibling) windowed.spacer.nextSibling.remove();
      scroll.append(...children.slice(1));
    } else {
      scroll.replaceChildren(...children);
    }
    if (itemIndex.size) windowed.render();
  };

  const renderHead = () => {
    host.stateChanged({
      repo,
      repoName: repoLabel(host.root(), repo),
      read,
      changed: files().length,
      staged: stagedCount(),
      conflicts: conflictCount(),
      committing,
    });
  };

  /** The file whose diff the detail shows, and how. */
  /** @type {AbortController|null} */
  let diffAbort = null;
  /** @type {AbortController|null} The blame being read, aborted when the diff or blame is asked again. */
  let blameAbort = null;
  let diffGeneration = 0;
  /** @type {any} */
  let patch = null;
  /** @type {string|null} */
  let shownKey = null;

  /**
   * @param {GroupId} group - The row's group.
   * @returns {{scope: string, verb: 'stage'|'unstage'}} Which diff it is and what its lines do: a
   *   conflict's is the working file against HEAD, which shows its markers.
   */
  const sideOf = (group) => (group === 'staged' ? { scope: '@staged', verb: 'unstage' }
    : group === 'conflicts' ? { scope: '@uncommitted', verb: 'stage' } : { scope: '@unstaged', verb: 'stage' });

  /**
   * Read an untracked file whole into the file host, dropping the answer if
   * the selection has moved on by then.
   * @param {string} absolute - Its absolute path.
   */
  const loadFile = (absolute) => {
    diffAbort?.abort();
    blameAbort?.abort();
    const mine = ++diffGeneration;
    const controller = new AbortController();
    diffAbort = controller;
    fileHost.replaceChildren();
    void fetchLiveFile(absolute, { signal: controller.signal, whole: true, userInitiated: true }).then((result) => {
      if (!live || mine !== diffGeneration || controller.signal.aborted) return;
      renderLiveFileBody(fileHost, result, { absolutePath: absolute, userInitiated: true });
    });
  };

  const loadDiff = () => {
    const hit = lookup(selected);
    diffAbort?.abort();
    blameAbort?.abort();
    if (!hit) return;
    if (hit.group === 'untracked') return;
    const mine = ++diffGeneration;
    const controller = new AbortController();
    diffAbort = controller;
    const { scope } = sideOf(hit.group);
    git().diff(repo, hit.file.path, { scope, contextLines: viewer.contextLines, signal: controller.signal, ...ws() })
      .then((next) => {
        if (!live || mine !== diffGeneration) return;
        patch = next;
        viewer.setPatch(next);
        if (viewer.blameOn) loadBlame();
      })
      .catch((/** @type {any} */ e) => {
        if (!live || mine !== diffGeneration || controller.signal.aborted) return;
        viewer.setError(errorText(e));
      });
  };

  /**
   * Read the selected file's blame for the gutter: the working tree's, or the
   * index's for a staged file. One for a file left since is dropped.
   */
  const loadBlame = () => {
    const hit = lookup(selected);
    if (!hit) return;
    const key = selected;
    const asked = diffGeneration;
    blameAbort?.abort();
    blameAbort = new AbortController();
    git().read('blame', { repo, ...ws(), blame: { path: hit.file.path, rev: hit.group === 'staged' ? '@staged' : '' }, signal: blameAbort.signal })
      .then((blame) => {
        if (live && key === selected && asked === diffGeneration) viewer.setBlame(/** @type {any} */ (blame));
      }, () => {
        if (live && key === selected && asked === diffGeneration) viewer.setBlame(null);
      });
  };

  /**
   * @param {string} text - The note, '' for none.
   * @param {boolean} [failed] - It says a write was refused, in the look every
   *   place says a failure inline with, rather than why the file is as it is.
   */
  const setNote = (text, failed = false) => {
    note.textContent = text;
    note.hidden = !text;
    note.classList.toggle('git-inline-error', Boolean(text) && failed);
  };

  const discardLinesButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-changes__crumb-discard-lines btn btn-xs btn-danger-quiet'));
  discardLinesButton.type = 'button';

  const drawDiscardLines = () => {
    const count = viewer.getStageSelection().length;
    // Offered once there are lines to discard: before that it would be a
    // disabled button in a bar that is already full.
    discardLinesButton.hidden = count === 0;
    discardLinesButton.disabled = count === 0;
    discardLinesButton.textContent = count
      ? t('Discard {count, plural, one {# line} other {# lines}}', { count })
      : t('Discard lines');
    discardLinesButton.title = t('Pick changed lines in the diff, then discard just those (undoable)');
  };

  const renderDetail = () => {
    const hit = lookup(selected);
    const sig = hit ? `${selected}\u0000${signatureOf({ ...hit.file, pending: false })}` : '';
    if (!hit) {
      shownKey = null;
      shownSig = '';
      patch = null;
      diffAbort?.abort();
      const back = /** @type {HTMLButtonElement} */ (createElement('button', 'git-changes__back btn btn-icon btn-xs', '‹'));
      back.type = 'button';
      crumb.replaceChildren(back);
      placeholder.hidden = false;
      placeholder.textContent = t('Select a file to see its diff. Click lines to pick them, then stage just those.');
      viewerHost.hidden = true;
      fileHost.hidden = true;
      fileHost.replaceChildren();
      setNote('');
      return;
    }
    placeholder.hidden = true;
    const keyChanged = shownKey !== selected;
    if (!keyChanged && sig === shownSig) return;
    if (keyChanged) setNote('');
    shownKey = selected;
    shownSig = sig;
    const { group, file } = hit;
    const back = /** @type {HTMLButtonElement} */ (createElement('button', 'git-changes__back btn btn-icon btn-xs', '‹'));
    back.type = 'button';
    back.title = t('Back (esc)');
    const { name, dir } = splitPath(file.path);
    const title = createElement('span', 'git-changes__crumb-title text-truncate');
    title.append(createElement('span', 'git-changes__name', name), createElement('span', 'git-changes__dir', dir));
    const stat = statOf(file, group);
    const nums = createElement('span', 'git-changes__nums git-changes__crumb-nums');
    if (stat?.added) nums.append(createElement('span', 'git-changes__add', `+${stat.added}`));
    if (stat?.removed) nums.append(createElement('span', 'git-changes__del', `−${stat.removed}`));
    const acts = createElement('span', 'git-changes__crumb-acts');
    if (isToggleable(file, group)) {
      const stage = /** @type {HTMLButtonElement} */ (createElement('button', 'git-changes__crumb-stage btn btn-xs btn-neutral',
        group === 'staged' ? t('Unstage') : t('Stage')));
      stage.type = 'button';
      acts.append(stage);
    }
    if (group === 'conflicts') {
      const titles = sideTitles(read?.stopped, read?.head?.sha || '');
      for (const [cls, label, title] of /** @type {[string, string, string][]} */ ([
        ['ours', t('Take ours'), titles.ours],
        ['theirs', t('Take theirs'), titles.theirs],
        ['resolved', t('Mark resolved'), t('Stage the file as it is now')],
      ])) {
        const b = /** @type {HTMLButtonElement} */ (createElement('button',
          `git-changes__crumb-${cls} btn btn-xs ${cls === 'resolved' ? 'btn-primary' : 'btn-neutral'}`, label));
        b.type = 'button';
        b.title = title;
        acts.append(b);
      }
    }
    if (file.submodule && file.submoduleCommit && group === 'changes') {
      const update = /** @type {HTMLButtonElement} */ (createElement('button', 'git-changes__crumb-update btn btn-xs btn-neutral', t('Update')));
      update.type = 'button';
      update.title = t('Check the submodule out at the commit recorded for it');
      acts.append(update);
    }
    if (group === 'changes') acts.append(discardLinesButton);
    if ((group === 'changes' && isToggleable(file, group)) || group === 'untracked') {
      const discardButton = /** @type {HTMLButtonElement} */ (createElement('button', 'git-changes__crumb-discard btn btn-xs btn-danger-quiet', t('Discard')));
      discardButton.type = 'button';
      discardButton.title = t('Discard the changes to this file (undoable)');
      acts.append(discardButton);
    }
    const absolute = [host.root().replace(/[/\\]+$/, ''), repo, file.path].filter(Boolean).join('/');
    const onDisk = file.index !== 'D' && file.worktree !== 'D';
    const fileActions = onDisk ? createFileActions(absolute, { pin: absolute }) : null;
    if (fileActions) acts.append(fileActions);
    crumb.replaceChildren(back, title, nums, ...(group === 'untracked' ? [] : [viewOptions]), acts);
    drawDiscardLines();

    if (group === 'untracked') {
      setNote('');
      viewerHost.hidden = true;
      fileHost.hidden = false;
      loadFile(absolute);
      return;
    }
    fileHost.hidden = true;
    fileHost.replaceChildren();

    /** @type {string} */
    let why = '';
    if (file.submodule && !isToggleable(file, group)) why = t('Changed inside the submodule: commit there, then stage its new commit here.');
    else if (file.submodule) why = t('A submodule: its change is the commit it points at, so there are no lines to stage.');
    else if (file.lfs) why = t('Stored in Git LFS: the diff is of its pointer, so stage it whole.');
    else if (file.binary) why = t('A binary file: stage it whole.');
    // A conflict's diff is there to be read, markers and all: it is resolved
    // whole, from the crumb.
    viewer.setStageable(why || group === 'conflicts' ? null : sideOf(group).verb);
    // Blame is of the file as this diff's new side has it: there is none for
    // one that side deleted (an untracked file, which nothing has committed,
    // never reaches the diff).
    const gone = group === 'staged' ? file.index === 'D' : file.worktree === 'D';
    viewer.setBlameable(!file.submodule && !file.binary && !gone);
    if (why) setNote(why);
    else if (keyChanged) setNote('');
    viewerHost.hidden = false;
    loadDiff();
  };

  const render = () => {
    if (!live) return;
    renderHead();
    renderList();
    renderDetail();
    commitBox.setState({
      branch: read?.branch || '',
      detached: Boolean(read?.detached),
      staged: stagedCount(),
      headMessage: read?.head?.message || '',
      operation: read?.operation || '',
    });
    syncLevel();
  };

  // --- selection and keys --------------------------------------------------

  /**
   * @param {string|null} key - The row to select.
   * @param {boolean} [open] - Whether to push the detail too.
   */
  const select = (key, open = false) => {
    selected = key;
    for (const [k, cached] of rowCache) cached.row.setAttribute('aria-selected', String(k === key));
    const at = key ? itemIndex.get(key) : undefined;
    if (at !== undefined) windowed.scrollIntoView(at);
    else if (key) rowCache.get(key)?.row.scrollIntoView?.({ block: 'nearest' });
    renderDetail();
    if (open) setLevel('detail');
  };

  /**
   * @param {number} by - Rows to move, down positive.
   */
  const move = (by) => {
    if (!order.length) return;
    const at = selected ? order.indexOf(selected) : -1;
    const next = at < 0 ? 0 : Math.max(0, Math.min(order.length - 1, at + by));
    select(order[next] ?? null);
  };

  /**
   * @param {string} key - The row.
   * @returns {any[]|null} Its menu's rows, null when it is not listed.
   */
  const rowMenu = (key) => {
    const hit = lookup(key);
    if (!hit) return null;
    const { group, file } = hit;
    const absolute = [host.root().replace(/[/\\]+$/, ''), repo, file.path].filter(Boolean).join('/');
    const { name, dir } = splitPath(file.path);
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1) : '';
    /** @type {any[]} */
    const items = [];
    const row = rowCache.get(key)?.row || null;
    if (group === 'conflicts') {
      items.push({ label: t('Take ours'), onClick: () => resolveConflict(key, 'ours', row) });
      items.push({ label: t('Take theirs'), onClick: () => resolveConflict(key, 'theirs', row) });
      items.push({ label: t('Mark resolved'), onClick: () => resolveConflict(key, 'resolved', row) });
      items.push({ separator: true });
      items.push({ label: t('Open in editor'), onClick: () => { void openPath({ path: absolute }).catch((/** @type {any} */ e) => host.toast.error(errorText(e))); } });
    } else if (isToggleable(file, group)) {
      items.push({ label: group === 'staged' ? t('Unstage') : t('Stage'), onClick: () => toggle(key) });
    }
    if (file.submodule && file.submoduleCommit && group === 'changes') {
      items.push({ label: t('Update submodule'), onClick: () => updateSub(file.path) });
    }
    if ((group === 'changes' && isToggleable(file, group)) || group === 'untracked') {
      items.push({ label: t('Discard changes (undoable)'), danger: true, onClick: () => discard(key) });
    }
    if (group === 'untracked') {
      items.push({ separator: true });
      items.push({ label: t('Ignore this file'), onClick: () => ignore(file.path, 'file') });
      if (ext) items.push({ label: t('Ignore all *.{ext}', { ext }), onClick: () => ignore(file.path, 'extension') });
      if (dir) items.push({ label: t('Ignore {folder}/', { folder: dir }), onClick: () => ignore(file.path, 'folder') });
    }
    if (group !== 'conflicts' && items.length) items.push({ separator: true });
    // A conflict's menu is its ways out; an untracked file has no history yet.
    if (group !== 'untracked' && group !== 'conflicts') items.push({ label: t('File history'), onClick: () => host.showFileHistory(file.path) });
    const gone = file.worktree === 'D' || file.index === 'D';
    // A conflict's menu already opens it, in the editor, above.
    if (group !== 'conflicts') {
      items.push({ label: t('Open'), disabled: gone, onClick: () => { void openPath({ path: absolute }).catch((/** @type {any} */ e) => host.toast.error(errorText(e))); } });
    }
    items.push({ label: t('Add to pinboard'), disabled: gone, onClick: () => { void pinFile(absolute); } });
    items.push({ label: t('Copy path'), onClick: () => { void copyToClipboard(file.path).catch((/** @type {any} */ e) => host.toast.error(errorText(e))); } });
    return items;
  };

  /**
   * @param {string} key - The row.
   * @param {number} x - Where to open the menu.
   * @param {number} y - Where to open the menu.
   * @param {Element} anchor - What it was opened on.
   */
  const openRowMenu = (key, x, y, anchor) => {
    const items = rowMenu(key);
    if (items) openMenuAt(items, x, y, anchor);
  };

  scroll.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    const act = target.closest('.git-changes__group-act');
    if (act instanceof HTMLElement) {
      groupAction(/** @type {GroupId} */ (act.dataset.group));
      return;
    }
    const row = target.closest('.git-changes__row');
    if (!(row instanceof HTMLElement)) return;
    const key = row.dataset.key || '';
    const side = target.closest('.git-changes__side');
    if (side instanceof HTMLElement) {
      resolveConflict(key, side.dataset.side === 'theirs' ? 'theirs' : 'ours', side);
    } else if (target.closest('.git-changes__more')) {
      const rect = /** @type {Element} */ (target.closest('.git-changes__more')).getBoundingClientRect();
      openRowMenu(key, rect.left, rect.bottom, row);
    } else if (target.closest('.git-changes__st') && !key.startsWith('conflicts:')) {
      toggle(key);
    } else {
      select(key, true);
    }
  });
  // A double-click stages or unstages the row, as its letter does; its first
  // click has already selected it. A conflict is resolved, not staged, and the
  // row's own buttons keep their single meaning.
  scroll.addEventListener('dblclick', (event) => {
    const target = /** @type {Element} */ (event.target);
    const row = target.closest('.git-changes__row');
    if (!(row instanceof HTMLElement) || target.closest('button')) return;
    const key = row.dataset.key || '';
    if (key.startsWith('conflicts:')) return;
    window.getSelection?.()?.removeAllRanges();
    toggle(key);
  });
  const dropMenu = contextMenuFor(scroll, (target) => {
    const row = target.closest('.git-changes__row');
    if (!(row instanceof HTMLElement)) return null;
    select(row.dataset.key || null);
    return rowMenu(row.dataset.key || '');
  });

  crumb.addEventListener('click', (event) => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest('.git-changes__back')) setLevel('list');
    else if (target.closest('.git-changes__crumb-stage') && selected) toggle(selected);
    else if (target.closest('.git-changes__crumb-discard') && selected) discard(selected);
    else if (target.closest('.git-changes__crumb-discard-lines')) discardLines();
    else if (target.closest('.git-changes__crumb-update') && selected) {
      const hit = lookup(selected);
      if (hit) updateSub(hit.file.path);
    }
    else if (selected) {
      for (const mode of /** @type {const} */ (['ours', 'theirs', 'resolved'])) {
        const b = target.closest(`.git-changes__crumb-${mode}`);
        if (b) resolveConflict(selected, mode, b);
      }
    }
  });

  const discardLines = () => {
    const hit = lookup(selected);
    const lines = viewer.getStageSelection();
    if (!hit || !lines.length || !patch) return;
    void runOp({
      kind: 'discard-lines', repo, path: hit.file.path, lines,
      revision: patch.revision, context: patch.context,
    }, { onError: (e) => staleRefusal(e) }).then((job) => {
      if (!job) return;
      viewer.clearStageSelection();
      drawDiscardLines();
      offerDiscardUndo(t('Discarded {count, plural, one {# line} other {# lines}} of {name}',
        { count: lines.length, name: splitPath(hit.file.path).name }), job);
      loadDiff();
    });
  };

  /**
   * A lines write refused because the diff moved: read it again and say so.
   * @param {any} e - The rejection.
   * @returns {boolean} True when it was that refusal and is handled.
   */
  const staleRefusal = (e) => {
    if (e?.kind !== 'stale') return false;
    loadDiff();
    setNote(t('The file changed since this diff was read, so nothing was done. Here it is again: pick the lines again.'), true);
    return true;
  };

  detail.addEventListener('diff-stage-request', (event) => {
    const hit = lookup(selected);
    const detailOf = /** @type {any} */ (event).detail || {};
    if (!hit) return;
    const verb = detailOf.verb;
    const kind = verb === 'unstage' ? 'unstage-lines' : verb === 'discard' ? 'discard-lines' : 'stage-lines';
    void runOp({
      kind, repo, path: hit.file.path, lines: detailOf.lines,
      revision: detailOf.revision, context: detailOf.context,
    }, { onError: (e) => staleRefusal(e) }).then((job) => {
      if (!job) return;
      viewer.clearStageSelection();
      drawDiscardLines();
      setNote('');
      loadDiff();
    });
  });
  detail.addEventListener('diff-context-change', () => loadDiff());
  detail.addEventListener('diff-blame-toggle', (event) => {
    if (/** @type {CustomEvent} */ (event).detail?.on) loadBlame();
  });
  detail.addEventListener('diff-blame-select', (event) => {
    const sha = /** @type {CustomEvent} */ (event).detail?.sha;
    if (sha) host.showHistory({ sha });
  });
  // Picking lines repaints the viewer in place without telling anyone, so the
  // crumb's count is redrawn after any click or key that could have picked one.
  viewerHost.addEventListener('click', () => drawDiscardLines());
  viewerHost.addEventListener('keyup', () => drawDiscardLines());

  head.handlers.repo = (next) => switchRepo(next);

  /**
   * Check a submodule of the repository out at the commit recorded for it.
   * @param {string} path - The submodule.
   */
  const updateSub = (path) => { void updateSubmodule((op) => runOp(/** @type {GitOp} */ (op)), host.toast, repo, path); };

  /** Fill the head's repository picker from the tree's repositories. */
  const drawRepos = () => {
    head.setRepos(repos.map((r) => ({ value: r.path, label: repoLabel(host.root(), r.path) })), repo);
  };

  /**
   * Show another repository of the tree.
   * @param {string} next - Its path.
   */
  const switchRepo = (next) => {
    if (next === repo) return;
    repo = next;
    read = null;
    overlays = [];
    selected = null;
    rowCache.clear();
    setLevel('list');
    commitBox.setMessage(drafts.get(draftKey()) || '');
    render();
    requestRead({ fresh: true });
    host.repoChanged(repo);
  };

  // --- the watch -----------------------------------------------------------

  /**
   * Subscribe to the tree `ws()` names.
   * @returns {(() => void)|undefined} Unsubscribe.
   */
  const watchTree = () => git().watch((event) => {
    if (!live) return;
    if (event.type === 'git-change') {
      if (event.repos.some((r) => (r.path || '') === repo)) requestRead();
    } else if (event.type === 'git-resync') {
      requestRead({ fresh: true });
      void loadJobs();
    } else if (event.type === 'git-job') {
      host.log.upsert(event.job);
      host.jobChanged(event.job);
      if (committing && event.job.kind === 'commit' && event.job.state === 'running') commitBox.setOutput(event.job.output || '');
    }
  }, ws());
  let unwatch = watchTree();

  /**
   * The pin now names another tree: watch that one and read it from scratch,
   * starting at the repository named, until `setRepos` says what it holds.
   * @param {string} [at] - The repository, by its path in the tree: '' for its root.
   */
  const setTree = (at = '') => {
    if (!live) return;
    unwatch?.();
    unwatch = watchTree();
    diffAbort?.abort();
    repo = at;
    read = null;
    readError = '';
    overlays = [];
    selected = null;
    shownSig = '';
    rowCache.clear();
    setLevel('list');
    commitBox.setMessage(drafts.get(draftKey()) || '');
    render();
    requestRead({ fresh: true });
    void loadJobs();
  };

  const loadJobs = async () => {
    try {
      const jobs = await git().jobs(ws());
      if (live && Array.isArray(jobs)) {
        host.log.setJobs(jobs);
        host.jobsLoaded(jobs);
      }
    } catch (_) { /* the log starts empty; live jobs still arrive */ }
  };

  commitBox.setMessage(drafts.get(draftKey()) || '');
  render();
  requestRead();
  void loadJobs();

  return {
    element,
    refresh: () => requestRead(),
    setTree,
    handleKey: (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      switch (event.key) {
        case 'j': case 'ArrowDown': move(1); return true;
        case 'k': case 'ArrowUp': move(-1); return true;
        case '/': filter.open(); return true;
        case ' ':
          if (selected) toggle(selected);
          return true;
        case 'Enter':
          if (!selected) return false;
          if (measureMode() === 'stack') setLevel('detail');
          else viewer.focus();
          return true;
        case 'Escape':
          if (level === 'detail') {
            setLevel('list');
            return true;
          }
          return filter.close();
        case 'c':
          if (measureMode() === 'chip') {
            if (!commitPopover) openCommitPopover(head.primaryButton);
            return true;
          }
          host.showChanges();
          setLevel('list');
          commitBox.focus();
          return true;
        case 'g':
          if (!commitBox.canGenerate()) return true;
          if (measureMode() === 'chip') {
            if (!commitPopover) openCommitPopover(head.primaryButton);
          } else {
            host.showChanges();
            setLevel('list');
          }
          generateControl.open(commitBox.generateButton);
          return true;
        default:
          return false;
      }
    },
    focusMessage: () => commitBox.focus(),
    commit: (anchor) => commit(anchor || null),
    showFirstConflict: () => {
      const file = groupsOf(files()).find((g) => g.id === 'conflicts')?.files[0];
      if (!file) return;
      const key = `conflicts:${file.path}`;
      if (!order.includes(key)) filter.close();
      select(key, true);
    },
    focus: () => scroll.focus(),
    repo: () => repo,
    dirtyCount: () => (read ? files().length : null),
    showRepo: (next) => {
      // One the tree, as last read, does not hold is not switched to.
      if (repos.length && !repos.some((r) => r.path === next)) return;
      switchRepo(next);
      drawRepos();
    },
    setRepos: (next) => {
      repos = next;
      drawRepos();
      if (repos.length && !repos.some((r) => r.path === repo)) switchRepo(repos[0]?.path ?? '');
    },
    teardown: () => {
      live = false;
      diffAbort?.abort();
      blameAbort?.abort();
      inFlight?.abort.abort();
      unwatch?.();
      dropMenu();
      windowed.destroy();
      generateControl.teardown();
      host.toast.hide();
    },
  };
}
