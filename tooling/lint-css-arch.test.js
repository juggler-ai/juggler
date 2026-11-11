//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Cases for scripts/lint-css-arch. Run by `make lint-css` before the check
 * itself; throws (exit 1) when any check's findings for the fixtures below are
 * not exactly the expected ones. The source trees are written to a scratch
 * directory and removed afterwards; the sheets are passed in memory.
 */

import assert from 'node:assert/strict';
import { log } from 'node:console';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as espree from 'espree';

const require = createRequire(import.meta.url);
const arch = require('../scripts/lint-css-arch');

/** @type {string[]} */
const wrong = [];

/**
 * Record a disagreement between the items a check reported and the expected ones.
 * @param {string} label - The case.
 * @param {{item: string}[]} failures - What the check reported.
 * @param {string[]} want - The items it should have reported, in any order.
 */
function expectItems(label, failures, want) {
  const got = failures.map((f) => f.item);
  const extra = got.filter((x) => !want.includes(x));
  const missing = want.filter((x) => !got.includes(x));
  if (extra.length || missing.length) {
    wrong.push(`${label}:\n${extra.map((x) => `  + ${x}\n`).join('')}${missing.map((x) => `  - ${x}\n`).join('')}`);
  }
}

/**
 * Write a tree of files under a root.
 * @param {string} root - The directory to write into.
 * @param {Record<string, string>} files - Each file's text, by forward-slashed path.
 */
function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

/**
 * The manifest's sheets with absolute paths under a css directory, as main() builds them.
 * @param {string} cssDir - The directory the sheets sit in.
 * @param {{file: string, layer: string, owns?: string[], enumerates?: boolean}[]} sheets - The manifest's sheets.
 * @returns {{file: string, layer: string, abs: string}[]} The sheets with `abs` set.
 */
function placed(cssDir, sheets) {
  return sheets.map((s) => ({ ...s, abs: path.join(cssDir, ...s.file.split('/')) }));
}

// ---------------------------------------------------------------------------
// dead-selector and dynamicClasses, over a production corpus read from a tree.
// ---------------------------------------------------------------------------

/** A production tree, plus the test sources and vendor code the corpus must not read. */
const CORPUS_TREE = {
  'web/js/app.js': [
    "import { thing } from './import-path-only.js';",
    "export * from './reexport-path-only.js';",
    '// A comment names <div class="comment-only"> and builds comment-built-${thing}.',
    '/* block-comment-only */',
    'const identonly = thing;',
    "const el = document.createElement('div');",
    "el.className = 'live-literal anim anim2 nest-host icon';",
    'el.innerHTML = `<span class="live-template">${identonly}</span>`;',
    "el.id = 'live-id';",
    "el.title = t('t-only');",
    "console.warn('console-only');",
    "markForTranslation('mark-only');",
    "if (!el) throw new Error('error-only');",
    'el.classList.add(`chip-${identonly}`);',
    'el.classList.add(`nothing-${identonly}`);',
    'el.classList.add(`notail-${identonly}`);',
    "el.style.animation = 'js-anim 1s';",
    'el.dataset.label = t(`text-built-${identonly}`);',
    "import('./dynamic-path-only.js');",
    '',
  ].join('\n'),
  'web/js/app-test.js': "document.body.className = 'dash-test-only';\n",
  'web/js/vendor/prism-core.js': 'var prismident = 1;\n',
  'web/js/vendor/bundle.min.js': "var v = 'vendor-only';\n",
  'web/js-tests/t.js': "document.body.className = 'test-dir-only test-built-' + document.body.id;\n",
  'web/sdk/s.js': "export const s = (kind) => 'sdk-live plus-' + kind;\n",
  'web/extensions/ext/e.js': "export const e = 'ext-live';\n",
  'web/extensions/ext/_tests/e.js': "export const e = 'underscore-tests-only';\n",
  'web/machine/m.js': "export const m = 'machine-live';\n",
  'web/index.html': [
    '<!doctype html><html><head>',
    '<!-- <div class="html-comment-only"> -->',
    '<script nonce="{{.CSPNonce}}">',
    "document.body.classList.add('inline-script'); // inline-comment-only",
    "document.body.className = 'html-built-' + document.body.id;",
    '</script>',
    '<script type="application/json">{"k": "json-string"}</script>',
    '</head><body><div class="html-attr" title="a > b">html-text-only</div></body></html>',
    '',
  ].join('\n'),
  'web/engine.html': '<div class="engine-attr"></div>\n',
  'web/sandbox.html': '<div class="sandbox-attr"></div>\n',
  'web/machine/index.html': '<div class="machine-attr"></div>\n',
  'web/shell/window-shell.html': '<div class="shell-attr"></div>\n',
  'web/shell/stand-in.html': '<div class="stand-in-attr"></div>\n',
  // Stylesheets outside web/css: an extension's and the machine page's are
  // checked; a test's, a vendored one's and web/css's own (the manifest's) are not.
  'web/extensions/ext/e.css': [
    '.ext-live, .machine-live, .ext-sheet-dead, #ext-dead-id { color: red; }',
    '@keyframes ext-anim { to { opacity: 0; } }',
    '@keyframes ext-dead-anim { to { opacity: 0; } }',
    '.ext-live { animation: ext-anim 1s; }',
    '',
  ].join('\n'),
  'web/machine/m.css': '.machine-live, .sdk-live, .machine-sheet-dead { color: red; }\n',
  'web/extensions/ext/_tests/t.css': '.test-sheet-dead { color: red; }\n',
  'web/js/vendor/v.css': '.vendor-sheet-dead { color: red; }\n',
  'web/css/components/x.css': '.manifest-sheet-dead { color: red; }\n',
};

