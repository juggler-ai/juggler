//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The session's event feed: one synchronous fan-out that the session, its
 * extracts (the sync reducer, the persistence) and every Conversation announce
 * on, and that components subscribe to.
 *
 * The names are a closed set, {@link SessionEventType}. Both doors are typed
 * with it, so an announcement under a name nobody listens for, or a listener
 * testing for a name nobody sends, is a type error rather than a check that
 * quietly never matches.
 *
 * Each listener is contained, as on the socket's emitter: its throw goes to
 * the fault sink and the fan-out carries on, because subscribers are
 * independent and a release viewer has no console to read the throw in.
 * @module model/session-events
 */

import { reportFault } from '../utils/fault-report.js';

/**
 * @typedef {import('./session.js').default} Session
 * @typedef {import('./conversation.js').default} Conversation
 * @typedef {import('./message-thread.js').default} MessageThread
 */

/**
 * Every name announced on the session feed.
 *
 * Session-level: `session:loaded` (a load or a project switch adopted a
 * manifest), `session:saved`, `session:save-error`, `session:metadata-changed`
 * (`data.keys` names what moved), `session:workspaces-changed`,
 * `workspace:selected`.
 *
 * The conversation list: `conversation:created`, `conversation:deleted`,
 * `conversation:renamed`, `conversation:rename-requested`,
 * `conversation:reordered`, `conversation:switched`,
 * `conversation:focus-followed`, `conversation:auto-naming`,
 * `conversation:duplicating` (a duplicate of `conversationId` started or ended).
 *
 * One conversation, announced by the Conversation itself:
 * `conversation:changed`, `conversation:loadstate-changed`,
 * `conversation:items-removed`, `conversation:context-window-updated`,
 * `conversation:strategy-changed`, `context-items:changed`,
 * `processing:stopped`.
 *
 * A model asking for a view, which the model may not reach itself:
 * `conversation:turn-requested`, `command-manager:open-requested`,
 * `conversation-export:open-requested`, `conversation:thread-open-requested`,
 * `conversation:warning-requested`, and the three a conversation's tab answers
 * in its composer: `composer:clear-requested`, `composer:restore-requested`,
 * `composer:draft-requested`. A warning request is the one that carries an
 * answer back: the tab sets `heard` and `shown` on it, so the conversation can
 * record a warning nobody showed (see `Conversation.showWarning`).
 * @typedef {keyof SessionEventPayloads} SessionEventType
 */

/**
 * What each announcement carries, by name: the shape of `data` a listener of
 * that name receives.
 * @typedef {{
 *   'session:loaded': Session,
 *   'session:saved': Session,
 *   'session:save-error': unknown,
 *   'session:metadata-changed': {keys: string[], metadata: Record<string, unknown>, remote: boolean},
 *   'session:workspaces-changed': Session['workspaces'],
 *   'workspace:selected': Session['workspaces'][number]|null,
 *   'conversation:created': Conversation,
 *   'conversation:deleted': Conversation,
 *   'conversation:renamed': {conversationId: string},
 *   'conversation:rename-requested': {conversationId: string},
 *   'conversation:reordered': {conversationId?: string, beforeId?: string|null},
 *   'conversation:switched': Conversation,
 *   'conversation:focus-followed': {id: string, from: string},
 *   'conversation:auto-naming': {conversationId: string, active: boolean},
 *   'conversation:duplicating': {conversationId: string, active: boolean},
 *   'conversation:changed': {conversationId: string, insertedItemIds?: string[], metadataKeys?: string[]},
 *   'conversation:loadstate-changed': {conversationId: string, loadState: 'unloaded'|'loading'|'loaded'|'error'},
 *   'conversation:items-removed': {conversation: Conversation, messageThread: MessageThread, removed: number},
 *   'conversation:context-window-updated': Conversation,
 *   'conversation:strategy-changed': {conversation: Conversation, strategyId: string|undefined},
 *   'context-items:changed': {conversationId: string},
 *   'processing:stopped': string,
 *   'conversation:turn-requested': {conversationId: string},
 *   'command-manager:open-requested': {conversationId: string},
 *   'conversation-export:open-requested': {conversationId: string},
 *   'conversation:thread-open-requested': {conversationId: string, threadId: string},
 *   'conversation:warning-requested': {conversationId: string, message: string, duration: number, heard: boolean, shown: boolean},
 *   'composer:clear-requested': {conversationId: string, threadId: string|null, onlyIfText?: string},
 *   'composer:restore-requested': {conversationId: string, message: NonNullable<Conversation['_pendingUserMessage']>},
 *   'composer:draft-requested': {conversationId: string, text: string}
 * }} SessionEventPayloads
 */

