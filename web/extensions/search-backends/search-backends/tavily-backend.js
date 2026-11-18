//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { ApiSearchBackend, field, mapResults } from '../lib/api-search.js';

/**
 * Tavily — a search API built for agents. Free tier of 1,000 searches a month;
 * reachable from mainland China.
 * @augments ApiSearchBackend
 */
class TavilySearchBackend extends ApiSearchBackend {
  static MANIFEST = {
    id: 'tavily',
    name: 'Tavily',
    version: '1.0.0',
    description: 'Searches with the Tavily API (needs an API key; free tier available)',
    author: 'Juggler Team',
    requiredSettings: ['tavily_api_key']
  };

  static NOT_CONFIGURED = 'Tavily API key is not set (Settings → Extensions → Web Search Services → Tavily).';

  /**
   * @param {import('juggler/search-backend').SearchRequest} request - What to search for
   * @param {string} key - API key
   * @returns {import('../lib/api-search.js').ApiRequest} The request
   */
  buildRequest({ query, count, allowedDomains, blockedDomains }, key) {
    return {
      method: 'POST',
      url: 'https://api.tavily.com/search',
      headers: { authorization: `Bearer ${key}` },
      json: {
        query,
        max_results: count,
        search_depth: 'basic',
        ...(allowedDomains?.length ? { include_domains: allowedDomains } : {}),
        ...(blockedDomains?.length ? { exclude_domains: blockedDomains } : {})
      }
    };
  }

  /**
   * @param {unknown} payload - Parsed body
   * @returns {import('juggler/search-backend').SearchResultItem[]} Results
   */
  parse(payload) {
    return mapResults(field(payload, 'results'), 'Tavily', (r) => ({
      title: r.title, url: r.url, description: r.content, date: r.published_date
    }));
  }
}

export default TavilySearchBackend;
