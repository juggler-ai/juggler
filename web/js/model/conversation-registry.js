//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The session's conversations as the tab bar holds them: which are open, in
 * what order, which one is on screen, which were used most recently, and what
 * each is called.
 *
 * The registry records; it does not decide. Anything that needs a worker, the
 * server or the workspace table — loading a conversation, tearing one down,
 * working out where a new tab belongs among the boxes, persisting the order —
 * is the session's, which settles the outcome and then writes it here. So this
 * module imports nothing but the tape.
 *
 * **The map is the tab-bar order.** Insertion order is what the bar draws, so a
 * move is a rebuild of the whole order rather than an in-place edit, and the
 * rebuild keeps the Map object itself: a conversation's worker can still be
 * spawning when the order changes, and a caller awaiting it holds a live view of
 * the bar rather than a snapshot of the order it was inserted into. The map is
 * handed out read-only for the same reason it is never replaced — every write
 * goes through a method here.
 *
 * **Every arrival and departure is taped** (`session-mut`, with the caller's
 * `from`), here and nowhere else, so a failure dump can say when a tab came or
 * went and what did it. A reorder of conversations already held is not taped;
 * it changes no membership.
 * @module model/conversation-registry
 */

import { recordTape } from '../utils/event-tape.js';

/** @typedef {import('./conversation.js').default} Conversation */

/**
 * What is on screen: a conversation's tab, or a workspace's box.
 * @typedef {{kind: 'conversation'|'workspace', id: string}} Selection
 */

export default class ConversationRegistry {
  constructor() {
    /**
     * The open conversations, in tab-bar order.
     * @type {Map<string, Conversation>}
     * @private
     */
    this._conversations = new Map();

    /**
     * What is on screen, and the only thing that says so.
     *
     * The tab strip is one list of things to choose between — conversation tabs
     * and workspace boxes — and exactly one of them is chosen at a time. That
     * is one fact, so it is one field: naming a new selection is the whole of
     * giving up the old one, and no caller has an invariant to maintain between
     * two of them.
     * @type {Selection|null}
     * @private
     */
    this._selection = null;

    /**
     * The conversation that stays loaded, and the one the backend is told to
     * reopen.
     *
     * Deliberately not part of the selection, and **never** consulted to decide
     * what is showing: while a workspace panel holds the selection this still
     * names the conversation behind it, which is what a click on its tab comes
     * back to and what is persisted as `activeConversationId`. Asking this
     * field what is on screen is the bug this split exists to make impossible.
     * @type {string|null}
     * @private
     */
    this._loadedId = null;

    /**
     * Conversation ids, most recently used first. Picks the tab to fall back to
     * when the loaded conversation goes away.
     * @type {string[]}
     * @private
     */
    this._mru = [];

    /**
     * Conversation names from the last session manifest (id → name). The
     * backend derives them from the on-disk folder names on every
     * `GET /api/session`, so the bar can draw tabs before any Yjs doc hydrates.
     * A rename updates its entry locally on success, and the next manifest
     * overwrites it.
     * @type {Record<string, string>}
     * @private
     */
    this._names = {};
  }

  // ── The list ─────────────────────────────────────────────────────────────

  /**
   * The open conversations, in tab-bar order. Live and read-only: always the
   * same Map, and written only through this registry.
   * @returns {ReadonlyMap<string, Conversation>} The map.
   */
  get conversations() {
    return this._conversations;
  }

  /**
   * @returns {number} How many conversations are open.
   */
  get size() {
    return this._conversations.size;
  }

  /**
   * @param {string} id - Conversation id
   * @returns {Conversation|null} The conversation, or null when it is not open
   */
  get(id) {
    return this._conversations.get(id) ?? null;
  }

  /**
   * @param {string} id - Conversation id
   * @returns {boolean} Whether it is open
   */
  has(id) {
    return this._conversations.has(id);
  }

  /**
   * @returns {string[]} The open conversations' ids, in tab-bar order
   */
  ids() {
    return [...this._conversations.keys()];
  }

  /**
   * Add a conversation at the end of the bar, or replace the entry in place
   * when the id is already open.
   * @param {string} id - Conversation id
   * @param {Conversation} conv - The conversation
   * @param {string} from - Caller, for the tape
   */
  insert(id, conv, from) {
    recordTape('session-mut', id, { op: 'set', from });
    this._conversations.set(id, conv);
  }

  /**
   * Put the bar in `orderedIds` order, adding any of `additions` it names.
   *
   * An id naming neither an open conversation nor an addition is skipped — a
   * conversation not here yet arrives with its own event. An open conversation
   * the caller didn't name keeps its relative position at the end, so a
   * partial order never drops anything.
   * @param {string[]} orderedIds - Ids in their new order
   * @param {Map<string, Conversation>} [additions] - Conversations to add, or to put in place of the entry an id already has
   * @param {string} [from] - Caller, for the tape entry an addition leaves
   */
  arrange(orderedIds, additions, from = 'arrange') {
    /** @type {Map<string, Conversation>} */
    const next = new Map();
    for (const id of orderedIds) {
      const conv = additions?.get(id) ?? this._conversations.get(id);
      if (conv) next.set(id, conv);
    }
    for (const [id, conv] of this._conversations) {
      if (!next.has(id)) next.set(id, conv);
    }
    this._rebuild(next, from);
  }

  /**
   * Make the bar exactly `next`: what it names, in its order, and nothing else.
   * The server's manifest is applied this way, so a conversation another view
   * deleted leaves the list here, through the same door as every other
   * departure.
   * @param {Map<string, Conversation>} next - The whole list, in order
   * @param {string} from - Caller, for the tape
   */
  replace(next, from) {
    this._rebuild(next, from);
  }

