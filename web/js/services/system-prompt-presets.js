//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Browser-side bridge between the server's user-preset store, the enabled
 * extensions' `systemPromptPresets`, and the in-memory `systemPromptRegistry`.
 * Built-in presets ship in the registry; this module fetches the user's saved
 * presets and each enabled extension's presets, merges them in, and
 * tracks which preset (of any source) is the chosen session default.
 *
 * Module singleton: there is exactly one preset registry app-wide and `import`
 * is the discovery mechanism (see the frontend-service-style note in CLAUDE.md).
 * @module services/system-prompt-presets
 */

import apiService from './api.js';
import { t } from '../../sdk/lib/i18n.js';
import { systemPromptRegistry, BUILTIN_DEFAULT_ID } from '../../sdk/lib/system-prompt-registry.js';
import { fetchExtensionPresets } from './extensions.js';

/** @type {string} Last-known default preset id from the server ('' = unset). */
let _defaultId = '';

/**
 * The first load of the user's and the extensions' presets, shared by every
 * caller that waits for it; null until something asks.
 * @type {Promise<void>|null}
 */
let _firstLoad = null;

/** @type {boolean} Whether a read of the extensions' presets has succeeded. */
let _extensionsLoaded = false;

/**
 * Counts reads of the extensions' presets. Each read applies its result only
 * while it is the latest, so a slow read that lands after a newer one cannot
 * bring back the set from before an extension was switched on or off.
 * @type {number}
 */
let _extensionReadGeneration = 0;

/**
 * Whether the extensions' presets have been read at least once, so a preset
 * missing from the registry is really missing rather than not yet read.
 * @returns {boolean} True once a read has succeeded
 */
export function extensionPresetsLoaded() {
  return _extensionsLoaded;
}

/**
 * Read the presets of every enabled extension into the registry, replacing
 * the previous extension set. The server has parsed them and namespaced their
 * ids `<extensionId>/<file-stem>`. Never throws — on failure the previous
 * extension set stays, and {@link ensureUserPresetsLoaded} tries again.
 * @returns {Promise<void>}
 */
async function refreshExtensionPresets() {
  const generation = ++_extensionReadGeneration;
  try {
    const presets = await fetchExtensionPresets();
    if (generation !== _extensionReadGeneration) return;
    systemPromptRegistry.setExtensionPresets(presets);
    _extensionsLoaded = true;
  } catch (err) {
    console.warn('[SystemPromptPresets] Could not load extension presets:', err);
  }
}

/**
 * Fetch the user's presets and default id from the server, and the presets of
 * enabled extensions, merge them into the registry, and cache the default id.
 * Never throws — on failure it leaves the registry's built-ins in place and
 * returns the current state.
 * @returns {Promise<{presets: import('../../sdk/lib/system-prompt-registry.js').SystemPromptPreset[], defaultId: string}>} The merged preset list and the resolved default id
 */
async function refreshUserPresets() {
  await Promise.all([
    (async () => {
      try {
        const { presets, defaultId } = await apiService.getSystemPromptPresets();
        systemPromptRegistry.setUserPresets(Array.isArray(presets) ? presets : []);
        _defaultId = typeof defaultId === 'string' ? defaultId : '';
      } catch {
        // Offline / endpoint missing — keep built-ins, keep prior default.
      }
    })(),
    refreshExtensionPresets()
  ]);
  return { presets: systemPromptRegistry.getAllPresets(), defaultId: getDefaultPresetId() };
}

/**
 * Re-read the presets of enabled extensions, after an extension has been
 * switched on or off. The user's presets and default are left as they are; a
 * default that named a preset which has gone falls back in
 * {@link getDefaultPresetId}. Before the first load has started nothing is
 * read: that load reads them anyway. While it is in flight, it is waited for
 * and the presets read again, since its read may predate the switch.
 * @returns {Promise<void>}
 */
export async function reloadExtensionPresets() {
  if (!_firstLoad) return;
  await _firstLoad;
  await refreshExtensionPresets();
}

