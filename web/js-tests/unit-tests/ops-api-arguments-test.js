//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: every ops-api wrapper takes its trailing arguments in one order.
 *
 * A rooted op is `(params, signal, allowedPaths, workspaceId)` and the shell is
 * `(params, signal, workspaceId)`. The arguments are positional and all
 * optional, so a wrapper that took them in another order would not fail: it
 * would send a grant as a workspace id, or drop the signal, and the op would run
 * somewhere else, or uncancellably, looking exactly as if it had worked. Each
 * case calls a wrapper the way the rule says to and reads what reached the wire.
 * @module unit-tests/ops-api-arguments
 */

import { assert } from '../utilities/test-helpers.js';
import {
  readFile,
  readFiles,
  writeFile,
  editFile,
  editFileLines,
  fileHash,
  stat,
  mkdir,
  getTree,
  expandDirectory,
  glob,
  copyTree,
  compareTrees,
  grep,
  findSymbol,
  shell,
} from '../../js/services/ops-api.js';

/**
 * What one call put on the wire.
 * @typedef {object} Sent
 * @property {any} body - The parsed request body.
 * @property {boolean} aborted - Whether the request went out already cancelled.
 */

/**
 * Run `call` against a fetch that records the request and answers success.
 * @param {() => Promise<any>} call - The wrapper call.
 * @returns {Promise<Sent>} What was sent.
 */
async function sentBy(call) {
  const real = window.fetch;
  /** @type {Sent|null} */
  let sent = null;
  window.fetch = /** @type {any} */ (async (/** @type {any} */ _input, /** @type {any} */ init) => {
    sent = { body: JSON.parse(init.body), aborted: !!init.signal?.aborted };
    return new window.Response(JSON.stringify({ success: true, data: { ok: true } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  try {
    await call().catch(() => {});
  } finally {
    window.fetch = real;
  }
  if (!sent) throw new Error('the wrapper sent nothing');
  return sent;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => Promise<void>} fn - Test body.
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

  const grant = ['/granted/elsewhere'];
  const where = 'ws_argument_order';
  /** @returns {AbortSignal} A signal that has already fired. */
  const cancelled = () => { const c = new AbortController(); c.abort(); return c.signal; };

  /** @type {[string, (signal: AbortSignal, paths: string[], ws: string) => Promise<any>][]} */
  const rooted = [
    ['readFile', (s, p, w) => readFile({ path: 'a' }, s, p, w)],
    ['readFiles', (s, p, w) => readFiles({ paths: ['a'] }, s, p, w)],
    ['writeFile', (s, p, w) => writeFile({ path: 'a', content: '' }, s, p, w)],
    ['editFile', (s, p, w) => editFile({ path: 'a', old_str: 'x', new_str: 'y' }, s, p, w)],
    ['editFileLines', (s, p, w) => editFileLines({ path: 'a', startLine: 1, endLine: 1, newContent: '' }, s, p, w)],
    ['fileHash', (s, p, w) => fileHash({ path: 'a' }, s, p, w)],
    ['stat', (s, p, w) => stat({ path: 'a' }, s, p, w)],
    ['mkdir', (s, p, w) => mkdir({ path: 'a' }, s, p, w)],
    ['getTree', (s, p, w) => getTree({}, s, p, w)],
    ['expandDirectory', (s, p, w) => expandDirectory({ path: 'a' }, s, p, w)],
    ['glob', (s, p, w) => glob({ pattern: '*' }, s, p, w)],
    ['copyTree', (s, p, w) => copyTree({ to: 'b' }, s, p, w)],
    ['compareTrees', (s, p, w) => compareTrees({ left: 'a', right: 'b' }, s, p, w)],
    ['grep', (s, p, w) => grep({ pattern: 'x' }, s, p, w)],
    ['findSymbol', (s, p, w) => findSymbol({ symbol: 'x' }, s, p, w)],
  ];

  for (const [name, call] of rooted) {
    await run(`${name} takes (params, signal, allowedPaths, workspaceId)`, async () => {
      const sent = await sentBy(() => call(cancelled(), grant, where));
      assert(JSON.stringify(sent.body.allowedPaths) === JSON.stringify(grant),
        `the grant did not travel as the grant, got allowedPaths=${JSON.stringify(sent.body.allowedPaths)}`);
      assert(sent.body.workspaceId === where,
        `the workspace did not travel as the workspace, got workspaceId=${JSON.stringify(sent.body.workspaceId)}`);
      assert(sent.aborted, 'the caller\'s signal never reached the request');
    });
  }

  await run('shell takes (params, signal, workspaceId)', async () => {
    const sent = await sentBy(() => shell({ command: 'true' }, cancelled(), where));
    assert(sent.body.workspaceId === where,
      `the workspace did not travel as the workspace, got workspaceId=${JSON.stringify(sent.body.workspaceId)}`);
    assert(sent.body.allowedPaths === undefined, 'a shell carries no grant');
    assert(sent.aborted, 'the caller\'s signal never reached the request');
  });

  // Extensions call these by position, so the shapes that left out a slot are
  // still read correctly: the grant goes as the grant, the id as the workspace.
  /** @type {[string, (paths: any, ws: any) => Promise<any>][]} */
  const signalless = [
    ['fileHash', (p, w) => fileHash({ path: 'a' }, p, w)],
    ['stat', (p, w) => stat({ path: 'a' }, p, w)],
    ['mkdir', (p, w) => mkdir({ path: 'a' }, p, w)],
    ['getTree', (p, w) => getTree({}, p, w)],
    ['expandDirectory', (p, w) => expandDirectory({ path: 'a' }, p, w)],
  ];
  for (const [name, call] of signalless) {
    await run(`${name} still reads (params, allowedPaths, workspaceId)`, async () => {
      const sent = await sentBy(() => call(grant, where));
      assert(JSON.stringify(sent.body.allowedPaths) === JSON.stringify(grant),
        `got allowedPaths=${JSON.stringify(sent.body.allowedPaths)}`);
      assert(sent.body.workspaceId === where, `got workspaceId=${JSON.stringify(sent.body.workspaceId)}`);
    });
    await run(`${name} still reads (params, undefined, workspaceId)`, async () => {
      const sent = await sentBy(() => call(undefined, where));
      assert(sent.body.allowedPaths === undefined, `got allowedPaths=${JSON.stringify(sent.body.allowedPaths)}`);
      assert(sent.body.workspaceId === where, `got workspaceId=${JSON.stringify(sent.body.workspaceId)}`);
    });
  }

  await run('findSymbol still reads (params, signal, workspaceId)', async () => {
    const sent = await sentBy(() => findSymbol({ symbol: 'x' }, cancelled(), /** @type {any} */ (where)));
    assert(sent.body.allowedPaths === undefined, `got allowedPaths=${JSON.stringify(sent.body.allowedPaths)}`);
    assert(sent.body.workspaceId === where, `got workspaceId=${JSON.stringify(sent.body.workspaceId)}`);
    assert(sent.aborted, 'the caller\'s signal never reached the request');
  });

  await run('shell still reads (params, workspaceId, signal)', async () => {
    const sent = await sentBy(() => shell({ command: 'true' }, /** @type {any} */ (where), /** @type {any} */ (cancelled())));
    assert(sent.body.workspaceId === where, `got workspaceId=${JSON.stringify(sent.body.workspaceId)}`);
    assert(sent.aborted, 'the caller\'s signal never reached the request');
  });

  return { passed, failed, errors };
}
