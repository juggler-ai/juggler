//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Client-side mirror of the server-pushed provider/model list. The server
 * computes the list at startup and on every credential change, then broadcasts
 * it over the `providers-update` WebSocket event; this module owns the
 * subscription and exposes a synchronous `get()` plus a `waitForFirst()` for
 * callers that need to block until the first push arrives.
 */

import wsService from './websocket.js';

/** @typedef {{ id: string, contextWindow: number, maxOutputTokens: number, fromAPI: boolean, inputModalities?: string[], streamsLiveUsage?: boolean }} ModelWithContext */
/** @typedef {{ name: string, displayName: string, description: string, authType: string, authSource?: string, authHint?: string, configKeyName: string, envVarName: string, apiKeyURL: string, keySource: string, available: boolean, modelsWithContext: ModelWithContext[] }} Provider */

/** @type {Provider[]} */
let _cache = [];
let _hasReceived = false;
let _ready = false;
/** @type {Array<(list: Provider[]) => void>} */
const _waiters = [];
/** @type {Array<(list: Provider[]) => void>} */
const _readyWaiters = [];

wsService.on('providers-update', (/** @type {unknown} */ data) => {
  _cache = /** @type {Provider[]} */ (Array.isArray(data) ? data : []);
  _hasReceived = true;
  const pending = _waiters.splice(0);
  for (const fn of pending) fn(_cache);
});

// Emitted right after each 'providers-update' with whether that snapshot is the
// settled, post-compute list. The connect seed arrives with ready=false (its
// availability isn't computed yet); the first real refresh arrives with ready=true.
wsService.on('providers-ready', (/** @type {unknown} */ ready) => {
  if (ready !== true) return;
  _ready = true;
  const pending = _readyWaiters.splice(0);
  for (const fn of pending) fn(_cache);
});

const providersCache = {
  /**
   * Latest provider list. Returns `[]` until the first push arrives — most
   * callers should prefer `waitForFirst()` when they need a populated list
   * at startup.
   * @returns {Provider[]} Current cached providers.
   */
  get() {
    return _cache;
  },

  /**
   * Resolves with the list once at least one push has been observed.
   * Resolves immediately if a push has already arrived.
   * @returns {Promise<Provider[]>} Promise that resolves with the cached list.
   */
  waitForFirst() {
    if (_hasReceived) return Promise.resolve(_cache);
    return new Promise((resolve) => {
      _waiters.push(resolve);
    });
  },

  /**
   * Resolves with the list once a *settled* snapshot has arrived — i.e. after the
   * server's first provider refresh has computed real availability, not the
   * pre-compute connect seed. Callers that branch on `hasAvailableProvider()`
   * (e.g. first-run onboarding) must use this, not `waitForFirst()`, or they'll
   * read the empty seed and conclude no provider is configured. Resolves
   * immediately once a ready snapshot has been observed.
   * @returns {Promise<Provider[]>} Promise that resolves with the settled list.
   */
  waitForReady() {
    if (_ready) return Promise.resolve(_cache);
    return new Promise((resolve) => {
      _readyWaiters.push(resolve);
    });
  },

  /**
   * Whether the first push has arrived. Useful for tests that want to
   * branch on cache state without subscribing.
   * @returns {boolean} True once any providers-update has been observed.
   */
  hasReceived() {
    return _hasReceived;
  },

  /**
   * Whether at least one provider is currently usable — enabled with a working
   * credential and at least one listable model. This is the "can the user
   * actually send a message" signal, distinct from `hasReceived()` (did any
   * push arrive) and from the raw list length (which counts unavailable
   * providers too).
   * @returns {boolean} True if some provider can serve a model right now.
   */
  hasAvailableProvider() {
    return _cache.some((p) => p.available && (p.modelsWithContext?.length ?? 0) > 0);
  },

  /**
   * Ask the server to refresh provider availability/model lists. The endpoint
   * returns the previous cached list immediately; the fresh result arrives via
   * the normal providers-update WebSocket event.
   * @returns {Promise<void>}
   */
  async refresh() {
    const response = await fetch('/api/providers/refresh', { method: 'POST' });
    if (!response.ok) {
      throw new Error(`Provider refresh failed: ${response.status}`);
    }
  }
};

export default providersCache;
