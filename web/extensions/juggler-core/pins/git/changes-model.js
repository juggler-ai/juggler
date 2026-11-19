//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Changes place's model, DOM-free: how a `changes()` answer falls into the
 * groups the list draws, and what a write does to it before git has answered.
 * The second is the optimistic half of the list — a guess at the next read,
 * drawn at once and dropped as soon as a read that knows better arrives.
 * @module pins/git/changes-model
 */

/**
 * @typedef {import('juggler/pinboard-item-type').PinGitChangedFile & {pending?: boolean}} ChangedFile
 * @typedef {'conflicts'|'staged'|'changes'|'untracked'} GroupId
 * @typedef {{id: GroupId, files: ChangedFile[]}} Group
 */

/** The groups, in the order the list draws them. */
const GROUP_ORDER = /** @type {const} */ (['conflicts', 'staged', 'changes', 'untracked']);

/**
 * @param {ChangedFile} file - A file.
 * @returns {boolean} Whether it is an unresolved merge.
 */
function isConflicted(file) {
  return Boolean(file.conflicted) || file.index === 'U' || file.worktree === 'U';
}

/**
 * @param {string} letter - One side's porcelain letter.
 * @returns {boolean} Whether that side holds a tracked change.
 */
const changedSide = (letter) => letter !== '.' && letter !== '?' && letter !== '';

/**
 * Whether a file's unstaged side is something staging can take. A submodule
 * modified without a new commit holds edits or untracked files of its own:
 * `git add` records only the commit it has checked out, which the index
 * already has, so only a commit inside the submodule takes them. It is listed,
 * as `git status` lists it, but there is nothing here to stage.
 * @param {ChangedFile} file - The file.
 * @returns {boolean} Whether its unstaged side can be staged.
 */
function worktreeStageable(file) {
  return !(file.submodule && file.worktree === 'M' && !file.submoduleCommit);
}

/**
 * Whether a file's row in a group can be staged or unstaged — what its letter,
 * a double-click, space and its menu do. A conflict is resolved instead.
 * @param {ChangedFile} file - The file.
 * @param {GroupId} group - Its group.
 * @returns {boolean} Whether the row toggles.
 */
export function isToggleable(file, group) {
  if (group === 'conflicts') return false;
  return group !== 'changes' || worktreeStageable(file);
}

/**
 * Which groups a file is drawn in. A file staged and changed again is in both
 * Staged and Changes: those are two different diffs, staged and unstaged apart.
 * @param {ChangedFile} file - The file.
 * @returns {GroupId[]} Its groups.
 */
function groupsOfFile(file) {
  if (isConflicted(file)) return ['conflicts'];
  /** @type {GroupId[]} */
  const out = [];
  if (changedSide(file.index)) out.push('staged');
  if (changedSide(file.worktree)) out.push('changes');
  if (file.worktree === '?') out.push('untracked');
  return out;
}

/**
 * Every group, in order, with the files in it; empty groups included.
 * @param {ChangedFile[]} files - The files.
 * @returns {Group[]} The groups.
 */
export function groupsOf(files) {
  /** @type {Record<GroupId, ChangedFile[]>} */
  const by = { conflicts: [], staged: [], changes: [], untracked: [] };
  for (const file of files) for (const group of groupsOfFile(file)) by[group].push(file);
  return GROUP_ORDER.map((id) => ({ id, files: by[id] }));
}

/**
 * Whether a file is partly staged: drawn in both Staged and Changes.
 * @param {ChangedFile} file - The file.
 * @returns {boolean} True when it has both sides.
 */
export function isPartlyStaged(file) {
  return !isConflicted(file) && changedSide(file.index) && changedSide(file.worktree) && worktreeStageable(file);
}

/**
 * The letter a row shows for a file in a group.
 * @param {ChangedFile} file - The file.
 * @param {GroupId} group - Its group.
 * @returns {string} The letter.
 */
export function letterOf(file, group) {
  if (group === 'conflicts') return '!';
  if (group === 'untracked') return '?';
  return group === 'staged' ? file.index : file.worktree;
}

/** Each letter's tone, which the row's colour is drawn from. */
const TONES = /** @type {Record<string, string>} */ ({
  M: 'modified', T: 'modified', A: 'added', D: 'removed', R: 'renamed', C: 'renamed', '?': 'untracked', '!': 'conflicted',
});

/**
 * @param {string} letter - A row's letter.
 * @returns {string} Its tone.
 */
export function toneOf(letter) {
  return TONES[letter] || 'modified';
}

/**
 * The line counts a row shows for the side its group is about.
 * @param {ChangedFile} file - The file.
 * @param {GroupId} group - Its group.
 * @returns {{added: number, removed: number}|undefined} The counts, if any.
 */
export function statOf(file, group) {
  return group === 'staged' ? file.staged : file.unstaged;
}

