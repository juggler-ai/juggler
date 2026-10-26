//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for WebSearch action plugin
 * Tests parsing, domain filtering, and URL building in isolation.
 *
 * The scraper and the domain filters are pure functions in
 * `context-items/web-search/ddg-parser.js` and are exercised directly; only
 * the request-shaping test needs an item instance.
 */

import WebSearchContextItem from '../context-items/web-search-context-item.js';
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
    const first = results[0];
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
    if (results[1].title !== 'Tom & Jerry <2>') {
      throw new Error(`Expected decoded title "Tom & Jerry <2>", got "${results[1].title}"`);
    }
    if (results[1].url !== 'https://test.org/duck2') {
      throw new Error(`Expected url "https://test.org/duck2", got "${results[1].url}"`);
    }

    // Third result: inline tags in the snippet must be stripped.
    if (results[2].description !== 'Duck description 3') {
      throw new Error(`Expected stripped description "Duck description 3", got "${results[2].description}"`);
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

    if (filtered[0].url !== 'https://example.com/page1') {
      throw new Error('Should include example.com');
    }

    if (filtered[1].url !== 'https://sub.example.com/page3') {
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

    if (filtered[0].url !== 'https://test.org/page2') {
      throw new Error('Should only include test.org');
    }

    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  }
}

/**
 * Test DuckDuckGo params building
 * @returns {{passed: boolean, error?: string}} Test result
 */
/**
 * @param {any} session
 * @param {any} conversation
 * @returns {{passed: boolean, error?: string}} Test result
 */
function testDuckDuckGoParamsBuilding(session, conversation) {
  const action = new WebSearchContextItem({ id: "web-search", session, conversation, messageThread: conversation.rootMessageThread });

  try {
    const params = action.buildDuckDuckGoParams('test query');
    /** @type {any} */
    const anyParams = params;

    if (anyParams.url !== 'https://html.duckduckgo.com/html/') {
      throw new Error(`Expected DDG URL, got ${anyParams.url}`);
    }

    if (anyParams.method !== 'POST') {
      throw new Error(`Expected POST method, got ${anyParams.method}`);
    }

    if (!anyParams.form_data || anyParams.form_data.q !== 'test query') {
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
 * page (retried, then surfaced as an error by `search`).
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
 * Build a WebSearch item whose page fetches are answered from `pages` in
 * order, with no real backoff wait, recording each request it makes and each
 * wait it asked for. Clears any rate-limit cooldown a previous test left.
 * @param {any} session
 * @param {any} conversation
 * @param {Array<{content: string, status: number, blocked?: boolean}>} pages
 * @returns {{action: WebSearchContextItem, calls: unknown[], waits: number[]}} Item, its request log and its backoff waits
 */
function scriptedSearch(session, conversation, pages) {
  WebSearchContextItem.blockedUntil = 0;
  const action = new WebSearchContextItem({ id: 'web-search', session, conversation, messageThread: conversation.rootMessageThread });
  /** @type {unknown[]} */
  const calls = [];
  /** @type {number[]} */
  const waits = [];
  const queue = [...pages];
  /** @type {any} */ (action).fetchSearchPage = async (/** @type {unknown} */ params) => {
    calls.push(params);
    const page = queue.shift();
    if (!page) {
      throw new Error('search fetched more pages than the test scripted');
    }
    return { url: WebSearchContextItem.DDG_URL, truncated: false, ...page };
  };
  /** @type {any} */ (action).delay = async (/** @type {number} */ ms) => { waits.push(ms); };
  return { action, calls, waits };
}

/**
 * A blocked proxy response (DuckDuckGo's HTTP 202 rate-limit answer) is
 * retried like a captcha page, and a later real page is returned as results.
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testBlockedStatusIsRetried(session, conversation) {
  try {
    const { action, calls } = scriptedSearch(session, conversation, [
      { content: '', status: 202, blocked: true },
      { content: DUCKDUCKGO_HTML_RESPONSE, status: 200 }
    ]);
    const result = await action.search('test query');
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
 * When every attempt is blocked, the error names the status and says the
 * search was rate-limited, rather than a bare HTTP code.
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testBlockedEveryAttemptExplains(session, conversation) {
  try {
    const attempts = WebSearchContextItem.MAX_RETRIES + 1;
    const pages = Array.from({ length: attempts }, () => ({ content: '', status: 202, blocked: true }));
    const { action, calls } = scriptedSearch(session, conversation, pages);
    let message = '';
    try {
      await action.search('test query');
    } catch (e) {
      message = /** @type {Error} */ (e).message;
    }
    if (calls.length !== attempts) {
      throw new Error(`Expected ${attempts} fetches, got ${calls.length}`);
    }
    if (!message.includes('HTTP 202') || !message.includes('rate-limiting')) {
      throw new Error(`Expected a rate-limit error naming HTTP 202, got "${message}"`);
    }
    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  } finally {
    WebSearchContextItem.blockedUntil = 0;
  }
}

