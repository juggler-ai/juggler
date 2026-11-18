//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { validateManifest } from './lib/manifest.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Search backend manifest — static metadata describing a backend.
 * @typedef {object} SearchBackendManifest
 * @property {string} id - Backend identifier, kebab-case (e.g. 'tavily'), unique
 *   among the backends of all enabled extensions. The Web search setting stores
 *   a backend as `<extension id>/<id>` (`@me/acme/acme`), so changing either
 *   drops the backend from every user's order.
 * @property {string} name - Human-readable name. Shown in Settings, and to the
 *   model as the provider that answered.
 * @property {string} version - Semantic version
 * @property {string} description - One sentence: what it searches and what it needs (an API key, a URL).
 * @property {string} [author] - Who wrote it
 * @property {string[]} [requiredSettings] - Keys of the extension's
 *   `juggler.extension.json` settings this backend cannot search without (an
 *   API key, a server URL). Until every one has a value, Settings → Web search
 *   offers a link to set the backend up instead of a switch. List only what is
 *   truly required: an optional setting here strands the backend behind that link.
 */

/**
 * What a backend is asked for. Domain filters are a hint: the WebSearch tool
 * filters every backend's results by domain afterwards, so a backend that
 * cannot narrow its search by domain may ignore them. Later versions may add
 * optional fields; a backend ignores any it does not know.
 * @typedef {object} SearchRequest
 * @property {string} query - The search query
 * @property {number} count - The most results the tool will show. A ceiling, not
 *   a target: return fewer when the service caps its page size.
 * @property {string[]} [allowedDomains] - Only results from these domains
 * @property {string[]} [blockedDomains] - No results from these domains
 * @property {AbortSignal} [signal] - Aborted when the tool call is cancelled
 */

/**
 * One search result.
 * @typedef {object} SearchResultItem
 * @property {string} title - Result title
 * @property {string} url - Result URL
 * @property {string} [description] - Snippet or summary
 * @property {string} [date] - Publication date, as the backend gives it
 */

/**
 * What a backend answers. An empty `results` is a genuine "nothing found" —
 * a backend that could not search throws instead.
 * @typedef {object} SearchResponse
 * @property {SearchResultItem[]} results - Results, best first
 */

/**
 * The backend refused this connection for now: rate-limited, a captcha, quota
 * spent. The WebSearch tool rests the backend for a while (see
 * {@link SearchBlockedError#retryAfterMs}; the tool caps the rest) and tries
 * the next one in the user's order.
 *
 * The tool recognises both error types by `name`, not `instanceof`, so a
 * subclass must keep the name its base class sets.
 */
export class SearchBlockedError extends Error {
  /**
   * @param {string} message - Why, in words the model can act on
   * @param {{retryAfterMs?: number}} [options] - How long the backend asked to be left alone, when it said
   */
  constructor(message, { retryAfterMs } = {}) {
    super(message);
    this.name = 'SearchBlockedError';
    /** @type {number|undefined} */
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The backend cannot be used until the user configures it — no API key, no
 * server URL. The WebSearch tool skips it without a word unless no backend
 * could search, and then names the setting.
 */
export class SearchNotConfiguredError extends Error {
  /** @param {string} message - What is missing and where to set it */
  constructor(message) {
    super(message);
    this.name = 'SearchNotConfiguredError';
  }
}

/**
 * Check a backend class's manifest. Throws with a message naming the class.
 * @param {typeof SearchBackend} ctor - The backend class
 * @throws {Error} When the manifest cannot be acted on as written
 */
export function validateSearchBackendManifest(ctor) {
  validateManifest(ctor);
  const className = ctor?.name || 'SearchBackend';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(ctor.MANIFEST.id))) {
    throw new Error(`${className}.MANIFEST.id must be kebab-case (got "${ctor.MANIFEST.id}")`);
  }
  const required = ctor.MANIFEST.requiredSettings;
  if (required !== undefined && (!Array.isArray(required) ||
      !required.every((key) => typeof key === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(key)))) {
    throw new Error(`${className}.MANIFEST.requiredSettings must be an array of setting keys`);
  }
  if (typeof ctor.prototype.search !== 'function' || ctor.prototype.search === SearchBackend.prototype.search) {
    throw new Error(`${className} must implement search()`);
  }
}

