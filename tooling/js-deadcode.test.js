//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Cases for js-deadcode. Run by `make lint-js-deadcode` before the check
 * itself; throws (exit 1) when the findings for the fixture tree below are not
 * exactly the expected ones. The tree is written to a scratch directory and
 * removed afterwards.
 */

import assert from 'node:assert/strict';
import { log } from 'node:console';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyse } from './js-deadcode.js';

/** @type {Record<string, string>} */
const FILES = {
  // An HTML module root, and a test document's.
  'web/index.html': '<!-- <script src> in a comment --><script type="module" src="{{.BasePath}}/v{{.StaticVersion}}/js/app.js"></script>\n',
  'web/js-tests/run.html': '<script type="module" src="/js-tests/t.js"></script>\n',

  'web/js/app.js': [
    "import { used, notCalled } from './lib.js';",
    "import * as ns from './ns.js';",
    "import def from './def.js';",
    "import { chained, starred } from './barrel.js';",
    "import 'used-mod';",
    "/** @param {import('./types.js').Shape} s - A shape @returns {object} s */",
    'const keep = (s) => s;',
    "/** @param {import('./types.js').Unused} s - Documents dead code only */",
    'export function draw(s) { return s; }',
    'used(); ns.a(); def(); chained(); starred(); keep({ a: 1 });',
    "import('./lazy.js').then(({ lazyFn }) => lazyFn());",
    'const name = globalThis.pick;',
    'import(name);',
    'const other = globalThis.other;',
    'import(other);',
    "new Worker(new URL('./worker.js', import.meta.url));",
    "await import('./side-effect.js');",
    "import('./side-effect-bare.js');",
    'export const notReadByAnyone = 1;',
    '',
  ].join('\n'),
  'web/js/lib.js': [
    'export function used() { helper(); }',
    'export function helper() {}',
    'export function notCalled() {}',
    'export function testOnly() { testOnlyHelper(); }',
    'function testOnlyHelper() {}',
    'export function __hookRead() { resetCache(); }',
    'function resetCache() {}',
    'export function __hookUnread() {}',
    'function __orphanForTests() {}',
    'function unreferenced() {}',
    '',
  ].join('\n'),
  'web/js/ns.js': 'export function a() {}\nexport function b() {}\n',
  'web/js/def.js': 'export default function () {}\n',
  'web/js/barrel.js': "export { chained, chainUnused as renamed } from './chain-src.js';\nexport * from './star-src.js';\n",
  'web/js/chain-src.js': 'export function chained() {}\nexport function chainUnused() {}\n',
  'web/js/star-src.js': 'export function starred() {}\nexport function starUnused() {}\n',
  'web/js/lazy.js': 'export function lazyFn() {}\nexport function lazyUnused() {}\n',
  'web/js/loaded.js': 'export default 1;\nexport const extra = 2;\n',
  // Loaded only for what running them does: no export of either is read.
  'web/js/side-effect.js': 'export function sideUnused() {}\nglobalThis.ran = 1;\n',
  'web/js/side-effect-bare.js': 'export function bareUnused() {}\nglobalThis.ran = 2;\n',
  'web/js/worker.js': 'self.onmessage = () => {};\n',
  'web/js/types.js': [
    '/** @typedef {{a: number}} Shape */',
    '/** @typedef {{b: number}} Unused */',
    '/** @typedef {{c: number}} LocalOnly */',
    '/** @typedef {{d: number}} OnlyDeadCodeUses */',
    '/** @param {LocalOnly} x - Read by top-level code @returns {number} c */',
    'const read = (x) => x.c;',
    'read({ c: 1 });',
    '/** @param {OnlyDeadCodeUses} x - In a function nothing calls @returns {number} d */',
    'const unread = (x) => x.d;',
    'export {};',
    '',
  ].join('\n'),
  'web/js/orphan.js': 'export const x = 1;\n',
  'web/js/only-tests.js': 'export const y = 1;\n',
  'web/js/go-entry.js': 'console.log(1);\n',
  'web/js/go-test-entry.js': 'console.log(2);\n',
  'web/js/types/a.d.ts': "declare module 'used-mod' {\n  export const v: number;\n}\n",
  'web/js/types/b.d.ts': "declare module 'unused-mod' {\n  export const v: number;\n}\n",

  // The public SDK: live by path, and what it imports is production use.
  'web/sdk/api.js': "import { fromSdk } from '../js/inner.js';\nexport function publicFn() { return fromSdk(); }\n",
  'web/js/inner.js': 'export function fromSdk() {}\nexport function innerDead() {}\n',

  'web/js-tests/t.js': [
    "import { used, testOnly, __hookRead } from '../js/lib.js';",
    "import { deletedFromLib } from '../js/lib.js';",
    "import { y } from '../js/only-tests.js';",
    "import { helperUsed } from './util.js';",
    'used(); testOnly(); __hookRead(); helperUsed(y);',
    '',
  ].join('\n'),
  'web/js-tests/util.js': 'export function helperUsed() {}\nexport function helperDead() {}\n',
  'web/js-tests/util-dead.js': 'export const z = 1;\n',

  // Tooling: checked for the names it imports, and for nothing else.
  'tooling/imports.js': [
    "import { used, missingNamed } from '../web/js/lib.js';",
    "import missingDefault from '../web/js/lib.js';",
    "import def from '../web/js/def.js';",
    "import { starred, starMissing } from '../web/js/barrel.js';",
    "import { viaRelay, relayed } from './relay.js';",
    "import { Shape } from '../web/js/types.js';",
    "import { v } from 'used-mod';",
    "import { readFileSync } from 'node:fs';",
    "export { chained as chainOk, chainMissing } from '../web/js/barrel.js';",
    "export * from './relay.js';",
    "const { lazyFn, lazyMissing } = await import('../web/js/lazy.js');",
    "import('../web/js/lazy.js').then(({ thenMissing }) => thenMissing);",
    "const { default: loadedDefault } = await import('../web/js/loaded.js');",
    "/** @type {import('../web/js/types.js').Shape} */ const s = { a: 1 };",
    "/** @type {import('../web/js/types.js').TypeMissing} */ const t = { a: 1 };",
    "/** @type {import('../web/js/lib.js').used} */ const u = used;",
    "/** @import { Unused, ImportTagMissing } from '../web/js/types.js' */",
    'used(); def(); starred(); viaRelay(); relayed(); lazyFn(); readFileSync(v, String(s) + t + u + loadedDefault);',
    '',
  ].join('\n'),
  // A re-export chain: viaRelay resolves through barrel to chain-src;
  // chainUnused is exported by barrel only as `renamed`.
  'tooling/relay.js': [
    "export { chained as viaRelay, chainUnused as relayed } from '../web/js/barrel.js';",
    '',
  ].join('\n'),

  // Go roots: production, and a test's.
  'cmd/x.go': 'package x\n\nconst entry = "/js/go-entry.js"\n',
  'cmd/x_test.go': 'package x\n\nconst testEntry = "web/js/go-test-entry.js"\n',
};

