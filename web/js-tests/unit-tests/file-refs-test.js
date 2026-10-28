//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * File-reference test: which inline-code spans in a reply are taken for a path
 * inside the conversation's tree, and what absolute path each one names.
 *
 * Only the syntax is decided here; whether the file exists is the resolver's
 * question, covered alongside.
 * @module unit-tests/file-refs-test
 */

import { assert } from '../utilities/test-helpers.js';

/** The working root every case resolves against. */
const ROOT = '/Users/me/proj';

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

  const { fileRefCandidate } = await import('../../js/utils/file-refs.js');

  /**
   * @param {string} label
   * @param {() => void | Promise<void>} fn
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

  /** @type {Array<[string, string, number|undefined]>} text, absolute path, line */
  const accepted = [
    ['CLAUDE.md', `${ROOT}/CLAUDE.md`, undefined],
    ['juggler/web/js/app.js', `${ROOT}/juggler/web/js/app.js`, undefined],
    ['juggler/web/js/app.js:348', `${ROOT}/juggler/web/js/app.js`, 348],
    ['web/js/app.js:12:3', `${ROOT}/web/js/app.js`, 12],
    ['web/js/app.js:12-40', `${ROOT}/web/js/app.js`, 12],
    ['./scripts/push-release', `${ROOT}/scripts/push-release`, undefined],
    ['docs/', `${ROOT}/docs`, undefined],
    [`${ROOT}/cmd/main.go`, `${ROOT}/cmd/main.go`, undefined],
    [`${ROOT}/cmd/main.go:7`, `${ROOT}/cmd/main.go`, 7],
    ['a/../b/c.js', `${ROOT}/b/c.js`, undefined],
    ['.github/workflows/release.yml', `${ROOT}/.github/workflows/release.yml`, undefined],
    ['  web/x.js  ', `${ROOT}/web/x.js`, undefined],
  ];

  for (const [text, path, line] of accepted) {
    await run(`accepts ${JSON.stringify(text)}`, () => {
      const got = fileRefCandidate(text, ROOT);
      assert(got !== null, `expected a candidate, got null`);
      assert(got.path === path, `path: expected ${path}, got ${got.path}`);
      assert(got.line === line, `line: expected ${line}, got ${got.line}`);
    });
  }

  const rejected = [
    '',
    'Makefile', // no slash and no extension: a word, not a path
    'make check',
    'a b.js',
    'https://example.com/x.js',
    'file:///Users/me/proj/x.js',
    'mailto:a@b.c',
    '~/code/x.js',
    '/etc/hosts',
    '/Users/me/projector/x.js', // shares the root's prefix but is outside it
    '../../x.js',
    '../sibling/x.js',
    '*.go',
    'web/**/x.js',
    'foo.bar()',
    'obj.method(arg)',
    'x => x.y',
    'a.b',
    '1.2.3',
    'v1.2',
    '3.14',
    'e.g.',
    '...',
    '.',
    '/',
    '<div>.html',
    'npm i foo.js',
    '--flag=x.js',
    `web/${'a'.repeat(400)}.js`,
    'line\nbreak.js',
    'web/x.js:abc',
  ];

  for (const text of rejected) {
    await run(`rejects ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)}`, () => {
      const got = fileRefCandidate(text, ROOT);
      assert(got === null, `expected null, got ${JSON.stringify(got)}`);
    });
  }

  await run('a root given with a trailing slash resolves the same', () => {
    const got = fileRefCandidate('web/x.js', `${ROOT}/`);
    assert(got?.path === `${ROOT}/web/x.js`, `got ${JSON.stringify(got)}`);
  });

  await run('no root, no candidate', () => {
    assert(fileRefCandidate('web/x.js', '') === null, 'expected null without a root');
  });

  await run('a Windows root resolves with its own separators', () => {
    const root = 'C:\\Users\\me\\proj';
    const rel = fileRefCandidate('web/x.js', root);
    assert(rel?.path === 'C:\\Users\\me\\proj\\web\\x.js', `relative: got ${JSON.stringify(rel)}`);
    const abs = fileRefCandidate('C:\\Users\\me\\proj\\web\\x.js:9', root);
    assert(abs?.path === 'C:\\Users\\me\\proj\\web\\x.js' && abs.line === 9, `absolute: got ${JSON.stringify(abs)}`);
    assert(fileRefCandidate('D:\\other\\x.js', root) === null, 'a path on another drive is outside the root');
  });

  // ── The existence resolver ────────────────────────────────────────────────

  const { createFileRefResolver } = await import('../../js/utils/file-refs.js');

  /**
   * A resolver over a fake server holding `files`, recording every request.
   * @param {object} [options]
   * @param {Set<string>} [options.files] - Paths the fake server says exist.
   * @param {() => number} [options.now] - Clock for the missing-path expiry.
   * @param {boolean} [options.fail] - Answer every request with null (could not ask).
   * @returns {{resolver: ReturnType<typeof createFileRefResolver>, calls: Array<{paths: string[], workspaceId: string}>, state: {fail: boolean}}}
   *   The resolver, the requests it has made, and a switch for failing them.
   */
  const fakeResolver = (options = {}) => {
    const { files = new Set(), now = Date.now } = options;
    /** @type {Array<{paths: string[], workspaceId: string}>} */
    const calls = [];
    const state = { fail: options.fail ?? false };
    const resolver = createFileRefResolver({
      debounceMs: 0,
      now,
      fetchExisting: async (paths, workspaceId = '') => {
        calls.push({ paths: [...paths], workspaceId });
        return state.fail ? null : new Set(paths.filter((p) => files.has(p)));
      },
    });
    return { resolver, calls, state };
  };

  await run('paths asked for in the same tick go out as one request', async () => {
    const files = new Set(['/r/a.js', '/r/c.js']);
    const { resolver, calls } = fakeResolver({ files });
    const waits = ['/r/a.js', '/r/b.js', '/r/c.js'].map((p) => resolver.request('', [p]));
    await Promise.all(waits);
    assert(calls.length === 1, `expected 1 request, got ${calls.length}`);
    assert(calls[0].paths.length === 3, `expected 3 paths in it, got ${calls[0].paths.length}`);
    assert(resolver.lookup('', '/r/a.js') === true, 'a.js exists');
    assert(resolver.lookup('', '/r/b.js') === false, 'b.js is missing');
  });

  await run('a large batch is split so no request carries more than 50 paths', async () => {
    const { resolver, calls } = fakeResolver();
    const paths = Array.from({ length: 120 }, (_, i) => `/r/f${i}.js`);
    await resolver.request('', paths);
    assert(calls.length === 3, `expected 3 requests, got ${calls.length}`);
    assert(calls.every((c) => c.paths.length <= 50), `sizes ${calls.map((c) => c.paths.length)}`);
  });

  await run('re-asking for known and in-flight paths sends nothing more', async () => {
    const { resolver, calls } = fakeResolver({ files: new Set(['/r/a.js']) });
    // A streaming tail re-parsed many times over, naming the same two paths.
    const waits = [];
    for (let i = 0; i < 50; i++) waits.push(resolver.request('', ['/r/a.js', '/r/b.js']));
    await Promise.all(waits);
    for (let i = 0; i < 50; i++) await resolver.request('', ['/r/a.js', '/r/b.js']);
    assert(calls.length === 1, `expected 1 request, got ${calls.length}`);
  });

  await run('a check that could not be made is not cached, and is asked again', async () => {
    const { resolver, calls, state } = fakeResolver({ files: new Set(['/r/a.js']), fail: true });
    await resolver.request('', ['/r/a.js']);
    assert(resolver.lookup('', '/r/a.js') === undefined, 'unknown after a failed check');
    state.fail = false;
    await resolver.request('', ['/r/a.js']);
    assert(calls.length === 2, `expected 2 requests, got ${calls.length}`);
    assert(resolver.lookup('', '/r/a.js') === true, 'known once the check succeeds');
  });

  await run('a missing path is asked again once its answer expires; a present one is not', async () => {
    let clock = 1000;
    const files = new Set(['/r/here.js']);
    const { resolver, calls } = fakeResolver({ files, now: () => clock });
    await resolver.request('', ['/r/here.js', '/r/later.js']);
    assert(resolver.lookup('', '/r/later.js') === false, 'missing at first');
    files.add('/r/later.js');
    clock += 60_000;
    assert(resolver.lookup('', '/r/later.js') === undefined, 'the missing answer has expired');
    assert(resolver.lookup('', '/r/here.js') === true, 'the present answer has not');
    await resolver.request('', ['/r/here.js', '/r/later.js']);
    assert(calls.length === 2, `expected 2 requests, got ${calls.length}`);
    assert(calls[1].paths.join() === '/r/later.js', `only the expired path is re-asked, got ${calls[1].paths}`);
    assert(resolver.lookup('', '/r/later.js') === true, 'present once created');
  });

  await run('each workspace has its own answers and is asked about by its own id', async () => {
    const { resolver, calls } = fakeResolver({ files: new Set(['/r/a.js']) });
    await resolver.request('', ['/r/a.js']);
    assert(resolver.lookup('ws1', '/r/a.js') === undefined, 'the project answer is not the workspace one');
    await resolver.request('ws1', ['/r/a.js']);
    assert(calls.length === 2 && calls[1].workspaceId === 'ws1', `calls ${JSON.stringify(calls)}`);
  });

  // ── Decorating rendered markdown ──────────────────────────────────────────

  const { decorateFileRefs } = await import('../../js/utils/file-refs.js');
  const { renderAssistantContent } = await import('../../sdk/lib/markdown.js');

  /**
   * @param {string} md - Markdown to render.
   * @returns {HTMLElement} A detached holder of the rendered nodes.
   */
  const rendered = (md) => {
    const holder = document.createElement('div');
    holder.innerHTML = renderAssistantContent(md);
    return holder;
  };

  await run('only inline code that names an existing file becomes a reference', async () => {
    const { resolver, calls } = fakeResolver({ files: new Set([`${ROOT}/web/a.js`]) });
    const holder = rendered([
      'See `web/a.js:12` and `web/gone.js`, not `foo.bar()`.',
      '',
      '```',
      'web/a.js',
      '```',
      '',
      'A [link `web/a.js`](https://example.com).',
    ].join('\n'));
    const waiting = decorateFileRefs(holder, { root: ROOT, workspaceId: '', resolver });
    assert(waiting !== null, 'unknown candidates are asked about');
    await waiting;
    assert(calls.length === 1, `expected 1 request, got ${calls.length}`);
    assert(calls[0].paths.join() === `${ROOT}/web/a.js,${ROOT}/web/gone.js`,
      `fenced code, linked code and non-paths are never asked about: ${calls[0].paths}`);
    const refs = [...holder.querySelectorAll('code.markdown-file-ref')];
    assert(refs.length === 1, `expected 1 reference, got ${refs.length}`);
    assert(refs[0].getAttribute('data-file-path') === `${ROOT}/web/a.js`, 'carries the absolute path');
    assert(refs[0].getAttribute('data-file-line') === '12', 'carries the line');
    assert(refs[0].getAttribute('role') === 'link' && refs[0].getAttribute('tabindex') === '0', 'is a keyboard link');
    assert(!holder.querySelector('[data-file-ref-pending]'), 'nothing is left pending');
  });

  await run('a known answer is applied synchronously and asks nothing', async () => {
    const { resolver, calls } = fakeResolver({ files: new Set([`${ROOT}/web/a.js`]) });
    await resolver.request('', [`${ROOT}/web/a.js`, `${ROOT}/web/gone.js`]);
    // A streaming tail is re-parsed into fresh elements on every delta; a path
    // already answered must not flicker through "pending" each time.
    for (let i = 0; i < 20; i++) {
      const holder = rendered('`web/a.js` and `web/gone.js`');
      const waiting = decorateFileRefs(holder, { root: ROOT, workspaceId: '', resolver });
      assert(waiting === null, 'nothing to wait for');
      assert(holder.querySelectorAll('code.markdown-file-ref').length === 1, 'the present path is a reference at once');
    }
    assert(calls.length === 1, `expected only the priming request, got ${calls.length}`);
  });

  await run('nothing is decorated without a root', () => {
    const { resolver, calls } = fakeResolver();
    const holder = rendered('`web/a.js`');
    assert(decorateFileRefs(holder, { root: '', workspaceId: '', resolver }) === null, 'nothing to wait for');
    assert(calls.length === 0 && !holder.querySelector('[data-file-ref-pending]'), 'nothing asked or marked');
  });

  return { passed, failed, errors };
}
