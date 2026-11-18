//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { ApiSearchBackend, field, mapResults } from '../lib/api-search.js';

/**
 * Zhipu (智谱) web search API, standard engine. Hosted in mainland China and
 * billed in CNY; uses the same key as the GLM models on open.bigmodel.cn.
 * @augments ApiSearchBackend
 */
class ZhipuSearchBackend extends ApiSearchBackend {
  static MANIFEST = {
    id: 'zhipu',
    name: 'Zhipu Search',
    version: '1.0.0',
    description: 'Searches with the Zhipu (智谱) web search API (needs a BigModel API key)',
    author: 'Juggler Team',
    requiredSettings: ['zhipu_api_key']
  };

  static NOT_CONFIGURED = 'Zhipu API key for search is not set (Settings → Extensions → Web Search Services → Zhipu Search).';

  /**
   * @param {import('juggler/search-backend').SearchRequest} request - What to search for
   * @param {string} key - API key
   * @returns {import('../lib/api-search.js').ApiRequest} The request
   */
  buildRequest({ query, count }, key) {
    return {
      method: 'POST',
      url: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      headers: { authorization: `Bearer ${key}` },
      // The API takes at most 70 characters of query.
      json: { search_query: query.slice(0, 70), search_engine: 'search_std', count }
    };
  }

  /**
   * @param {unknown} payload - Parsed body
   * @returns {import('juggler/search-backend').SearchResultItem[]} Results
   */
  parse(payload) {
    return mapResults(field(payload, 'search_result'), 'Zhipu Search', (r) => ({
      title: r.title, url: r.link, description: r.content, date: r.publish_date
    }));
  }
}

export default ZhipuSearchBackend;
