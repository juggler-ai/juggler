//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The Web search setting: which search backends the WebSearch tool may use,
 * and in what order — and which of them are set up.
 *
 * Stored as `webSearch.order` in settings.json (core.WebSearchSettings), a
 * list of backend keys, `<extension id>/<backend MANIFEST id>`: a key names a
 * backend only as the extension that provides it, so a different extension
 * offering the same id never inherits the user's choice. Absent means the
 * default, DuckDuckGo alone; an empty list means no backend at all.
 *
 * The engine reads the setting afresh at every search, so a change made in any
 * window applies to the next search without a broadcast. A key that no enabled
 * extension provides is kept in the setting and skipped here, so a backend
 * whose extension is off for a while comes back in its place.
 *
 * Whether a backend is set up is declared by the backend itself
 * (`MANIFEST.requiredSettings`) and answered by {@link readBackendSetup}.
 * @module services/web-search-backends
 */

import searchBackendRegistry from '../registries/search-backend-registry.js';
import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';
import { updateSettings } from './settings-api.js';
import { fetchExtensions } from './extensions.js';
import { extensionConfigGet } from './ops-api.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';

/**
 * The order used while none is stored: DuckDuckGo, which needs no key.
 * @type {readonly string[]}
 */
const DEFAULT_SEARCH_ORDER = Object.freeze(['@juggler/core/duckduckgo']);

/**
 * A search backend ready to be asked, in the user's order.
 * @typedef {object} ResolvedSearchBackend
 * @property {string} id - The backend's key, `<extension id>/<MANIFEST id>`
 * @property {string} name - Its display name, which the tool reports as the provider
 * @property {import('juggler/search-backend').default} backend - An instance to call `search()` on
 */

/**
 * The key the setting stores a backend under.
 * @param {string} extensionId - The providing extension's id
 * @param {string} backendId - The backend's MANIFEST id
 * @returns {string} `<extensionId>/<backendId>`
 */
export function backendKey(extensionId, backendId) {
  return `${extensionId}/${backendId}`;
}

/**
 * Split a stored key into the extension and backend ids it names.
 * @param {string} key - `<extension id>/<MANIFEST id>`
 * @returns {{extensionId: string, backendId: string}|null} The parts, or null for a key without both
 */
function parseBackendKey(key) {
  const slash = key.lastIndexOf('/');
  if (slash <= 0 || slash === key.length - 1) return null;
  return { extensionId: key.slice(0, slash), backendId: key.slice(slash + 1) };
}

/**
 * The stored order, or the default when none is stored. An empty list is
 * kept: it is the user's choice of no backend.
 * @param {unknown} order - `webSearch.order` as read from the settings document
 * @returns {string[]} The order to use
 */
export function effectiveSearchOrder(order) {
  return Array.isArray(order)
    ? order.filter((key) => typeof key === 'string')
    : [...DEFAULT_SEARCH_ORDER];
}

/**
 * Read the order from the server. A failed read fails the search rather than
 * falling back to the default: a user who chose a service for privacy (their
 * own SearXNG) must not have the query sent to another.
 * @param {AbortSignal} [signal] - Abort signal
 * @returns {Promise<string[]>} Backend keys, first choice first
 * @throws {Error} When the setting cannot be read
 */
async function readSearchOrder(signal) {
  let doc;
  try {
    doc = await fetchJson(apiUrl('/settings'), { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(`Couldn't read the Web search setting, so no search was sent: ${extractErrorMessage(err)}`, { cause: err });
  }
  return effectiveSearchOrder(doc?.webSearch?.order);
}

/**
 * Store a new order.
 * @param {string[]|null} order - Backend keys, first choice first; `[]` for
 *   none, `null` to restore the default
 * @returns {Promise<string[]>} The order as stored (the default when none is)
 */
export async function saveSearchOrder(order) {
  const doc = await updateSettings({ webSearch: { order } });
  return effectiveSearchOrder(doc?.webSearch?.order);
}

/**
 * The backends the WebSearch tool should ask, in order: every key in the
 * setting whose backend is installed, switched on and provided by the
 * extension the key names, each a fresh instance.
 * @param {AbortSignal} [signal] - Abort signal
 * @returns {Promise<ResolvedSearchBackend[]>} Possibly empty
 * @throws {Error} When the setting cannot be read
 */
export async function resolveSearchBackends(signal) {
  const order = await readSearchOrder(signal);
  /** @type {ResolvedSearchBackend[]} */
  const resolved = [];
  for (const key of order) {
    const parts = parseBackendKey(key);
    if (!parts) continue;
    const Backend = searchBackendRegistry.get(parts.backendId);
    if (!Backend || searchBackendRegistry.getExtensionId(parts.backendId) !== parts.extensionId) continue;
    resolved.push({ id: key, name: Backend.MANIFEST.name, backend: new Backend() });
  }
  return resolved;
}

/**
 * Whether a stored setting value counts as filled in.
 * @param {import('./extensions.js').ExtensionSetting|undefined} setting - The setting's declaration
 * @param {unknown} value - Its value as `extconfig get` reports it
 * @returns {boolean} True when it has a value
 */
function hasValue(setting, value) {
  if (setting?.type === 'secret') return /** @type {{__present?: boolean}|null} */ (value)?.__present === true;
  return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null;
}

/**
 * Which installed backends are not yet set up — a setting named in their
 * `MANIFEST.requiredSettings` has no value — and which have settings to show
 * on their page in Extensions (`"capability": "search-backend:<id>"`). Keyed by
 * backend key. A required key the extension does not declare counts as unset,
 * so the mistake shows. An extension whose settings cannot be read counts as
 * set up, so its backends stay switchable rather than stuck behind a link.
 * @returns {Promise<{needsSetup: Set<string>, withSettings: Set<string>}>} Backend keys
 */
export async function readBackendSetup() {
  /** @type {Set<string>} */
  const needsSetup = new Set();
  /** @type {Set<string>} */
  const withSettings = new Set();
  /** @type {import('./extensions.js').Extension[]} */
  let extensions = [];
  try {
    extensions = await fetchExtensions();
  } catch {
    return { needsSetup, withSettings };
  }
  const manifests = new Map(extensions.map(({ manifest }) => [manifest?.id, manifest]));

  /** @type {Map<string, Array<{key: string, required: string[]}>>} */
  const requiredByExtension = new Map();
  for (const { id, manifest, extensionId } of searchBackendRegistry.getCatalogManifests()) {
    if (!extensionId) continue;
    const key = backendKey(extensionId, id);
    if ((manifests.get(extensionId)?.settings ?? []).some((s) => s.capability === `search-backend:${id}`)) {
      withSettings.add(key);
    }
    const required = manifest.requiredSettings ?? [];
    if (required.length === 0) continue;
    requiredByExtension.set(extensionId, [...(requiredByExtension.get(extensionId) ?? []), { key, required }]);
  }

  await Promise.all([...requiredByExtension].map(async ([extensionId, backends]) => {
    /** @type {Record<string, unknown>} */
    let values;
    try {
      values = /** @type {Record<string, unknown>} */ (await extensionConfigGet({ extId: extensionId })) ?? {};
    } catch {
      return;
    }
    const declared = new Map((manifests.get(extensionId)?.settings ?? []).map((s) => [s.key, s]));
    for (const { key, required } of backends) {
      if (!required.every((name) => declared.has(name) && hasValue(declared.get(name), values[name]))) {
        needsSetup.add(key);
      }
    }
  }));
  return { needsSetup, withSettings };
}
