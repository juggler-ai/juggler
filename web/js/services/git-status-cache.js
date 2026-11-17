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
 * Status is read when the server says the tree changed, not on a clock. While
 * anything watches this cache it watches the tree on the server
 * ({@link module:services/git-watch}), which pushes a change whenever the
 * tree's index, refs, HEAD, working files or an operation in progress do; each
 * change is one read. One cache means one watch and one read per change, however
 * many surfaces are open, which matters because each read shells out once per
 * repository under the tree.
 *
 * A read also follows a new connection, since changes made while the window was
 * cut off were never pushed to it, and the window gaining focus, which costs
 * nothing while the user is elsewhere and catches anything the server could not
 * see. Where the server cannot watch the whole tree it pushes on a clock of its
 * own for that tree alone.
 */

import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import api from './api.js';
import { watchGit } from './git-watch.js';
import { gitWorkspaceId, onGitWorkspaceChange } from './git-workspace.js';
import wsService from './websocket.js';

/**
 * @typedef {object} GitStatusSnapshot
 * @property {string} root - Absolute path of the tree that was read.
 * @property {string} workspace - What that tree is called when it is not the
 *   project (a worktree's label, say); '' for the project.
 * @property {import('./api.js').GitRepoStatus[]} repos - Every repo found under it.
 */

/** @type {GitStatusSnapshot|null} Latest snapshot; null means nothing has been fetched yet. */
let _snapshot = null;
/** @type {string} Latest fetch error, retained beside the last good snapshot. */
let _error = '';
/** @type {Set<() => void>} Watchers, notified after every change. */
const _listeners = new Set();
/** @type {(() => void)|null} Ends the server-side watch of the tree, while there is one. */
let _unwatch = null;
/** The tree the server-side watch is of. */
let _watchedId = '';
/** @type {(() => void)|null} Ends the reconnect subscription, while there is one. */
let _stopOnOpen = null;
/** @type {Promise<GitStatusSnapshot|null>|null} In-flight fetch, shared by concurrent callers. */
let _inFlight = null;
/**
 * Whether the tree changed while a read was out. That read may have looked
 * before the change, so another follows it.
 */
let _dirty = false;
/** Identifies the in-flight fetch, so a finished one only clears its own slot. */
let _inFlightId = 0;
/**
 * Bumped whenever what we are looking at changes. A fetch that resolves after
 * its generation has passed is answering a question about the previous project,
 * so its answer is dropped rather than shown.
 */
let _generation = 0;

/**
 * Whether what is held describes a tree other than the one being looked at —
 * kept on screen across a tab switch until the new tree answers.
 */
let _foreign = false;

/**
 * What was last announced, so an unchanged answer is not announced again.
 * @type {string}
 */
let _announced = '';

/**
 * Tell every watcher, if there is anything to tell them.
 *
 * A change the server pushes is often one the status does not show — a file
 * saved with the bytes it had, a ref rewritten in place — and a read on focus
 * usually finds what was already there. Announcing every answer would rebuild
 * every watching surface to draw precisely what it was already drawing.
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

/**
 * Read the tree again: now, or once the read already out has answered, since
 * that one may have looked before whatever prompted this.
 */
function readAgain() {
  if (_inFlight) {
    _dirty = true;
    return;
  }
  void gitStatusCache.refresh();
}

/**
 * Watch the tree being looked at, on the server and for reconnects and focus,
 * exactly while something watches this cache.
 */
function updateWatching() {
  const wanted = _listeners.size > 0;
  if (!wanted) {
    if (!_unwatch) return;
    _unwatch();
    _unwatch = null;
    _stopOnOpen?.();
    _stopOnOpen = null;
    if (typeof window !== 'undefined') window.removeEventListener('focus', readAgain);
    return;
  }

  const id = gitWorkspaceId();
  if (_unwatch && id === _watchedId) return;
  // The new tree is watched before the old one is let go, so a tree the two
  // share is never dropped and taken up again on the server.
  const previous = _unwatch;
  _watchedId = id;
  // Only a change is read: a job frame is a write's progress, and what the
  // write does to the tree is pushed as a change of its own.
  _unwatch = watchGit(id, (frame) => {
    if (frame.type === 'git-change') readAgain();
  });
  previous?.();
  if (!previous) {
    _stopOnOpen = wsService.on('open', readAgain);
    if (typeof window !== 'undefined') window.addEventListener('focus', readAgain);
  }
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
   * Watch for changes. The first watcher has the server watch the tree and the
   * last one to leave lets it go, so nothing watches or runs git for a surface
   * nobody has open. The listener is called after a snapshot or error changes,
   * and carries nothing — call `get()`.
   * @param {() => void} listener - Called when the snapshot may have changed.
   * @returns {() => void} Unsubscribe.
   */
  subscribe(listener) {
    _listeners.add(listener);
    updateWatching();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      _listeners.delete(listener);
      updateWatching();
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
        _foreign = false;
      } catch (err) {
        if (generation !== _generation) return _snapshot;
        _error = extractErrorMessage(err);
        if (_foreign) _snapshot = null;
        _foreign = false;
      } finally {
        // Only if it is still ours: a reset in between has already discarded
        // this one, and clearing unconditionally would discard its replacement.
        if (_inFlightId === id) _inFlight = null;
      }
      notifyIfChanged();
      // The tree changed while this read was out, so it may describe the tree
      // from before; one more read settles it, however many changes there were.
      if (_dirty && _inFlightId === id && _listeners.size > 0) {
        _dirty = false;
        void gitStatusCache.refresh();
      }
      return _snapshot;
    })();
    _inFlight = pending;
    return pending;
  },

  /**
   * Forget everything known about the working tree. Exported for tests, which cannot otherwise get back to the initial state.
   * @returns {void}
   */
  reset() {
    _generation++;
    _snapshot = null;
    _error = '';
    _foreign = false;
    _dirty = false;
    // Let go of any read still in flight. It is answering a question about the
    // tree we just stopped looking at, and leaving it here would make the next
    // `refresh()` adopt it instead of asking about the new one.
    _inFlight = null;
    notifyIfChanged();
  },
};

/**
 * Follow the user to a conversation that works in another tree, without
 * blanking first. Switching tabs is the commonest thing a user does, and
 * dropping to "Checking…" for the length of one `git status` changes the card's
 * height and moves everything around it — usually to come back to the same
 * answer, since most conversations share a tree. So the last answer stays up
 * while the new tree is read at once, and watchers hear only if it differs.
 *
 * The old answer stays only until the new one: a refused read discards it,
 * because the previous tree's counts under a tree that cannot be read would be
 * wrong for as long as the refusal lasts.
 * @returns {void}
 */
function follow() {
  _generation++;
  _inFlight = null;
  _dirty = false;
  _foreign = _snapshot !== null || _error !== '';
  updateWatching();
  if (_listeners.size > 0) void gitStatusCache.refresh();
}

// The user moving to a conversation that works in another tree replaces the
// tree this describes.
onGitWorkspaceChange(follow);

export default gitStatusCache;
