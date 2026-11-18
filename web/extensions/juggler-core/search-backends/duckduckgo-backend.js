//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import SearchBackend, { SearchBlockedError } from 'juggler/search-backend';
import { webSearch } from 'juggler/ops';
import { parseDuckDuckGoResponse, looksLikeNoResults } from '../context-items/web-search/ddg-parser.js';

/**
 * DuckDuckGoSearchBackend - DuckDuckGo's HTML results page, scraped.
 *
 * Needs no key, which is why it is the default. The server's `websearch` op is
 * only a CORS proxy; the request, the scraping (`ddg-parser.js`) and the retry
 * ladder live here.
 *
 * DuckDuckGo throttles bursts of requests from one IP, answering with HTTP 202
 * and a challenge page instead of results (the proxy reports that, and
 * 403/429, as `blocked`). A blocked response, or a 200 page with zero result
 * blocks and no genuine "no results" marker, is retried with exponential
 * backoff + jitter up to {@link DuckDuckGoSearchBackend.MAX_RETRIES} times; a
 * block that outlasts them is a {@link SearchBlockedError}, after which the
 * WebSearch tool rests this backend. A genuine empty result set (the
 * `no-results` marker on an unblocked page) is returned as zero results.
 * @augments SearchBackend
 */
class DuckDuckGoSearchBackend extends SearchBackend {
  static MANIFEST = {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    version: '1.0.0',
    description: 'Searches DuckDuckGo (no API key required, but it may rate-limit busy or shared connections)',
    author: 'Juggler Team'
  };

  // DuckDuckGo HTML endpoint URL
  static DDG_URL = 'https://html.duckduckgo.com/html/';

  // A block lasts seconds to minutes, so a retry inside a second only re-hits
  // it (and can prolong it). The waits are 5–10s then 10–15s (base · 2^n plus
  // up to one base of jitter), ~15–25s in all before the block is reported.
  static MAX_RETRIES = 2;
  static RETRY_BASE_MS = 5000;

  /**
   * Build DuckDuckGo search params (POST)
   * @param {string} query - Search query
   * @returns {object} Params for the server's CORS proxy
   */
  buildDuckDuckGoParams(query) {
    return {
      url: DuckDuckGoSearchBackend.DDG_URL,
      method: 'POST',
      form_data: {
        q: query,
        b: '',  // offset
        kl: ''  // region
      }
    };
  }

  /**
   * Fetch one results page through the proxy — the one place a search
   * touches the network.
   * @param {object} params - Proxy params from {@link buildDuckDuckGoParams}
   * @param {AbortSignal} [signal] - Aborts the request
   * @returns {Promise<import('../../../js/services/ops-api.js').WebSearchProxyResponse>} Proxy response
   */
  fetchSearchPage(params, signal) {
    return webSearch(
      /** @type {import('../../../js/services/ops-api.js').WebSearchParams} */ (params),
      signal
    );
  }

  /**
   * Abortable delay used for retry backoff. Rejects promptly if the search's
   * abort signal fires while waiting, so a cancelled search does not sit out
   * the backoff.
   * @param {number} ms - Milliseconds to wait
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<void>} Resolves after `ms`, rejects on abort
   */
  delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Aborted'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
      }, { once: true });
    });
  }

  /**
   * @param {import('juggler/search-backend').SearchRequest} request - What to search for
   * @returns {Promise<import('juggler/search-backend').SearchResponse>} The results
   */
  async search({ query, signal }) {
    const params = this.buildDuckDuckGoParams(query);
    const maxAttempts = DuckDuckGoSearchBackend.MAX_RETRIES + 1;
    const startedAt = Date.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.fetchSearchPage(params, signal);

      const blocked = response.blocked === true;
      const results = blocked ? [] : parseDuckDuckGoResponse(response.content);
      if (results.length > 0 || (!blocked && looksLikeNoResults(response.content))) {
        return { results }; // got hits, or a genuine empty result set — either way, done
      }

      // Refused outright, or zero result blocks and no "no results" marker
      // (almost certainly a captcha page). Retry with backoff unless attempts
      // are spent.
      if (attempt === maxAttempts) {
        const spanS = Math.round((Date.now() - startedAt) / 1000);
        throw new SearchBlockedError(blocked
          ? `DuckDuckGo refused the search (HTTP ${response.status}) on all ${maxAttempts} attempts over ${spanS}s: it is rate-limiting this connection.`
          : 'DuckDuckGo returned no results and no "no results" page, which usually means a captcha: it is blocking this connection.');
      }
      const backoff = DuckDuckGoSearchBackend.RETRY_BASE_MS * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * DuckDuckGoSearchBackend.RETRY_BASE_MS);
      await this.delay(backoff + jitter, signal);
    }
    return { results: [] }; // unreachable: the last attempt returns or throws
  }
}

export default DuckDuckGoSearchBackend;
