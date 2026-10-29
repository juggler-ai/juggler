//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
/* eslint-disable jsdoc/require-param, jsdoc/require-returns, jsdoc/require-returns-description, jsdoc/require-property-description, jsdoc/escape-inline-tags */
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The storage machinery behind {@link module:model/message-thread-permissions}:
 * one collection of entries kept in two scopes at once.
 *
 *   - session:      project-wide, stored as JSON in `session.metadata`
 *   - conversation: this conversation tab, stored in the conversation Yjs doc
 *
 * Permission rules and allowed paths are the same collection with different
 * payloads, so both are instances of {@link createScopedStore} rather than two
 * hand-copied read/save/locate/move sets. Everything entry-shaped —
 * normalization, defaults, identity, what a session entry is allowed to be —
 * arrives as configuration; the store itself never inspects an entry's fields.
 * @module model/scoped-permission-store
 */

import { plain } from './item-accessor.js';

/**
 * @typedef {'session'|'conversation'} PermissionScope
 * @typedef {import('./message-thread.js').default} MessageThread
 */

export const SCOPE_SESSION = 'session';
export const SCOPE_CONVERSATION = 'conversation';

/** @type {PermissionScope[]} Lookup order: session entries outrank conversation ones. */
const SCOPES = [SCOPE_SESSION, SCOPE_CONVERSATION];

/** @param {MessageThread} mt @returns {Record<string, unknown>} */
function sessionMetadata(mt) {
  return mt.conversation?.session?.metadata || {};
}

/**
 * @template E
 * @typedef {object} ScopedStoreConfig
 * @property {string} sessionKey Key holding the session-scoped array in `session.metadata`.
 * @property {string} conversationKey Key holding the conversation-scoped array in the Yjs doc.
 * @property {(entry: unknown, fallbackScope: PermissionScope) => E} normalize Coerce a stored entry into its canonical shape, defaulting its scope.
 * @property {(a: E, b: E) => boolean} sameIdentity Whether two entries mean the same grant (dedupe across scopes).
 * @property {(entry: E, key: string) => boolean} matches Whether an entry is the one a caller named (id, path, …).
 * @property {(mt: MessageThread) => unknown[]} [defaults] Entries to fall back to when the conversation has never stored any.
 * @property {(mt: MessageThread, entry: E) => boolean} [sessionAllows] Drop session-scoped entries this returns false for (see the rules store).
 * @property {(mt: MessageThread, entries: E[]) => void} [afterConversationSave] Side effect to run once a conversation-scope write lands.
 */

/**
 * @template E
 * @typedef {object} ScopedStore
 * @property {(mt: MessageThread, scope: PermissionScope) => E[]} read
 * @property {(mt: MessageThread, scope: PermissionScope, entries: E[]) => void} save
 * @property {(mt: MessageThread) => E[]} all
 * @property {(mt: MessageThread, entry: E, scope: PermissionScope) => void} append
 * @property {(mt: MessageThread, key: string) => {scope: PermissionScope, entries: E[], entry: E, index: number}|null} locate
 * @property {(mt: MessageThread, key: string) => boolean} remove
 * @property {(mt: MessageThread, key: string, mutate: (entry: E, scope: PermissionScope) => E) => boolean} update
 * @property {(mt: MessageThread, key: string, targetScope: PermissionScope, options?: {canMoveTo?: (mt: MessageThread, entry: E) => boolean}) => boolean} move
 */

/**
 * Build one two-scope collection.
 * @template {object} E
 * @param {ScopedStoreConfig<E>} config
 * @returns {ScopedStore<E>}
 */
