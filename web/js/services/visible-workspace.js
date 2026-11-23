//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Which workspace tree the visible conversation works in.
 *
 * A window shows one conversation at a time, so anything in the window's chrome
 * that describes "the tree" — the git status card's counts, the review's file
 * list, one file's diff — describes the visible conversation's. Several such
 * surfaces can sit on top of one another while asking different endpoints
 * through services that deliberately share no state, so the one thing they
 * cannot be allowed to disagree about is *which tree*: counts from a worktree
 * above a diff from the project would read as a working surface showing the
 * wrong bytes. Hence one answer, held here, that all of them read.
 *
 * It is not per-pin or per-card state: two surfaces open in one window are
 * looking at the same tree by construction, which is also what lets them share
 * one poll.
 *
 * `''` is the project, which is what an unbound conversation works in.
 *
 * Only the id travels. The server resolves it, refusing the same four ways every
 * other workspace-addressed request is refused, so a binding that cannot be
 * honoured surfaces as an error rather than as the project's tree wearing the
 * conversation's name.
 * @module services/visible-workspace
 */

/** @type {string} The workspace the visible conversation works in; '' is the project. */
let _workspaceId = '';

/** @type {Set<() => void>} Notified after the tree changes. */
const _listeners = new Set();

/** @type {(() => void)|null} Teardown for the session currently being followed. */
let _unfollow = null;

/**
 * The workspace the visible conversation works in, '' for the project.
 * @returns {string} The workspace id.
 */
export function visibleWorkspaceId() {
  return _workspaceId;
}

/**
 * Set the visible tree. Idempotent: naming the tree already visible tells
 * nobody anything, which matters because the session events that drive this
 * include the streaming firehose.
 * @param {string} id - Workspace id, '' for the project.
 * @returns {void}
 */
export function setVisibleWorkspace(id) {
  const next = typeof id === 'string' ? id : '';
  if (next === _workspaceId) return;
  _workspaceId = next;
  for (const fn of _listeners) {
    try {
      fn();
    } catch (err) {
      console.error('[VisibleWorkspace] Subscriber failed:', err);
    }
  }
}

/**
 * Watch for the visible tree changing. Each surface that reads the tree takes
 * one of these and lets go of what it knew: what was being described has been
 * replaced.
 * @param {() => void} listener - Called after the tree changes.
 * @returns {() => void} Unsubscribe.
 */
export function onVisibleWorkspaceChange(listener) {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/**
 * Follow a session's visible conversation, so the answer is whichever tree the
 * user is looking at. Called once, by whoever owns the session.
 *
 * The three events are the three ways the answer moves: the session loading
 * (which conversation is visible is restored, not chosen), a tab switch, and a
 * metadata write — which is how a blank tab acquires its binding, long after it
 * became visible, on its first send.
 *
 * A workspace becoming usable is deliberately NOT one of them. It does not
 * change which workspace the conversation is bound to, only whether the server
 * can resolve it, and the surfaces that read it poll: they will have asked again
 * within twenty seconds. Resetting every surface on a table broadcast would cost
 * more than the wait does.
 * @param {import('../model/session.js').default|null} session - The session to follow.
 * @returns {() => void} Stop following, and go back to the project.
 */
export function followSession(session) {
  if (_unfollow) _unfollow();
  if (!session) {
    setVisibleWorkspace('');
    return () => {};
  }

  const sync = () => setVisibleWorkspace(session.getVisibleConversation()?.workspaceId || '');
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
    setVisibleWorkspace('');
  };
  return _unfollow;
}
