//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Settings → Web search: which backends WebSearch uses, in what order.
 *
 * A backend is offered a switch only once it can search; one still missing
 * its key is a link to its page in Extensions instead. Switching one on, or
 * moving one, saves the order — and a key in the stored order whose backend is
 * not ready now keeps its place in the setting rather than being dropped.
 * Switching off the last one stores an empty order, not the default.
 *
 * The real registry supplies the installed backends. The server is stubbed:
 * the settings PUT is answered by echoing the order it was sent (a real one
 * would change the shared test server's search order under every other lane),
 * and the extension settings read says which keys are set.
 * @module unit-tests/web-search-tab-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { WebSearchTab } from '../../js/components/settings/web-search-tab.js';
import searchBackendRegistry from '../../js/registries/search-backend-registry.js';

// The keys the setting stores the backends under.
const DDG = '@juggler/core/duckduckgo';
const TAVILY = '@juggler/search-backends/tavily';
const BRAVE = '@juggler/search-backends/brave';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * Answer the settings PUT by echoing its order (recording each), and the
 * extension settings read with `values`; everything else goes to the server.
 * @param {Record<string, unknown>} values - What `extconfig get` returns for `@juggler/search-backends`
 * @param {string[][]} puts - Collects each order PUT
 * @returns {() => void} Restores fetch.
 */
function stubServer(values, puts) {
  const originalFetch = window.fetch;
  const json = (/** @type {unknown} */ body) => new window.Response(JSON.stringify(body),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = /** @type {typeof fetch} */ (async (url, init) => {
    const href = String(url);
    if (href.endsWith('/api/settings') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      puts.push(body.webSearch.order);
      return json({ webSearch: body.webSearch });
    }
    if (href.includes('/api/ops/call') && typeof init?.body === 'string') {
      const request = JSON.parse(init.body);
      if (request.toolId === 'extconfig' && request.operation === 'get') {
        return json({ success: true, data: request.params?.extId === '@juggler/search-backends' ? values : {} });
      }
    }
    return originalFetch.call(window, url, init);
  });
  return () => { window.fetch = originalFetch; };
}

/**
 * Mount the tab with a stored order and wait for its first drawing.
 * @param {string[]} order - The stored `webSearch.order`
 * @returns {Promise<{host: HTMLElement, tab: WebSearchTab, opened: string[]}>} The mounted tab and the Extensions pages it opened
 */
async function mount(order) {
  const host = /** @type {HTMLElement & {open?: (tab?: string, options?: any) => Promise<void>}} */ (document.createElement('div'));
  host.innerHTML = '<div id="web-search-form"></div>';
  /** @type {string[]} */
  const opened = [];
  host.open = async (_tab, options) => { opened.push(options?.capability?.id); };
  document.body.appendChild(host);
  const tab = new WebSearchTab(host);
  tab.onSettingsChanged({ webSearch: { order } });
  await tab.refresh();
  return { host, tab, opened };
}

/**
 * @param {HTMLElement} host - The mounted tab
 * @param {string} key - A backend key
 * @returns {HTMLElement} Its row
 */
function rowOf(host, key) {
  const row = /** @type {HTMLElement|null} */ (host.querySelector(`.web-search-row[data-backend="${CSS.escape(key)}"]`));
  if (!row) throw new Error(`no row for ${key}`);
  return row;
}

/**
 * @param {HTMLElement} host - The mounted tab
 * @returns {string[]} The keys drawn in use, in order
 */
function inUse(host) {
  return Array.from(host.querySelectorAll('.web-search-order > .web-search-row'))
    .map((el) => /** @type {HTMLElement} */ (el).dataset.backend ?? '');
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (!searchBackendRegistry.isInitialized()) await searchBackendRegistry.init();

  await run('a backend with its key is a switch; one without is a link to its page', async () => {
    /** @type {string[][]} */
    const puts = [];
    const restore = stubServer({ tavily_api_key: { __present: true }, brave_api_key: { __present: false } }, puts);
    const { host, tab, opened } = await mount([DDG]);
    try {
      assert(JSON.stringify(inUse(host)) === JSON.stringify([DDG]), `in use: ${JSON.stringify(inUse(host))}`);
      assert(!!rowOf(host, DDG).querySelector('.drag-grip'), 'a backend in use has a grip to drag it by');
      const tavily = rowOf(host, TAVILY);
      assert(!!tavily.querySelector('input[type="checkbox"]'), 'a backend with its key set has a switch');
      const brave = rowOf(host, BRAVE);
      assert(!brave.querySelector('input[type="checkbox"]'), 'a backend without its key has no switch');
      const link = /** @type {HTMLButtonElement|null} */ (brave.querySelector('.provider-control button'));
      if (!link) throw new Error('a backend without its key has no link');
      link.click();
      assert(JSON.stringify(opened) === '["brave"]', `the link opens the backend's page: ${JSON.stringify(opened)}`);
      assert(puts.length === 0, `drawing saved something: ${JSON.stringify(puts)}`);
    } finally {
      restore();
      tab.dispose();
      host.remove();
    }
  });

  await run('switching a backend on saves it last in the order and moves it up', async () => {
    /** @type {string[][]} */
    const puts = [];
    const restore = stubServer({ tavily_api_key: { __present: true } }, puts);
    const { host, tab } = await mount([DDG]);
    try {
      const input = /** @type {HTMLInputElement} */ (rowOf(host, TAVILY).querySelector('input[type="checkbox"]'));
      input.click();
      await waitFor(() => puts.length === 1, 'the order to be saved');
      assert(JSON.stringify(puts[0]) === JSON.stringify([DDG, TAVILY]), `saved ${JSON.stringify(puts[0])}`);
      await waitFor(() => JSON.stringify(inUse(host)) === JSON.stringify([DDG, TAVILY]),
        () => `tavily to be drawn in use, got ${JSON.stringify(inUse(host))}`);
    } finally {
      restore();
      tab.dispose();
      host.remove();
    }
  });

  await run('Alt+ArrowUp on a switch moves its backend up, and keeps focus on it', async () => {
    /** @type {string[][]} */
    const puts = [];
    const restore = stubServer({ tavily_api_key: { __present: true } }, puts);
    const { host, tab } = await mount([DDG, TAVILY]);
    try {
      const input = /** @type {HTMLInputElement} */ (rowOf(host, TAVILY).querySelector('input[type="checkbox"]'));
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
      await waitFor(() => puts.length === 1, 'the order to be saved');
      assert(JSON.stringify(puts[0]) === JSON.stringify([TAVILY, DDG]), `saved ${JSON.stringify(puts[0])}`);
      await waitFor(() => JSON.stringify(inUse(host)) === JSON.stringify([TAVILY, DDG]),
        () => `the new order to be drawn, got ${JSON.stringify(inUse(host))}`);
      const focused = /** @type {HTMLElement|null} */ (document.activeElement);
      assert(focused?.closest('.web-search-row')?.getAttribute('data-backend') === TAVILY,
        'focus stays on the switch that was moved');
    } finally {
      restore();
      tab.dispose();
      host.remove();
    }
  });

  await run('a stored backend that is not set up keeps its place in the setting', async () => {
    /** @type {string[][]} */
    const puts = [];
    const restore = stubServer({ tavily_api_key: { __present: true } }, puts);
    const { host, tab } = await mount([BRAVE, DDG]);
    try {
      assert(JSON.stringify(inUse(host)) === JSON.stringify([DDG]),
        `a backend without its key is not drawn in use: ${JSON.stringify(inUse(host))}`);
      const input = /** @type {HTMLInputElement} */ (rowOf(host, TAVILY).querySelector('input[type="checkbox"]'));
      input.click();
      await waitFor(() => puts.length === 1, 'the order to be saved');
      assert(JSON.stringify(puts[0]) === JSON.stringify([BRAVE, DDG, TAVILY]),
        `the stored brave was dropped or misplaced: ${JSON.stringify(puts[0])}`);
    } finally {
      restore();
      tab.dispose();
      host.remove();
    }
  });

  await run('switching off the last backend in use stores no backend, and it stays off', async () => {
    /** @type {string[][]} */
    const puts = [];
    const restore = stubServer({}, puts);
    const { host, tab } = await mount([DDG]);
    try {
      const input = /** @type {HTMLInputElement} */ (rowOf(host, DDG).querySelector('input[type="checkbox"]'));
      input.click();
      await waitFor(() => puts.length === 1, 'the order to be saved');
      assert(JSON.stringify(puts[0]) === '[]', `saved ${JSON.stringify(puts[0])}, not an empty order`);
      // The settings document that comes back holds the empty order: drawn
      // from it, DuckDuckGo must not come back on as the default.
      tab.onSettingsChanged({ webSearch: { order: [] } });
      assert(inUse(host).length === 0, `a stored empty order drew ${JSON.stringify(inUse(host))} in use`);
    } finally {
      restore();
      tab.dispose();
      host.remove();
    }
  });

  return { passed, failed, errors };
}
