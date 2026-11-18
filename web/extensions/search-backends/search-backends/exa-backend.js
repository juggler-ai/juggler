//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { ApiSearchBackend, field, mapResults } from '../lib/api-search.js';

// Characters of matching passages asked for per result. A search result is a
// lead to follow; a page worth reading whole is worth a WebFetch.
const HIGHLIGHT_CHARS = 600;

/**
 * Exa — neural web search. Each result comes with the passages of the page
 * that match the query, which become its description.
 * @augments ApiSearchBackend
 */
class ExaSearchBackend extends ApiSearchBackend {
  static MANIFEST = {
    id: 'exa',
    name: 'Exa',
    version: '1.0.0',
    description: 'Searches with the Exa API, returning the passages that match (needs an API key)',
    author: 'Juggler Team',
    requiredSettings: ['exa_api_key']
  };

  static NOT_CONFIGURED = 'Exa API key is not set (Settings → Extensions → Web Search Services → Exa).';

  /**
   * @param {import('juggler/search-backend').SearchRequest} request - What to search for
   * @param {string} key - API key
   * @returns {import('../lib/api-search.js').ApiRequest} The request
   */
  buildRequest({ query, count, allowedDomains, blockedDomains }, key) {
    return {
      method: 'POST',
      url: 'https://api.exa.ai/search',
      headers: { 'x-api-key': key },
      json: {
        query,
        numResults: count,
        type: 'auto',
        contents: { highlights: { maxCharacters: HIGHLIGHT_CHARS } },
        ...(allowedDomains?.length ? { includeDomains: allowedDomains } : {}),
        ...(blockedDomains?.length ? { excludeDomains: blockedDomains } : {})
      }
    };
  }

  /**
   * @param {unknown} payload - Parsed body
   * @returns {import('juggler/search-backend').SearchResultItem[]} Results
   */
  parse(payload) {
    return mapResults(field(payload, 'results'), 'Exa', (r) => {
      const highlights = Array.isArray(r.highlights) ? r.highlights.filter((h) => typeof h === 'string') : [];
      return {
        title: r.title,
        url: r.url,
        description: highlights.join(' … ') || (typeof r.text === 'string' ? r.text.slice(0, HIGHLIGHT_CHARS) : ''),
        date: r.publishedDate
      };
    });
  }
}

export default ExaSearchBackend;
