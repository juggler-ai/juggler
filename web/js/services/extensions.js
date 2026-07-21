//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Extensions service — fetches the unified extension catalog from the backend.
 *
 * A Juggler Extension is the packaging unit: one `juggler.extension.json`
 * manifest plus a bundle of capabilities (context items, strategies, commands).
 * `GET /api/extensions` returns the discovered extensions with their `provides`
 * globs already expanded to concrete served URLs. This service is the single
 * frontend entry point the registries use to learn which capability modules to
 * load and which extension owns each one.
 * @module services/extensions
 */

import { resolveAssetUrl, importModuleUrl } from '../utils/asset-url.js';
import { whenRegistriesReady } from '../registries/registry-ready.js';

/**
 * @typedef {object} ExtensionManifest
 * @property {string} id - Scoped extension id, e.g. '@juggler/core'
 * @property {string} name - Human-readable extension name
 * @property {string} version - Extension semver
 * @property {string} [author] - Extension author
 * @property {string} [homepage] - Extension homepage URL
 * @property {string} [engineApi] - Required host SDK compat range
 * @property {string[]} [permissions] - Declared host access (filesystem/shell/web) this extension's code uses; shown to the user as disclosure, not enforced
 */

/**
 * @typedef {object} ExtensionCapabilities
 * @property {string[]} contextItems - Served URLs of context-item modules
 * @property {string[]} strategies - Served URLs of strategy modules
 * @property {string[]} commands - Served URLs of command modules
 * @property {string} [systemPrompt] - Served URL of the extension's system-prompt contribution module (omitted when none declared)
 * @property {string} [lifecycle] - Served URL of the extension's lifecycle module (omitted when none declared)
 */

/**
 * @typedef {object} Extension
 * @property {ExtensionManifest} manifest - The parsed extension manifest
 * @property {string} source - Provenance: 'builtin', 'user'
 * @property {ExtensionCapabilities} capabilities - Glob-expanded served URLs per type
 * @property {string} [error] - Set when the manifest failed to parse/validate
 * @property {string} [manifestPath] - Absolute on-disk path of juggler.extension.json (omitted for embedded builtin extensions with no revealable file)
 * @property {Record<string, string>} [files] - Map of each capability's served URL to its absolute on-disk path (omitted for embedded builtin)
 */

/**
 * @typedef {object} CapabilityRef
 * @property {string} path - Served URL of the capability module
 * @property {string|null} extensionId - id of the owning extension (null when the capability has no owning extension)
 * @property {string} source - Provenance of the owning extension ('builtin', 'user')
 */

/** @type {Extension[]|null} */
let cached = null;

/**
 * Last-known-good disabled set. A transient `/api/config/plugins` blip must not
 * collapse the disabled set to empty: that would resurrect a disabled
 * extension's always-on system-prompt sections for one assembly, flip the
 * prompt bytes, and cold-start claudecode's warm cache (next turn flips back).
 * On failure we serve the prior successful set instead. A genuine plugin toggle
 * goes through reloadRegistries() → resetExtensionsCache(), which clears this so
 * fresh state is re-read.
 * @type {Set<string>|null}
 */
let lastKnownDisabled = null;

/** Map plugin-type → the capabilities key it lives under in the response. */
const TYPE_TO_KEY = /** @type {const} */ ({
  'context-item': 'contextItems',
  strategy: 'strategies',
  command: 'commands',
});

/**
 * Fetch the extension catalog from the backend (cached after first call).
 * @returns {Promise<Extension[]>} Discovered extensions (may include invalid ones with `error`)
 */
export async function fetchExtensions() {
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch('/api/extensions');
    if (!response.ok) {
      console.warn('[Extensions] Failed to fetch extensions:', response.status);
      return [];
    }
    /** @type {Extension[]} */
    const result = await response.json();
    cached = Array.isArray(result) ? result : [];
    return cached;
  } catch (err) {
    console.warn('[Extensions] Error fetching extensions:', err);
    return [];
  }
}

/**
 * Get the capability module references for a plugin type across all valid,
 * enabled extensions. Each ref carries the owning `extensionId` so the registry
 * can attribute the loaded class to its extension. Extensions whose manifest
 * failed to validate (`error` set) are skipped — their capabilities are not
 * served.
 * @param {'context-item'|'strategy'|'command'} type - Plugin type
 * @returns {Promise<CapabilityRef[]>} Capability references in extension order
 */
export async function getExtensionCapabilities(type) {
  const extensions = await fetchExtensions();
  const key = TYPE_TO_KEY[type];
  if (!key) return [];

  /** @type {CapabilityRef[]} */
  const refs = [];
  for (const ext of extensions) {
    if (ext.error) continue; // invalid manifest — capabilities not served
    const urls = ext.capabilities?.[key] || [];
    for (const path of urls) {
      refs.push({ path, extensionId: ext.manifest.id, source: ext.source });
    }
  }
  return refs;
}

/**
 * Reset the cached catalog. Called by reload-registries.js and tests so a
 * subsequent fetch re-reads the backend.
 */
export function resetExtensionsCache() {
  cached = null;
  // A genuine reload (plugin toggle) must re-read the disabled set fresh, so
  // drop the last-known-good cache too — otherwise a stale set could survive.
  lastKnownDisabled = null;
}

/**
 * Fetch the per-project disabled-id set (capability ids and extension ids share
 * one flat list). Used to gate extension-level system-prompt contributions:
 * a disabled extension contributes nothing. On a transient failure we serve the
 * last-known-good set rather than empty: collapsing to empty would resurrect a
 * disabled extension's always-on contribution sections for one assembly, flip
 * the system-prompt bytes, and cold-start claudecode's warm cache.
 * @returns {Promise<Set<string>>} Disabled capability/extension ids
 */
