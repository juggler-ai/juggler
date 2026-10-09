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
import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * @typedef {object} ExtensionManifest
 * @property {string} id - Scoped extension id, e.g. '@juggler/core'
 * @property {string} name - Human-readable extension name
 * @property {string} version - Extension semver
 * @property {string} [author] - Extension author
 * @property {string} [homepage] - Extension homepage URL
 * @property {string} [engineApi] - Required host SDK compat range
 * @property {string[]} [permissions] - Declared host access (filesystem/shell/web) this extension's code uses; shown to the user as disclosure, not enforced
 * @property {ExtensionSetting[]} [settings] - Declarative global settings rendered by the Extensions catalog
 */

/**
 * @typedef {object} ExtensionSetting
 * @property {string} key - Stable configuration key
 * @property {'string'|'text'|'secret'|'boolean'|'number'|'enum'|'url'} type - Control and value type (`text` is a multi-line string)
 * @property {string} label - Human-readable label
 * @property {string} [help] - Supporting text
 * @property {string|number|boolean} [default] - Effective value when unset
 * @property {boolean} [required] - Whether the value must be supplied
 * @property {string[]} [options] - Allowed enum values
 * @property {'global'} [scope] - Persistence scope
 * @property {string} [capability] - `<itemType>:<id>` of a capability whose page also shows this setting
 */

/**
 * @typedef {object} ExtensionCapabilities
 * @property {string[]} contextItems - Served URLs of context-item modules
 * @property {string[]} strategies - Served URLs of strategy modules
 * @property {string[]} commands - Served URLs of command modules
 * @property {string[]} infoCards - Served URLs of info-card modules
 * @property {string[]} fileViewers - Served URLs of file-viewer modules
 * @property {string[]} pinboardItems - Served URLs of pinboard-item modules
 * @property {string[]} pinboardItemMeta - Served URLs of pinboard-item agent descriptors
 * @property {string[]} workspaceProviders - Served URLs of workspace-provider modules
 * @property {string[]} hooks - Served URLs of tool-hook modules
 * @property {string} [systemPrompt] - Served URL of the extension's system-prompt contribution module (omitted when none declared)
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
 * @typedef {object} PluginConfig
 * @property {Set<string>} disabled - Ids switched off for this project, already resolved by the server
 * @property {Record<string, {extension?: string, file?: string, type?: string, name?: string}>} attribution - What each switched-off id was
 */

/**
 * The last successfully read plugin config, shared by every reader. Six
 * registries plus the catalog rebuild together and all want the same fact;
 * without this they each fetched it, so they could disagree.
 *
 * It is never thrown away, only marked stale — see {@link disabledStale}.
 * @type {PluginConfig|null}
 */
let pluginConfig = null;

/**
 * Whether {@link pluginConfig} needs re-reading. Invalidation sets this rather
 * than nulling the set, because the two roles differ: as a CACHE it is stale
 * the moment config changes, but as a FALLBACK it is still the best answer
 * available if the re-read fails. Discarding it would mean a blip immediately
 * after a toggle answered "nothing is disabled", switching every disabled
 * capability back on — and for an extension-level disable that also resurrects
 * its always-on system-prompt sections for one assembly, flipping the prompt
 * bytes and cold-starting claudecode's warm cache.
 */
let disabledStale = false;

/**
 * In-flight fetch, so concurrent first readers make one request.
 * @type {Promise<PluginConfig|null>|null}
 */
let disabledInFlight = null;

/**
 * Read the project's plugin config, once per load and shared by every caller.
 * @returns {Promise<PluginConfig|null>} The config, or null when never readable
 */
async function loadPluginConfig() {
  if (pluginConfig && !disabledStale) return pluginConfig;
  if (disabledInFlight) return disabledInFlight;

  disabledInFlight = (async () => {
    const data = await fetchJson(apiUrl('/config/plugins'), { fallback: null });
    // Unreadable: serve the config that WAS read, or null if there has never
    // been one. Never an empty set — see disabledStale.
    if (!data) return pluginConfig;
    pluginConfig = {
      disabled: new Set(Array.isArray(data.disabled) ? data.disabled : []),
      attribution: (data.attribution && typeof data.attribution === 'object') ? data.attribution : {},
    };
    disabledStale = false;
    return pluginConfig;
  })();

  try {
    return await disabledInFlight;
  } finally {
    disabledInFlight = null;
  }
}