/**
 * Two sides' counts as one, for a change that moves wholly to one side.
 * @param {{added: number, removed: number}|undefined} a - One side.
 * @param {{added: number, removed: number}|undefined} b - The other.
 * @returns {{added: number, removed: number}|undefined} Their sum.
 */
function sum(a, b) {
  if (!a && !b) return undefined;
  return { added: (a?.added || 0) + (b?.added || 0), removed: (a?.removed || 0) + (b?.removed || 0) };
}

/**
 * @param {ChangedFile} file - The file.
 * @returns {ChangedFile} It with its unstaged side staged.
 */
function staged(file) {
  if (isConflicted(file)) return file;
  if (file.worktree === '?') {
    return { ...file, index: 'A', worktree: '.', staged: sum(file.staged, file.unstaged), unstaged: undefined, pending: true };
  }
  if (!changedSide(file.worktree) || !worktreeStageable(file)) return file;
  const index = changedSide(file.index) ? file.index : file.worktree;
  return { ...file, index, worktree: '.', staged: sum(file.staged, file.unstaged), unstaged: undefined, pending: true };
}

/**
 * @param {ChangedFile} file - The file.
 * @returns {ChangedFile} It with its staged side unstaged.
 */
function unstaged(file) {
  if (isConflicted(file) || !changedSide(file.index)) return file;
  if (file.index === 'A' && file.worktree === '.') {
    return { ...file, index: '?', worktree: '?', unstaged: sum(file.staged, file.unstaged), staged: undefined, pending: true };
  }
  const worktree = changedSide(file.worktree) ? file.worktree : file.index;
  return { ...file, index: '.', worktree, unstaged: sum(file.staged, file.unstaged), staged: undefined, pending: true };
}

/**
 * @param {ChangedFile} file - The file.
 * @returns {ChangedFile|null} It with its unstaged side gone, or null when nothing is left.
 */
function discarded(file) {
  if (file.worktree === '?') return null;
  if (!changedSide(file.index)) return null;
  return { ...file, worktree: '.', unstaged: undefined, pending: true };
}

/**
 * @param {ChangedFile} file - The file.
 * @returns {ChangedFile} It with its conflict resolved and staged: a change to
 *   it, as far as the client can tell before git says what was taken.
 */
function resolved(file) {
  if (!isConflicted(file)) return file;
  return { ...file, conflicted: false, index: 'M', worktree: '.', staged: undefined, unstaged: undefined, pending: true };
}

/**
 * @param {ChangedFile} file - The file.
 * @returns {ChangedFile} It in conflict again.
 */
function unresolved(file) {
  return { ...file, conflicted: true, index: 'U', worktree: 'U', staged: undefined, unstaged: undefined, pending: true };
}

/**
 * What a write will do to the files, as far as the client can tell: the
 * optimistic list drawn until a read says what it did. Kinds it cannot predict
 * (line staging, commits) leave the files as they are.
 * @param {ChangedFile[]} files - The files as last drawn.
 * @param {import('juggler/pinboard-item-type').PinGitOp} op - The write.
 * @returns {ChangedFile[]} The files as they will be.
 */
export function applyOp(files, op) {
  const paths = new Set(op.paths || []);
  const each = (/** @type {(f: ChangedFile) => ChangedFile|null} */ fn, /** @type {(f: ChangedFile) => boolean} */ which) =>
    /** @type {ChangedFile[]} */ (files.map((f) => (which(f) ? fn(f) : f)).filter(Boolean));
  switch (op.kind) {
    case 'stage': return each(staged, (f) => paths.has(f.path));
    case 'unstage': return each(unstaged, (f) => paths.has(f.path));
    case 'stage-all': return each(staged, (f) => f.worktree !== '?');
    case 'unstage-all': return each(unstaged, () => true);
    case 'discard': return each(discarded, (f) => paths.has(f.path));
    case 'resolve': return each(resolved, (f) => f.path === op.path);
    case 'unresolve':
      // A file resolved to what HEAD has is no change at all, and gone from the list.
      if (!files.some((f) => f.path === op.path)) {
        return [...files, unresolved(/** @type {ChangedFile} */ ({ path: op.path || '', index: '.', worktree: '.' }))];
      }
      return each(unresolved, (f) => f.path === op.path);
    default: return files;
  }
}

/**
 * A file's identity for drawing: everything a row shows of it, so a row is
 * rebuilt only when one of these moved.
 * @param {ChangedFile} file - The file.
 * @returns {string} Its signature.
 */
export function signatureOf(file) {
  return JSON.stringify([file.path, file.oldPath, file.index, file.worktree, file.conflicted, file.submodule,
    file.submoduleCommit, file.submoduleModified, file.submoduleUntracked,
    file.binary, file.lfs, file.staged, file.unstaged, file.pending]);
}