/** Every class the sheet styles, and whether production evidence keeps it alive. */
const LIVE = [
  'live-literal', 'live-template', 'anim', 'anim2', 'nest-host', 'icon', 'html-attr', 'inline-script',
  'json-string', 'ext-live', 'sdk-live', 'machine-live', 'prismident', 'engine-attr', 'sandbox-attr',
  'machine-attr',
];
const DEAD = [
  'comment-only', 'block-comment-only', 'identonly', 'import-path-only', 'reexport-path-only',
  'dynamic-path-only', 't-only', 'console-only', 'mark-only', 'error-only', 'html-comment-only',
  'html-text-only', 'inline-comment-only', 'dash-test-only', 'test-dir-only', 'underscore-tests-only',
  'vendor-only',
];
/** Classes only a dynamicClasses entry can keep alive; the stale entries' classes are dead. */
const DYNAMIC_LIVE = ['chip-red', 'plus-big', 'html-built-x'];
const DYNAMIC_DEAD = ['stale-a', 'comment-built-a', 'text-built-a', 'test-built-a', 'tail-a'];

const DEAD_SHEET = [
  "@font-face { font-family: F; src: url(fonts/f.woff2) format('woff2'); }",
  `${[...LIVE, ...DEAD, ...DYNAMIC_LIVE, ...DYNAMIC_DEAD].map((c) => `.${c}`).join(',\n')} { color: red; }`,
  '#live-id, #dead-id { color: red; }',
  'a[href$=".pdf"], .icon { background: url(icons/x.woff2); }',
  '.nest-host { background: url(n.woff2); & .live-literal { color: red; } }',
  '@keyframes js-anim { to { opacity: 0; } }',
  '@keyframes css-anim { to { opacity: 0; } }',
  '@keyframes var-anim { to { opacity: 0; } }',
  '@keyframes dead-anim { to { opacity: 0; } }',
  '.anim { animation: css-anim 1s; --pulse: var-anim 2s; }',
  '.anim2 { animation: var(--pulse); }',
  '',
].join('\n');

const deadSheets = [{ file: 'components/a.css', layer: 'components' }];
const deadSources = new Map([['components/a.css', DEAD_SHEET]]);

const DYNAMIC = [
  { pattern: 'chip-*', builtBy: 'web/js/app.js' },
  { pattern: 'plus-*', builtBy: 'web/sdk/s.js' },
  { pattern: 'html-built-*', builtBy: 'web/index.html' },
  // Stale: nothing composes the prefix any more.
  { pattern: 'stale-*', builtBy: 'web/js/app.js' },
  // Stale: only a comment composes it.
  { pattern: 'comment-built-*', builtBy: 'web/js/app.js' },
  // Stale: only a message composes it.
  { pattern: 'text-built-*', builtBy: 'web/js/app.js' },
  // Stale: only a longer prefix ending in it is composed.
  { pattern: 'tail-*', builtBy: 'web/js/app.js' },
  // A test is not a production source.
  { pattern: 'test-built-*', builtBy: 'web/js-tests/t.js' },
  // Composed, but no sheet styles a match.
  { pattern: 'nothing-*', builtBy: 'web/js/app.js' },
  { pattern: 'bad*glob*', builtBy: 'web/js/app.js' },
  { pattern: 'chip-*', builtBy: 'web/js/app.js' },
  { pattern: 'lonely-*' },
];

