//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * What the Git pin's Refs place lists and offers, with no DOM: its sections in
 * order, the row a key names, and — one source for both — the actions a ref's
 * ⋯ menu shows and its detail pane draws as buttons.
 *
 * An action is data, `{type, …}`, which the place carries out. A label is
 * worded here, when it is asked for, through `t`.
 *
 * Keys: `wt:<path>` a worktree, `br:<name>` a branch, `rm:<remote>/<name>` a
 * remote's branch (a remote's name holds no `/`), `tg:<name>` a tag,
 * `st:<sha>` a stash and `sm:<path>` a submodule.
 *
 * A submodule is offered only Update — checking it out at the commit its
 * repository records — and Open as repository, where everything else about it
 * is done as for any repository: the client manages no submodule beyond that.
 * @module pins/git/refs-model
 */

import { translator } from 'juggler/i18n';

const t = translator('@juggler/core');

/**
 * @typedef {import('../../lib/git-client.js').GitRefs} GitRefs
 * @typedef {GitRefs['branches'][number]} Branch
 * @typedef {GitRefs['tags'][number]} Tag
 * @typedef {GitRefs['stashes'][number]} Stash
 * @typedef {import('../../lib/git-client.js').GitWorktrees['trees'][number]} Tree
 * @typedef {import('../../lib/git-client.js').GitSubmodules['submodules'][number]} Submodule
 */

/**
 * A worktree as the place shows it: git's description and what Juggler knows of it.
 * @typedef {object} TreeView
 * @property {Tree} tree - As `git worktree list` describes it.
 * @property {string} name - The last part of its path.
 * @property {{id: string}|null} workspace - The workspace that is this tree, if
 *   one is (`workspaces.forTree`): whose Finish options are its endings.
 * @property {boolean} otherWorkspace - Whether some other open workspace is
 *   rooted there.
 * @property {{id: string, title: string}[]} conversations - The conversations working in it.
 * @property {{options: {id: string, label: string, description?: string, danger?: boolean}[], unavailableReason?: string}|null} finish -
 *   Its workspace's endings, when a workspace is this tree.
 * @property {string|null} viewId - What `config.workspace` names to view it, null when it cannot be viewed.
 * @property {string} viewRepo - What `config.repo` names to view it there: '' for that tree's root.
 */

/**
 * @typedef {object} RefsState
 * @property {GitRefs|null} refs - The last refs read.
 * @property {TreeView[]} trees - The last worktree read, annotated; the main tree first.
 * @property {Submodule[]} submodules - The last submodules read.
 * @property {number} dirty - Changed files in the viewed tree.
 * @property {boolean} following - Whether the pin follows the conversation's workspace.
 * @property {boolean} logOpen - Whether the command log is open.
 */

/**
 * One menu row, or one detail button.
 * @typedef {object} RefItem
 * @property {string} [label] - Its words.
 * @property {string} [hint] - Why it is disabled, or what it will do.
 * @property {boolean} [disabled] - Shown, not chosen.
 * @property {boolean} [danger] - Destructive.
 * @property {boolean} [header] - A label over the rows after it.
 * @property {boolean} [separator] - A divider.
 * @property {boolean} [checked] - Shown ticked.
 * @property {{type: string, [field: string]: any}} [action] - What choosing it does.
 */

/**
 * @typedef {object} RefRow
 * @property {string} key - The row's key.
 * @property {'wt'|'branch'|'remote'|'tag'|'stash'|'submodule'} ctx - What it is.
 * @property {any} entity - Its tree view, branch, `{remote, branch}`, tag, stash or submodule.
 */

/**
 * @typedef {object} RefSection
 * @property {string} id - `worktrees`, `branches`, `remote:<name>`, `tags`, `stashes` or `submodules`.
 * @property {string} title - Its heading.
 * @property {RefRow[]} rows - Its rows.
 */

/**
 * A tree as the places show it: what Juggler knows of it beside git's words.
 * @param {Tree} tree - The tree.
 * @param {import('juggler/pinboard-item-type').PinWorkspaces|undefined} workspaces - The session's workspaces.
 * @returns {TreeView} Its view.
 */