/**
 * One announcement of a given name, as a listener of that name receives it.
 * @template {SessionEventType} K
 * @typedef {{type: K, data: SessionEventPayloads[K], session: Session}} SessionEventOf
 */

/**
 * One announcement, as a listener of every name receives it: narrowing on
 * `type` narrows `data` to that name's payload.
 * @typedef {{[K in SessionEventType]: SessionEventOf<K>}[SessionEventType]} SessionEvent
 */

/** @typedef {(event: SessionEvent) => void} SessionEventListener */

class SessionEvents {
  /**
   * @param {Session} session - The session each event is stamped with.
   */
  constructor(session) {
    /** @type {Session} @private */
    this._session = session;

    /**
     * The subscriptions, in the order they were taken, whether to one type
     * (`type` set) or to everything (`type` null). Each is its own entry, so
     * one callback subscribed twice is called twice, and either unsubscribe
     * releases only its own.
     * @type {Set<{callback: SessionEventListener, type: SessionEventType|null}>}
     * @private
     */
    this._listeners = new Set();
  }

  /**
   * Listen to the feed: to one type of announcement — `subscribe(type, cb)`,
   * which is what a listener that would otherwise switch on `event.type` for a
   * single case wants — or to every one, `subscribe(cb)`. Both kinds share one
   * subscription order.
   * @overload
   * @param {SessionEventListener} callback - Called synchronously with each event.
   * @returns {() => void} Stops this subscription; calling it again does nothing.
   */
  /**
   * @template {SessionEventType} K
   * @overload
   * @param {K} type - The one type to hear.
   * @param {(event: SessionEventOf<K>) => void} callback - Called synchronously with each event of that type.
   * @returns {() => void} Stops this subscription; calling it again does nothing.
   */
  /**
   * @template {SessionEventType} K
   * @param {SessionEventListener|K} typeOrCallback - A type, or the callback for everything.
   * @param {(event: SessionEventOf<K>) => void} [callback] - The callback, when a type is given.
   * @returns {() => void} Stops this subscription; calling it again does nothing.
   */
  subscribe(typeOrCallback, callback) {
    /** @type {{callback: SessionEventListener, type: SessionEventType|null}} */
    let entry;
    if (typeof typeOrCallback === 'function') {
      entry = { callback: typeOrCallback, type: null };
    } else {
      const type = typeOrCallback;
      const typed = callback;
      // notify delivers an entry only events of its own type, so the event
      // this one receives is the K it subscribed to.
      entry = {
        callback: event => typed?.(/** @type {SessionEventOf<K>} */ (event)),
        type
      };
    }
    this._listeners.add(entry);
    return () => { this._listeners.delete(entry); };
  }

  /**
   * Announce an event to every listener of it, synchronously and in
   * subscription order. The walk is over the live set: a listener subscribed
   * during the fan-out hears this event too, and one unsubscribed before it is
   * reached does not.
   * @template {SessionEventType} K
   * @param {K} type - What happened
   * @param {SessionEventPayloads[K]} data - What it happened to
   */
  notify(type, data) {
    /** @type {SessionEventOf<K>} */
    const event = { type, data, session: this._session };
    for (const entry of this._listeners) {
      if (entry.type !== null && entry.type !== type) continue;
      try {
        entry.callback(/** @type {SessionEvent} */ (event));
      } catch (error) {
        reportFault(`session-listener:${type}`, error);
      }
    }
  }

  /** Drop every subscription; the session's destroy calls it. */
  clear() {
    this._listeners.clear();
  }
}

export default SessionEvents;
