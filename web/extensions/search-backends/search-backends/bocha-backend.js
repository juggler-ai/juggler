//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { ApiSearchBackend, field, mapResults } from '../lib/api-search.js';

/**
 * Bocha (博查) Web Search API. Hosted in mainland China and billed in CNY;
 * strong on Chinese queries.
 * @augments ApiSearchBackend
 */
class BochaSearchBackend extends ApiSearchBackend {
  static MANIFEST = {
    id: 'bocha',
    name: 'Bocha',
    version: '1.0.0',
    description: 'Searches with the Bocha (博查) Web Search API (needs an API key)',
    author: 'Juggler Team',
    requiredSettings: ['bocha_api_key']
  };

  static NOT_CONFIGURED = 'Bocha API key is not set (Settings → Extensions → Web Search Services → Bocha).';

  /**
   * @param {import('juggler/search-backend').SearchRequest} request - What to search for
   * @param {string} key - API key
   * @returns {import('../lib/api-search.js').ApiRequest} The request
   */
  buildRequest({ query, count }, key) {
    return {
      method: 'POST',
      url: 'https://api.bochaai.com/v1/web-search',
      headers: { authorization: `Bearer ${key}` },
      json: { query, count, summary: true, freshness: 'noLimit' }
    };
  }

  /**
   * @param {unknown} payload - Parsed body
   * @returns {import('juggler/search-backend').SearchResultItem[]} Results
   */
  parse(payload) {
    // The results sit under `data`, beside the request's code and log id.
    return mapResults(field(payload, 'data', 'webPages', 'value') ?? field(payload, 'webPages', 'value'), 'Bocha', (r) => ({
      title: r.name, url: r.url, description: r.summary || r.snippet, date: r.datePublished
    }));
  }
}

export default BochaSearchBackend;
