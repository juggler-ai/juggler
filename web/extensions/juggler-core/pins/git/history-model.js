//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What the Git pin's History place shows beside its commits, with no DOM: the
 * chips that mark where refs and worktrees stand, the scopes it offers, and
 * what can be done at a commit.
 *
 * Every worktree's HEAD is marked, not only the viewed one's: the viewed
 * tree's branch is the filled chip, a branch checked out in another tree is a
 * worktree chip naming that tree, and a detached tree is marked by its name.
 * @module pins/git/history-model
 */

import { translator } from 'juggler/i18n';
import { baseName, currentBranch, viewedTree } from './refs-model.js';

const t = translator('@juggler/core');

/**
 * @typedef {import('./refs-model.js').RefsState} RefsState
 * @typedef {import('./refs-model.js').RefItem} RefItem
 */

/**
 * Checking out a branch that stands at a commit, rather than the commit
 * detached: each local branch there that no tree has out, then each remote
 * branch there with no local branch of its name, as a new branch tracking it —
 * as the Refs place offers them. A branch out here or in another tree is not
 * offered: there is nothing to switch to, or git refuses it.
 * @param {string} sha - The commit.
 * @param {RefsState} state - What is known.
 * @returns {RefItem[]} Their items.
 */
function branchCheckouts(sha, state) {
  const refs = state.refs;
  /** @type {RefItem[]} */
  const items = [];
  for (const b of refs?.branches || []) {
    if (b.sha !== sha || b.head || b.worktree) continue;
    items.push({ label: t('Checkout {branch}', { branch: b.name }), action: { type: 'switch', op: { branch: b.name }, name: b.name } });
  }
  const local = new Set((refs?.branches || []).map((b) => b.name));
  for (const remote of refs?.remotes || []) {
    for (const b of remote.branches) {
      if (b.sha !== sha || b.name === 'HEAD' || local.has(b.name)) continue;
      local.add(b.name);
      const rev = `${remote.name}/${b.name}`;
      items.push({
        label: t('Checkout {branch} as local branch', { branch: rev }),
        action: { type: 'switch', op: { branch: b.name, rev, track: true }, name: b.name },
      });
    }
  }
  return items;
}

/**
 * The actions at one commit: the ⋯ menu's rows, and the detail pane's buttons.
 * A branch standing at the commit is offered for checkout ahead of the commit
 * itself, detached. A pick, the rewrites and the resets act on the branch in
 * view, so they are offered only while there is one; a rewrite or a reset
 * names the HEAD it moves from, so one the branch has moved past since is
 * refused.
 * @param {'commit'} ctx - What it is on.
 * @param {string} sha - The commit.
 * @param {RefsState} state - What is known.
 * @returns {RefItem[]} Its items, in order.
 */
export function menuFor(ctx, sha, state) {
  if (ctx !== 'commit' || !sha) return [];
  const branch = currentBranch(state);
  const head = viewedTree(state)?.tree.head || '';
  /** @type {RefItem[]} */
  const items = [
    ...branchCheckouts(sha, state),
    { label: t('Checkout (detached)'), action: { type: 'switch', op: { rev: sha, detach: true }, name: sha.slice(0, 7) } },
    { label: t('Branch here…'), action: { type: 'branch-here', rev: sha } },
    { label: t('Tag here…'), action: { type: 'tag-here', rev: sha } },
    { label: t('New worktree from here…'), action: { type: 'new-worktree', values: { base: sha } } },
    { separator: true },
  ];
  if (branch) items.push({ label: t('Cherry-pick onto {branch}', { branch }), action: { type: 'cherry-pick', rev: sha, branch } });
  items.push({ label: t('Revert'), action: { type: 'revert', rev: sha } });
  if (branch) {
    const rewrite = (/** @type {string} */ kind) => ({ type: 'rewrite', op: { kind, rev: sha, expectHead: head } });
    const reset = (/** @type {string} */ mode) => ({ type: 'reset', rev: sha, mode, branch, expectHead: head });
    items.push(
      { label: t('Reword…'), action: { type: 'reword', rev: sha, expectHead: head } },
      { label: t('Fix up with staged changes'), hint: t('Fold what is staged into this commit'), action: rewrite('fixup') },
      { label: t('Drop commit'), danger: true, hint: t('Take this commit out of the branch (undoable)'), action: rewrite('drop') },
      { separator: true },
      { label: t('Reset {branch} here — keep changes staged', { branch }), action: reset('soft') },
      { label: t('Reset {branch} here — keep changes', { branch }), action: reset('mixed') },
      { label: t('Reset {branch} here — discard changes…', { branch }), danger: true, action: reset('hard') },
    );
  }
  items.push({ separator: true }, { label: t('Copy SHA'), action: { type: 'copy-sha', sha } });
  return items;
}

