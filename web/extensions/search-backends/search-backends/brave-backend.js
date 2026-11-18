//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { ApiSearchBackend, field, mapResults } from '../lib/api-search.js';
import { withSiteFilter } from '../lib/query.js';

/**
 * Brave Search — an independent index. Metered (with a monthly credit); not
 * reachable from mainland China.
 * @augments ApiSearchBackend
 */
class BraveSearchBackend extends ApiSearchBackend {
  static MANIFEST = {
    id: 'brave',
    name: 'Brave Search',
    version: '1.0.0',
    description: 'Searches with the Brave Search API (needs an API key)',
    author: 'Juggler Team',
    requiredSettings: ['brave_api_key']
  };

  static NOT_CONFIGURED = 'Brave Search API key is not set (Settings → Extensions → Web Search Services → Brave Search).';

  /**
   * @param {import('juggler/search-backend').SearchRequest} request - What to search for
   * @param {string} key - API key
   * @returns {import('../lib/api-search.js').ApiRequest} The request
   */
  buildRequest({ query, count, allowedDomains }, key) {
    const params = new URLSearchParams({ q: withSiteFilter(query, allowedDomains), count: String(Math.min(count, 20)) });
    return {
      method: 'GET',
      url: `https://api.search.brave.com/res/v1/web/search?${params}`,
      headers: { 'x-subscription-token': key }
    };
  }

  /**
   * @param {unknown} payload - Parsed body
   * @returns {import('juggler/search-backend').SearchResultItem[]} Results
   */
  parse(payload) {
    // A query with no web results has no `web` section at all.
    return mapResults(field(payload, 'web', 'results') ?? [], 'Brave Search', (r) => ({
      title: r.title, url: r.url, description: r.description, date: r.page_age
    }));
  }
}

export default BraveSearchBackend;