export async function fetchDisabledPluginIds() {
  try {
    const response = await fetch('/api/config/plugins');
    if (!response.ok) return lastKnownDisabled || new Set();
    const { disabled } = await response.json();
    lastKnownDisabled = new Set(Array.isArray(disabled) ? disabled : []);
    return lastKnownDisabled;
  } catch {
    return lastKnownDisabled || new Set();
  }
}

/**
 * Collect the ids of every currently-enabled capability across all three
 * registries. The registries already drop disabled capabilities at load
 * (`_applyDisabledFilter`), so their registered ids ARE the enabled set
 * (catalog minus disabled). Registries are imported dynamically to avoid a
 * static import cycle (the registries import this module).
 * @returns {Promise<string[]>} Enabled capability ids
 */
async function collectEnabledPluginIds() {
  const [ci, st, cm] = await Promise.all([
    import('../registries/context-item-registry.js'),
    import('../registries/strategy-registry.js'),
    import('../registries/command-registry.js'),
  ]);
  /** @type {Set<string>} */
  const ids = new Set();
  for (const reg of [ci.default, st.default, cm.default]) {
    if (reg && typeof reg.getIds === 'function') {
      for (const id of reg.getIds()) ids.add(id);
    }
  }
  return Array.from(ids);
}

/**
 * Aggregate the system-prompt contributions of every enabled extension into one
 * block for the cached system-prompt anchor. Each enabled extension that
 * declares a `systemPrompt` module has its default export invoked with the
 * enabled-plugin set, so a contribution can gate its sections on the specific
 * plugins the user has on. Extensions disabled at the extension level
 * contribute nothing. A failing contribution is logged and skipped — it never
 * breaks prompt assembly.
 * @returns {Promise<string>} Combined contributions (possibly empty), sections separated by blank lines
 */
export async function buildExtensionSystemPromptContributions() {
  // Wait for the capability registries to finish their initial hydration before
  // reading the enabled-plugin set: contributions gate their sections on
  // enabledPluginIds, so rendering against a partially-hydrated registry would
  // drop sections and change the cached system-prompt bytes.
  await whenRegistriesReady();
  const extensions = await fetchExtensions();
  const [disabled, enabledPluginIds] = await Promise.all([
    fetchDisabledPluginIds(),
    collectEnabledPluginIds(),
  ]);

  /** @type {string[]} */
  const parts = [];
  for (const ext of extensions) {
    if (ext.error) continue;
    const extId = ext.manifest?.id;
    if (extId && disabled.has(extId)) continue; // extension disabled → no contribution
    const url = ext.capabilities?.systemPrompt;
    if (!url) continue;
    try {
      const mod = await importModuleUrl(resolveAssetUrl(url));
      const fn = mod?.default;
      if (typeof fn !== 'function') continue;
      const text = fn({ enabledPluginIds });
      if (typeof text === 'string' && text.trim()) {
        parts.push(text.trim());
      }
    } catch (err) {
      console.warn('[Extensions] system-prompt contribution failed:', url, err);
    }
  }
  return parts.join('\n\n');
}

/**
 * Invoke a lifecycle hook on every enabled extension that declares a `lifecycle`
 * module. Each such module's default export is a hooks object (see
 * `juggler/lifecycle`); the named hook is called with `ctx`. Extensions disabled
 * at the extension level are skipped. A hook that throws (or a module that fails
 * to import) is logged and skipped — it never breaks conversation handling.
 *
 * This is the host-side dispatch that makes worktree-style, project-scoped
 * setup/teardown possible as an extension: the hook body calls
 * `bindWorkspace`/`unbindWorkspace`/`shell` from `juggler/ops`. It fires for
 * every conversation in the project (per-project opt-in via enabling the
 * extension), independent of the strategy axis.
 * @param {'onConversationActivated'|'onConversationDeleted'} hook - Hook name.
 * @param {import('../../sdk/lifecycle.js').LifecycleContext | import('../../sdk/lifecycle.js').LifecycleDeleteContext} ctx - Hook context.
 * @returns {Promise<void>} Resolves once every module's hook has settled.
 */
export async function runExtensionLifecycleHook(hook, ctx) {
  await whenRegistriesReady();
  const extensions = await fetchExtensions();
  const disabled = await fetchDisabledPluginIds();
  for (const ext of extensions) {
    if (ext.error) continue;
    const extId = ext.manifest?.id;
    if (extId && disabled.has(extId)) continue; // extension disabled → no lifecycle
    const url = ext.capabilities?.lifecycle;
    if (!url) continue;
    try {
      const mod = await importModuleUrl(resolveAssetUrl(url));
      const fn = mod?.default?.[hook];
      if (typeof fn !== 'function') continue;
      await fn(ctx);
    } catch (err) {
      console.warn(`[Extensions] lifecycle ${hook} failed:`, url, err);
    }
  }
}

/**
 * @typedef {object} ExtensionLocations
 * @property {string} userExtensions - Global extension container (~/.juggler/extensions)
 */

/** @type {ExtensionLocations} */
const EMPTY_LOCATIONS = { userExtensions: '' };

/**
 * Fetch the on-disk directories where extensions live, so the catalog can show a
 * developer exactly where to install new ones.
 * @returns {Promise<ExtensionLocations>} The install locations (fields may be empty)
 */
export async function fetchExtensionLocations() {
  try {
    const response = await fetch('/api/extensions/locations');
    if (!response.ok) return { ...EMPTY_LOCATIONS };
    return await response.json();
  } catch {
    return { ...EMPTY_LOCATIONS };
  }
}
