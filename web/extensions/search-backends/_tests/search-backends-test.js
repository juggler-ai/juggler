//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Web Search Services backends.
 *
 * Each backend is fed a response in the shape its service documents and must
 * map it to `{title, url, description}` — a service that renames a field would
 * otherwise turn every search into "no results" without a word. The request
 * each builds, and the shared status handling (a missing key, a refused key, a
 * rate limit, a spent quota), are checked once each. No request leaves the
 * machine: `readSetting` and `send` are stubbed.
 */

import TavilySearchBackend from '../search-backends/tavily-backend.js';
import BraveSearchBackend from '../search-backends/brave-backend.js';
import SearxngSearchBackend from '../search-backends/searxng-backend.js';
import DeepSeekSearchBackend from '../search-backends/deepseek-backend.js';
import BochaSearchBackend from '../search-backends/bocha-backend.js';
import ZhipuSearchBackend from '../search-backends/zhipu-backend.js';
import ExaSearchBackend from '../search-backends/exa-backend.js';
import { SearchBlockedError, SearchNotConfiguredError } from 'juggler/search-backend';
import { fetchExtensions } from '../../../js/services/extensions.js';

/** @typedef {import('../lib/api-search.js').ApiSearchBackend} ApiSearchBackend */

/**
 * A backend instance answering every request with `response`, recording what
 * it was asked to send.
 * @param {new () => ApiSearchBackend} Backend - Backend class
 * @param {{status?: number, body: unknown, headers?: Record<string, string>}} response - The canned answer
 * @param {string} [setting] - The key or URL it reads
 * @returns {{backend: ApiSearchBackend, sent: any[]}} The backend and its request log
 */
function stubbed(Backend, response, setting = 'test-key') {
  const backend = new Backend();
  /** @type {any[]} */
  const sent = [];
  /** @type {any} */ (backend).readSetting = async () => setting;
  /** @type {any} */ (backend).send = async (/** @type {any} */ req) => {
    sent.push(req);
    return {
      status: response.status ?? 200,
      statusText: '',
      headers: response.headers ?? {},
      body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
    };
  };
  return { backend, sent };
}

/** One recorded answer per service, in the shape its documentation gives. */
const CASES = /** @type {Array<{Backend: any, body: unknown, host: string}>} */ ([
  {
    Backend: TavilySearchBackend,
    host: 'api.tavily.com',
    body: { query: 'q', results: [{ title: 'T1', url: 'https://a.example/1', content: 'Tavily snippet', score: 0.9 }] }
  },
  {
    Backend: BraveSearchBackend,
    host: 'api.search.brave.com',
    body: { web: { results: [{ title: 'T1', url: 'https://a.example/1', description: 'Brave <strong>snippet</strong>' }] } }
  },
  {
    Backend: SearxngSearchBackend,
    host: 'searx.example',
    body: { query: 'q', results: [{ title: 'T1', url: 'https://a.example/1', content: 'SearXNG snippet', engine: 'bing' }] }
  },
  {
    Backend: DeepSeekSearchBackend,
    host: 'api.deepseek.com',
    body: { results: [{ title: 'T1', url: 'https://a.example/1', snippet: 'short', summary: 'DeepSeek summary', date: '2026-01-02' }] }
  },
  {
    Backend: BochaSearchBackend,
    host: 'api.bochaai.com',
    body: { code: 200, log_id: 'x', data: { _type: 'SearchResponse', webPages: { value: [{ name: 'T1', url: 'https://a.example/1', snippet: 'short', summary: 'Bocha summary' }] } } }
  },
  {
    Backend: ZhipuSearchBackend,
    host: 'open.bigmodel.cn',
    body: { id: 'x', search_result: [{ title: 'T1', link: 'https://a.example/1', content: 'Zhipu snippet', publish_date: '2026-01-02' }] }
  },
  {
    Backend: ExaSearchBackend,
    host: 'api.exa.ai',
    body: { requestId: 'x', results: [{ title: 'T1', url: 'https://a.example/1', highlights: ['Exa snippet'], publishedDate: '2026-01-02' }] }
  }
]);

