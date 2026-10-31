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
    'web/js/a.js': [
      '.a { font-size: 13px; }',
      '.b { font-size: var(--font-size-sm); }',
      '.c { border-radius: 4px; }',
      '.d { border-radius: var(--radius-md) 0; }',
      '.e { border-top-left-radius: 50%; font-size: 1.2em !important; }',
      '.f { font-size: ${size}; }',
      '',
    ].join('\n'),
    'web/sdk/s.js': 'el.style.cssText = "font-size: 12px";\n',
    'web/extensions/ext/style.css': '.g { border-radius: 3px 0; }\n',
    'web/extensions/ext/_tests/t.js': '.h { font-size: 9px; }\n',
    'web/js/vendor/v.js': '.i { font-size: 9px; }\n',
    'web/js/x-test.js': '.j { font-size: 9px; }\n',
  });
  expectItems('scale-literal', arch.checkScaleLiterals(scaleRoot), [
    'web/js/a.js:1', 'web/js/a.js:3', 'web/sdk/s.js:1', 'web/extensions/ext/style.css:1',
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
