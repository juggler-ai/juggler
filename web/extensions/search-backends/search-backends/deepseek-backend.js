//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { ApiSearchBackend, field, mapResults } from '../lib/api-search.js';
import { withSiteFilter } from '../lib/query.js';

/**
 * DeepSeek's Search API. Hosted in mainland China and billed in CNY; works
 * well for Chinese queries.
 * @augments ApiSearchBackend
 */
class DeepSeekSearchBackend extends ApiSearchBackend {
  static MANIFEST = {
    id: 'deepseek',
    name: 'DeepSeek Search',
    version: '1.0.0',
    description: 'Searches with the DeepSeek Search API (needs a DeepSeek API key)',
    author: 'Juggler Team',
    requiredSettings: ['deepseek_api_key']
  };

  static NOT_CONFIGURED = 'DeepSeek API key for search is not set (Settings → Extensions → Web Search Services → DeepSeek Search).';

  /**
   * @param {import('juggler/search-backend').SearchRequest} request - What to search for
   * @param {string} key - API key
   * @returns {import('../lib/api-search.js').ApiRequest} The request
   */
  buildRequest({ query, count, allowedDomains }, key) {
    return {
      method: 'POST',
      url: 'https://api.deepseek.com/v1/tools/search',
      headers: { authorization: `Bearer ${key}` },
      // The API takes at most 128 characters of query.
      json: { query: withSiteFilter(query, allowedDomains).slice(0, 128), count }
    };
  }

  /**
   * @param {unknown} payload - Parsed body
   * @returns {import('juggler/search-backend').SearchResultItem[]} Results
   */
  parse(payload) {
    return mapResults(field(payload, 'results'), 'DeepSeek Search', (r) => ({
      title: r.title, url: r.url, description: r.summary || r.snippet, date: r.date
    }));
  }
}

export default DeepSeekSearchBackend;
