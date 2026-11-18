//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

import SearchBackend, { SearchBlockedError, SearchNotConfiguredError } from 'juggler/search-backend';
import { extensionConfigResolve, httpRequest } from 'juggler/ops';
import { markUntranslated } from 'juggler/i18n';

/** This extension's id, under which its settings are stored. */
const EXTENSION_ID = '@juggler/search-backends';

/** How long a backend rests after it says its quota is spent and names no wait. */
const QUOTA_REST_MS = 15 * 60 * 1000;

/**
 * One HTTP request, as `httpRequest` takes it.
 * @typedef {object} ApiRequest
 * @property {'GET'|'POST'} method - HTTP method
 * @property {string} url - Full URL
 * @property {Record<string, string>} [headers] - Request headers
 * @property {unknown} [json] - Body, sent as JSON
 * @property {boolean} [allowPrivateHosts] - Allow a LAN or loopback host (a self-hosted server the user named)
 */

/**
 * The shared shape of a search service reached over a JSON API: read one
 * setting (an API key or a server URL), send one request, map the answer.
 * A subclass names the setting as the one entry of its
 * `MANIFEST.requiredSettings` — which is also how Settings → Web search knows
 * it is set up — and implements {@link buildRequest} and {@link parse}; the
 * status handling, which every service needs alike, is here, and
 * {@link statusError} lets a subclass say more for a status of its own.
 *
 * Not a backend itself — it lives outside `search-backends/`, so the
 * extension's glob never loads it.
 * @augments SearchBackend
 */
export class ApiSearchBackend extends SearchBackend {
  /**
   * What to tell the model when the setting is empty. Set by subclasses.
   * @type {string}
   */
  static NOT_CONFIGURED = '';

