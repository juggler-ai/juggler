//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import ContextItem from 'juggler/context-item';
import { resolveSearchBackends } from '../../../js/services/web-search-backends.js';
import { translator, markUntranslated } from 'juggler/i18n';
import { filterResults } from './web-search/ddg-parser.js';

const t = translator('@juggler/core');

/**
 * @typedef {object} WebSearchParams
 * @property {string} query - The search query
 * @property {string[]} [allowed_domains] - Only include results from these domains
 * @property {string[]} [blocked_domains] - Exclude results from these domains
 */

/** @typedef {import('juggler/search-backend').SearchResultItem} WebSearchResultItem */
/** @typedef {import('../../../js/services/web-search-backends.js').ResolvedSearchBackend} ResolvedSearchBackend */

/**
 * @typedef {object} WebSearchResult
 * @property {string} query - The search query
 * @property {WebSearchResultItem[]} results - Search results
 * @property {number} count - Number of results
 * @property {string} provider - Name of the backend that answered (e.g. "DuckDuckGo")
 * @property {string[]} [failedFirst] - Why each backend tried before it failed,
 *   when one did — a revoked key would otherwise go unnoticed behind the next
 *   backend's answers. Unconfigured and resting backends are not listed.
 */

/** Most results a search returns. */
const MAX_RESULTS = 10;

/**
 * WebSearchContextItem - Search the web
 *
 * The one search tool the model sees. Which service answers is the user's Web
 * search setting: an ordered list of search backends (`juggler/search-backend`,
 * contributed by extensions; DuckDuckGo by default). This class asks them in
 * that order and stops at the first that answers; it owns the schema, the
 * domain filtering, the rest period after a block, and the rendering.
 * @class
 * @augments ContextItem
 */
class WebSearchContextItem extends ContextItem {
  /** @returns {{color: string, icon?: string}} Badge options */
  static getBadgeOptions() {
    return { color: 'web', icon: 'icon-search' };
  }

  static MANIFEST = {
    id: 'web-search',
    name: 'Web Search',
    version: '3.0.0',
    description: 'Search the web with the services chosen in Settings → Web search',
    author: 'Juggler Team',
    requiresApproval: false
  };

  // After a backend reports a block (SearchBlockedError), every search in this
  // realm skips it, without contacting it, until this long has passed (or as
  // long as it asked) — so a model that retries straight away, or a parallel
  // conversation, does not keep the block alive. A wait the backend asks for is
  // capped at MAX_REST_MS, so one bad Retry-After cannot switch it off for the
  // day. Keyed by backend key (`<extension id>/<id>`); the value is the epoch
  // ms the rest ends.
  static REST_MS = 60000;
  static MAX_REST_MS = 15 * 60000;
  /** @type {Map<string, number>} */
  static restingUntil = new Map();