function annotateTree(tree, workspaces) {
  const ids = new Set(tree.rows || []);
  const rows = ids.size ? (workspaces?.list() || []).filter((r) => ids.has(r.id) && r.state !== 'closed') : [];
  const id = rows.length ? (workspaces?.forTree({ path: tree.path, branch: tree.branch || '', rows: rows.map((r) => r.id) }) || '') : '';
  const mine = (id && rows.find((r) => r.id === id)) || null;
  return {
    tree,
    name: baseName(tree.path),
    workspace: mine ? { id: mine.id } : null,
    otherWorkspace: rows.some((r) => r !== mine),
    conversations: rows.flatMap((r) => workspaces?.conversationsOf(r.id) || []),
    finish: mine ? (workspaces?.finishOptions(mine.id) || null) : null,
    viewId: tree.tree === null ? null : (mine ? mine.id : tree.tree),
    viewRepo: mine ? '' : (tree.treeRepo || ''),
  };
}

/**
 * What the model is asked about, from the last reads and the pin.
 * @param {object} known - What is known.
 * @param {GitRefs|null} known.refs - The last refs read.
 * @param {Tree[]} known.trees - The last worktree read.
 * @param {Submodule[]} known.submodules - The last submodules read.
 * @param {import('juggler/pinboard-item-type').PinWorkspaces|undefined} known.workspaces - The session's workspaces.
 * @param {number|null} known.dirty - The viewed tree's changed files, null before they are read.
 * @param {boolean} known.following - Whether the pin follows the conversation's workspace.
 * @param {boolean} known.logOpen - Whether the command log is open.
 * @returns {RefsState} The state.
 */
export function refsState({ refs, trees, submodules, workspaces, dirty, following, logOpen }) {
  const views = trees.map((tree) => annotateTree(tree, workspaces));
  const viewed = views.find((v) => v.tree.current);
  return { refs, trees: views, submodules, dirty: dirty ?? viewed?.tree.dirty ?? 0, following, logOpen };
}

/**
 * @param {RefsState} state - What is known.
 * @returns {TreeView|undefined} The tree the pin is viewing.
 */
export function viewedTree(state) {
  return state.trees.find((v) => v.tree.current);
}

/**
 * @param {RefsState} state - What is known.
 * @param {string} path - A tree's path.
 * @returns {TreeView|undefined} The tree there.
 */
export function treeAt(state, path) {
  return state.trees.find((v) => v.tree.path === path);
}

/**
 * @param {string} path - An absolute path.
 * @returns {string} Its last part.
 */
export function baseName(path) {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) || path;
}

/**
 * The sections in their order: worktrees, branches, each remote, tags,
 * stashes, and submodules when the repository has any.
 *
 * Git counts the repository's own checkout as its main worktree. Alone, it is
 * only the tree in view, so the section lists it only beside a linked one,
 * where it is the way back.
 * @param {RefsState} state - What is known.
 * @returns {RefSection[]} The sections.
 */
export function sectionsOf(state) {
  const refs = state.refs;
  const trees = state.trees.length === 1 && state.trees[0]?.tree.main ? [] : state.trees;
  /** @type {RefSection[]} */
  const out = [{
    id: 'worktrees',
    title: t('Worktrees'),
    rows: trees.map((v) => ({ key: `wt:${v.tree.path}`, ctx: /** @type {const} */ ('wt'), entity: v })),
  }];
  if (!refs) return out;
  out.push({
    id: 'branches',
    title: t('Branches'),
    rows: [...refs.branches].sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => ({ key: `br:${b.name}`, ctx: /** @type {const} */ ('branch'), entity: b })),
  });
  for (const remote of refs.remotes) {
    out.push({
      id: `remote:${remote.name}`,
      title: t('Remote · {name}', { name: remote.name }),
      rows: remote.branches.filter((b) => b.name !== 'HEAD')
        .map((b) => ({ key: `rm:${remote.name}/${b.name}`, ctx: /** @type {const} */ ('remote'), entity: { remote: remote.name, branch: b } })),
    });
  }
  out.push({
    id: 'tags',
    title: t('Tags'),
    rows: refs.tags.map((tag) => ({ key: `tg:${tag.name}`, ctx: /** @type {const} */ ('tag'), entity: tag })),
  });
  out.push({
    id: 'stashes',
    title: t('Stashes'),
    rows: refs.stashes.map((s) => ({ key: `st:${s.sha}`, ctx: /** @type {const} */ ('stash'), entity: s })),
  });
  if (state.submodules.length) {
    out.push({
      id: 'submodules',
      title: t('Submodules'),
      rows: state.submodules.map((m) => ({ key: `sm:${m.path}`, ctx: /** @type {const} */ ('submodule'), entity: m })),
    });
  }
  return out;
}

/**
 * What the list's filter matches a row by: the name it shows — a remote
 * branch with its remote, a stash by its message, a submodule by its path.
 * @param {RefRow} row - The row.
 * @returns {string} Its name.
 */