/**
 * Every backend maps its service's documented answer to a result with a
 * title, URL and plain-text description, and sends its request to its own
 * service with the key it read.
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testEachBackendMapsItsAnswer() {
  try {
    for (const { Backend, body, host } of CASES) {
      const id = Backend.MANIFEST.id;
      const setting = id === 'searxng' ? 'https://searx.example/' : 'test-key';
      const { backend, sent } = stubbed(Backend, { body }, setting);
      const { results } = await backend.search({ query: 'test query', count: 10 });
      const [first] = results;
      if (results.length !== 1 || first?.title !== 'T1' || first?.url !== 'https://a.example/1') {
        throw new Error(`${id}: expected one result T1 at https://a.example/1, got ${JSON.stringify(results)}`);
      }
      if (!first.description || /[<>]/.test(first.description) || !/snippet|summary/.test(first.description)) {
        throw new Error(`${id}: expected a plain-text description, got ${JSON.stringify(first.description)}`);
      }
      const req = sent[0];
      if (new URL(req.url).hostname !== host) {
        throw new Error(`${id}: expected a request to ${host}, got ${req.url}`);
      }
      const carriesKey = id === 'searxng' || Object.values(req.headers || {}).some((v) => String(v).includes('test-key'));
      if (!carriesKey) {
        throw new Error(`${id}: the request does not carry the key: ${JSON.stringify(req.headers)}`);
      }
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  }
}

/**
 * The shared status handling: no key is "not configured" (skipped quietly),
 * a rate limit or spent quota is a block with the wait the service asked
 * for, and a refused key is an ordinary failure that says where to fix it.
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testStatusHandling() {
  try {
    /**
     * @param {() => Promise<unknown>} run - The search
     * @returns {Promise<any>} What it threw
     */
    const thrown = async (run) => {
      try {
        await run();
      } catch (e) {
        return e;
      }
      throw new Error('expected the search to throw');
    };
    const request = { query: 'test query', count: 10 };

    const unset = await thrown(() => stubbed(TavilySearchBackend, { body: {} }, '').backend.search(request));
    if (!(unset instanceof SearchNotConfiguredError)) {
      throw new Error(`no key: expected SearchNotConfiguredError, got ${unset?.name}`);
    }

    const limited = await thrown(() => stubbed(TavilySearchBackend, { status: 429, body: {}, headers: { 'Retry-After': '30' } }).backend.search(request));
    if (!(limited instanceof SearchBlockedError) || limited.retryAfterMs !== 30000) {
      throw new Error(`429: expected a block resting 30000ms, got ${limited?.name} ${limited?.retryAfterMs}`);
    }

    const spent = await thrown(() => stubbed(BochaSearchBackend, { status: 402, body: { msg: 'insufficient balance' } }).backend.search(request));
    if (!(spent instanceof SearchBlockedError) || !((spent.retryAfterMs ?? 0) > 60000)) {
      throw new Error(`402: expected a long block, got ${spent?.name} ${spent?.retryAfterMs}`);
    }

    const refused = await thrown(() => stubbed(BraveSearchBackend, { status: 401, body: {} }).backend.search(request));
    if (refused?.name !== 'Error' || !/HTTP 401/.test(refused.message) || !/Settings/.test(refused.message)) {
      throw new Error(`401: expected a plain error naming the status and the setting, got ${refused?.name}: ${refused?.message}`);
    }

    const noJson = await thrown(() => stubbed(SearxngSearchBackend, { status: 403, body: 'Forbidden' }, 'http://localhost:8888').backend.search(request));
    if (!/search\.formats/.test(noJson?.message)) {
      throw new Error(`SearXNG 403: expected the JSON-format hint, got ${noJson?.message}`);
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  }
}