/**
 * Retries of a rate-limited search are spaced far enough apart to give the
 * limit a chance to lift: every wait is at least a few seconds, and each is
 * longer than the one before. A sub-second ladder only re-hits a block that
 * is still in force.
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testBlockedRetriesAreSpaced(session, conversation) {
  try {
    const attempts = WebSearchContextItem.MAX_RETRIES + 1;
    const pages = Array.from({ length: attempts }, () => ({ content: '', status: 202, blocked: true }));
    const { action, waits } = scriptedSearch(session, conversation, pages);
    await action.search('test query').catch(() => {});
    if (waits.length !== attempts - 1) {
      throw new Error(`Expected ${attempts - 1} backoff waits, got ${waits.length}`);
    }
    if (waits.some(ms => ms < 3000)) {
      throw new Error(`Every backoff wait should be at least 3s, got ${JSON.stringify(waits)}`);
    }
    for (let i = 1; i < waits.length; i++) {
      if (waits[i] <= waits[i - 1]) {
        throw new Error(`Backoff waits should grow, got ${JSON.stringify(waits)}`);
      }
    }
    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  } finally {
    WebSearchContextItem.blockedUntil = 0;
  }
}

/**
 * Once a search has exhausted its retries against a rate-limit, the next
 * search — from any item — fails at once without contacting DuckDuckGo
 * until the cooldown has passed, and says how long is left.
 * @param {any} session
 * @param {any} conversation
 * @returns {Promise<{passed: boolean, error?: string}>} Test result
 */
async function testRateLimitCooldownSkipsNetwork(session, conversation) {
  try {
    const attempts = WebSearchContextItem.MAX_RETRIES + 1;
    const pages = Array.from({ length: attempts }, () => ({ content: '', status: 202, blocked: true }));
    const first = scriptedSearch(session, conversation, pages);
    await first.action.search('test query').catch(() => {});

    // A fresh item, so the cooldown must be shared, not per-instance.
    const second = new WebSearchContextItem({ id: 'web-search', session, conversation, messageThread: conversation.rootMessageThread });
    let fetched = 0;
    /** @type {any} */ (second).fetchSearchPage = async () => {
      fetched++;
      return { url: WebSearchContextItem.DDG_URL, truncated: false, content: DUCKDUCKGO_HTML_RESPONSE, status: 200 };
    };
    let message = '';
    try {
      await second.search('another query');
    } catch (e) {
      message = /** @type {Error} */ (e).message;
    }
    if (fetched !== 0) {
      throw new Error(`Expected no fetch during the cooldown, got ${fetched}`);
    }
    if (!/\d+s/.test(message)) {
      throw new Error(`Expected the cooldown error to say how long is left, got "${message}"`);
    }

    // Once the cooldown has lapsed, searches reach the network again.
    WebSearchContextItem.blockedUntil = Date.now() - 1;
    const result = await second.search('another query');
    if (fetched !== 1 || result.results.length !== 3) {
      throw new Error(`Expected one fetch with 3 results after the cooldown, got ${fetched} fetch(es), ${result.results.length} results`);
    }
    return { passed: true };
  } catch (e) {
    const error = /** @type {Error} */ (e);
    return { passed: false, error: error.message };
  } finally {
    WebSearchContextItem.blockedUntil = 0;
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
    { name: 'DuckDuckGo params building', fn: () => testDuckDuckGoParamsBuilding(session, conversation) },
    { name: 'Empty and blocked results handling', fn: () => testEmptyResultsHandling() },
    { name: 'Blocked status is retried', fn: () => testBlockedStatusIsRetried(session, conversation) },
    { name: 'Blocked on every attempt explains', fn: () => testBlockedEveryAttemptExplains(session, conversation) },
    { name: 'Blocked retries are spaced', fn: () => testBlockedRetriesAreSpaced(session, conversation) },
    { name: 'Rate-limit cooldown skips the network', fn: () => testRateLimitCooldownSkipsNetwork(session, conversation) }
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