  /**
   * Take a conversation out of the bar and out of the most-recently-used
   * list: the removal for a conversation that is really going away.
   * @param {string} id - Conversation id
   * @param {string} from - Caller, for the tape
   * @returns {Conversation|null} What was removed, or null when it was not open
   */
  remove(id, from) {
    const conv = this._conversations.get(id);
    if (!conv) return null;
    recordTape('session-mut', id, { op: 'delete', from });
    this._conversations.delete(id);
    this._mru = this._mru.filter(x => x !== id);
    return conv;
  }

  /**
   * Take a conversation out of the bar and nothing else. For an entry that
   * never finished arriving and is expected back on the next sync, so its
   * place in the most-recently-used list is left where it was.
   * @param {string} id - Conversation id
   * @param {string} from - Caller, for the tape
   * @returns {boolean} Whether an entry was dropped
   */
  forget(id, from) {
    if (!this._conversations.has(id)) return false;
    recordTape('session-mut', id, { op: 'delete', from });
    this._conversations.delete(id);
    return true;
  }

  /**
   * Empty the bar. The selection, names and most-recently-used list are left
   * alone: a load that clears the bar refills it and chooses again.
   * @param {string} from - Caller, for the tape
   */
  clear(from) {
    recordTape('session-mut', null, { op: 'clear', size: this._conversations.size, from });
    this._conversations.clear();
  }

  /**
   * Forget everything: the bar, the names, the most-recently-used list and the
   * selection. What a project switch leaves — another project's conversations
   * are not this one's, so nothing is selected and there is nothing to come
   * back to.
   */
  reset() {
    this.clear('reset');
    this._names = {};
    this._mru = [];
    this.clearSelection();
  }

  /**
   * Swap the map's contents for `next`, keeping the Map itself, and tape what
   * joined and what left.
   * @param {Map<string, Conversation>} next - New contents, in their new order
   * @param {string} from - Caller, for the tape
   * @private
   */
  _rebuild(next, from) {
    for (const id of this._conversations.keys()) {
      if (next.has(id)) continue;
      recordTape('session-mut', id, { op: 'delete', from });
      this._mru = this._mru.filter(x => x !== id);
    }
    for (const id of next.keys()) {
      if (!this._conversations.has(id)) recordTape('session-mut', id, { op: 'set', from });
    }
    this._conversations.clear();
    for (const [id, conv] of next) this._conversations.set(id, conv);
  }

  // ── What is on screen ────────────────────────────────────────────────────

  /**
   * @returns {Selection|null} What is on screen
   */
  get selection() {
    return this._selection;
  }

  /**
   * @returns {string|null} The conversation that stays loaded and is reopened next time, whether or not it is on screen
   */
  get loadedConversationId() {
    return this._loadedId;
  }

  /**
   * The conversation on screen, or null when something else is. Read from the
   * selection, so it cannot disagree with it.
   * @returns {string|null} The id, or null
   */
  get visibleConversationId() {
    return this._selection?.kind === 'conversation' ? this._selection.id : null;
  }

  /**
   * @returns {string|null} The workspace whose panel is on screen, or null
   */
  get visibleWorkspaceId() {
    return this._selection?.kind === 'workspace' ? this._selection.id : null;
  }

  /**
   * Move the selection. Choosing a conversation also makes it the one to come
   * back to; choosing a workspace deliberately leaves that alone, which is what
   * makes the panel somewhere you are rather than somewhere you left off.
   * @param {Selection|null} selection - What is now on screen
   */
  select(selection) {
    this._selection = selection;
    if (selection?.kind === 'conversation') {
      this._loadedId = selection.id;
    }
  }

  /**
   * Nothing on screen, and nothing to come back to.
   */
  clearSelection() {
    this._selection = null;
    this._loadedId = null;
  }

  /**
   * Record a conversation as the most recently used.
   * @param {string} id - Conversation id
   */
  touch(id) {
    this._mru = [id, ...this._mru.filter(x => x !== id)];
  }

  /**
   * The tab to show when the loaded one goes away: the most recently used
   * conversation still open, else the first in the bar.
   * @returns {string|undefined} Its id, or undefined when the bar is empty
   */
  fallback() {
    return this._mru.find(x => this._conversations.has(x)) ?? this._conversations.keys().next().value;
  }

  // ── Names ────────────────────────────────────────────────────────────────

  /**
   * @param {string} id - Conversation id
   * @returns {string} Its name from the last manifest or rename, or '' when none is known
   */
  name(id) {
    return this._names[id] || '';
  }

  /**
   * Record a conversation's canonical name ahead of the next manifest.
   * @param {string} id - Conversation id
   * @param {string} name - Its name
   */
  setName(id, name) {
    this._names[id] = name;
  }

  /**
   * Take a manifest's names as the whole of what is known.
   * @param {Record<string, string>} names - id → name
   */
  adoptNames(names) {
    this._names = { ...names };
  }

  /**
   * Take a manifest's names, keeping the last known name of any open
   * conversation the manifest no longer lists. Such a conversation is about to
   * be torn down, which is asynchronous, and stays drawable until it is gone;
   * the next merge drops its name, because by then it is no longer open.
   * @param {Record<string, string>} names - id → name
   */
  mergeNames(names) {
    /** @type {Record<string, string>} */
    const retained = {};
    for (const id of this._conversations.keys()) {
      if (!Object.hasOwn(names, id) && this._names[id]) retained[id] = this._names[id];
    }
    this._names = { ...retained, ...names };
  }
}