/** Map plugin-type → the capabilities key it lives under in the response. */
const TYPE_TO_KEY = /** @type {const} */ ({
  'context-item': 'contextItems',
  strategy: 'strategies',
  command: 'commands',
  'info-card': 'infoCards',
  'file-viewer': 'fileViewers',
  'pinboard-item': 'pinboardItems',
  'pinboard-item-meta': 'pinboardItemMeta',
  'workspace-provider': 'workspaceProviders',
  hook: 'hooks',
});

/**
 * Fetch the extension catalog from the backend (cached after first call).
 * @returns {Promise<Extension[]>} Discovered extensions (may include invalid ones with `error`)
 */
export async function fetchExtensions() {
  if (cached) {
    return cached;
  }

  /** @type {Extension[]|null} */
  const result = await fetchJson(apiUrl('/extensions'), {
    errorPrefix: '[Extensions] Failed to fetch extensions',
    fallback: null,
  });
  if (result === null) return [];
  cached = Array.isArray(result) ? result : [];
  return cached;
}

/**
 * Get the capability module references for a plugin type across all valid,
 * enabled extensions. Each ref carries the owning `extensionId` so the registry
 * can attribute the loaded class to its extension. Extensions whose manifest
 * failed to validate (`error` set) are skipped — their capabilities are not
 * served.
 * @param {keyof typeof TYPE_TO_KEY} type - Plugin type. Derived from the map
 *   rather than written out again: spelled as a literal union it had already
 *   drifted, missing `pinboard-item-meta` for as long as that type has existed.
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
  // A genuine reload (plugin toggle) must re-read the disabled set fresh. The
  // set itself is kept as the failure fallback; only its freshness is dropped.
  disabledStale = true;
  disabledInFlight = null;
}

/**
 * The set of capability and extension ids switched off for this project —
 * already resolved by the server, so the build's own defaults and any project
 * countermand are applied and callers see one flat answer.
 *
 * This is the ONLY reader of `/api/config/plugins`. Every registry's
 * `_applyDisabledFilter` and the extensions catalog come through here, so a
 * rebuild reads the config once and no two of them can split on different sets.
 *
 * Returns null when the set is genuinely unknown — the config could not be read
 * and nothing has ever been read successfully. Callers must treat that as "leave
 * things as they are"; treating it as empty would switch every disabled
 * capability back on for as long as the blip lasts.
 * @returns {Promise<Set<string>|null>} Disabled ids, or null when unknown
 */
export async function fetchDisabledPluginIds() {
  return (await loadPluginConfig())?.disabled ?? null;
}

/**
 * What the config remembers about each switched-off id: which extension and
 * module file it came from, its type and its name. Recorded when a capability is
 * switched off, so a row can still describe it once the module that defines it
 * stops loading and its id becomes unknowable from the running app.
 *
 * A hint and nothing more — it never decides whether something is disabled, only
 * how it is described. Empty is always a valid answer.
 * @returns {Promise<Record<string, {extension?: string, file?: string, type?: string, name?: string}>>} Description keyed by capability id
 */
export async function fetchPluginAttribution() {
  return (await loadPluginConfig())?.attribution ?? {};
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
  const [ci, st, cm, fv] = await Promise.all([
    import('../registries/context-item-registry.js'),
    import('../registries/strategy-registry.js'),
    import('../registries/command-registry.js'),
    import('../registries/file-viewer-registry.js'),
  ]);
  /** @type {Set<string>} */
  const ids = new Set();
  for (const reg of [ci.default, st.default, cm.default, fv.default]) {
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
  const [known, enabledPluginIds] = await Promise.all([
    fetchDisabledPluginIds(),
    collectEnabledPluginIds(),
  ]);
  const disabled = known || new Set();

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
  return await fetchJson(apiUrl('/extensions/locations'), { fallback: { ...EMPTY_LOCATIONS } })
    || { ...EMPTY_LOCATIONS };
}
