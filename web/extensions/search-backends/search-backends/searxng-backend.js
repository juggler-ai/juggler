//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import { ApiSearchBackend, field, mapResults } from '../lib/api-search.js';
import { withSiteFilter } from '../lib/query.js';
import { markUntranslated } from 'juggler/i18n';

/**
 * SearXNG — a self-hosted metasearch server, queried through its JSON API.
 * The server must list `json` under `search.formats` in its settings.yml;
 * otherwise it answers 403.
 * @augments ApiSearchBackend
 */
class SearxngSearchBackend extends ApiSearchBackend {
  static MANIFEST = {
    id: 'searxng',
    name: 'SearXNG',
    version: '1.0.0',
    description: 'Searches a SearXNG server you run (needs its URL, with the JSON format enabled)',
    author: 'Juggler Team',
    requiredSettings: ['searxng_url']
  };

  static NOT_CONFIGURED = 'SearXNG server URL is not set (Settings → Extensions → Web Search Services → SearXNG).';

  /**
   * @param {import('juggler/search-backend').SearchRequest} request - What to search for
   * @param {string} base - Server URL
   * @returns {import('../lib/api-search.js').ApiRequest} The request
   */
  buildRequest({ query, allowedDomains }, base) {
    const params = new URLSearchParams({ q: withSiteFilter(query, allowedDomains), format: 'json' });
    return {
      method: 'GET',
      url: `${base.replace(/\/+$/, '').replace(/\/search$/, '')}/search?${params}`,
      // The user named this server, and it is often on their own machine or LAN.
      allowPrivateHosts: true
    };
  }

  /**
   * SearXNG answers 403 when its JSON format is off; it takes no key to refuse.
   * @param {number} status - HTTP status
   * @returns {Error|null} The error to throw
   */
  statusError(status) {
    return status === 403
      ? new Error(markUntranslated('SearXNG refused the JSON format (HTTP 403): add json under search.formats in its settings.yml.'))
      : null;
  }

  /**
   * @param {unknown} payload - Parsed body
   * @returns {import('juggler/search-backend').SearchResultItem[]} Results
   */
  parse(payload) {
    return mapResults(field(payload, 'results'), 'SearXNG', (r) => ({
      title: r.title, url: r.url, description: r.content, date: r.publishedDate
    }));
  }
}

export default SearxngSearchBackend;