/**
 * A query with no hits is an empty list, not an error — Brave omits its `web`
 * section entirely then — while a body of the wrong shape is an error.
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testEmptyAndMalformed() {
  try {
    const request = { query: 'test query', count: 10 };
    const empty = await stubbed(BraveSearchBackend, { body: { type: 'search' } }).backend.search(request);
    if (empty.results.length !== 0) {
      throw new Error(`Brave with no web section: expected no results, got ${empty.results.length}`);
    }
    let message = '';
    try {
      await stubbed(TavilySearchBackend, { body: { unexpected: true } }).backend.search(request);
    } catch (e) {
      message = /** @type {Error} */ (e).message;
    }
    if (!/no result list/.test(message)) {
      throw new Error(`malformed Tavily body: expected "no result list", got "${message}"`);
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  }
}

/**
 * Exa is asked for the matching passages of each page, capped small, never the
 * whole text; the passages join into the description, with the page text as a
 * fallback when it sends none.
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testExaAsksForCappedHighlights() {
  try {
    const { backend, sent } = stubbed(ExaSearchBackend, { body: { results: [
      { title: 'One', url: 'https://a.example/1', highlights: ['First', 'Second'] },
      { title: '', url: 'https://a.example/2', text: 'Body text' }
    ] } });
    const { results } = await backend.search({
      query: 'q', count: 7, allowedDomains: ['exa.ai'], blockedDomains: ['example.com']
    });
    const { json } = sent[0];
    const cap = json.contents?.highlights?.maxCharacters;
    if (json.contents.text !== undefined || !(Number.isInteger(cap) && cap > 0 && cap <= 2000)) {
      throw new Error(`expected a small highlights cap and no full text, got ${JSON.stringify(json.contents)}`);
    }
    if (json.numResults !== 7 || json.includeDomains?.[0] !== 'exa.ai' || json.excludeDomains?.[0] !== 'example.com') {
      throw new Error(`count or domain filters missing: ${JSON.stringify(json)}`);
    }
    if (results[0]?.description !== 'First … Second' || results[1]?.description !== 'Body text' ||
        results[1]?.title !== 'https://a.example/2') {
      throw new Error(`unexpected results ${JSON.stringify(results)}`);
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  }
}

/**
 * Every backend's required setting is one this extension declares, shown on
 * that backend's page. `readSetting` is stubbed everywhere else, so a renamed
 * key would otherwise leave a backend that can never be set up — reported as
 * "not set" however often the user enters it.
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testRequiredSettingsAreDeclared() {
  try {
    const extensions = await fetchExtensions();
    const manifest = extensions.find((ext) => ext.manifest?.id === '@juggler/search-backends')?.manifest;
    if (!manifest) throw new Error('@juggler/search-backends is not in the extension catalogue');
    const declared = new Map((manifest.settings ?? []).map((s) => [s.key, s]));
    for (const { Backend } of CASES) {
      const { id, requiredSettings } = Backend.MANIFEST;
      if (!Array.isArray(requiredSettings) || requiredSettings.length !== 1) {
        throw new Error(`${id}: expected exactly one required setting, got ${JSON.stringify(requiredSettings)}`);
      }
      const setting = declared.get(requiredSettings[0]);
      if (!setting) throw new Error(`${id}: required setting "${requiredSettings[0]}" is not declared in juggler.extension.json`);
      if (setting.capability !== `search-backend:${id}`) {
        throw new Error(`${id}: "${setting.key}" is shown on ${setting.capability || 'no page'}, not search-backend:${id}`);
      }
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  }
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests() {
  const tests = [
    { name: 'Each backend maps its answer', fn: testEachBackendMapsItsAnswer },
    { name: 'Status handling', fn: testStatusHandling },
    { name: 'Empty and malformed answers', fn: testEmptyAndMalformed },
    { name: 'Exa asks for capped highlights', fn: testExaAsksForCappedHighlights },
    { name: 'Required settings are declared', fn: testRequiredSettingsAreDeclared }
  ];
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  for (const test of tests) {
    const result = await test.fn();
    if (result.passed) {
      passed++;
    } else {
      failed++;
      errors.push(`${test.name}: ${result.error || 'unknown error'}`);
    }
  }
  return { passed, failed, errors };
}