const scratch = mkdtempSync(path.join(tmpdir(), 'lint-css-arch-test-'));
try {
  const corpusRoot = path.join(scratch, 'corpus');
  writeTree(corpusRoot, CORPUS_TREE);
  const corpus = arch.productionCorpus(corpusRoot, espree);

  expectItems('dead-selector', arch.checkDeadSelectors({ dynamicClasses: DYNAMIC }, deadSheets, deadSources, corpus), [
    ...DEAD, ...DYNAMIC_DEAD, '#dead-id', '@dead-anim',
    'stale-*', 'comment-built-*', 'text-built-*', 'tail-*', 'test-built-*', 'nothing-*', 'bad*glob*', 'chip-*',
    JSON.stringify({ pattern: 'lonely-*' }),
  ]);

  // With no evidence at all, every name the sheet styles is dead: the live
  // cases above are alive because of their source, not because the check
  // cannot see them.
  expectItems('dead-selector, empty corpus', arch.checkDeadSelectors({}, deadSheets, deadSources, { tokens: new Set(), composed: new Map() }), [
    ...LIVE, ...DEAD, ...DYNAMIC_LIVE, ...DYNAMIC_DEAD, '#live-id', '#dead-id', '@js-anim', '@dead-anim',
  ]);

  // Every production stylesheet outside web/css is held to the same corpus:
  // a sheet is global once loaded, so a class in an extension's sheet is alive
  // when any production source builds it, its own extension's or not.
  const outside = arch.outsideStylesheets(corpusRoot);
  expectItems('outsideStylesheets', outside.sheets.map((s) => ({ item: s.file })), [
    'web/extensions/ext/e.css', 'web/machine/m.css',
  ]);
  expectItems('dead-selector, sheets outside web/css', arch.checkDeadSelectors({}, outside.sheets, outside.sources, corpus), [
    'ext-sheet-dead', 'machine-sheet-dead', '#ext-dead-id', '@ext-dead-anim',
  ]);

  // A source root or a rendered document that has gone missing fails the run
  // rather than dropping out of the corpus.
  for (const gone of ['web/machine', 'web/sandbox.html']) {
    const root = path.join(scratch, `missing-${path.basename(gone)}`);
    writeTree(root, CORPUS_TREE);
    rmSync(path.join(root, gone), { recursive: true });
    assert.throws(() => arch.productionCorpus(root, espree), /ENOENT/, `productionCorpus without ${gone}`);
  }

  // -------------------------------------------------------------------------
  // extension-styling: the classes web/sdk and web/extensions put on elements
  // or style, against the host's public styling API.
  // -------------------------------------------------------------------------
  const extRoot = path.join(scratch, 'ext');
  writeTree(extRoot, {
    'web/js/app.js': "const el = document.createElement('div'); el.className = 'panel-row host-only';\n",
    'web/sdk/lib/h.js': "export const b = () => createElement('div', 'sdk-block btn panel-row sdk-own');\n",
    'web/extensions/ext/a.js': [
      "const el = document.createElement('div');",
      "el.className = 'btn btn-primary ext-own panel-row is-open btn-icon-header';",
      "el.title = 'host-only';",
      '',
    ].join('\n'),
    'web/extensions/ext/view.js': [
      "injectStylesOnce('ext-view', `.viewer-page { gap: 0; } .ext-own2 .btn { gap: 0; }`);",
      'const CSS = `.ext-own3 .sdk-block, .is-open { gap: 0; }`;',
      "injectStylesOnce('ext-view-2', CSS);",
      '',
    ].join('\n'),
    // An SDK helper's own class stays the SDK's, on the element it builds for
    // a caller's class and on the caller's element it is handed.
    'web/sdk/lib/f.js': [
      "export function codeBox(text, cls) { const p = document.createElement('pre'); p.className = cls; p.classList.add('sdk-block'); return p; }",
      "export function mark(el) { el.classList.add('sdk-block'); }",
      '',
    ].join('\n'),
    'web/extensions/ext/calls.js': "codeBox('x', 'ext-box'); const own = document.createElement('div'); own.className = 'ext-mark'; mark(own);\n",
    'web/extensions/ext/debt.js': "const d = document.createElement('div'); d.className = 'debt-row';\n",
    'web/extensions/ext/_tests/t.js': "const t = document.createElement('div'); t.className = 'test-only-row';\n",
    'web/extensions/ext/a-test.js': "const u = document.createElement('div'); u.className = 'test-only-row';\n",
  });
  const extSheets = [
    { file: 'patterns/buttons.css', layer: 'patterns' },
    { file: 'components/panel.css', layer: 'components' },
  ];
  const extSources = new Map([
    ['patterns/buttons.css', '.btn { gap: 0; } .btn-primary { gap: 0; } .btn-icon-header { gap: 0; } .btn-xs { gap: 0; }\n'],
    ['components/panel.css', '.panel-row, .panel-row.is-open, .viewer-page, .sdk-block, .debt-row, .fixed-row, .host-only, .test-only-row { gap: 0; }\n'],
  ]);
  const extManifest = {
    public: [
      { pattern: 'btn', why: 'the button' },
      { pattern: 'btn-primary', why: 'its primary role' },
      { pattern: 'is-*', why: 'state vocabulary' },
      { pattern: 'ghost-*', why: 'matches nothing the host styles' },
      { pattern: 'btn-xs' },
    ],
    sdk: ['sdk-block', 'sdk-unused'],
    extensionDebt: [
      { file: 'web/extensions/ext/debt.js', classes: ['debt-row', 'fixed-row', 'own-class'] },
      { file: 'web/extensions/ext/gone.js', classes: ['debt-row'] },
    ],
  };
  const { buildMarkupModel } = require('../scripts/css-markup-model');
  const eslintScope = require('eslint-scope');
  const extModel = buildMarkupModel({ repoRoot: extRoot, espree, eslintScope });
  const extUse = arch.extensionClassUse(extRoot, extModel, espree);
  expectItems('extension-styling', arch.checkExtensionStyling(extManifest, extSheets, extSources, extUse), [
    'web/extensions/ext/a.js .panel-row',
    'web/extensions/ext/a.js .btn-icon-header',
    'web/extensions/ext/view.js .viewer-page',
    'web/extensions/ext/view.js .sdk-block',
    'web/sdk/lib/h.js .panel-row',
    'public ghost-*',
    'public btn-xs',
    'sdk sdk-unused',
    'extensionDebt web/extensions/ext/debt.js .fixed-row',
    'extensionDebt web/extensions/ext/debt.js .own-class',
    'extensionDebt web/extensions/ext/gone.js .debt-row',
  ]);

  // -------------------------------------------------------------------------
  // css-markup-model: an icon class handed over as data (`icon: 'icon-x'`)
  // lands on a <span>, and says nothing about the classes beside it.
  // -------------------------------------------------------------------------
  const iconRoot = path.join(scratch, 'icon-data');
  writeTree(iconRoot, {
    'web/js/a.js': [
      "export const badge = () => ({ color: 'web', icon: 'icon-data-only' });",
      "export const meta = { iconClass: 'icon-also-read', label: 'x', other: 'icon-not-an-icon-key' };",
      "export const action = { iconClass: 'menu-gear-glyph' };",
      "const s = document.createElement('i'); s.className = 'icon-also-read';",
      "export const notIcon = { icon: 'refresh' };",
      '',
    ].join('\n'),
  });
  const iconModel = buildMarkupModel({ repoRoot: iconRoot, espree, eslintScope });
  assert.deepEqual([...(iconModel.tagsOf('icon-data-only') ?? [])], ['span'], 'icon: data literal is a span');
  assert.deepEqual([...(iconModel.tagsOf('icon-also-read') ?? [])].sort(), ['i', 'span'], 'iconClass: adds span to what the markup says');
  assert.equal(iconModel.canCoexist(['icon-also-read', 'other-class']), false, 'a tag-only fact leaves a closed class closed');
  assert.equal(iconModel.canCoexist(['icon-data-only', 'other-class']), true, 'a data-only icon class is not closed');
  assert.equal(iconModel.tagsOf('icon-not-an-icon-key'), null, 'only the icon keys name an icon class');
  assert.equal(iconModel.tagsOf('refresh'), null, 'an icon value that is not an icon-* class is not one');
  assert.deepEqual([...(iconModel.tagsOf('menu-gear-glyph') ?? [])], ['span'], 'iconClass: any class name is a span');

  // -------------------------------------------------------------------------
  // css-markup-model: an element built and handed straight back
  // (`return createElement('div', 'x')`) has the tag it was built with.
  // -------------------------------------------------------------------------
  const returnRoot = path.join(scratch, 'returned');
  writeTree(returnRoot, {
    'web/js/a.js': [
      "import { createElement } from './html.js';",
      "export const title = (text) => createElement('div', 'returned-title other-title', text);",
      "export const any = (tag) => createElement(tag, 'returned-any');",
      '',
    ].join('\n'),
  });
  const returnModel = buildMarkupModel({ repoRoot: returnRoot, espree, eslintScope });
  assert.deepEqual([...(returnModel.tagsOf('returned-title') ?? [])], ['div'], 'return createElement: its literal tag');
  assert.equal(returnModel.canCoexist(['returned-title', 'unrelated']), true, 'a returned element closes no class');
  assert.equal(returnModel.tagsOf('returned-any'), null, 'a tag the caller names is unknown');

  // -------------------------------------------------------------------------
  // css-markup-model: a field set to a const element (`this._title = title`)
  // is that element; one also set to anything else stays of unknown tag.
  // -------------------------------------------------------------------------
  const fieldRoot = path.join(scratch, 'field-alias');
  writeTree(fieldRoot, {
    'web/js/a.js': [
      'export class A {',
      "  build() { const title = document.createElement('h3'); this._title = title; this._other = title; }",
      "  clear() { this._title = null; this._title?.classList.remove('field-mod'); }",
      "  sync(on) { this._title.classList.toggle('field-mod', on); }",
      "  swap(x) { this._other = x; this._other.classList.add('field-ambiguous'); }",
      '}',
      '',
    ].join('\n'),
  });
  const fieldModel = buildMarkupModel({ repoRoot: fieldRoot, espree, eslintScope });
  assert.deepEqual([...(fieldModel.tagsOf('field-mod') ?? [])], ['h3'], 'this.field = const: the const\'s tag');
  assert.equal(fieldModel.tagsOf('field-ambiguous'), null, 'a field also set to something else has no tag');

  // -------------------------------------------------------------------------
  // css-markup-model: a class put on a parameter lands on what the callers
  // hand in, and a class slot handed on to a factory is that factory's slot.
  // -------------------------------------------------------------------------
  const paramRoot = path.join(scratch, 'parameters');
  writeTree(paramRoot, {
    'web/js/a.js': [
      "export function mark(code) { code.classList.add('param-mark'); }",
      "export function present({ surface }) { surface.classList.add('param-sheet'); }",
      "export function presentVia(surface) { present({ surface }); }",
      "export function wild(x) { x.classList.add('param-wild'); }",
      "export function pre(text, className = 'param-default') { const p = document.createElement('pre'); p.className = className; return p; }",
      "export function section(text, className = 'param-forwarded') { return pre(text, className); }",
      '',
    ].join('\n'),
    'web/js/b.js': [
      "const code = document.createElement('code'); mark(code);",
      "const nav = document.createElement('nav'); present({ surface: nav });",
      "presentVia(document.createElement('ul'));",
      "wild(document.createElement('div')); wild(document.querySelector('.x'));",
      "section('t'); section('t', 'param-passed');",
      '',
    ].join('\n'),
  });
  const paramModel = buildMarkupModel({ repoRoot: paramRoot, espree, eslintScope });
  assert.deepEqual([...(paramModel.tagsOf('param-mark') ?? [])], ['code'], 'a parameter is the element its caller passes');
  assert.deepEqual([...(paramModel.tagsOf('param-sheet') ?? [])].sort(), ['nav', 'ul'], 'an options key, and a parameter handed on');
  assert.equal(paramModel.tagsOf('param-wild'), null, 'one unreadable caller leaves the tag unknown');
  assert.deepEqual([...(paramModel.tagsOf('param-forwarded') ?? [])], ['pre'], 'a class slot handed on: its default');
  assert.deepEqual([...(paramModel.tagsOf('param-passed') ?? [])], ['pre'], 'a class slot handed on: its callers');

  // -------------------------------------------------------------------------
  // css-markup-model: a class put on an element the model did not build — a
  // parameter, a lookup, a callback's result — joins whatever element that
  // really is. A `getElementById('<literal>')` is the document's element with
  // that id; anything else may be any element, so its class can share one
  // with any class at all.
  // -------------------------------------------------------------------------
  const openRoot = path.join(scratch, 'open-elements');
  writeTree(openRoot, {
    'web/index.html': '<header><button id="open-net" class="open-host open-ghost"></button><div class="open-solo"></div></header>\n',
    'web/js/a.js': [
      "export function bindNet(button) { button.classList.add('open-remote'); }",
      "bindNet(document.getElementById('open-net'));",
      "const host = document.getElementById('open-net'); host.classList.add('open-direct');",
      "export function wildBind(el) { el.classList.add('open-param'); }",
      'wildBind(window.someElement);',
      "document.querySelector('.x').classList.add('open-anon');",
      "export function later(row) { row.classList.add('open-unseen'); }",
      "const b = document.createElement('span'); b.className = 'open-built';",
      "export function make(cls) { const d = document.createElement('div'); d.className = 'open-base'; d.classList.add(cls); return d; }",
      "make('open-passed');",
      "const pick = () => 'open-returned'; const t = document.createElement('em'); t.classList.add('open-twin-base'); t.classList.add(pick());",
      "export function paint(el) { el.classList.add('open-painted'); }",
      "paint(document.createElement('dd')); paint(document.querySelector('.open-painted'));",
      "const solo = document.createElement('dt'); solo.className = 'open-solo-dt';",
      "export function present(el) { el.classList.add('open-sheet'); }",
      'export function inline({ host, sel }) { const s = host.querySelector(sel); present(s); }',
      "inline({ host: document, sel: '.open-menu-a' }); inline({ host: document, sel: '.open-menu-b' });",
      "const ma = document.createElement('menu'); ma.className = 'open-menu-a';",
      "const mb = document.createElement('menu'); mb.className = 'open-menu-b';",
      "export function inlineAny(host, sel) { host.querySelector(sel).classList.add('open-any-sheet'); }",
      "inlineAny(document, '.open-menu-a'); inlineAny(document, window.someSelector);",
      '',
    ].join('\n'),
  });
  const openModel = buildMarkupModel({ repoRoot: openRoot, espree, eslintScope });
  assert.equal(openModel.canCoexist(['open-host', 'open-remote']), true, 'a parameter given getElementById: that element\'s classes');
  assert.deepEqual([...(openModel.tagsOf('open-remote') ?? [])], ['button'], 'a parameter given getElementById: that element\'s tag');
  assert.equal(openModel.canCoexist(['open-remote', 'open-solo']), false, 'a parameter given getElementById: no other element');
  assert.equal(openModel.canCoexist(['open-host', 'open-ghost', 'open-direct']), true, 'getElementById: that element\'s classes');
  assert.deepEqual([...(openModel.tagsOf('open-direct') ?? [])], ['button'], 'getElementById: that element\'s tag');
  assert.equal(openModel.canCoexist(['open-direct', 'open-solo']), false, 'getElementById: no other element');
  assert.equal(openModel.canCoexist(['open-param', 'open-host']), true, 'a parameter given anything: any classes');
  assert.equal(openModel.tagsOf('open-param'), null, 'a parameter given anything: any tag');
  assert.equal(openModel.canCoexist(['open-anon', 'open-solo']), true, 'a lookup: any classes');
  assert.equal(openModel.canCoexist(['open-unseen', 'open-host']), true, 'a parameter nobody calls: any classes');
  assert.equal(openModel.canCoexist(['open-built', 'open-host']), false, 'an element built here keeps its classes to itself');
  assert.equal(openModel.canCoexist(['open-passed', 'open-base']), true, 'a class handed to a factory joins the classes it adds');
  assert.equal(openModel.canCoexist(['open-returned', 'open-twin-base']), true, 'a returned class name joins the element\'s other classes');
  assert.deepEqual([...(openModel.tagsOf('open-painted') ?? [])], ['dd'], 'a lookup by the parameter\'s own class: the other callers\' element');
  assert.equal(openModel.canCoexist(['open-painted', 'open-solo-dt']), false, 'a lookup by the parameter\'s own class: no other element');
  assert.deepEqual([...(openModel.tagsOf('open-sheet') ?? [])], ['menu'], 'a lookup by a selector parameter: what its callers name');
  assert.equal(openModel.canCoexist(['open-sheet', 'open-solo']), false, 'a lookup by a selector parameter: no other element');
  assert.equal(openModel.canCoexist(['open-any-sheet', 'open-solo']), true, 'a selector parameter one caller cannot name: any element');

  // -------------------------------------------------------------------------
  // token-parity
  // -------------------------------------------------------------------------
  const tokenSources = new Map([
    ['tokens/theme.css', [
      ':root { --space: 1rem; }',
      ':root[data-theme="dark"] { --fg: #000; --dark-only: #000; --one-theme: #111; --line: #000; }',
      ':root[data-theme="light"] { --fg: #fff; --light-only: #fff; }',
      // Two rules on one line: the theme block is the second.
      '.pad { color: var(--line); } :root[data-theme="light"] { --line: #fff; }',
      '',
    ].join('\n')],
    ['components/b.css', [
      '.b { color: var(--fg); margin: var(--space, 1rem); padding: var(--nowhere); gap: var(--ghost, 1px); }',
      '.c { color: var(--one-theme, red); width: var(--js-set); }',
      '.d { color: var(--fg, black); }',
      '',
    ].join('\n')],
  ]);
  const tokenSheets = [{ file: 'tokens/theme.css', layer: 'tokens' }, { file: 'components/b.css', layer: 'components' }];
  expectItems('token-parity', arch.checkTokenParity(
    { jsSetProperties: ['--js-set', '--js-unread', '--js-unnamed'] },
    tokenSheets, tokenSources,
    { tokens: new Set(['--js-set', '--js-unread']), composed: new Map() },
  ), ['--space', '--nowhere', '--ghost', '--fg', '--dark-only', '--light-only', '--js-unread', '--js-unnamed']);

  // -------------------------------------------------------------------------
  // ownership
  // -------------------------------------------------------------------------
  const ownSheets = [
    { file: 'components/menu.css', layer: 'components', owns: ['menu', 'menu-*'] },
    { file: 'components/popup.css', layer: 'components', owns: ['popup', '[data-view="board"]'] },
    { file: 'components/policy.css', layer: 'components', enumerates: true },
    { file: 'components/star.css', layer: 'components', owns: ['*'] },
    { file: 'components/enum-own.css', layer: 'components', enumerates: true, owns: ['foo'] },
    { file: 'components/dup-scope.css', layer: 'components', owns: ["[data-view = 'board']"] },
    // A name another sheet's glob already covers: two owners for one root.
    { file: 'components/menu-bar.css', layer: 'components', owns: ['menu-bar'] },
    // Two globs that cover each other's names: one failure, not two.
    { file: 'patterns/tip.css', layer: 'patterns', owns: ['tip*'] },
    { file: 'components/tip-row.css', layer: 'components', owns: ['tip-row*'] },
  ];
  const ownSources = new Map([
    ['components/menu.css', [
      '.menu, .menu-item { color: red; }',
      ':root[data-theme="light"] .menu { color: red; }',
      // Filed by its subject.
      '.popup .menu-item { color: red; }',
      // Neither its root's sheet nor its subject's.
      '.popup .label { color: red; }',
      '.orphan { color: red; }',
      '',
    ].join('\n')],
    ['components/popup.css', [
      '.popup { color: red; }',
      // Filed by the scope this sheet claims.
      '[data-view="board"] .menu { color: red; }',
      '[data-view="other"] .menu { color: red; }',
      '',
    ].join('\n')],
    ['components/policy.css', '.menu, .popup { color: red; }\n.unclaimed { color: red; }\n'],
  ]);
  expectItems('ownership', arch.checkOwnership({}, ownSheets, ownSources), [
    'components/menu.css:popup', 'components/menu.css:orphan', 'components/popup.css:menu',
    'components/policy.css:unclaimed', 'components/star.css:*', 'components/enum-own.css:foo',
    'components/dup-scope.css:[data-view=board]',
    'components/menu-bar.css:menu-bar', 'components/tip-row.css:tip-row*',
  ]);

  // Custom properties and @keyframes names are owned like classes: a name an
  // `owns` glob matches, or one a glob-free entry prefixes, or a `--` claim.
  const propSheets = [
    { file: 'tokens/t.css', layer: 'tokens' },
    { file: 'components/menu.css', layer: 'components', owns: ['menu', 'menu-item*'] },
    { file: 'components/card.css', layer: 'components', owns: ['card', '--deck-*'] },
    { file: 'components/policy.css', layer: 'components', enumerates: true },
    // A `--` claim another sheet's claim already covers.
    { file: 'components/hand.css', layer: 'components', owns: ['--deck-hand-*'] },
  ];
  const propSources = new Map([
    // Tokens are the global vocabulary: nothing there needs an owner.
    ['tokens/t.css', ':root { --accent: red; --anything-goes: 1px; }\n@keyframes token-free { to { opacity: 0; } }\n'],
    ['components/menu.css', [
      // Its own by prefix and by glob; then one with no owner.
      '.menu { --menu-gap: 1px; --menu-item-pad: 2px; --size: 1px; gap: var(--size); }',
      // Setting another group's hook (by prefix, by claim) and a token.
      '.menu .menu-item { --card-pad: 1px; --deck-w: 1px; --accent: blue; }',
      '@media (width > 1px) { .menu { --nested: 1px; } }',
      '.menu { &:hover { --hover-tint: 1px; } --after-nest: 1px; }',
      // A modifier in a selector is not a property.
      '.menu-item--close:hover { color: red; }',
      '/* .menu { --commented: 1px; } */',
      '@keyframes menu-in { to { opacity: 0; } }',
      // Keyframes are defined, never set as a hook: another group's name fails.
      '@keyframes card-in { to { opacity: 0; } }',
      '@keyframes fade { to { opacity: 0; } }',
      '',
    ].join('\n')],
    // A `--` claim covers properties and keyframes, never a class root.
    ['components/card.css', '.card { --deck-w: 1px; --deckle: 1px; }\n@keyframes deck-deal { to { opacity: 0; } }\n.deck-thing { color: red; }\n'],
    ['components/policy.css', '.menu { --policy-x: 1px; }\n@keyframes policy-in { to { opacity: 0; } }\n'],
  ]);
  expectItems('ownership, custom properties and keyframes', arch.checkOwnership({}, propSheets, propSources), [
    'components/menu.css:--size', 'components/menu.css:--nested', 'components/menu.css:--hover-tint',
    'components/menu.css:--after-nest', 'components/menu.css:@card-in', 'components/menu.css:@fade',
    'components/card.css:--deckle', 'components/card.css:deck-thing', 'components/hand.css:--deck-hand-*',
  ]);

  // -------------------------------------------------------------------------
  // layer-order
  // -------------------------------------------------------------------------
  const orderSheets = [
    { file: 'tokens/t.css', layer: 'tokens' },
    { file: 'base/fonts.css', layer: 'base' },
    { file: 'components/a.css', layer: 'components' },
    { file: 'base/late.css', layer: 'base' },
    { file: 'base/empty-late.css', layer: 'base' },
    { file: 'layout/x.css', layer: 'components' },
    { file: 'extra/y.css', layer: 'extra' },
  ];
  const orderSources = new Map([
    ['tokens/t.css', ':root { --a: 1; }\n'],
    ['base/fonts.css', '@font-face { font-family: F; src: url(f.woff2); }\n'],
    ['components/a.css', '.a { color: red; }\n'],
    ['base/late.css', '.late { color: red; }\n'],
    ['base/empty-late.css', '@font-face { font-family: G; src: url(g.woff2); }\n'],
  ]);
  expectItems('layer-order', arch.checkLayerOrder({ layers: ['tokens', 'base', 'components'] }, orderSheets, orderSources), [
    'base/late.css:order', 'layout/x.css:layer', 'extra/y.css:layer',
  ]);

  // layer-order, the wrap: every sheet is one `@layer <its layer> { … }`, the
  // first sheet declares the order ahead of its block, and every document
  // links that sheet before any other.
  const wrapManifest = { layers: ['tokens', 'base', 'components'] };
  const wrapSheets = [
    { file: 'base/fonts.css', layer: 'base' },
    { file: 'tokens/ok.css', layer: 'tokens' },
    { file: 'base/bare.css', layer: 'base' },
    { file: 'base/wrong.css', layer: 'base' },
    { file: 'components/two.css', layer: 'components' },
    { file: 'components/after.css', layer: 'components' },
    { file: 'components/stmt.css', layer: 'components' },
    { file: 'components/nested.css', layer: 'components' },
    { file: 'components/brace.css', layer: 'components' },
  ];
  const wrapSources = new Map([
    ['base/fonts.css', '/* order */\n@layer tokens, base, components;\n\n@layer base {\n@font-face { font-family: F; }\n}\n'],
    ['tokens/ok.css', '/* banner */\n@layer tokens {\n:root { --a: 1; }\n}\n/* trailing note */\n'],
    ['base/bare.css', '.a { color: red; }\n'],
    ['base/wrong.css', '@layer components {\n.b { color: red; }\n}\n'],
    ['components/two.css', '@layer components {\n.c { color: red; }\n}\n@layer components {\n.d { color: red; }\n}\n'],
    ['components/after.css', '@layer components {\n.e { color: red; }\n}\n.f { color: red; }\n'],
    ['components/stmt.css', '@layer tokens, base, components;\n@layer components {\n.g { color: red; }\n}\n'],
    ['components/nested.css', '@layer components {\n@media (width <= 10rem) { .h { color: red; } }\n}\n'],
    ['components/brace.css', '@layer components {\n.i::after { content: "}"; }\n}\n'],
  ]);
  const wrapDocs = new Map([
    ['first.html', '<link rel="stylesheet" href="/v1/css/base/fonts.css">\n<link rel="stylesheet" href="/v1/css/tokens/ok.css">'],
    ['late.html', '<link rel="stylesheet" href="/v1/css/tokens/ok.css">\n<link rel="stylesheet" href="/v1/css/base/fonts.css">'],
    ['shell.html', '{{template "window-shell-head" .}}\n<link rel="stylesheet" href="{{.AssetBase}}/css/components/two.css">'],
    ['own.html', '<link rel="stylesheet" href="own.css">'],
  ]);
  expectItems('layer-order wrap', arch.checkLayerWrap(wrapManifest, wrapSheets, wrapSources, wrapDocs), [
    'base/bare.css:wrap', 'base/wrong.css:wrap', 'components/two.css:wrap', 'components/after.css:wrap',
    'components/stmt.css:order-statement', 'late.html:first-link',
  ]);
  expectItems('layer-order wrap, statement', arch.checkLayerWrap(wrapManifest, wrapSheets.slice(0, 2), new Map([
    ['base/fonts.css', '@layer base, tokens, components;\n@layer base {\n@font-face { font-family: F; }\n}\n'],
    ['tokens/ok.css', '@layer tokens {\n:root { --a: 1; }\n}\n'],
  ]), new Map()), ['base/fonts.css:order-statement']);
  expectItems('layer-order wrap, no statement', arch.checkLayerWrap(wrapManifest, wrapSheets.slice(0, 2), new Map([
    ['base/fonts.css', '@layer base {\n@font-face { font-family: F; }\n}\n'],
    ['tokens/ok.css', '@layer tokens {\n:root { --a: 1; }\n}\n'],
  ]), new Map()), ['base/fonts.css:order-statement']);

  // -------------------------------------------------------------------------
  // asset-url
  // -------------------------------------------------------------------------
  const assetCss = path.join(scratch, 'assets', 'web', 'css');
  writeTree(assetCss, { 'base/f.woff2': '' });
  expectItems('asset-url', arch.checkAssetUrls(placed(assetCss, [{ file: 'base/fonts.css', layer: 'base' }]), new Map([
    ['base/fonts.css', [
      '@font-face { font-family: F; src: url(f.woff2) format("woff2"), url("missing.woff2"); }',
      ".a { background: url('/abs.png'); }",
      '.b { background: url(data:image/png;base64,AAA=); mask: url(#m); border-image: url(https://x.test/y.png); }',
      '.c { background: url( f.woff2?v=1#x ); }',
      '/* url(commented-out.png) */',
      '',
    ].join('\n')],
  ])), ['base/fonts.css:missing.woff2', 'base/fonts.css:/abs.png']);

  // -------------------------------------------------------------------------
  // link-parity
  // -------------------------------------------------------------------------
  const link = (sheet) => `<link rel="stylesheet" href="{{.BasePath}}/v{{.StaticVersion}}/css/${sheet}">`;
  const linkRoot = path.join(scratch, 'links');
  writeTree(linkRoot, {
    'web/index.html': [link('base/a.css'), link('components/b.css')].join('\n'),
    'web/js-tests/headless-test.html': [link('components/b.css'), link('base/a.css'), link('components/c.css')].join('\n'),
  });
  const linkManifest = { sheets: ['base/a.css', 'components/b.css', 'components/d.css'].map((file) => ({ file, layer: '' })) };
  expectItems('link-parity', arch.checkLinkParity(linkManifest, linkRoot), [
    'index.html:components/d.css', 'headless-test.html:components/d.css',
    'headless-test.html:components/c.css', 'headless-test.html:order',
  ]);
  rmSync(path.join(linkRoot, 'web', 'js-tests'), { recursive: true });
  expectItems('link-parity, missing document', arch.checkLinkParity(linkManifest, linkRoot), [
    'index.html:components/d.css', 'web/js-tests/headless-test.html:missing',
  ]);

  // -------------------------------------------------------------------------
  // scale-literal
  // -------------------------------------------------------------------------
  const scaleRoot = path.join(scratch, 'scale');
  writeTree(scaleRoot, {
    // A script's CSS is read from its string and template literals only.
    'web/js/a.js': [
      'const css = `',
      '.a { font-size: 13px; }',
      '.b { font-size: var(--font-size-sm); }',
      '.c { border-radius: 4px; }',
      '.d { border-radius: var(--radius-md) 0; }',
      '.e { border-top-left-radius: 50%; font-size: 1.2em !important; }',
      '.f { font-size: ${size}; padding: ${pad} 1rem; }',
      '`;',
      '// a comment saying padding: 1rem is not CSS',
      'const box = { gap: 8, margin: 0 };',
      '',
    ].join('\n'),
    'web/sdk/s.js': 'el.style.cssText = "font-size: 12px";\n',
    'web/extensions/ext/style.css': '.g { border-radius: 3px 0; }\n',
    'web/extensions/ext/_tests/t.js': '"font-size: 9px";\n',
    'web/js/vendor/v.js': '"font-size: 9px";\n',
    'web/js/x-test.js': '"font-size: 9px";\n',
    'web/css/components/x.css': [
      '.w1 { font-weight: 600; }',
      '.w2 { font-weight: var(--font-weight-bold); line-height: 1.45; }',
      '.l { line-height: 1; z-index: 2; }',
      '.z { z-index: 10; }',
      '.zv { z-index: var(--z-modal); line-height: var(--row-h); }',
      '.t1 { transition: opacity 0.2s, color 0s; }',
      '.t2 { transition: opacity var(--transition-fast), color var(--duration-base) var(--ease-out); }',
      '.t3 {',
      '    transition:',
      '        opacity var(--transition-fast),',
      '        transform 300ms cubic-bezier(0.2, 0, 0, 1);',
      '}',
      '.a1 { animation: spin 1.2s linear infinite; }',
      '.a2 { animation: pop 200ms cubic-bezier(0.2, 0, 0, 1); }',
      '@keyframes pop { 0% { animation-timing-function: cubic-bezier(0.4, 0, 1, 1); } }',
      '.s1 { padding: 0.5rem; }',
      '.s2 { padding: var(--space-8) 0 auto 2%; margin: -0.0625rem 0.5em; gap: 0; }',
      '.s3 { margin-inline-start: calc(100% - var(--space-8) + 0.0625rem); row-gap: 4px; }',
      '.s4 { margin-top: calc(100% - 1rem); }',
      '/* .comment { padding: 3rem; } */',
      '.k { padding: inherit; font-weight: unset; }',
      '',
    ].join('\n'),
    'web/css/tokens/scale.css': ':root { --space-8: 0.5rem; font-weight: 600; }\n',
    'web/css/vendor/theme.css': '.v { padding: 3rem; }\n',
    'web/machine/m.css': '.m { gap: 0.75rem; }\n',
  });
  expectItems('scale-literal', arch.checkScaleLiterals(scaleRoot), [
    'web/js/a.js:2', 'web/js/a.js:4', 'web/sdk/s.js:1', 'web/extensions/ext/style.css:1',
    'web/css/components/x.css:1', 'web/css/components/x.css:2', 'web/css/components/x.css:4',
    'web/css/components/x.css:6', 'web/css/components/x.css:10', 'web/css/components/x.css:14',
    'web/css/components/x.css:16', 'web/css/components/x.css:19', 'web/machine/m.css:1',
  ]);

  // -------------------------------------------------------------------------
  // layer-inversion
  // -------------------------------------------------------------------------
  const anything = { tagsOf: () => null, canCoexist: () => true };
  const inversions = arch.checkLayerInversion(
    { layers: ['base', 'components'] },
    [{ file: 'base/a.css', layer: 'base' }, { file: 'components/b.css', layer: 'components' }],
    new Map([
      ['base/a.css', [
        // Beats a higher-layer rule by specificity: an inversion.
        '.card .title { color: red; }',
        // The same specificity: source order and layer order agree.
        '.equal { background: red; }',
        // Important: wins in both regimes. Without it, an inversion.
        '.box .solo { margin: 0 !important; }',
        '.box .plain { margin: 0; }',
        // No property in common.
        '.card .other { padding: 0; }',
        // Media that cannot hold together. Outside any media, an inversion.
        '@media (max-width: 400px) { .card .narrow { width: 0; } }',
        '.card .wide { width: 0; }',
        '',
      ].join('\n')],
      ['components/b.css', [
        '.title { color: blue; }',
        '.equal { background: blue; }',
        '.solo { margin: 1px; }',
        '.other { border: 0; }',
        '@media (min-width: 800px) { .narrow { width: 1px; } }',
        '',
      ].join('\n')],
    ]),
    anything,
  );
  expectItems('layer-inversion', [...inversions].flatMap(([pair, found]) => found.map((f) => ({ item: `${pair}: ${f.lower.selector} / ${f.higher.selector}` }))), [
    'base/a.css > components/b.css: .card .title / .title',
    'base/a.css > components/b.css: .box .plain / .solo',
    'base/a.css > components/b.css: .card .wide / .narrow',
  ]);

  // -------------------------------------------------------------------------
  // the layer-inversion ratchet
  // -------------------------------------------------------------------------
  /**
   * Fake inversions for one file pair.
   * @param {number} n - How many.
   * @returns {{lower: {file: string, line: number, selector: string}, higher: {file: string, line: number, selector: string}}[]} The inversions.
   */
  const found = (n) => Array.from({ length: n }, (_, i) => ({
    lower: { file: 'l.css', line: i + 1, selector: '.l .x' },
    higher: { file: 'h.css', line: i + 1, selector: '.x' },
  }));
  const findings = new Map([['a > b', found(2)], ['c > d', found(6)], ['g > h', found(1)], ['i > j', found(1)]]);
  const printed = [];
  const consoleError = console.error;
  console.error = (/** @type {unknown[]} */ ...args) => { printed.push(args.join(' ')); };
  let problems;
  let clean;
  try {
    problems = arch.reportInversionRatchet(findings, ['a > b 2', 'c > d 5', 'e > f 1', 'g > h 3', 'i > j', 'garbage']);
    const before = printed.length;
    clean = arch.reportInversionRatchet(new Map([['a > b', found(2)]]), ['a > b 2']);
    assert.equal(printed.length, before, 'a ratchet every count matches prints nothing');
  } finally {
    console.error = consoleError;
  }
  assert.equal(clean, 0, 'a ratchet every count matches reports no problem');
  const report = printed.join('\n');
  for (const want of [
    '"i > j" is not "<lower> > <higher> <count>"',
    '"garbage" is not "<lower> > <higher> <count>"',
    'c > d — 6 inversions, 5 allowed: 1 new',
    'g > h — down to 1 from 3',
    'i > j — 1 rule filed below what they override',
    'e > f — none left of 1',
  ]) {
    if (!report.includes(want)) wrong.push(`layer-inversion ratchet: no "${want}" in\n${report}\n`);
  }
  if (report.includes('a > b')) wrong.push(`layer-inversion ratchet: the matching pair a > b was reported\n${report}\n`);
  if (problems !== 8) wrong.push(`layer-inversion ratchet: ${problems} problems, want 8\n`);

  // A Windows checkout of a `text=auto` file has CRLF line endings: a comment
  // line must still be dropped whole, and an entry must keep no stray \r.
  for (const eol of ['\n', '\r\n']) {
    const entries = arch.parseInversionRatchet(['# a comment', '#', 'a > b 2  # trailing', '', 'c > d 5'].join(eol) + eol);
    const want = ['a > b 2', 'c > d 5'];
    if (JSON.stringify(entries) !== JSON.stringify(want)) {
      wrong.push(`layer-inversion ratchet (${JSON.stringify(eol)} line ends): parsed ${JSON.stringify(entries)}, want ${JSON.stringify(want)}\n`);
    }
  }

  assert.equal(wrong.length, 0, `lint-css-arch fixture (+ unexpected, - missing):\n${wrong.join('')}`);
  log('✓ lint-css-arch cases');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