/** @type {import('./js-deadcode.js').Config} */
const CONFIG = {
  sources: ['web'],
  exclude: [],
  tests: [/^web\/js-tests\//],
  publicApi: ['web/sdk/'],
  serverRoot: 'web',
  html: ['web/index.html', 'web/js-tests/run.html'],
  importsOnly: ['tooling'],
  manifests: [],
  goDirs: ['cmd'],
  dynamic: [
    { file: 'web/js/app.js', expr: 'name', targets: ['web/js/loaded.js'], names: ['default'], why: 'declared' },
    { file: 'web/js/app.js', expr: 'gone', targets: [], names: '*', why: 'stale' },
  ],
};

const root = mkdtempSync(path.join(tmpdir(), 'js-deadcode-'));
try {
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  const f = analyse(root, CONFIG);
  const got = {
    problems: f.problems.map((p) => `${p.file}: ${p.message}`),
    deadFiles: f.deadFiles,
    testOnlyFiles: f.testOnlyFiles,
    deadExports: f.deadExports.map((e) => `${e.file}: ${e.name}${e.local ? ' (drop export)' : ''}`),
    testOnlyExports: f.testOnlyExports.map((e) => `${e.file}: ${e.name}`),
    deadBindings: f.deadBindings.map((b) => `${b.file}: ${b.name}${b.testOnly ? ' (test-only)' : ''}`),
    badImports: (f.badImports ?? []).map((b) => `${b.file}:${b.line}: ${b.message}`),
  };
  const want = {
    problems: [
      'web/js/app.js: DYNAMIC_IMPORTS entry `gone` matches no site there — remove it',
      'web/js/app.js: import() `other` cannot be resolved: make it a literal, or say what it loads in DYNAMIC_IMPORTS',
    ],
    deadFiles: ['web/js-tests/util-dead.js', 'web/js/orphan.js', 'web/js/types/b.d.ts'],
    testOnlyFiles: ['web/js/go-test-entry.js', 'web/js/only-tests.js'],
    deadExports: [
      'web/js-tests/util.js: helperDead',
      'web/js/app.js: draw',
      'web/js/app.js: notReadByAnyone',
      'web/js/barrel.js: renamed',
      'web/js/chain-src.js: chainUnused',
      'web/js/inner.js: innerDead',
      'web/js/lazy.js: lazyUnused',
      'web/js/lib.js: helper (drop export)',
      'web/js/lib.js: notCalled',
      'web/js/lib.js: __hookUnread',
      'web/js/loaded.js: extra',
      'web/js/ns.js: b',
      'web/js/star-src.js: starUnused',
      'web/js/side-effect.js: sideUnused',
      'web/js/side-effect-bare.js: bareUnused',
      'web/js/types.js: Unused',
      'web/js/types.js: OnlyDeadCodeUses',
    ],
    testOnlyExports: ['web/js/lib.js: testOnly'],
    deadBindings: [
      'web/js/lib.js: testOnlyHelper (test-only)',
      'web/js/lib.js: __orphanForTests',
      'web/js/lib.js: unreferenced',
      'web/js/types.js: unread',
    ],
    badImports: [
      'tooling/imports.js:1: web/js/lib.js exports no `missingNamed`',
      'tooling/imports.js:2: web/js/lib.js has no default export',
      'tooling/imports.js:4: web/js/barrel.js exports no `starMissing`',
      'tooling/imports.js:6: `Shape` is only a typedef of web/js/types.js — a type has no value to import',
      'tooling/imports.js:9: web/js/barrel.js exports no `chainMissing`',
      'tooling/imports.js:11: web/js/lazy.js exports no `lazyMissing`',
      'tooling/imports.js:12: web/js/lazy.js exports no `thenMissing`',
      'tooling/imports.js:15: web/js/types.js declares no type `TypeMissing`',
      'tooling/imports.js:17: web/js/types.js declares no type `ImportTagMissing`',
      'tooling/relay.js:1: web/js/barrel.js exports no `chainUnused`',
      'web/js-tests/t.js:2: web/js/lib.js exports no `deletedFromLib`',
    ],
  };
  /** @type {string[]} */ const wrong = [];
  for (const key of /** @type {(keyof typeof want)[]} */ (Object.keys(want))) {
    const g = [...got[key]].sort();
    const w = [...want[key]].sort();
    const extra = g.filter((x) => !w.includes(x));
    const missing = w.filter((x) => !g.includes(x));
    if (extra.length || missing.length) {
      wrong.push(`${key}:\n${extra.map((x) => `  + ${x}\n`).join('')}${missing.map((x) => `  - ${x}\n`).join('')}`);
    }
  }
  assert.equal(wrong.length, 0, `js-deadcode fixture (+ unexpected, - missing):\n${wrong.join('')}`);
  log('✓ js-deadcode cases');
} finally {
  rmSync(root, { recursive: true, force: true });
}