export function createScopedStore(config) {
  const { sessionKey, conversationKey, normalize, sameIdentity, matches, defaults, sessionAllows, afterConversationSave } = config;

  /** @param {MessageThread} mt @returns {E[]} */
  function readSession(mt) {
    const stored = sessionMetadata(mt)[sessionKey];
    if (!Array.isArray(stored)) return [];
    const entries = stored.map(e => normalize(e, SCOPE_SESSION));
    return sessionAllows ? entries.filter(e => sessionAllows(mt, e)) : entries;
  }

  /** @param {MessageThread} mt @returns {E[]} */
  function readConversation(mt) {
    const stored = plain(mt.conversation.getMetadata(conversationKey));
    /** @type {unknown[]} */
    const source = Array.isArray(stored) ? stored : (defaults?.(mt) || []);
    return source.map(e => normalize(e, SCOPE_CONVERSATION));
  }

  /** @param {MessageThread} mt @param {E[]} entries */
  function saveSession(mt, entries) {
    const session = mt.conversation?.session;
    const normalized = entries.map(e => normalize(e, SCOPE_SESSION));
    if (session?.patchMetadata) session.patchMetadata({ [sessionKey]: normalized });
    else if (session) session.metadata = { ...(session.metadata || {}), [sessionKey]: normalized };
  }

  /** @param {MessageThread} mt @param {E[]} entries */
  function saveConversation(mt, entries) {
    const normalized = entries.map(e => normalize(e, SCOPE_CONVERSATION));
    mt.conversation.setMetadata(conversationKey, normalized);
    afterConversationSave?.(mt, normalized);
  }

  /** @param {MessageThread} mt @param {PermissionScope} scope @returns {E[]} */
  function read(mt, scope) {
    return scope === SCOPE_SESSION ? readSession(mt) : readConversation(mt);
  }

  /** @param {MessageThread} mt @param {PermissionScope} scope @param {E[]} entries */
  function save(mt, scope, entries) {
    if (scope === SCOPE_SESSION) saveSession(mt, entries);
    else saveConversation(mt, entries);
  }

  /** @param {MessageThread} mt @returns {E[]} */
  function all(mt) {
    return [...readSession(mt), ...readConversation(mt)];
  }

  /** @param {MessageThread} mt @param {E} entry @param {PermissionScope} scope */
  function append(mt, entry, scope) {
    save(mt, scope, [...read(mt, scope), entry]);
  }

  /** @param {MessageThread} mt @param {string} key @returns {{scope: PermissionScope, entries: E[], entry: E, index: number}|null} */
  function locate(mt, key) {
    for (const scope of SCOPES) {
      const entries = read(mt, scope);
      const index = entries.findIndex(e => matches(e, key));
      const entry = entries[index];
      if (index !== -1 && entry !== undefined) return { scope, entries, entry, index };
    }
    return null;
  }

  /** @param {MessageThread} mt @param {string} key @returns {boolean} */
  function remove(mt, key) {
    const hit = locate(mt, key);
    if (!hit) return false;
    const next = hit.entries.slice();
    next.splice(hit.index, 1);
    save(mt, hit.scope, next);
    return true;
  }

  /** @param {MessageThread} mt @param {string} key @param {(entry: E, scope: PermissionScope) => E} mutate @returns {boolean} */
  function update(mt, key, mutate) {
    const hit = locate(mt, key);
    if (!hit) return false;
    const next = hit.entries.slice();
    next[hit.index] = mutate(hit.entry, hit.scope);
    save(mt, hit.scope, next);
    return true;
  }

  /**
   * Move an entry to the other scope. Already-there is success; an entry the
   * destination already holds (by identity) is dropped rather than duplicated.
   * @param {MessageThread} mt
   * @param {string} key
   * @param {PermissionScope} targetScope
   * @param {{canMoveTo?: (mt: MessageThread, entry: E) => boolean}} [options]
   * @returns {boolean}
   */
  function move(mt, key, targetScope, options = {}) {
    const target = targetScope === SCOPE_SESSION ? SCOPE_SESSION : SCOPE_CONVERSATION;
    const hit = locate(mt, key);
    if (!hit) return false;
    if (hit.scope === target) return true;
    const moved = normalize({ ...hit.entry, scope: target }, target);
    if (options.canMoveTo && !options.canMoveTo(mt, moved)) return false;
    const sourceNext = hit.entries.slice();
    sourceNext.splice(hit.index, 1);
    const targetEntries = read(mt, target);
    // Write the destination before removing the source so live popup renderers
    // never see the row disappear and re-enter at a different position.
    if (!targetEntries.some(e => sameIdentity(e, moved))) save(mt, target, [...targetEntries, moved]);
    save(mt, hit.scope, sourceNext);
    return true;
  }

  return { read, save, all, append, locate, remove, update, move };
}