  /**
   * The setting's value, trimmed ('' when unset). A seam for tests.
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<string>} The value
   */
  async readSetting(signal) {
    const ctor = /** @type {typeof ApiSearchBackend} */ (this.constructor);
    const key = ctor.MANIFEST.requiredSettings?.[0] ?? '';
    const config = /** @type {Record<string, unknown>} */ (await extensionConfigResolve({ extId: EXTENSION_ID }, signal));
    const value = config?.[key];
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * The error for a failed status this service explains better than the
   * shared handling does, or null to use that. Override.
   * @param {number} _status - HTTP status
   * @param {unknown} _payload - The parsed body, or null
   * @returns {Error|null} The error to throw
   */
  statusError(_status, _payload) {
    return null;
  }

  /**
   * Send one request. A seam for tests.
   * @param {ApiRequest} req - The request
   * @param {AbortSignal} [signal] - Abort signal
   * @returns {Promise<{status: number, statusText: string, headers: Record<string, string>, body: string}>} The response
   */
  send(req, signal) {
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json', ...(req.headers || {}) };
    if (req.json !== undefined) headers['content-type'] = 'application/json';
    return httpRequest({
      method: req.method,
      url: req.url,
      headers,
      ...(req.json !== undefined ? { body: JSON.stringify(req.json) } : {}),
      ...(req.allowPrivateHosts ? { allowPrivateHosts: true } : {})
    }, signal);
  }

  /**
   * Build the request for one search. Override.
   * @param {import('juggler/search-backend').SearchRequest} _request - What to search for
   * @param {string} _setting - The setting's value (a key or a URL)
   * @returns {ApiRequest} The request
   */
  buildRequest(_request, _setting) {
    return notImplemented('buildRequest');
  }

  /**
   * Map a successful answer to results. Override. Throw when the payload is
   * not the shape the service documents; {@link field} reads into it.
   * @param {unknown} _payload - The parsed JSON body
   * @returns {import('juggler/search-backend').SearchResultItem[]} Results, best first
   */
  parse(_payload) {
    return notImplemented('parse');
  }

  /**
   * @param {import('juggler/search-backend').SearchRequest} request - What to search for
   * @returns {Promise<import('juggler/search-backend').SearchResponse>} The results
   */
  async search(request) {
    const ctor = /** @type {typeof ApiSearchBackend} */ (this.constructor);
    const name = ctor.MANIFEST.name;
    const setting = await this.readSetting(request.signal);
    if (!setting) throw new SearchNotConfiguredError(markUntranslated(ctor.NOT_CONFIGURED));

    const response = await this.send(this.buildRequest(request, setting), request.signal);
    /** @type {unknown} */
    let payload = null;
    try {
      payload = JSON.parse(response.body);
    } catch {
      // Left null: a non-JSON body is reported by status below, or as invalid.
    }
    const status = response.status;
    if (status < 200 || status >= 300) {
      const own = this.statusError(status, payload);
      if (own) throw own;
    }
    if (status === 429 || status === 402) {
      const retryAfterMs = retryAfter(response.headers) ?? (status === 402 ? QUOTA_REST_MS : undefined);
      throw new SearchBlockedError(markUntranslated(status === 402
        ? `${name} says this account's quota or balance is used up (HTTP 402).`
        : `${name} is rate-limiting this key (HTTP 429).`), { retryAfterMs });
    }
    if (status === 401 || status === 403) {
      throw new Error(markUntranslated(`${name} refused the API key (HTTP ${status}): check it on ${name}'s page in Settings → Extensions.`));
    }
    if (status < 200 || status >= 300) {
      throw new Error(markUntranslated(`${name} search failed (HTTP ${status}): ${errorMessage(payload, response)}`));
    }
    if (payload === null) {
      throw new Error(markUntranslated(`${name} returned a response that is not JSON (HTTP ${status})`));
    }
    return { results: this.parse(payload) };
  }
}

/**
 * Throw for a method a subclass was meant to override.
 * @param {string} method - Its name
 * @returns {never} Never returns
 */
function notImplemented(method) {
  throw new Error(`${method}() not implemented`);
}

/**
 * The wait a `Retry-After` header asks for, in ms, when it gives seconds.
 * @param {Record<string, string>} headers - Response headers
 * @returns {number|undefined} The wait, or undefined when none is given
 */
function retryAfter(headers) {
  const raw = Object.entries(headers || {}).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * The most useful error text in a failed answer.
 * @param {unknown} payload - Parsed body, or null
 * @param {{statusText: string, body: string}} response - The response
 * @returns {string} The message
 */
function errorMessage(payload, response) {
  const fromPayload = field(payload, 'error', 'message') ?? field(payload, 'error') ?? field(payload, 'message') ??
    field(payload, 'msg') ?? field(payload, 'detail');
  if (typeof fromPayload === 'string' && fromPayload) return fromPayload;
  return response.body.trim().slice(0, 300) || response.statusText || 'unknown error';
}

/**
 * Read a value at a path into parsed JSON, or undefined where the path runs
 * out — so a parser can state the shape it expects without a cast at each step.
 * @param {unknown} value - Parsed JSON
 * @param {...string} path - Keys to follow
 * @returns {unknown} The value found, or undefined
 */
export function field(value, ...path) {
  let at = value;
  for (const key of path) {
    if (at === null || typeof at !== 'object') return undefined;
    at = /** @type {Record<string, unknown>} */ (at)[key];
  }
  return at;
}

/**
 * Strip markup and collapse whitespace in a snippet. Some services mark the
 * matched words with `<strong>`.
 * @param {unknown} text - Snippet as the service gave it
 * @returns {string} Plain text
 */
function plainText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Map one service's result list, dropping entries without a URL.
 * @param {unknown} list - The service's array of results
 * @param {string} service - Service name, for the error when `list` is not an array
 * @param {(item: Record<string, unknown>) => {title: unknown, url: unknown, description?: unknown, date?: unknown}} pick - Field mapping
 * @returns {import('juggler/search-backend').SearchResultItem[]} Results
 */
export function mapResults(list, service, pick) {
  if (!Array.isArray(list)) {
    throw new Error(markUntranslated(`${service}'s response has no result list`));
  }
  /** @type {import('juggler/search-backend').SearchResultItem[]} */
  const out = [];
  for (const item of list) {
    const entry = item !== null && typeof item === 'object' ? /** @type {Record<string, unknown>} */ (item) : {};
    const { title, url, description, date } = pick(entry);
    if (typeof url !== 'string' || !url) continue;
    out.push({
      title: plainText(title) || url,
      url,
      description: plainText(description),
      ...(typeof date === 'string' && date ? { date } : {})
    });
  }
  return out;
}
