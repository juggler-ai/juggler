//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Server URL building test.
 *
 * A page served through the machine server's session proxy is mounted at
 * /p/<key>/, and says so in `window.__jugglerBase`. Every /api and WebSocket URL
 * the client builds must carry that base, or it reaches the machine server's own
 * root instead of the session. A page reached directly has an empty base and
 * must build exactly the URLs it always has.
 * @module unit-tests/api-url-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { basePath, apiUrl, isApiUrl, wsUrl, serverPath } = await import('../../js/utils/api-url.js');
  const { resolveAssetUrl } = await import('../../js/utils/asset-url.js');
  const { default: apiService } = await import('../../js/services/api.js');

  const g = /** @type {any} */ (globalThis);
  const hadBase = Object.prototype.hasOwnProperty.call(g, '__jugglerBase');
  const savedBase = g.__jugglerBase;
  /** @param {string|undefined} base */
  const setBase = (base) => {
    if (base === undefined) delete g.__jugglerBase;
    else g.__jugglerBase = base;
  };
  const restoreBase = () => setBase(hadBase ? savedBase : undefined);

  /**
   * Run one case under a given base, restoring the page's own afterwards.
   * @param {string} label
   * @param {string|undefined} base
   * @param {() => void | Promise<void>} fn
   */
  const run = async (label, base, fn) => {
    setBase(base);
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      restoreBase();
    }
  };

  const origin = globalThis.location.origin;
  const host = globalThis.location.host;

  await run('an untemplated page has an empty base', undefined, () => {
    assert(basePath() === '', `basePath() = ${basePath()}`);
    assert(apiUrl('/config') === '/api/config', `apiUrl = ${apiUrl('/config')}`);
  });

  await run('a direct page builds the URLs it always has', '', () => {
    assert(apiUrl('/logs?path=a%2Fb') === '/api/logs?path=a%2Fb', `apiUrl = ${apiUrl('/logs?path=a%2Fb')}`);
    assert(wsUrl('role=viewer') === `ws://${host}/api/ws?role=viewer`, `wsUrl = ${wsUrl('role=viewer')}`);
    assert(isApiUrl('/api/config'), 'relative /api URL');
    assert(isApiUrl(`${origin}/api/config`), 'absolute /api URL');
    assert(!isApiUrl('/v1/js/app.js'), 'an asset is not /api');
  });

  await run('a proxied page builds every URL under its base', '/p/myapp-81fb48e2', () => {
    assert(basePath() === '/p/myapp-81fb48e2', `basePath() = ${basePath()}`);
    assert(apiUrl('/config') === '/p/myapp-81fb48e2/api/config', `apiUrl = ${apiUrl('/config')}`);
    assert(wsUrl('role=viewer&token=t') === `ws://${host}/p/myapp-81fb48e2/api/ws?role=viewer&token=t`,
      `wsUrl = ${wsUrl('role=viewer&token=t')}`);
  });

  await run('the token shim test follows the base', '/p/myapp-81fb48e2', () => {
    assert(isApiUrl('/p/myapp-81fb48e2/api/config'), 'this session, relative');
    assert(isApiUrl(`${origin}/p/myapp-81fb48e2/api/config`), 'this session, absolute');
    // The token belongs to this session's server: never hand it to another
    // session, nor to the machine server's own API.
    assert(!isApiUrl('/p/other-deadbeef/api/config'), 'another session');
    assert(!isApiUrl('/api/server/sessions'), 'the machine server itself');
  });

  await run('non-API server paths follow the base', '/p/myapp-81fb48e2', () => {
    assert(serverPath('/sandbox') === '/p/myapp-81fb48e2/sandbox', `serverPath = ${serverPath('/sandbox')}`);
    assert(serverPath('/worker-module?url=x') === '/p/myapp-81fb48e2/worker-module?url=x',
      `serverPath = ${serverPath('/worker-module?url=x')}`);
  });

  await run('a direct page leaves non-API server paths alone', '', () => {
    assert(serverPath('/sandbox') === '/sandbox', `serverPath = ${serverPath('/sandbox')}`);
  });

  await run('disk-served extension assets follow the base', '/p/myapp-81fb48e2', () => {
    // Built-in assets take the versioned prefix, which the server already
    // templates under the base; disk-served ones skip it and need the base
    // of their own.
    const got = resolveAssetUrl('/user-extensions/x/y.js');
    assert(got === '/p/myapp-81fb48e2/user-extensions/x/y.js', `resolveAssetUrl = ${got}`);
  });

  await run('APIService requests go through the base', '/p/myapp-81fb48e2', async () => {
    /** @type {string[]} */
    const urls = [];
    const realFetch = window.fetch;
    window.fetch = /** @type {any} */ (async (/** @type {any} */ url) => {
      urls.push(String(url));
      return new globalThis.Response('{"status":"ok"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      await apiService.getHealth();
    } finally {
      window.fetch = realFetch;
    }
    assert(urls.length === 1 && urls[0] === '/p/myapp-81fb48e2/api/health', `fetched ${JSON.stringify(urls)}`);
  });

  return { passed, failed, errors };
}
