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
import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';
import { t } from '../../sdk/lib/i18n.js';

/** `windowAssumed` marks a provider-wide fallback window (the server reported none and no catalogue entry knew the model); `providerContextWindow` is present only when the user overrode the window. */
/** @typedef {{ id: string, contextWindow: number, maxOutputTokens: number, fromAPI: boolean, windowAssumed?: boolean, providerContextWindow?: number|null, inputModalities?: string[], streamsLiveUsage?: boolean }} ModelWithContext */
/** `spawnsLocalProcess` marks a provider Juggler runs as a subprocess in the conversation's own directory (the CLI agents), so it can only serve a workspace this machine can spawn into. */
/** `switchTo` names a provider better suited to the server this one is pointed at (LocalAI aimed at LM Studio), for the UI to offer the switch. */
/** @typedef {{ provider: string, displayName: string, reason: string }} ProviderSwitch */
/** `decisions` marks a provider whose models answer decision requests (yes/no, choice and score questions) and `decisionOnly` one that cannot hold a conversation, so no chat picker may offer its models. Both are absent for a provider that only chats. */
/** @typedef {{ name: string, displayName: string, description: string, authType: string, authSource?: string, authHint?: string, configKeyName: string, envVarName: string, apiKeyURL: string, keySource: string, available: boolean, spawnsLocalProcess?: boolean, decisions?: boolean, decisionOnly?: boolean, switchTo?: ProviderSwitch, modelsWithContext: ModelWithContext[] }} Provider */

/** @type {Provider[]} */
let _cache = [];
let _hasReceived = false;
let _ready = false;
/** @type {Array<(list: Provider[]) => void>} */
const _waiters = [];
/** @type {Array<(list: Provider[]) => void>} */
const _readyWaiters = [];

// Page-lifetime subscriptions, never released by design: this module IS the
// page's providers cache, and lives exactly as long as the socket it listens to.
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
   * The providers whose models can hold a conversation: everything but the
   * decision-only ones. This is the list for any picker that chooses a model to
   * chat with.
   * @returns {Provider[]} Current cached providers that chat.
   */
  getChat() {
    return providersCache.get().filter((p) => !p.decisionOnly);
  },

  /**
   * The providers whose models answer decision requests, for the picker that
   * chooses a decision model.
   * @returns {Provider[]} Current cached providers that make decisions.
   */
  getDecision() {
    return providersCache.get().filter((p) => p.decisions);
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
   * Whether a settled snapshot has arrived — the synchronous form of
   * `waitForReady()`. Until it has, the list may be the connect seed, whose
   * emptiness says nothing about what is configured.
   * @returns {boolean} True once a ready providers-update has been observed.
   */
  isReady() {
    return _ready;
  },

  /**
   * Whether at least one provider is currently usable — enabled with a working
   * credential and at least one listable model. This is the "can the user
   * actually send a message" signal, distinct from `hasReceived()` (did any
   * push arrive) and from the raw list length (which counts unavailable
   * providers too). A decision-only provider does not count: it cannot answer a
   * message, so a user with only a decision model still needs a chat provider.
   * @returns {boolean} True if some provider can serve a model right now.
   */
  hasAvailableProvider() {
    return providersCache.getChat().some((p) => p.available && (p.modelsWithContext?.length ?? 0) > 0);
  },

  /**
   * Ask the server to refresh provider availability/model lists. The endpoint
   * returns the previous cached list immediately; the fresh result arrives via
   * the normal providers-update WebSocket event.
   * @returns {Promise<void>}
   */
  async refresh() {
    await fetchJson(apiUrl('/providers/refresh'), { method: 'POST', errorPrefix: t('Provider refresh failed') });
  },

  /**
   * Move from a provider to the one its `switchTo` names. The server asks the
   * provider again before acting, carries the user's per-model settings across,
   * turns the old provider off and the new one on, and republishes the list.
   * @param {string} from - Name of the provider being left.
   * @returns {Promise<string>} Name of the provider switched to.
   */
  async switchProvider(from) {
    const result = await fetchJson(apiUrl('/providers/switch'), {
      method: 'POST',
      body: { from },
      // i18n-ignore: never shown; both callers show only the server's detail (httpErrorText)
      errorPrefix: "Couldn't switch provider",
    });
    return /** @type {any} */ (result)?.provider || '';
  }
};

export default providersCache;
