//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the WebSearch tool and its DuckDuckGo backend.
 *
 * The scraper and the domain filters are pure functions in
 * `context-items/web-search/ddg-parser.js` and are exercised directly; the
 * DuckDuckGo backend's retry ladder runs against scripted pages; the tool's
 * fallback across backends runs against stand-in backends.
 */

import WebSearchContextItem from '../context-items/web-search-context-item.js';
import DuckDuckGoSearchBackend from '../search-backends/duckduckgo-backend.js';
import { SearchBlockedError, SearchNotConfiguredError } from 'juggler/search-backend';
import { effectiveSearchOrder, resolveSearchBackends } from '../../../js/services/web-search-backends.js';
import searchBackendRegistry from '../../../js/registries/search-backend-registry.js';
import {
  parseDuckDuckGoResponse,
  looksLikeNoResults,
  matchesDomain,
  filterResults
} from '../context-items/web-search/ddg-parser.js';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation
} from '../../../js-tests/utilities/test-helpers.js';

/**
 * Fixture: DuckDuckGo HTML response
 */
const DUCKDUCKGO_HTML_RESPONSE = `
<!DOCTYPE html>
<html>
<body>
	<div class="results">
	<div class="result results_links results_links_deep web-result ">
		<h2 class="result__title">
			<a rel="nofollow" class="result__a" href="https://example.com/duck1">Duck Result 1</a>
		</h2>
		<a class="result__snippet" href="https://example.com/duck1">Duck description 1</a>
	</div>
	<div class="result results_links results_links_deep web-result ">
		<h2 class="result__title">
			<a rel="nofollow" class="result__a" href="https://test.org/duck2">Tom &amp; Jerry &lt;2&gt;</a>
		</h2>
		<a class="result__snippet" href="https://test.org/duck2">Duck description 2</a>
	</div>
	<div class="result results_links results_links_deep web-result ">
		<h2 class="result__title">
			<a rel="nofollow" class="result__a" href="https://sub.example.com/duck3">Duck Result 3</a>
		</h2>
		<a class="result__snippet" href="https://sub.example.com/duck3">Duck <b>description</b> 3</a>
	</div>
	</div>
</body>
</html>
`;

/**
 * Test DuckDuckGo HTML parsing
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testDuckDuckGoParsing() {
  try {
    const results = parseDuckDuckGoResponse(DUCKDUCKGO_HTML_RESPONSE);

    // Check count
    if (results.length !== 3) {
      throw new Error(`Expected 3 results, got ${results.length}`);
    }

    // Check first result
    const [first, second, third] = results;
    if (!first || !second || !third) {
      throw new Error(`Expected 3 results, got ${results.length}`);
    }
    if (first.title !== 'Duck Result 1') {
      throw new Error(`Expected title "Duck Result 1", got "${first.title}"`);
    }
    if (first.url !== 'https://example.com/duck1') {
      throw new Error(`Expected url "https://example.com/duck1", got "${first.url}"`);
    }
    if (first.description !== 'Duck description 1') {
      throw new Error(`Expected description "Duck description 1", got "${first.description}"`);
    }

    // Second result: HTML entities in the title must be decoded.
    if (second.title !== 'Tom & Jerry <2>') {
      throw new Error(`Expected decoded title "Tom & Jerry <2>", got "${second.title}"`);
    }
    if (second.url !== 'https://test.org/duck2') {
      throw new Error(`Expected url "https://test.org/duck2", got "${second.url}"`);
    }

    // Third result: inline tags in the snippet must be stripped.
    if (third.description !== 'Duck description 3') {
      throw new Error(`Expected stripped description "Duck description 3", got "${third.description}"`);
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test domain matching logic
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testDomainMatching() {
  try {
    // Exact match
    if (!matchesDomain('example.com', 'example.com')) {
      throw new Error('Should match exact domain');
    }

    // Subdomain match
    if (!matchesDomain('sub.example.com', 'example.com')) {
      throw new Error('Should match subdomain');
    }

    // Deep subdomain match
    if (!matchesDomain('deep.sub.example.com', 'example.com')) {
      throw new Error('Should match deep subdomain');
    }

    // Should NOT match
    if (matchesDomain('notexample.com', 'example.com')) {
      throw new Error('Should not match different domain');
    }

    // Should NOT match prefix-only
    if (matchesDomain('example.com.attacker.com', 'example.com')) {
      throw new Error('Should not match attacker domain with prefix');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test domain filtering - allowed domains
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testDomainFilteringAllowed() {
  const results = [
    { title: 'Result 1', url: 'https://example.com/page1', description: 'desc1' },
    { title: 'Result 2', url: 'https://test.org/page2', description: 'desc2' },
    { title: 'Result 3', url: 'https://sub.example.com/page3', description: 'desc3' }
  ];

  try {
    // Filter to only example.com (should include subdomains)
    const filtered = filterResults(results, ['example.com'], []);

    if (filtered.length !== 2) {
      throw new Error(`Expected 2 results, got ${filtered.length}`);
    }

    if (filtered[0]?.url !== 'https://example.com/page1') {
      throw new Error('Should include example.com');
    }

    if (filtered[1]?.url !== 'https://sub.example.com/page3') {
      throw new Error('Should include sub.example.com');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test domain filtering - blocked domains
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testDomainFilteringBlocked() {
  const results = [
    { title: 'Result 1', url: 'https://example.com/page1', description: 'desc1' },
    { title: 'Result 2', url: 'https://test.org/page2', description: 'desc2' },
    { title: 'Result 3', url: 'https://sub.example.com/page3', description: 'desc3' }
  ];

  try {
    // Block example.com (should block subdomains too)
    const filtered = filterResults(results, [], ['example.com']);

    if (filtered.length !== 1) {
      throw new Error(`Expected 1 result, got ${filtered.length}`);
    }

    if (filtered[0]?.url !== 'https://test.org/page2') {
      throw new Error('Should only include test.org');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * @param {any} session
 * @param {any} conversation
 * @returns {WebSearchContextItem} A fresh WebSearch item
 */
