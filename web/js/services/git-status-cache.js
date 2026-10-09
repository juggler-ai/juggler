//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Client-side cache of a git working-tree's status, shared by every surface that
 * shows it — the sidebar info card and the pinboard's Git pin.
 *
 * Which tree is not this module's question: it reads the answer from
 * {@link module:services/git-workspace}, which is the visible conversation's
 * workspace, so a window looking at a worktree conversation counts that worktree
 * and not the project. One answer, because the review service reads the same one
 * and the two sit on top of each other in the pin.
 *
 * Git status is pull-based: the file watcher never reports anything under `.git`
 * (it skips dot-directories before fsnotify ever sees them), so there is nothing
 * to subscribe to and this module polls. One cache means one poll: two surfaces
 * open at once run git no more often than one does, which matters because each
 * poll shells out once per repository under the project.
 *
 * The poll runs only while something is watching and only while the window is
 * focused. A background `git status` fighting the user's own git client is worse
 * than a slightly stale number, and `--no-optional-locks` server-side reduces
 * that contention rather than removing the reason for it.
 */

import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import api from './api.js';
import { gitWorkspaceId, onGitWorkspaceChange } from './git-workspace.js';
import wsService from './websocket.js';

/**
 * @typedef {object} GitStatusSnapshot
 * @property {string} root - Absolute path of the tree that was read.
 * @property {string} workspace - What that tree is called when it is not the
 *   project (a worktree's label, say); '' for the project.
 * @property {import('./api.js').GitRepoStatus[]} repos - Every repo found under it.
 */

/**
 * Re-poll this often (ms) while watched and focused. Deliberately lazy: this is
 * ambient information, not something anyone waits on.
 */
const REFRESH_MS = 20000;

/** @type {GitStatusSnapshot|null} Latest snapshot; null means nothing has been fetched yet. */
let _snapshot = null;
/** @type {string} Latest fetch error, retained beside the last good snapshot. */
let _error = '';
/** @type {Set<() => void>} Watchers, notified after every change. */
const _listeners = new Set();
/** @type {ReturnType<typeof setInterval>|null} */
let _timer = null;
/** @type {Promise<GitStatusSnapshot|null>|null} In-flight fetch, shared by concurrent callers. */
let _inFlight = null;
/** Identifies the in-flight fetch, so a finished one only clears its own slot. */
let _inFlightId = 0;
/**
 * Bumped whenever what we are looking at changes. A fetch that resolves after
 * its generation has passed is answering a question about the previous project,
 * so its answer is dropped rather than shown.
 */
let _generation = 0;

/**
 * What was last announced, so an unchanged answer is not announced again.
 * @type {string}
 */
let _announced = '';

/**
 * Tell every watcher, if there is anything to tell them.
 *
 * A working tree is usually the same working tree it was twenty seconds ago,
 * and the poll cannot know that until it has asked. Announcing every answer
 * meant every watching surface rebuilt itself three times a minute to draw
 * precisely what it was already drawing.
 */
function notifyIfChanged() {
  const next = JSON.stringify({ snapshot: _snapshot, error: _error });
  if (next === _announced) return;
  _announced = next;
  for (const fn of _listeners) {
    try {
      fn();
    } catch (err) {
      console.error('[GitStatus] Subscriber failed:', err);
    }
  }
}

/** @returns {boolean} Whether the window is focused, treating a non-DOM realm as focused. */
function focused() {
  return typeof document === 'undefined' || document.hasFocus();
}

/** Poll, unless the window is unfocused or a poll is already outstanding. */
function poll() {
  if (!focused()) return;
  void gitStatusCache.refresh();
}

/** Run the interval and the focus listener exactly while something is watching. */
function updatePolling() {
  const wanted = _listeners.size > 0;
  if (wanted === (_timer !== null)) return;

  if (wanted) {
    _timer = setInterval(poll, REFRESH_MS);
    if (typeof window !== 'undefined') window.addEventListener('focus', poll);
    return;
  }
  if (_timer) clearInterval(_timer);
  _timer = null;
  if (typeof window !== 'undefined') window.removeEventListener('focus', poll);
}

const gitStatusCache = {
  /**
   * The latest status, or null when nothing has been fetched yet. Null is a
   * distinct state from "no repositories": a surface should say it is still
   * looking rather than claim the project has no git.
   * @returns {GitStatusSnapshot|null} The latest snapshot, or null.
   */
  get() {
    return _snapshot;
  },

  /**
   * The last fetch error, if the last fetch failed. The previous snapshot is
   * kept alongside it: a transient failure should not blank a working display.
   * @returns {string} The error text, or ''.
   */
  getError() {
    return _error;
  },

  /**
   * Watch for changes. The first watcher starts the poll and the last one to
   * leave stops it, so nothing runs git for a surface nobody has open. The
   * listener is called after a snapshot or error changes, and carries nothing —
   * call `get()`.
   * @param {() => void} listener - Called when the snapshot may have changed.
   * @returns {() => void} Unsubscribe.
   */
  subscribe(listener) {
    _listeners.add(listener);
    updatePolling();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      _listeners.delete(listener);
      updatePolling();
    };
  },

  /**
   * Fetch now. Concurrent callers share one request, so two surfaces mounting at
   * the same moment cost one `git status` and not two. Never rejects: a failure
   * is recorded on `getError()` and resolves with the last good snapshot.
   * @returns {Promise<GitStatusSnapshot|null>} The snapshot after this fetch.
   */
  async refresh() {
    if (_inFlight) return _inFlight;

    const generation = _generation;
    const id = ++_inFlightId;
    const pending = (async () => {
      try {
        const data = await api.getGitStatus(gitWorkspaceId());
        if (generation !== _generation) return _snapshot;
        _snapshot = {
          root: (data && data.root) || '',
          workspace: (data && typeof data.workspace === 'string' && data.workspace) || '',
          repos: data && Array.isArray(data.repos) ? data.repos : [],
        };
        _error = '';
      } catch (err) {
        if (generation !== _generation) return _snapshot;
        _error = extractErrorMessage(err);
      } finally {
        // Only if it is still ours: a reset in between has already discarded
        // this one, and clearing unconditionally would discard its replacement.
        if (_inFlightId === id) _inFlight = null;
      }
      notifyIfChanged();
      return _snapshot;
    })();
    _inFlight = pending;
    return pending;
  },

  /**
   * Forget everything known about the working tree, as a project switch does.
   * Exported for tests, which cannot otherwise get back to the initial state.
   * @returns {void}
   */
  reset() {
    _generation++;
    _snapshot = null;
    _error = '';
    // Let go of any read still in flight. It is answering a question about the
    // tree we just stopped looking at, and leaving it here would make the next
    // `refresh()` adopt it instead of asking about the new one.
    _inFlight = null;
    notifyIfChanged();
  },
};

/**
 * Start again against a different tree. Whatever is known describes the previous
 * one, and showing another tree's counts until the next poll comes round would
 * be wrong for as long as twenty seconds — so drop it and ask at once.
 * @returns {void}
 */
function retarget() {
  gitStatusCache.reset();
  if (_listeners.size > 0) void gitStatusCache.refresh();
}

// A project switch replaces the tree this describes.
wsService.on('project-changed', retarget);

// So does the user moving to a conversation that works somewhere else. The same
// event, in every way this module cares about.
onGitWorkspaceChange(retarget);

export default gitStatusCache;