export function rowName(row) {
  switch (row.ctx) {
    case 'wt': return row.entity.name;
    case 'remote': return `${row.entity.remote}/${row.entity.branch.name}`;
    case 'stash': return row.entity.message;
    case 'submodule': return row.entity.path;
    default: return row.entity.name;
  }
}

/**
 * @param {RefsState} state - What is known.
 * @param {string|null} key - A row's key.
 * @returns {RefRow|null} The row, while it is still listed.
 */
export function rowOf(state, key) {
  if (!key) return null;
  for (const section of sectionsOf(state)) {
    const row = section.rows.find((r) => r.key === key);
    if (row) return row;
  }
  return null;
}

/**
 * The branch a merge, rebase, pick or reset acts on: the one in view.
 * @param {RefsState} state - What is known.
 * @returns {string} The viewed tree's branch, '' when detached or unknown.
 */
export function currentBranch(state) {
  const viewed = viewedTree(state);
  return viewed && !viewed.tree.detached ? viewed.tree.branch || '' : '';
}

/**
 * Merge into, squash into, and rebase onto, the current branch.
 * @param {RefsState} state - What is known.
 * @param {string} rev - What to merge or rebase onto.
 * @param {string} name - What to call it.
 * @returns {RefItem[]} The three, or none when HEAD is detached or it is the current branch.
 */
function integrateItems(state, rev, name) {
  const current = currentBranch(state);
  if (!current || name === current) return [];
  return [
    { label: t('Merge into {branch}', { branch: current }), action: { type: 'merge', rev, into: current } },
    { label: t('Squash into {branch}…', { branch: current }), action: { type: 'squash-merge', rev, into: current } },
    { label: t('Rebase {branch} onto this', { branch: current }), action: { type: 'rebase', rev, into: current } },
  ];
}

/**
 * @param {RefsState} state - What is known.
 * @param {Branch} b - The branch.
 * @returns {RefItem[]} Its actions.
 */
function branchItems(state, b) {
  const viewed = viewedTree(state);
  const outIn = b.worktree ? treeAt(state, b.worktree) : undefined;
  const here = Boolean(b.head || (b.worktree && viewed && b.worktree === viewed.tree.path));
  const elsewhereName = b.worktree ? (outIn?.name || baseName(b.worktree)) : '';
  /** @type {RefItem[]} */
  const items = [];
  if (here) {
    items.push({ label: t('Checked out here'), disabled: true });
  } else if (b.worktree) {
    items.push({
      label: t('Go to worktree “{name}”', { name: elsewhereName }),
      disabled: typeof outIn?.viewId !== 'string',
      action: { type: 'view-tree', path: b.worktree },
    });
  } else {
    items.push({ label: t('Checkout'), action: { type: 'switch', op: { branch: b.name }, name: b.name } });
    items.push({ label: t('New worktree from branch…'), action: { type: 'new-worktree', values: { branch: b.name } } });
  }
  items.push({ label: t('Show in History'), action: { type: 'show-history', sha: b.sha } });
  items.push({ separator: true }, ...integrateItems(state, b.name, b.name));
  if (b.upstream && b.behind > 0 && !b.worktree) {
    items.push({
      label: t('Fast-forward to {upstream}', { upstream: b.upstream }),
      action: { type: 'fast-forward', branch: b.name, upstream: b.upstream, expectSha: b.sha },
    });
  }
  items.push(state.refs?.remotes.length
    ? { label: t('Push to…'), action: { type: 'push-to', branch: b.name } }
    : { label: t('Push to…'), disabled: true, hint: t('No remote') });
  items.push({ separator: true });
  items.push({ label: t('Rename…'), action: { type: 'rename', branch: b.name } });
  items.push({ label: t('Set upstream…'), action: { type: 'upstream', branch: b.name, upstream: b.upstream || '' } });
  items.push({
    label: t('Delete'),
    danger: true,
    disabled: Boolean(b.worktree),
    hint: here ? t('Checked out here') : b.worktree ? t('in {name}', { name: elsewhereName }) : t('undoable'),
    action: { type: 'branch-delete', branch: b.name, expectSha: b.sha },
  });
  return items;
}

/**
 * @param {RefsState} state - What is known.
 * @param {{remote: string, branch: {name: string, sha: string}}} r - The remote branch.
 * @returns {RefItem[]} Its actions.
 */