/**
 * How the detail pane offers a commit's actions: its first group as buttons,
 * and everything after that first divider behind one ⋯ button. A row of a dozen
 * equal buttons, three of them resets, says nothing about which matter; the
 * first group is what is done to a commit most, and none of it is destructive.
 * @param {RefItem[]} items - What `menuFor` gave.
 * @returns {{buttons: RefItem[], more: RefItem[]}} The buttons, then the rest, in order.
 */
export function detailActions(items) {
  const at = items.findIndex((item) => item.separator);
  if (at < 0) return { buttons: items, more: [] };
  return { buttons: items.slice(0, at), more: items.slice(at + 1) };
}

/**
 * One chip on a commit.
 * @typedef {object} Chip
 * @property {'head'|'wt'|'branch'|'detached'|'remote'|'tag'} kind - What it marks.
 * @property {string} text - Its words.
 * @property {string} [title] - Its tooltip.
 */

/**
 * The chips on every commit something points at.
 * @param {RefsState} state - What is known.
 * @returns {Map<string, Chip[]>} By commit.
 */
export function chipIndex(state) {
  /** @type {Map<string, Chip[]>} */
  const index = new Map();
  /**
   * @param {string} sha - The commit.
   * @param {Chip} chip - The chip.
   */
  const add = (sha, chip) => {
    if (!sha) return;
    const list = index.get(sha) || [];
    list.push(chip);
    index.set(sha, list);
  };
  const viewed = viewedTree(state);
  const refs = state.refs;
  for (const b of refs?.branches || []) {
    const here = Boolean(b.head || (b.worktree && viewed && b.worktree === viewed.tree.path));
    if (here) {
      add(b.sha, { kind: 'head', text: b.name });
    } else if (b.worktree) {
      const where = state.trees.find((v) => v.tree.path === b.worktree)?.name || baseName(b.worktree);
      add(b.sha, { kind: 'wt', text: b.name, title: t('Checked out in {name}', { name: where }) });
    } else {
      add(b.sha, { kind: 'branch', text: b.name });
    }
  }
  for (const v of state.trees) {
    if (!v.tree.detached || v.tree.bare) continue;
    add(v.tree.head, {
      kind: v.tree.current ? 'head' : 'detached',
      text: t('{name} (detached)', { name: v.name }),
    });
  }
  for (const remote of refs?.remotes || []) {
    for (const b of remote.branches) {
      if (b.name !== 'HEAD') add(b.sha, { kind: 'remote', text: `${remote.name}/${b.name}` });
    }
  }
  for (const tag of refs?.tags || []) add(tag.target, { kind: 'tag', text: tag.name });
  return index;
}

/**
 * A scope as the picker holds it: `head`, `all`, `reflog`, or `ref:<name>`.
 * @typedef {string} ScopeKey
 */

/**
 * @param {ScopeKey} key - A picker value.
 * @returns {{scope: 'head'|'all'|'ref'|'reflog', ref?: string}} The log query's scope.
 */
export function scopeQuery(key) {
  if (key.startsWith('ref:')) return { scope: 'ref', ref: key.slice(4) };
  return { scope: key === 'all' || key === 'reflog' ? key : 'head' };
}

/**
 * The scopes the picker offers: every ref, the current branch, the reflog —
 * where HEAD has been, which is what undoing anything starts from — then each
 * ref by name.
 * @param {RefsState} state - What is known.
 * @returns {{label: string, options: {value: ScopeKey, label: string}[]}[]} Its groups; the first has no label.
 */
export function scopeGroups(state) {
  const refs = state.refs;
  /**
   * @param {string} name - A ref.
   * @returns {{value: ScopeKey, label: string}} Its option.
   */
  const named = (name) => ({ value: `ref:${name}`, label: name });
  return [
    { label: '', options: [{ value: 'all', label: t('All refs') }, { value: 'head', label: t('Current branch') }, { value: 'reflog', label: t('Reflog') }] },
    { label: t('Branches'), options: [...(refs?.branches || [])].map((b) => b.name).sort((a, b) => a.localeCompare(b)).map(named) },
    {
      label: t('Remote branches'),
      options: (refs?.remotes || []).flatMap((r) => r.branches.filter((b) => b.name !== 'HEAD').map((b) => named(`${r.name}/${b.name}`))),
    },
    { label: t('Tags'), options: (refs?.tags || []).map((tag) => named(tag.name)) },
  ].filter((g) => g.options.length);
}
