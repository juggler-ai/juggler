//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Browser-side bridge between the server's user-preset store and the in-memory
 * `systemPromptRegistry`. Built-in presets ship in the registry; this module
 * fetches the user's saved presets, merges them in, and tracks which preset
 * (built-in or user) is the chosen session default.
 *
 * Module singleton: there is exactly one preset registry app-wide and `import`
 * is the discovery mechanism (see the frontend-service-style note in CLAUDE.md).
 * @module services/system-prompt-presets
 */

import apiService from './api.js';
import { t } from '../../sdk/lib/i18n.js';
import { systemPromptRegistry, BUILTIN_DEFAULT_ID } from '../../sdk/lib/system-prompt-registry.js';

/** @type {string} Last-known default preset id from the server ('' = unset). */
let _defaultId = '';

/** @type {boolean} Whether a fetch has completed at least once. */
let _loaded = false;

/**
 * Fetch the user's presets and default id from the server, merge the presets
 * into the registry, and cache the default id. Never throws — on failure it
 * leaves the registry's built-ins in place and returns the current state.
 * @returns {Promise<{presets: import('../../sdk/lib/system-prompt-registry.js').SystemPromptPreset[], defaultId: string}>} The merged preset list and the resolved default id
 */
async function refreshUserPresets() {
  try {
    const { presets, defaultId } = await apiService.getSystemPromptPresets();
    systemPromptRegistry.setUserPresets(Array.isArray(presets) ? presets : []);
    _defaultId = typeof defaultId === 'string' ? defaultId : '';
  } catch {
    // Offline / endpoint missing — keep built-ins, keep prior default.
  }
  _loaded = true;
  return { presets: systemPromptRegistry.getAllPresets(), defaultId: getDefaultPresetId() };
}

/**
 * Ensure user presets have been fetched at least once this session.
 * @returns {Promise<{defaultId: string}>} The resolved default id
 */
export async function ensureUserPresetsLoaded() {
  if (!_loaded) await refreshUserPresets();
  return { defaultId: getDefaultPresetId() };
}

/**
 * The effective default preset id: the user's chosen default when set and still
 * present in the registry, otherwise the built-in `default`.
 * @returns {string} A preset id that resolves in the registry
 */
export function getDefaultPresetId() {
  if (_defaultId && systemPromptRegistry.getPreset(_defaultId)) return _defaultId;
  return BUILTIN_DEFAULT_ID;
}

/**
 * Resolve the prompt body to seed a new conversation with: the default preset's
 * content, or the built-in `default` content, or empty string if neither
 * resolves (the context item then falls back to its own built-in default).
 * @returns {{id: string, content: string}} The default preset id and its content
 */
export function getDefaultPresetSeed() {
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
