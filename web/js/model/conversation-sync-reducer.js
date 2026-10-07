//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The viewer's reducer for the server's `conversations-changed` broadcast: one
 * op at a time, applied to the session's conversation list.
 *
 * Every op is broadcast to every viewer, the one that caused it included, so
 * each handler is idempotent. When the originator receives its own echo, its
 * local state already shows the change and the op does nothing. Two ops need
 * more than that, and the state for both lives here:
 *
 * - **A local create's echo** (`created`) can outrun the HTTP response to the
 *   create that caused it. The session preallocates the id and brackets the
 *   request with {@link ConversationSyncReducer#beginLocalCreate} and
 *   {@link ConversationSyncReducer#endLocalCreate}. A `created` for an id in
 *   that bracket is skipped, because the local flow inserts the conversation
 *   itself once its worker is ready.
 * - **A focus request** (`focus`) arrives right behind the `created` it
 *   follows, while that create's load is still in flight. The load publishes
 *   its conversation into the map early (the worker's yjs-sync lands before the
 *   load resolves and must find it), so the map reports the id as switchable
 *   before the tab bar has built its element. A focus in that window would
 *   show a blank panel, so it is parked and redeemed once the create is
 *   announced.
 *
 * The reducer reaches the session only through {@link SyncHost}, which the
 * session builds. That is the whole of what it reads and changes.
 * @module model/conversation-sync-reducer
 */

import { reportFault } from '../utils/fault-report.js';

/**
 * What the reducer may ask of the session.
 * @typedef {object} SyncHost
 * @property {(id: string) => boolean} holds - Whether the conversation is in the active map
 * @property {() => string[]} order - The active map's ids, in tab-bar order
 * @property {(id: string, name: string) => void} setName - Record a conversation's canonical folder name
 * @property {(type: string, data: any) => void} notify - Announce on the session's event bus
 * @property {(type: string, data: any) => void} notifyChange - Announce on the `conversation:changed` feed
 * @property {(id: string) => Promise<object|null>} loadAtHead - Load a conversation from disk into the head of the bar; null if the load failed
 * @property {(id: string, opts: {clearVisibleIfNoFallback: boolean}) => Promise<object|null>} drop - Tear a conversation down and remove it, choosing a fallback if it was loaded; null if it was not held
 * @property {(ids: string[]) => void} reorder - Rebuild the active map in this order
 * @property {(id: string) => void} follow - Switch this viewer to a conversation
 * @property {(from: string) => boolean} shouldFollow - Whether a request from this conversation may move the viewer (`Session.shouldFollowRequest`)
 * @property {import('./conversation-bin.js').default} bin - The project's bin
 */

/**
 * One `conversations-changed` broadcast, as the server sends it. Which fields
 * are set depends on `op`.
 * @typedef {object} ConversationChange
 * @property {string} op - created | focus | deleted | renamed | binned | restored | binned-deleted | reordered
 * @property {string} [id] - The conversation the op is about
 * @property {string} [name] - Its canonical folder name (created, renamed, restored)
 * @property {string[]} [order] - The ids the server re-slotted (reordered)
 * @property {string} [from] - The conversation that asked for a focus
 */

export default class ConversationSyncReducer {
  /**
   * @param {SyncHost} host - The session's side of the reducer
   */
  constructor(host) {
    /** @private */
    this._host = host;

    /**
     * Ids whose local create or duplicate is in flight (see the module doc).
     * @type {Set<string>}
     * @private
     */
    this._localCreates = new Set();

    /**
     * Ids whose remote `created` load is in flight. A focus for one of these
     * is parked rather than followed (see the module doc).
     * @type {Set<string>}
     * @private
     */
    this._remoteCreates = new Set();

    /**
     * A focus request this viewer accepted but cannot act on yet, redeemed
     * when its conversation's `created` is announced. Null when there is none.
     * @type {{id: string, from: string}|null}
     * @private
     */
    this._pendingFocus = null;
  }

  /**
   * Apply one broadcast. The only entry point the transport uses, so the op
   * vocabulary is spelled once. An async op's failure is reported as a fault
   * under the op's name rather than left as an unattributed rejection.
   * @param {ConversationChange} change - The broadcast payload
   * @returns {Promise<void>} Settles when the op has been applied
   */
  async apply(change) {
    const { op, id = '', name = '', order, from = '' } = change ?? /** @type {ConversationChange} */ ({ op: '' });
    try {
      switch (op) {
        case 'created':        await this.created(id, name); break;
        case 'focus':          this.focus(id, from); break;
        case 'deleted':        await this.deleted(id); break;
        case 'renamed':        this.renamed(id, name); break;
        case 'binned':         await this.binned(id); break;
        case 'restored':       await this.restored(id, name); break;
        case 'binned-deleted': this._host.bin.noteLeft(id); break;
        case 'reordered':      this.reordered(order ?? []); break;
        default: console.warn('[ConversationSync] unknown conversations-changed op:', op);
      }
    } catch (error) {
      reportFault(`conversations-changed:${op}`, error, { conversationId: id });
    }
  }

  /**
   * Mark a preallocated id as being created by this viewer, before the
   * request that creates it is sent.
   * @param {string} id - The preallocated id
   * @returns {void}
   */
  beginLocalCreate(id) {
    this._localCreates.add(id);
  }

  /**
   * Close the bracket {@link ConversationSyncReducer#beginLocalCreate} opened,
   * whether the request succeeded or not.
   * @param {...(string|undefined)} ids - The preallocated id, and the id the
   *   server answered with if that differs
   * @returns {void}
   */
  endLocalCreate(...ids) {
    for (const id of ids) {
      if (id) this._localCreates.delete(id);
    }
  }

  /**
   * op="created": load the new conversation from disk and insert it at the
   * head of the bar, unless this viewer already holds it or is creating it.
   * @param {string} id - Server-allocated conversation id
   * @param {string} name - Canonical folder name
   * @returns {Promise<void>}
   */
  async created(id, name) {
    const host = this._host;
    host.setName(id, name);
    if (host.holds(id)) {
      // The originator, or an earlier broadcast, already added it.
      host.notifyChange('conversation:changed', { conversationId: id });
      this._redeemPendingFocus(id);
      return;
    }
    if (this._localCreates.has(id)) return;

    this._remoteCreates.add(id);
    let conv;
    try {
      conv = await host.loadAtHead(id);
    } finally {
      this._remoteCreates.delete(id);
    }
    if (conv) {
      host.notify('conversation:created', conv);
      this._redeemPendingFocus(id);
    }
  }

  /**
   * op="focus": switch this viewer to the given conversation. The server sends
   * it right after `created` when a headless creator (the engine's
   * new_conversation tool) asked viewers to follow. It is advisory:
   * {@link SyncHost#shouldFollow} decides, so a viewer reading another tab or
   * part-way through a message keeps its place.
   * @param {string} id - Conversation to switch to
   * @param {string} [from] - Conversation that asked; empty for an unattributed
   *   request, which is always followed
   * @returns {void}
   */
  focus(id, from = '') {
    if (!id) return;
    if (!this._host.shouldFollow(from)) return;
    if (this._host.holds(id) && !this._remoteCreates.has(id)) {
      this._followFocus(id, from);
    } else {
      this._pendingFocus = { id, from };
    }
  }

  /**
   * op="deleted": tear the conversation down and remove it. With no fallback
   * left to show, nothing is selected.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async deleted(id) {
    const conv = await this._host.drop(id, { clearVisibleIfNoFallback: true });
    if (conv) this._host.notify('conversation:deleted', conv);
  }

  /**
   * op="renamed": record the name and announce it so tab labels re-render.
   * Always announced: a full refresh may already have put the same value in
   * the cache without painting it, so equality is not evidence that anyone
   * has rendered it.
   * @param {string} id
   * @param {string} name - Canonical folder name
   * @returns {void}
   */
  renamed(id, name) {
    this._host.setName(id, name);
    this._host.notifyChange('conversation:renamed', { conversationId: id });
  }

  /**
   * op="binned": remove the conversation like a delete does, and count its
   * arrival in the bin. A conversation this viewer binned itself has already
   * left the map, so its own echo counts nothing.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async binned(id) {
    const conv = await this._host.drop(id, { clearVisibleIfNoFallback: false });
    if (!conv) return;
    this._host.bin.noteBinned();
    this._host.notify('conversation:deleted', conv);
  }

  /**
   * op="restored": load the conversation back in at the head of the bar, and
   * count its departure from the bin (once, even when this viewer asked for
   * the restore: see `conversation-bin.js`).
   *
   * The head, like a new conversation: pulling something out of the bin is a
   * deliberate act, and whatever it was wanted for happens next.
   * @param {string} id
   * @param {string} name - Canonical folder name
   * @returns {Promise<void>}
   */
  async restored(id, name) {
    const host = this._host;
    host.setName(id, name);
    if (host.holds(id)) return;
    // Counted before the load: the server has restored it whether or not this
    // viewer manages to open it.
    host.bin.noteLeft(id);
    const conv = await host.loadAtHead(id);
    if (conv) host.notify('conversation:created', conv);
  }

  /**
   * op="reordered": a PARTIAL reorder, matching what the server does to the
   * manifest (core.mergeConversationOrder). The ids it names are re-slotted, in
   * the sequence given, into the positions those ids hold now, and every other
   * tab stays where it is. The echo is never the whole truth about this bar:
   * order is persisted by posting the tab list and echoed to every viewer, so
   * an echo in flight describes the bar as it was when the post left, and a tab
   * created in that window appears in neither. Taking it literally is what
   * sends a brand-new tab to the bottom.
   *
   * An echo that changes nothing announces nothing.
   * @param {string[]} order - Conversation ids the server has reordered
   * @returns {void}
   */
  reordered(order) {
    if (!Array.isArray(order)) return;
    const host = this._host;
    const localKeys = host.order();

    // Only ids this realm holds can be placed. One it doesn't hold yet arrives
    // with its own created/restored op.
    const queue = order.filter((id, i) => host.holds(id) && order.indexOf(id) === i);
    if (queue.length === 0) return;

    const named = new Set(queue);
    let qi = 0;
    // Every slot `named` matches is filled from `queue`, and the two are built
    // from the same ids, so the read is always in range.
    const merged = localKeys.map((id) => (named.has(id) ? /** @type {string} */ (queue[qi++]) : id));

    if (merged.every((id, i) => localKeys[i] === id)) return;

    host.reorder(merged);
    host.notify('conversation:reordered', {});
  }

  /**
   * Redeem a parked focus once its conversation is inserted and announced. The
   * follow rule is asked again: the load takes long enough for the user to
   * have started typing since the request arrived. No-op for any other id.
   * @param {string} id - The conversation just inserted
   * @returns {void}
   * @private
   */
  _redeemPendingFocus(id) {
    const pending = this._pendingFocus;
    if (!pending || pending.id !== id) return;
    this._pendingFocus = null;
    if (this._host.shouldFollow(pending.from)) {
      this._followFocus(id, pending.from);
    }
  }

  /**
   * Follow a focus request: switch, then announce that the user was moved by
   * `from` rather than leaving it of their own accord. The attention manager
   * listens for `conversation:focus-followed`, because the requesting
   * conversation is usually mid-turn and comes to rest moments after the user
   * has been taken away from it.
   * @param {string} id - Conversation to switch to
   * @param {string} from - Conversation that asked; empty when unattributed
   * @returns {void}
   * @private
   */
  _followFocus(id, from) {
    this._host.follow(id);
    if (from) this._host.notify('conversation:focus-followed', { id, from });
  }
}