// ============================================================================
// SearchBackend Base Class
// ============================================================================

/**
 * SearchBackend - base class for the services the WebSearch tool searches with.
 *
 * The model always sees one tool, `WebSearch`; which service answers is the
 * user's choice, made in Settings → Web search as an ordered list. WebSearch
 * asks each backend in that order and stops at the first that answers. A
 * backend is a request and a mapping — the tool owns the schema, the domain
 * filtering, the fallback, the rest period after a block, and the rendering.
 *
 * Backends run only in the engine, where tools run. Throw
 * {@link SearchNotConfiguredError} when a key or URL is missing,
 * {@link SearchBlockedError} when the service refuses for now, and any other
 * error for a failure worth reporting; return an empty `results` only for a
 * genuine "nothing found".
 *
 * Declare settings (an API key: `"type": "secret"`) in the extension's
 * `juggler.extension.json`, with `"capability": "search-backend:<id>"` so they
 * appear on the backend's page in Extensions; name the ones it cannot search
 * without in `MANIFEST.requiredSettings`; and read them with
 * `extensionConfigResolve`. Settings → Web search decides from
 * `requiredSettings` whether a backend is set up; `SearchNotConfiguredError` is
 * what `search()` throws if one is empty all the same.
 *
 * ```javascript
 * import SearchBackend, { SearchNotConfiguredError, SearchBlockedError } from 'juggler/search-backend';
 * import { extensionConfigResolve, httpRequest } from 'juggler/ops';
 *
 * export default class AcmeSearchBackend extends SearchBackend {
 *   static MANIFEST = {
 *     id: 'acme',
 *     name: 'Acme Search',
 *     version: '1.0.0',
 *     description: 'Searches with the Acme API (needs an API key)',
 *     requiredSettings: ['acme_api_key']
 *   };
 *
 *   async search({ query, count, signal }) {
 *     const { acme_api_key: key } = await extensionConfigResolve({ extId: '@me/acme' }, signal);
 *     if (!key) throw new SearchNotConfiguredError('Acme API key is not set (Settings → Extensions → Acme Search)');
 *     const res = await httpRequest({
 *       method: 'GET',
 *       url: `https://api.acme.example/search?q=${encodeURIComponent(query)}&n=${count}`,
 *       headers: { authorization: `Bearer ${key}` }
 *     }, signal);
 *     if (res.status === 429) throw new SearchBlockedError('Acme is rate-limiting this key');
 *     if (res.status !== 200) throw new Error(`Acme search failed (HTTP ${res.status})`);
 *     return { results: JSON.parse(res.body).hits.map(h => ({ title: h.title, url: h.link, description: h.text })) };
 *   }
 * }
 * ```
 *
 * Method reference:
 * - `search(request: SearchRequest) → Promise<SearchResponse>`
 * @class
 * @abstract
 */
class SearchBackend {
  /**
   * Backend manifest (static property set by subclasses)
   * @type {SearchBackendManifest}
   * @static
   */
  static MANIFEST;

  constructor() {
    if (new.target === SearchBackend) {
      throw new Error('SearchBackend is an abstract class and cannot be instantiated directly');
    }
    validateSearchBackendManifest(/** @type {typeof SearchBackend} */ (this.constructor));
  }

  /**
   * Run one search. Override.
   * @param {SearchRequest} _request - What to search for
   * @returns {Promise<SearchResponse>} The results
   */
  async search(_request) {
    throw new Error('search() not implemented');
  }
}

export default SearchBackend;