/**
 * Ensure user presets have been fetched at least once this session, and the
 * extensions' presets read successfully — a read of them that failed is
 * tried again here, the next time a preset is needed.
 * @returns {Promise<{defaultId: string}>} The resolved default id
 */
export async function ensureUserPresetsLoaded() {
  if (!_firstLoad) _firstLoad = refreshUserPresets().then(() => {});
  await _firstLoad;
  if (!_extensionsLoaded) await refreshExtensionPresets();
  return { defaultId: getDefaultPresetId() };
}

/**
 * The effective default preset id: the user's chosen default when set and still
 * present in the registry, otherwise the built-in `default`.
 * @returns {string} A preset id that resolves in the registry
 */
export function getDefaultPresetId() {
  return resolveDefaultPresetId(_defaultId);
}

/**
 * Resolve a stored default id against the registry: the id itself while it
 * names a registered preset, otherwise the built-in `default` — so a default
 * naming a deleted user preset, or a preset of an extension that has been
 * switched off or removed, degrades rather than seeding nothing.
 * @param {string} id - The stored default id ('' = unset)
 * @returns {string} A preset id that resolves in the registry
 */
export function resolveDefaultPresetId(id) {
  if (id && systemPromptRegistry.getPreset(id)) return id;
  return BUILTIN_DEFAULT_ID;
}

/**
 * Resolve the prompt body to seed a new conversation with: the preferred
 * preset when one is named and registered (a strategy's `defaultPreset`), else
 * the default preset's content, or the built-in `default` content, or empty
 * string if none resolves (the context item then falls back to its own
 * built-in default).
 * @param {string} [preferredId] - A preset to use ahead of the default, if registered
 * @returns {{id: string, content: string}} The chosen preset id and its content
 */
export function getDefaultPresetSeed(preferredId = '') {
  const preferred = preferredId ? systemPromptRegistry.getPreset(preferredId) : undefined;
  if (preferred) return { id: preferredId, content: preferred.content };
  const id = getDefaultPresetId();
  const preset = systemPromptRegistry.getPreset(id) || systemPromptRegistry.getPreset(BUILTIN_DEFAULT_ID);
  return { id: preset ? id : BUILTIN_DEFAULT_ID, content: preset ? preset.content : '' };
}

/**
 * Save the current prompt body as a new user preset, then refresh the registry.
 * @param {string} name - Display name
 * @param {string} content - Prompt body to store
 * @returns {Promise<{id: string, name: string, content: string}>} The created preset
 */
export async function saveUserPreset(name, content) {
  const res = await apiService.saveSystemPromptPreset(name, content);
  if (!res || !res.success || !res.preset) {
    throw new Error(res && res.error ? res.error : t("Couldn't save preset"));
  }
  await refreshUserPresets();
  return res.preset;
}

/**
 * Delete a user preset, then refresh the registry.
 * @param {string} id - User preset id
 * @returns {Promise<void>}
 */
export async function deleteUserPreset(id) {
  const res = await apiService.deleteSystemPromptPreset(id);
  if (!res || !res.success) {
    throw new Error(res && res.error ? res.error : t("Couldn't delete preset"));
  }
  await refreshUserPresets();
}

/**
 * Update the name and content of an existing user preset, then refresh the registry.
 * @param {string} id - User preset id
 * @param {string} name - Display name
 * @param {string} content - Prompt body to store
 * @returns {Promise<{id: string, name: string, content: string}>} The updated preset
 */
export async function updateUserPreset(id, name, content) {
  const res = await apiService.updateSystemPromptPreset(id, name, content);
  if (!res || !res.success || !res.preset) {
    throw new Error(res && res.error ? res.error : t("Couldn't update preset"));
  }
  await refreshUserPresets();
  return res.preset;
}

/**
 * Set the session-default preset (built-in or user) and cache it locally.
 * @param {string} id - Preset id to make default
 * @returns {Promise<void>}
 */
export async function setDefaultPreset(id) {
  const res = await apiService.setDefaultSystemPromptPreset(id);
  if (!res || !res.success) {
    throw new Error(res && res.error ? res.error : t("Couldn't set default preset"));
  }
  _defaultId = id || '';
}