function remoteItems(state, r) {
  const rev = `${r.remote}/${r.branch.name}`;
  const local = state.refs?.branches.some((b) => b.name === r.branch.name);
  return [
    local
      ? { label: t('Local branch “{name}” exists', { name: r.branch.name }), disabled: true }
      : { label: t('Checkout as local branch'), action: { type: 'switch', op: { branch: r.branch.name, rev, track: true }, name: r.branch.name } },
    { label: t('New worktree from branch…'), action: { type: 'new-worktree', values: { base: rev } } },
    { label: t('Show in History'), action: { type: 'show-history', sha: r.branch.sha } },
    { separator: true },
    ...integrateItems(state, rev, rev),
  ];
}

/**
 * The remote a tag is pushed to, and the one a Push to… starts at: the current
 * branch's upstream's remote, else `origin` when there is one, else '' for the
 * server to choose.
 * @param {RefsState} state - What is known.
 * @returns {string} The remote's name.
 */
export function tagRemote(state) {
  const remotes = (state.refs?.remotes || []).map((r) => r.name);
  const current = currentBranch(state);
  const upstream = state.refs?.branches.find((b) => b.name === current)?.upstream || '';
  const tracked = remotes.filter((name) => upstream.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
  if (tracked) return tracked;
  return remotes.includes('origin') ? 'origin' : '';
}

/**
 * @param {RefsState} state - What is known.
 * @param {Tag} tag - The tag.
 * @returns {RefItem[]} Its actions.
 */
function tagItems(state, tag) {
  const remote = tagRemote(state);
  return [
    { label: t('Checkout (detached)'), action: { type: 'switch', op: { rev: tag.name, detach: true }, name: tag.name } },
    { label: t('Show in History'), action: { type: 'show-history', sha: tag.target } },
    { separator: true },
    {
      label: t('Push tag'),
      disabled: !state.refs?.remotes.length,
      hint: remote ? t('to {remote}', { remote }) : t('No remote'),
      action: { type: 'push-tag', name: tag.name, remote },
    },
    { separator: true },
    { label: t('Delete tag'), danger: true, hint: t('undoable'), action: { type: 'tag-delete', name: tag.name, expectSha: tag.sha, target: tag.target } },
  ];
}

/**
 * @param {Stash} s - The stash.
 * @returns {RefItem[]} Its actions.
 */
function stashItems(s) {
  return [
    { label: t('View changes'), action: { type: 'view-stash', stash: s.sha } },
    { label: t('Show in History'), action: { type: 'show-history', sha: s.sha, stash: s.message } },
    { separator: true },
    { label: t('Apply'), action: { type: 'stash-apply', stash: s.sha, message: s.message } },
    { label: t('Pop'), action: { type: 'stash-pop', stash: s.sha, message: s.message } },
    { label: t('Branch from stash…'), action: { type: 'stash-branch', stash: s.sha } },
    { separator: true },
    { label: t('Drop'), danger: true, hint: t('undoable'), action: { type: 'stash-drop', stash: s.sha, message: s.message } },
  ];
}

/**
 * @param {Submodule} m - The submodule.
 * @returns {RefItem[]} Its actions.
 */
function submoduleItems(m) {
  const sha = m.recorded.slice(0, 7);
  /** @type {Record<Submodule['state'], {disabled: boolean, hint: string}>} */
  const update = {
    current: { disabled: true, hint: t('Already at {sha}', { sha }) },
    moved: { disabled: false, hint: t('Check out {sha}, the commit recorded for it', { sha }) },
    uninitialized: { disabled: false, hint: t('Check it out at {sha}, cloning it if it needs to', { sha }) },
    conflicted: { disabled: true, hint: t('Resolve the conflict over it first') },
  };
  return [
    { label: t('Update'), ...update[m.state], action: { type: 'submodule-update', path: m.path } },
    {
      label: t('Open as repository'),
      disabled: !m.head,
      hint: m.head ? undefined : t('Not checked out'),
      action: { type: 'open-repo', path: m.path },
    },
  ];
}

/**
 * @param {TreeView} v - The tree.
 * @returns {RefItem[]} Its actions.
 */
function treeItems(v) {
  const tree = v.tree;
  /** @type {RefItem[]} */
  const items = [
    tree.current
      ? { label: t('Viewing this worktree'), disabled: true }
      : { label: t('View this worktree'), disabled: v.viewId === null, action: { type: 'view-tree', path: tree.path } },
    ...v.conversations.map((c) => ({
      label: t('Open conversation “{title}”', { title: c.title }),
      action: { type: 'show-conversation', id: c.id },
    })),
    { separator: true },
  ];
  if (tree.main) {
    items.push({ label: t('The main worktree can’t be removed'), disabled: true });
  } else if (v.workspace) {
    items.push({ label: t('Finish'), header: true });
    const finish = v.finish || { options: [] };
    for (const option of finish.options) {
      items.push({
        label: option.label,
        hint: option.description,
        danger: option.danger,
        action: { type: 'finish', id: v.workspace.id, option: option.id },
      });
    }
    if (!finish.options.length) {
      items.push({ label: finish.unavailableReason || t('Nothing to finish'), disabled: true });
    }
  } else if (tree.prunable) {
    items.push({ label: t('Prune worktrees that are gone'), action: { type: 'prune' } });
  } else {
    if (!v.otherWorkspace) {
      items.push({ label: t('Adopt as a Juggler workspace'), action: { type: 'adopt', path: tree.path, branch: tree.branch || '' } });
    }
    items.push(tree.locked
      ? { label: t('Unlock'), action: { type: 'unlock', path: tree.path } }
      : { label: t('Lock'), action: { type: 'lock', path: tree.path } });
    items.push({
      label: t('Remove worktree…'),
      danger: true,
      action: { type: 'remove-tree', path: tree.path, dirty: tree.dirty, locked: Boolean(tree.locked) },
    });
  }
  return items;
}

/**
 * The actions on one thing: the ⋯ menu's rows, and the detail pane's buttons.
 * @param {'wt'|'branch'|'remote'|'tag'|'stash'|'submodule'|'repo'|'section'} ctx - What it is.
 * @param {string} key - Its key; for `section`, the section's id.
 * @param {RefsState} state - What is known.
 * @returns {RefItem[]} Its items, in order.
 */
export function menuFor(ctx, key, state) {
  if (ctx === 'repo') {
    return [
      { label: t('Fetch'), action: { type: 'network', kind: 'fetch' } },
      { label: t('Pull'), action: { type: 'network', kind: 'pull' } },
      { label: t('Push'), action: { type: 'network', kind: 'push' } },
      ...(currentBranch(state) && state.refs?.remotes.length
        ? [{ label: t('Push to…'), action: { type: 'push-to', branch: currentBranch(state) } }] : []),
      { label: t('Add remote…'), action: { type: 'remote-add' } },
      { separator: true },
      { label: t('Stash changes…'), disabled: state.dirty === 0, action: { type: 'stash-save' } },
      { label: t('New branch…'), action: { type: 'branch-create' } },
      { label: t('New worktree…'), action: { type: 'new-worktree', values: null } },
      { separator: true },
      { label: t('Follow the conversation’s workspace'), checked: state.following, action: { type: 'follow' } },
      { label: state.logOpen ? t('Hide the command log') : t('Show the command log'), action: { type: 'log' } },
    ];
  }
  if (ctx === 'section') {
    if (key === 'worktrees') {
      return [
        ...(state.trees.some((v) => v.tree.prunable) ? [{ label: t('Prune'), action: { type: 'prune' } }] : []),
        { label: t('New worktree…'), action: { type: 'new-worktree', values: null } },
      ];
    }
    if (key === 'branches') return [{ label: t('New branch…'), action: { type: 'branch-create' } }];
    if (key === 'stashes') return [{ label: t('Stash changes…'), disabled: state.dirty === 0, action: { type: 'stash-save' } }];
    if (key === 'tags') {
      const remote = tagRemote(state);
      return [{
        label: t('Push all'),
        disabled: !state.refs?.tags.length || !state.refs?.remotes.length,
        action: { type: 'push-tags', remote },
      }];
    }
    const remote = key.startsWith('remote:') ? state.refs?.remotes.find((r) => `remote:${r.name}` === key) : undefined;
    if (remote) {
      return [
        { label: t('Edit…'), action: { type: 'remote-edit', remote: remote.name, url: remote.url || '' } },
        { label: t('Remove…'), action: { type: 'remote-remove', remote: remote.name } },
      ];
    }
    return [];
  }
  const row = rowOf(state, key);
  if (!row) return [];
  if (row.ctx === 'branch') return branchItems(state, row.entity);
  if (row.ctx === 'remote') return remoteItems(state, row.entity);
  if (row.ctx === 'tag') return tagItems(state, row.entity);
  if (row.ctx === 'stash') return stashItems(row.entity);
  if (row.ctx === 'submodule') return submoduleItems(row.entity);
  return treeItems(row.entity);
}