function newItem(session, conversation) {
  return new WebSearchContextItem({ id: 'web-search', session, conversation, messageThread: conversation.rootMessageThread });
}

/**
 * Test DuckDuckGo params building
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testDuckDuckGoParamsBuilding() {
  try {
    /** @type {any} */
    const params = new DuckDuckGoSearchBackend().buildDuckDuckGoParams('test query');

    if (params.url !== 'https://html.duckduckgo.com/html/') {
      throw new Error(`Expected DDG URL, got ${params.url}`);
    }

    if (params.method !== 'POST') {
      throw new Error(`Expected POST method, got ${params.method}`);
    }

    if (!params.form_data || params.form_data.q !== 'test query') {
      throw new Error('form_data should contain query');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test empty results handling and blocked-vs-genuine classification.
 *
 * `parseDuckDuckGoResponse` does not throw on an empty parse — it returns an
 * empty array — and `looksLikeNoResults` distinguishes DuckDuckGo's genuine
 * "no results" page (retained as an empty success) from a rate-limit/captcha
 * page (retried, then reported as a block by the backend).
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testEmptyResultsHandling() {
  try {
    // No result blocks -> empty array, not a throw.
    const blocked = parseDuckDuckGoResponse('<html><body></body></html>');
    if (!Array.isArray(blocked) || blocked.length !== 0) {
      throw new Error(`Expected empty array for no result blocks, got ${JSON.stringify(blocked)}`);
    }

    // An empty/anomalous page has no "no results" marker -> treated as blocked.
    if (looksLikeNoResults('<html><body></body></html>')) {
      throw new Error('Empty body should not be classified as a genuine no-results page');
    }

    // DuckDuckGo's genuine empty result set carries a no-results marker.
    if (!looksLikeNoResults('<div class="no-results">No results.</div>')) {
      throw new Error('no-results marker should be classified as a genuine empty result set');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Build a DuckDuckGo backend whose page fetches are answered from `pages` in
 * order, with no real backoff wait, recording each request it makes and each
 * wait it asked for.
 * @param {Array<{content: string, status: number, blocked?: boolean}>} pages
 * @returns {{backend: DuckDuckGoSearchBackend, calls: unknown[], waits: number[]}} Backend, its request log and its backoff waits
 */
function scriptedDuckDuckGo(pages) {
  const backend = new DuckDuckGoSearchBackend();
  /** @type {unknown[]} */
  const calls = [];
  /** @type {number[]} */
  const waits = [];
  const queue = [...pages];
  /** @type {any} */ (backend).fetchSearchPage = async (/** @type {unknown} */ params) => {
    calls.push(params);
    const page = queue.shift();
    if (!page) {
      throw new Error('search fetched more pages than the test scripted');
    }
    return { url: DuckDuckGoSearchBackend.DDG_URL, truncated: false, ...page };
  };
  /** @type {any} */ (backend).delay = async (/** @type {number} */ ms) => { waits.push(ms); };
  return { backend, calls, waits };
}

/**
 * A blocked proxy response (DuckDuckGo's HTTP 202 rate-limit answer) is
 * retried like a captcha page, and a later real page is returned as results.
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testBlockedStatusIsRetried() {
  try {
    const { backend, calls } = scriptedDuckDuckGo([
      { content: '', status: 202, blocked: true },
      { content: DUCKDUCKGO_HTML_RESPONSE, status: 200 }
    ]);
    const result = await backend.search({ query: 'test query', count: 10 });
    if (calls.length !== 2) {
      throw new Error(`Expected 2 fetches (blocked, then retried), got ${calls.length}`);
    }
    if (result.results.length !== 3) {
      throw new Error(`Expected the retried page's 3 results, got ${result.results.length}`);
    }
    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * When every attempt is blocked, the backend reports a block — the kind of
 * failure the WebSearch tool rests a backend for — naming the status and
 * saying the search was rate-limited, rather than a bare HTTP code.
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testBlockedEveryAttemptExplains() {
  try {
    const attempts = DuckDuckGoSearchBackend.MAX_RETRIES + 1;
    const pages = Array.from({ length: attempts }, () => ({ content: '', status: 202, blocked: true }));
    const { backend, calls } = scriptedDuckDuckGo(pages);
    /** @type {any} */
    let thrown = null;
    try {
      await backend.search({ query: 'test query', count: 10 });
    } catch (e) {
      thrown = e;
    }
    if (calls.length !== attempts) {
      throw new Error(`Expected ${attempts} fetches, got ${calls.length}`);
    }
    if (!(thrown instanceof SearchBlockedError)) {
      throw new Error(`Expected a SearchBlockedError, got ${thrown?.name}: ${thrown?.message}`);
    }
    if (!thrown.message.includes('HTTP 202') || !thrown.message.includes('rate-limiting')) {
      throw new Error(`Expected a rate-limit error naming HTTP 202, got "${thrown.message}"`);
    }
    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Retries of a rate-limited search are spaced far enough apart to give the
 * limit a chance to lift: every wait is at least a few seconds, and each is
 * longer than the one before. A sub-second ladder only re-hits a block that
 * is still in force.
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testBlockedRetriesAreSpaced() {
  try {
    const attempts = DuckDuckGoSearchBackend.MAX_RETRIES + 1;
    const pages = Array.from({ length: attempts }, () => ({ content: '', status: 202, blocked: true }));
    const { backend, waits } = scriptedDuckDuckGo(pages);
    await backend.search({ query: 'test query', count: 10 }).catch(() => {});
    if (waits.length !== attempts - 1) {
      throw new Error(`Expected ${attempts - 1} backoff waits, got ${waits.length}`);
    }
    if (waits.some(ms => ms < 3000)) {
      throw new Error(`Every backoff wait should be at least 3s, got ${JSON.stringify(waits)}`);
    }
    for (const [i, wait] of waits.entries()) {
      const before = waits[i - 1];
      if (before !== undefined && wait <= before) {
        throw new Error(`Backoff waits should grow, got ${JSON.stringify(waits)}`);
      }
    }
    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * A stand-in backend for the dispatcher tests: answers each search with the
 * next of `answers` — results to return, or an error to throw — and counts
 * the searches it was asked for.
 * @param {string} id - Backend id
 * @param {Array<Array<{title: string, url: string, description?: string}>|Error>} answers
 * @returns {{entry: {id: string, name: string, backend: any}, asked: () => number}} The resolved entry, and how many searches reached it
 */
function fakeBackend(id, answers) {
  let asked = 0;
  const queue = [...answers];
  const backend = {
    async search() {
      asked++;
      const next = queue.shift();
      if (!next) throw new Error(`${id} was asked more often than the test scripted`);
      if (next instanceof Error) throw next;
      return { results: next };
    }
  };
  return { entry: { id, name: id.toUpperCase(), backend }, asked: () => asked };
}

/**
 * A WebSearch item that searches with `entries` instead of the user's setting.
 * Clears any rest a previous test left.
 * @param {any} session
 * @param {any} conversation
 * @param {Array<{id: string, name: string, backend: any}>} entries
 * @returns {WebSearchContextItem} The item
 */
function itemWith(session, conversation, entries) {
  WebSearchContextItem.restingUntil.clear();
  const item = newItem(session, conversation);
  /** @type {any} */ (item).resolveBackends = async () => entries;
  return item;
}

const HITS = [
  { title: 'A', url: 'https://example.com/a', description: 'a' },
  { title: 'B', url: 'https://test.org/b', description: 'b' }
];

/**
 * A blocked backend falls through to the next in the user's order, and the
 * result names the one that answered.
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testBlockedFallsThrough(session, conversation) {
  try {
    const first = fakeBackend('first', [new SearchBlockedError('First is rate-limiting this connection.')]);
    const second = fakeBackend('second', [HITS]);
    const item = itemWith(session, conversation, [first.entry, second.entry]);
    const result = await item.search('test query');
    if (result.provider !== 'SECOND' || result.results.length !== 2) {
      throw new Error(`Expected SECOND's 2 results, got ${result.provider} with ${result.results.length}`);
    }
    if (first.asked() !== 1 || second.asked() !== 1) {
      throw new Error(`Expected each backend asked once, got ${first.asked()} and ${second.asked()}`);
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  } finally {
    WebSearchContextItem.restingUntil.clear();
  }
}

/**
 * An unconfigured backend is skipped quietly when another answers, and named
 * — with the setting to fix it — when none does. A backend's other failures
 * also fall through, and all the reasons reach the model.
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testUnconfiguredAndFailedFallThrough(session, conversation) {
  try {
    const keyless = fakeBackend('keyless', [new SearchNotConfiguredError('API key is not set.'), new SearchNotConfiguredError('API key is not set.')]);
    const broken = fakeBackend('broken', [new Error('HTTP 500'), new Error('HTTP 500')]);
    const good = fakeBackend('good', [HITS]);
    const ok = await itemWith(session, conversation, [keyless.entry, broken.entry, good.entry]).search('test query');
    if (ok.provider !== 'GOOD') {
      throw new Error(`Expected GOOD to answer past an unconfigured and a failing backend, got ${ok.provider}`);
    }
    // The failure is kept with the answer, so a broken first choice is not
    // hidden behind the next one; the merely unconfigured one is not.
    if (JSON.stringify(ok.failedFirst) !== JSON.stringify(['BROKEN failed: HTTP 500'])) {
      throw new Error(`Expected the answer to carry BROKEN's failure alone, got ${JSON.stringify(ok.failedFirst)}`);
    }
    const summary = String(newItem(session, conversation).getSummary(/** @type {any} */ ({
      success: true, prepared: { params: { query: 'test query' } }, result: ok
    })).summary ?? '');
    if (!summary.includes('BROKEN failed: HTTP 500')) {
      throw new Error(`Expected the model to be told BROKEN failed, got "${summary}"`);
    }

    let message = '';
    try {
      await itemWith(session, conversation, [keyless.entry, broken.entry]).search('test query');
    } catch (e) {
      message = /** @type {Error} */ (e).message;
    }
    for (const part of ['KEYLESS: API key is not set.', 'BROKEN failed: HTTP 500', 'Settings → Web search']) {
      if (!message.includes(part)) {
        throw new Error(`Expected the error to include "${part}", got "${message}"`);
      }
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  }
}

/**
 * The domain filters apply to whatever backend answered, whether or not it
 * honoured them itself.
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testDomainFiltersApplyToEveryBackend(session, conversation) {
  try {
    const only = fakeBackend('only', [HITS]);
    const result = await itemWith(session, conversation, [only.entry]).search('test query', ['example.com']);
    if (result.results.length !== 1 || result.results[0]?.url !== 'https://example.com/a') {
      throw new Error(`Expected only the example.com hit, got ${JSON.stringify(result.results)}`);
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  }
}

/**
 * Once a backend has reported a block, the next search — from any item —
 * skips it without a request until its rest has passed, and says how long is
 * left; a backend that named its own wait is rested that long.
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testBlockedBackendRestsAcrossItems(session, conversation) {
  try {
    const blocked = fakeBackend('ddg', [new SearchBlockedError('DuckDuckGo refused the search (HTTP 202): it is rate-limiting this connection.', { retryAfterMs: 120000 })]);
    await itemWith(session, conversation, [blocked.entry]).search('test query').catch(() => {});
    const restEnds = WebSearchContextItem.restingUntil.get('ddg') ?? 0;
    if (restEnds - Date.now() < 100000) {
      throw new Error(`Expected the backend's own 120s wait to be honoured, rest ends in ${restEnds - Date.now()}ms`);
    }

    // A fresh item and a fresh instance of the same backend: the rest is per
    // backend id and shared across the realm, not per item or per instance.
    const again = fakeBackend('ddg', [HITS]);
    const second = newItem(session, conversation);
    /** @type {any} */ (second).resolveBackends = async () => [again.entry];
    let message = '';
    try {
      await second.search('another query');
    } catch (e) {
      message = /** @type {Error} */ (e).message;
    }
    if (again.asked() !== 0) {
      throw new Error(`Expected no request during the rest, got ${again.asked()}`);
    }
    if (!/\d+s/.test(message)) {
      throw new Error(`Expected the error to say how long is left, got "${message}"`);
    }

    // Once the rest has lapsed, searches reach the backend again.
    WebSearchContextItem.restingUntil.set('ddg', Date.now() - 1);
    const result = await second.search('another query');
    if (again.asked() !== 1 || result.results.length !== 2) {
      throw new Error(`Expected one request with 2 results after the rest, got ${again.asked()} request(s), ${result.results.length} results`);
    }

    // A wait asked for beyond the cap is cut to it: one bad Retry-After must
    // not switch a backend off for the day.
    const greedy = fakeBackend('greedy', [new SearchBlockedError('Greedy is rate-limiting.', { retryAfterMs: 24 * 3600 * 1000 })]);
    await itemWith(session, conversation, [greedy.entry]).search('test query').catch(() => {});
    const greedyRest = (WebSearchContextItem.restingUntil.get('greedy') ?? 0) - Date.now();
    if (greedyRest > WebSearchContextItem.MAX_REST_MS || greedyRest < WebSearchContextItem.MAX_REST_MS - 60000) {
      throw new Error(`Expected a day's wait to be capped at ${WebSearchContextItem.MAX_REST_MS}ms, rest ends in ${greedyRest}ms`);
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  } finally {
    WebSearchContextItem.restingUntil.clear();
  }
}

/**
 * The order comes from settings.json's `webSearch.order`, with DuckDuckGo
 * alone while nothing is stored — and nothing at all for a stored empty list,
 * which is the user switching every backend off.
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testEffectiveOrder() {
  try {
    const ddg = '@juggler/core/duckduckgo';
    const tavily = '@juggler/search-backends/tavily';
    const cases = /** @type {Array<[unknown, string[]]>} */ ([
      [undefined, [ddg]],
      [null, [ddg]],
      [[], []],
      [[tavily, ddg], [tavily, ddg]]
    ]);
    for (const [stored, want] of cases) {
      const got = effectiveSearchOrder(stored);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(`effectiveSearchOrder(${JSON.stringify(stored)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  }
}

/**
 * Every built-in backend reaches the registry the app reads — the Web search
 * settings and the catalog list what is there, and WebSearch can only use what
 * is there — with none failing to load.
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testRegistryLoadsEveryBackend() {
  try {
    // The app's initAllRegistries() loads it; this harness loads it here.
    if (!searchBackendRegistry.isInitialized()) await searchBackendRegistry.init();
    const failures = searchBackendRegistry.getFailedModules();
    if (failures.length > 0) {
      throw new Error(`backend modules failed to load: ${JSON.stringify(failures)}`);
    }
    const ids = new Set(searchBackendRegistry.getCatalogManifests().map((m) => m.id));
    for (const id of ['duckduckgo', 'tavily', 'brave', 'searxng', 'deepseek', 'bocha', 'zhipu', 'exa']) {
      if (!ids.has(id)) throw new Error(`backend "${id}" is not in the registry (has: ${[...ids].join(', ') || 'nothing'})`);
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  }
}

/**
 * Answer GET /api/settings with `answer` (a settings document, or a status to
 * fail with) for the length of `fn`; everything else goes to the server.
 * @template T
 * @param {object|number} answer - The document, or an HTTP status
 * @param {() => Promise<T>} fn - What to run meanwhile
 * @returns {Promise<T>} What `fn` returned
 */
async function withSettingsAnswer(answer, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (async (url, init) => {
    if (String(url).endsWith('/api/settings') && (!init?.method || init.method === 'GET')) {
      return typeof answer === 'number'
        ? new globalThis.Response('settings unavailable', { status: answer })
        : new globalThis.Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch.call(globalThis, url, init);
  });
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * A stored key names a backend only as the extension that provides it: a key
 * naming another extension is skipped, not matched by its bare id. And a
 * setting that cannot be read fails the search rather than falling back to
 * the default, which would send the query to a service the user did not choose.
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testResolveByKey() {
  try {
    if (!searchBackendRegistry.isInitialized()) await searchBackendRegistry.init();
    const order = ['@someone-else/search/tavily', '@juggler/search-backends/tavily', 'duckduckgo'];
    const resolved = await withSettingsAnswer({ webSearch: { order } }, () => resolveSearchBackends());
    const ids = resolved.map((r) => r.id);
    if (JSON.stringify(ids) !== JSON.stringify(['@juggler/search-backends/tavily'])) {
      throw new Error(`Expected only the key naming tavily's own extension, got ${JSON.stringify(ids)}`);
    }

    let message = '';
    try {
      await withSettingsAnswer(500, () => resolveSearchBackends());
    } catch (e) {
      message = /** @type {Error} */ (e).message;
    }
    if (!message.includes("Couldn't read the Web search setting")) {
      throw new Error(`Expected an unreadable setting to fail the search, got ${message ? `"${message}"` : 'backends'}`);
    }
    return { passed: true };
  } catch (e) {
    return { passed: false, error: /** @type {Error} */ (e).message };
  }
}

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Path to fixture directory
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all tests
 * @param {TestContext} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  // Initialize registries and create test session/conversation
  await initializeRegistries();
  const session = await createTestSession();
  const conversation = await createTestConversation(session);

  const tests = [
    { name: 'DuckDuckGo HTML parsing', fn: () => testDuckDuckGoParsing() },
    { name: 'Domain matching logic', fn: () => testDomainMatching() },
    { name: 'Domain filtering (allowed)', fn: () => testDomainFilteringAllowed() },
    { name: 'Domain filtering (blocked)', fn: () => testDomainFilteringBlocked() },
    { name: 'DuckDuckGo params building', fn: () => testDuckDuckGoParamsBuilding() },
    { name: 'Empty and blocked results handling', fn: () => testEmptyResultsHandling() },
    { name: 'Blocked status is retried', fn: () => testBlockedStatusIsRetried() },
    { name: 'Blocked on every attempt explains', fn: () => testBlockedEveryAttemptExplains() },
    { name: 'Blocked retries are spaced', fn: () => testBlockedRetriesAreSpaced() },
    { name: 'Blocked backend falls through', fn: () => testBlockedFallsThrough(session, conversation) },
    { name: 'Unconfigured and failed backends fall through', fn: () => testUnconfiguredAndFailedFallThrough(session, conversation) },
    { name: 'Domain filters apply to every backend', fn: () => testDomainFiltersApplyToEveryBackend(session, conversation) },
    { name: 'Blocked backend rests across items', fn: () => testBlockedBackendRestsAcrossItems(session, conversation) },
    { name: 'Effective backend order', fn: () => testEffectiveOrder() },
    { name: 'Registry loads every backend', fn: () => testRegistryLoadsEveryBackend() },
    { name: 'Order keys name the providing extension', fn: () => testResolveByKey() }
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