  /**
   * Get tool definitions for WebSearch action
   * @returns {Array<{name: string, category: string, description: string, input_schema: import('juggler/strategy-type').JSONObjectSchema}>} Tool definitions
   */
  static getToolDefinitions() {
    /** @type {import('juggler/strategy-type').JSONObjectSchema} */
    const inputSchema = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 2,
          description: markUntranslated('The search query to use')
        },
        allowed_domains: {
          type: 'array',
          items: { type: 'string' },
          description: markUntranslated('Only include search results from these domains')
        },
        blocked_domains: {
          type: 'array',
          items: { type: 'string' },
          description: markUntranslated('Exclude search results from these domains')
        }
      },
      required: ['query']
    };

    // Backend-neutral on purpose: the tool list is part of the cached prompt,
    // and the result names the service that answered.
    const description = markUntranslated('Searches the web. Returns up to 10 results with titles, URLs, and descriptions. Supports domain filtering.');

    return [
      {
        name: 'WebSearch',
        category: 'read',
        description,
        input_schema: inputSchema
      }
    ];
  }

  /**
   * The backends to ask, in the user's order. A seam for tests.
   * @returns {Promise<ResolvedSearchBackend[]>} Possibly empty
   */
  resolveBackends() {
    return resolveSearchBackends(this.signal);
  }

  /**
   * Search with the first backend in the user's order that answers.
   *
   * A backend that is resting after a block is skipped without a request; one
   * that is not configured (no key) is skipped quietly; one that reports a
   * block is rested for {@link WebSearchContextItem.REST_MS} (or what it asked
   * for, up to {@link WebSearchContextItem.MAX_REST_MS}) and the next is tried;
   * any other failure is noted — in the result, when a later backend answers —
   * and the next is tried. Only when none answers does the search fail, with
   * every backend's reason. Cancellation is never caught.
   * @param {string} query - Search query
   * @param {string[]} [allowedDomains] - Allowed domains
   * @param {string[]} [blockedDomains] - Blocked domains
   * @returns {Promise<WebSearchResult>} Search result
   */
  async search(query, allowedDomains, blockedDomains) {
    const backends = await this.resolveBackends();
    if (backends.length === 0) {
      throw new Error('No web search service is available: none is chosen in Settings → Web search, or every one chosen is switched off or not installed. Carry on without search, or ask the user to choose one there.');
    }

    /** @type {string[]} */
    const failures = [];
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const unconfigured = [];
    for (const { id, name, backend } of backends) {
      const restingMs = (WebSearchContextItem.restingUntil.get(id) ?? 0) - Date.now();
      if (restingMs > 0) {
        failures.push(`${name} is rate-limiting this connection, so searches with it are paused for another ${Math.ceil(restingMs / 1000)}s. Retrying sooner would only extend the block.`);
        continue;
      }
      try {
        const response = await backend.search({
          query,
          count: MAX_RESULTS,
          allowedDomains,
          blockedDomains,
          signal: this.signal
        });
        const filtered = filterResults(Array.isArray(response?.results) ? response.results : [], allowedDomains, blockedDomains);
        return {
          query,
          results: filtered.slice(0, MAX_RESULTS),
          count: filtered.length,
          provider: name,
          ...(errors.length > 0 ? { failedFirst: errors } : {})
        };
      } catch (err) {
        if (this.signal?.aborted) throw err;
        const error = /** @type {Error & {retryAfterMs?: number}} */ (err);
        // Matched by name, not instanceof: a user extension may reach the SDK
        // through a different module instance than this one.
        if (error?.name === 'SearchNotConfiguredError') {
          unconfigured.push(`${name}: ${error.message}`);
        } else if (error?.name === 'SearchBlockedError') {
          const asked = Number(error.retryAfterMs);
          const restMs = Number.isFinite(asked) && asked > 0
            ? Math.min(asked, WebSearchContextItem.MAX_REST_MS)
            : WebSearchContextItem.REST_MS;
          WebSearchContextItem.restingUntil.set(id, Date.now() + restMs);
          failures.push(`${error.message} Searches with ${name} are paused for ${Math.round(restMs / 1000)}s.`);
        } else {
          const reason = `${name} failed: ${error?.message || String(err)}`;
          failures.push(reason);
          errors.push(reason);
        }
      }
    }

    const lines = [...failures, ...unconfigured];
    const reason = lines.length === 1 ? lines[0] : `No web search service could answer:\n${lines.map(l => `- ${l}`).join('\n')}`;
    // Said once the user's whole list has failed: there is nothing else to try
    // until they add or configure another service.
    throw new Error(`${reason}\nCarry on without search, or ask the user to add or configure another service in Settings → Web search.`);
  }

  /**
   * Validate and normalize parameters for execution
   * @override
   * @param {Record<string, unknown>} toolInput - Raw parameters from LLM
   * @returns {Promise<import('juggler/context-item').ValidationResult>} Validation result
   */
  async validate(toolInput) {
    const params = /** @type {WebSearchParams} */ (toolInput);

    if (!params.query) {
      return { valid: false, error: 'Missing required parameter: query' };
    }
    if (typeof params.query !== 'string') {
      return { valid: false, error: 'Parameter "query" must be a string' };
    }
    if (params.query.length < 2) {
      return { valid: false, error: 'Parameter "query" must be at least 2 characters' };
    }

    return { valid: true, params: toolInput };
  }

  /**
   * Execute the web search
   * @param {Record<string, unknown>} params - Prepared params from prepare
   * @returns {Promise<WebSearchResult>} Search result
   */
  async execute(params) {
    const searchParams = /** @type {WebSearchParams} */ (params);

    return await this.search(
      searchParams.query,
      searchParams.allowed_domains,
      searchParams.blocked_domains
    );
  }

  /**
   * Format any action outcome for display
   * @param {import('juggler/context-item').Outcome} outcome - Action outcome
   * @returns {import('juggler/context-item').ItemSummary} Formatted result
   */
  getSummary(outcome) {
    const prepared = outcome.prepared;
    const prepParams = /** @type {{query?: string}} */ (prepared?.params || {});
    const query = prepParams.query || 'unknown';

    if (!outcome.success) {
      return this.failureSummary(outcome.error || `Search failed for "${query}"`);
    }

    const result = /** @type {WebSearchResult} */ (outcome.result);
    const results = result.results || [];
    // Said so the model can tell the user: otherwise a broken first choice is
    // invisible behind the next one's answers.
    const failedFirst = result.failedFirst?.length
      ? `\n(Answered by ${result.provider} because ${result.failedFirst.length === 1 ? 'an earlier service' : 'earlier services'} in Settings → Web search failed: ${result.failedFirst.join('; ')})`
      : '';

    if (results.length === 0) {
      return this.successSummary(markUntranslated(`No results found for "${query}"${failedFirst}`), { icon: '○' });
    }

    // Format results for LLM - include markdown links
    const lines = [`Search results for "${query}" (via ${result.provider}):${failedFirst}\n`];
    for (const item of results) {
      lines.push(`- [${item.title}](${item.url})`);
      if (item.description) {
        lines.push(`  ${item.description}`);
      }
      lines.push('');
    }

    return this.successSummary(this.truncateForLLM(lines.join('\n'), { keywords: [query] }));
  }

  /**
   * Get status UI configuration
   * @override
   * @param {import('../../../js/services/action-executor.js').ActionStatus|null} actionStatus - Action execution status
   * @param {Record<string, unknown>} toolInput - Original tool input parameters
   * @returns {import('juggler/context-item').ResultStatusMessage|null} Status message config
   */
  getStatusUI(actionStatus, toolInput) {
    const query = String(toolInput?.query || t('unknown'));
    const displayQuery = query.length > 40 ? query.substring(0, 40) + '...' : query;

    return this.buildStatusUI(actionStatus, {
      typeName: t('Web Search'),
      pending: t('Searching for "{query}"...', { query: displayQuery }),
      success: () => {
        const result = /** @type {WebSearchResult} */ (actionStatus?.result);
        const count = result.count || result.results?.length || 0;
        const provider = result.provider || t('search');
        return t(
          '{count, plural, one {Found {count} result for "{query}" ({provider})} other {Found {count} results for "{query}" ({provider})}}',
          { count, query: displayQuery, provider }
        );
      }
    });
  }

  /**
   * @override
   * @param {string} _toolName
   * @returns {string} Section label
   */
  static getResultSectionLabel(_toolName) {
    return t('Results');
  }

  /**
   * @override
   * @param {HTMLElement} wrapper
   * @param {import('juggler/context-item').ToolActionRenderContext} ctx
   * @returns {{ skipResultSection?: boolean } | void} Render result; set skipResultSection to true when output is rendered inline
   */
  renderToolActionDetails(wrapper, ctx) {
    const { input, helpers } = ctx;
    const q = input.query !== null && input.query !== undefined ? String(input.query) : '';
    helpers.addSubsection(wrapper, t('Query'), q, 'properties-panel-code');
  }
}

export default WebSearchContextItem;
