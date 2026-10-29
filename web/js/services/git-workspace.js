//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Which tree this window's git surfaces are looking at.
 *
 * There are three of them — the status card's counts, the review's file list and
 * one file's diff — and in the Git pin they sit directly on top of one another.
 * They ask three different endpoints through two services that deliberately
 * share no state, so the one thing they cannot be allowed to disagree about is
 * *which tree*: counts from a worktree above a diff from the project would read
 * as a working pin showing the wrong bytes. Hence one answer, held here, that
 * all of them read.
 *
 * The answer is the **visible conversation's** workspace, because a git surface
 * is a window's chrome and a window shows one conversation at a time. It is not
 * per-pin or per-card state: two surfaces open in one window are looking at the
 * same tree by construction, which is also what keeps them on one poll.
 *
 * `''` is the project, which is what every surface showed before workspaces
 * existed, and what an unbound conversation still shows.
 *
 * Only the id travels. The server resolves it, refusing the same four ways every
 * other workspace-addressed request is refused, so a binding that cannot be
 * honoured surfaces as an error rather than as the project's tree wearing the
 * conversation's name.
 * @module services/git-workspace
 */

/** @type {string} The workspace whose tree the git surfaces show; '' is the project. */
let _workspaceId = '';

/** @type {Set<() => void>} Notified after the tree changes. */
const _listeners = new Set();

/** @type {(() => void)|null} Teardown for the session currently being followed. */
let _unfollow = null;

/**
 * The workspace the git surfaces are reading, '' for the project.
 * @returns {string} The workspace id.
 */
export function gitWorkspaceId() {
  return _workspaceId;
}

/**
 * Point the git surfaces at a tree. Idempotent: naming the tree they are already
 * looking at tells nobody anything, which matters because the session events
 * that drive this include the streaming firehose.
 * @param {string} id - Workspace id, '' for the project.
 * @returns {void}
 */
export function setGitWorkspace(id) {
  const next = typeof id === 'string' ? id : '';
  if (next === _workspaceId) return;
  _workspaceId = next;
  for (const fn of _listeners) {
    try {
      fn();
    } catch (err) {
      console.error('[GitWorkspace] Subscriber failed:', err);
    }
  }
}

/**
 * Watch for the tree changing. Each git service takes one of these and lets go
 * of what it knew: what was being described has been replaced.
 * @param {() => void} listener - Called after the tree changes.
 * @returns {() => void} Unsubscribe.
 */
export function onGitWorkspaceChange(listener) {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/**
 * Follow a session's visible conversation, so the git surfaces show whichever
 * tree the user is looking at. Called once, by whoever owns the session.
 *
 * The three events are the three ways the answer moves: the session loading
 * (which conversation is visible is restored, not chosen), a tab switch, and a
 * metadata write — which is how a blank tab acquires its binding, long after it
 * became visible, on its first send.
 *
 * A workspace becoming usable is deliberately NOT one of them. It does not
 * change which workspace the conversation is bound to, only whether the server
 * can resolve it, and the card is polled: it will have asked again within twenty
 * seconds. Resetting every surface on a table broadcast would cost more than the
 * wait does.
 * @param {import('../model/session.js').default|null} session - The session to follow.
 * @returns {() => void} Stop following, and go back to the project.
 */
export function followSession(session) {
  if (_unfollow) _unfollow();
  if (!session) {
    setGitWorkspace('');
    return () => {};
  }

  const sync = () => setGitWorkspace(session.getVisibleConversation()?.workspaceId || '');
  const unsubscribe = session.subscribe((event) => {
    switch (event?.type) {
      case 'session:loaded':
      case 'conversation:switched':
      case 'conversation:changed':
        sync();
        break;
      default:
        break;
    }
  });
  sync();

  _unfollow = () => {
    _unfollow = null;
    unsubscribe();
    setGitWorkspace('');
  };
  return _unfollow;
}
