//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The git changes of the trees this window shows, pushed by the server.
 *
 * The server watches a tree's git state — its index, refs, HEAD, working tree
 * and any operation in progress — only while a connection asks it to, and tells
 * only the connections that asked. This module does the asking for the whole
 * window: every surface that wants a tree's changes watches it here, and the
 * window names the union of those trees to the server in one git-watch frame,
 * again whenever the union changes and again on every new connection (the
 * server forgets a connection's watches when it goes).
 *
 * A watcher hears two kinds of frame for its tree, told apart by `type`. A
 * `git-change` says which repositories of the tree changed and in what part; it
 * carries no status, and what to read again is the watcher's own business. A
 * `git-job` is a write running in the tree, sent whenever its state changes and
 * with its hooks' output as it comes; it is not itself a change, since what the
 * write does to the tree arrives as one.
 */

import wsService from './websocket.js';

/**
 * @typedef {import('../protocol/server-wire-types.gen.js').GitChangeFrame} GitChange
 * @typedef {import('../protocol/server-wire-types.gen.js').GitJobFrame} GitJobFrame
 * @typedef {GitChange|GitJobFrame} GitFrame
 */

/** @type {Map<string, Set<(frame: GitFrame) => void>>} Watchers, by workspace id ('' is the project). */
const _watchers = new Map();

/** Name every watched tree to the server. */
function sendWatched() {
  wsService.sendGitWatch([..._watchers.keys()].sort());
}

/**
 * Hear of every git change to one tree, and of every write running in it, until
 * the returned function is called. Any number of watchers may share a tree; it
 * is watched while one remains.
 * @param {string} workspaceId - The tree: a workspace id, or '' for the project.
 * @param {(frame: GitFrame) => void} onChange - Called with each frame; `type`
 *   says whether it is a change or a job.
 * @returns {() => void} Stop watching. Safe to call twice.
 */
export function watchGit(workspaceId, onChange) {
  let watchers = _watchers.get(workspaceId);
  const isNew = !watchers;
  if (!watchers) {
    watchers = new Set();
    _watchers.set(workspaceId, watchers);
  }
  watchers.add(onChange);
  if (isNew) sendWatched();

  let stopped = false;
  const mine = watchers;
  return () => {
    if (stopped) return;
    stopped = true;
    mine.delete(onChange);
    if (mine.size === 0 && _watchers.get(workspaceId) === mine) {
      _watchers.delete(workspaceId);
      sendWatched();
    }
  };
}

/**
 * Hand one frame to the watchers of the tree it is about.
 * @param {unknown} data - The frame, as the socket emitted it.
 */
function dispatch(data) {
  const frame = /** @type {GitFrame} */ (data);
  const watchers = _watchers.get(frame.workspace || '');
  if (!watchers) return;
  for (const onChange of [...watchers]) {
    try {
      onChange(frame);
    } catch (err) {
      console.error('[GitWatch] Watcher failed:', err);
    }
  }
}

wsService.on('git-change', dispatch);
wsService.on('git-job', dispatch);

// A new connection starts with no watches on the server's side.
wsService.on('open', () => {
  if (_watchers.size > 0) sendWatched();
});
