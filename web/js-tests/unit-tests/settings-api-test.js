//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * services/settings-api.js — the REST calls the settings tabs make.
 *
 * Driven against a stubbed `fetch`, these pin the wire each function puts on it
 * (method, URL, body) and the failure policy it keeps: a single-key config write
 * is a PUT of exactly that key; a load given a fallback resolves to it; and a
 * failing write throws with the caller's prefix.
 * @module unit-tests/settings-api-test
 */

import { assert } from '../utilities/test-helpers.js';
import * as settingsApi from '../../js/services/settings-api.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @typedef {object} RecordedCall
 * @property {string} url The requested URL.
 * @property {string} method The HTTP method (GET when none was given).
 * @property {any} body The parsed JSON body, or null.
 * @property {Record<string, string>} headers The request headers.
 */

/**
 * Route window.fetch to `respond`, recording every request.
 * @param {(call: RecordedCall) => any} respond - Builds the response (or throws).
 * @returns {{calls: RecordedCall[], restore: () => void}} The recorded calls and a restore.
 */
function stubFetch(respond) {
  const original = window.fetch;
  /** @type {RecordedCall[]} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
      headers: init.headers || {},
    };
    calls.push(call);
    return respond(call);
  });
  return { calls, restore: () => { window.fetch = original; } };
}

/**
 * A JSON response.
 * @param {any} body - The decoded body.
 * @param {number} [status] - HTTP status.
 * @returns {any} A Response-shaped object.
 */
function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
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

  await run('setConfig PUTs the one key to /api/config as JSON', async () => {
    const { calls, restore } = stubFetch(() => json(null, 204));
    try {
      await settingsApi.setConfig('auto_name_disabled', true);
      assert(calls.length === 1, `expected one request, got ${calls.length}`);
      const [call] = calls;
      assert(call.method === 'PUT', `method was ${call.method}`);
      assert(call.url === '/api/config', `url was ${call.url}`);
      assert(JSON.stringify(call.body) === '{"auto_name_disabled":true}', `body was ${JSON.stringify(call.body)}`);
      assert(call.headers['Content-Type'] === 'application/json', 'the body was not sent as JSON');
    } finally {
      restore();
    }
  });

  await run('a failing setConfig throws with the caller’s prefix', async () => {
    const { restore } = stubFetch(() => json({ error: 'disk full' }, 500));
    try {
      let thrown = /** @type {any} */ (null);
      try {
        await settingsApi.setConfig('anthropic_api_key', 'sk-1', { errorPrefix: 'Failed to save API key' });
      } catch (e) {
        thrown = e;
      }
      assert(thrown, 'a 500 resolved instead of throwing');
      assert(thrown.status === 500, `status was ${thrown.status}`);
      assert(String(thrown.message).startsWith('Failed to save API key'), `message was ${thrown.message}`);
    } finally {
      restore();
    }
  });

  await run('a load given a fallback resolves to it when the server fails', async () => {
    const { calls, restore } = stubFetch(() => json({ error: 'down' }, 503));
    try {
      const fallback = { provider: 'a', model: 'b' };
      const got = await settingsApi.getDefaultModel({ fallback });
      assert(got === fallback, `got ${JSON.stringify(got)}`);
      assert(calls[0].url === '/api/default-model' && calls[0].method === 'GET', `requested ${calls[0].method} ${calls[0].url}`);
    } finally {
      restore();
    }
  });

  await run('a load given no fallback throws', async () => {
    const { restore } = stubFetch(() => json({ error: 'down' }, 503));
    try {
      let threw = false;
      try {
        await settingsApi.getConnectivity();
      } catch {
        threw = true;
      }
      assert(threw, 'getConnectivity() without a fallback swallowed the failure');
    } finally {
      restore();
    }
  });

  await run('updateSettings PUTs the patch to /api/settings and returns the document', async () => {
    const doc = { network: { proxy: { mode: 'none', url: '' } } };
    const { calls, restore } = stubFetch(() => json(doc));
    try {
      const got = await settingsApi.updateSettings({ network: { proxy: { mode: 'none', url: '' } } });
      assert(calls[0].method === 'PUT' && calls[0].url === '/api/settings', `requested ${calls[0].method} ${calls[0].url}`);
      assert(JSON.stringify(calls[0].body) === JSON.stringify(doc), `body was ${JSON.stringify(calls[0].body)}`);
      assert(JSON.stringify(got) === JSON.stringify(doc), `returned ${JSON.stringify(got)}`);
    } finally {
      restore();
    }
  });

  return { passed, failed, errors };
}
