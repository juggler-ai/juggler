//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tab auto-naming setting — a small client-side mirror of the global
 * `auto_name_disabled` credential, for synchronous reads on the hot new-tab
 * path.
 *
 * The server owns the setting (it gates the LLM auto-namer); this cache exists
 * so the conversation bar can decide, without an await, whether a freshly
 * created tab should open its inline rename editor (auto-naming OFF) or leave
 * the "Untitled N" name alone and focus the composer so the LLM names it after the
 * first message (auto-naming ON — the default).
 *
 * The cache defaults to enabled until seeded, so a startup race just yields the
 * default behaviour. It is seeded fire-and-forget from `ConversationBar.setSession`
 * (via {@link refreshAutoNameSetting}) and kept current by the Defaults settings
 * tab, which calls {@link setAutoNameEnabledCached} on load and on toggle.
 * @module services/auto-name-setting
 */

import { getConfigShared } from './settings-api.js';

/** @type {boolean} Cached "auto-naming enabled" state; default-on until seeded. */
let cachedEnabled = true;

/**
 * Whether tab auto-naming is currently enabled (synchronous read of the cache).
 * @returns {boolean} True when auto-naming is on (the default).
 */
export function isAutoNameEnabled() {
  return cachedEnabled;
}

/**
 * Update the cached state directly (used by the Defaults tab after load/toggle,
 * so the bar sees a change without re-fetching).
 * @param {boolean} enabled - The new enabled state.
 */
export function setAutoNameEnabledCached(enabled) {
  cachedEnabled = !!enabled;
}

/**
 * Refresh the cache from the server (GET /api/config). Best-effort: a failed
 * fetch leaves the last-known value (or the default) in place.
 * @returns {Promise<boolean>} The refreshed enabled state.
 */
export async function refreshAutoNameSetting() {
  // Offline / transient failure — keep the last-known value.
  const config = await getConfigShared();
  if (config) cachedEnabled = !(/** @type {any} */ (config).autoNameDisabled);
  return cachedEnabled;
}
