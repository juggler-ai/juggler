//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Cases for lint-css-in-js. Run by `make lint-css` before the check itself;
 * throws (exit 1) on the first case that disagrees.
 */

import assert from 'node:assert/strict';
import { log } from 'node:console';
import { fixSource, inScope, lintSource } from './lint-css-in-js.js';

const FILE = 'web/extensions/x/x.js';

/**
 * The findings for a JS source, as `line:column rule`.
 * @param {string} source - The JS source.
 * @param {string} [file] - Its repo-relative path.
 * @returns {Promise<string[]>} One entry per finding, in file order.
 */
async function findings(source, file = FILE) {
  return (await lintSource(source, file)).map((f) => `${f.line}:${f.column} ${f.rule}`);
}

/** A clean block, wrapped in whatever the case needs around it. */
const CLEAN = '.a {\n  color: var(--text-primary);\n}\n';

// Clean CSS, however it is passed, reports nothing.
for (const source of [
  `injectStylesOnce('a', \`\n${CLEAN}\`);`,
  `injectStylesOnce('a', ${JSON.stringify(CLEAN)});`,
  `const CSS = \`\n${CLEAN}\`;\ninjectStylesOnce('a', CSS);`,
  `ui.injectStylesOnce('a', \`\n${CLEAN}\`);`,
  // A file that injects nothing.
  "const css = '.a { color: #fff; }'; style.textContent = css;",
]) {
  assert.deepEqual(await findings(source), [], `clean: ${source}`);
}

// Every literal colour the sheets are refused, at its place in the JS file:
// the column of a finding on the template's first line counts from the backtick.
assert.deepEqual(await findings([
  'export function f() {}',
  "injectStylesOnce('a', `.a {",
  '  color: #fff;',
  '  background: var(--bg-raised, rgba(127, 127, 127, 0.15));',
  '  border-color: white;',
  '}`);',
].join('\n')), [
  '3:10 color-no-hex',
  '4:32 juggler/no-literal-colour-function',
  // The rest of stylelint-config-standard holds too.
  '4:32 color-function-alias-notation',
  '4:32 color-function-notation',
  '4:52 alpha-value-notation',
  '5:17 color-named',
]);
assert.deepEqual(await findings("injectStylesOnce('a', `.a { color: #fff; }`);"), ['1:36 color-no-hex']);
// A string literal, a const bound to one, and a member call are read the same way.
assert.deepEqual(await findings("injectStylesOnce('a', '.a { color: #fff; }');"), ['1:36 color-no-hex']);
assert.deepEqual(await findings("const S = '.a { color: #fff; }';\n\ninjectStylesOnce('a', S);"), ['1:24 color-no-hex']);
assert.deepEqual(await findings("sdk.ui.injectStylesOnce('a', `.a {\n  color: #fff;\n}`);"), ['2:10 color-no-hex']);
// Every other rule of the config holds too: rem over px.
assert.deepEqual(await findings("injectStylesOnce('a', `.a {\n  margin: 2px;\n}`);"), [
  '2:3 rem-over-px/rem-over-px', '2:12 unit-disallowed-list',
]);

// A `${…}` is a neutral placeholder — as a value, part of a value, in a class
// name, as a whole selector, in a var() fallback — and each line
// after one, a multi-line one included, is still reported where it is.
assert.deepEqual(await findings([
  "injectStylesOnce('a', `.a-${kind} {",
  '  width: ${w}rem;',
  '  color: ${colour};',
  '  background: var(--x, ${fallback});',
  '  border-color: ${pick(',
  '    a,',
  '    b)};',
  '  outline-color: red;',
  '',
  '  & ${sel} { color: var(--x); }',
  '}`);',
].join('\n')), ['8:18 color-named']);
// A finding after a `${…}` on its own line, or after an escape sequence, is at
// its column in the file.
assert.deepEqual(await findings("injectStylesOnce('a', `.a {\n  border: ${w} solid red;\n}`);"), ['2:22 color-named']);
assert.deepEqual(await findings("injectStylesOnce('a', `.a::before {\n  content: '\\\\2014'; color: red;\n}`);"), [
  '2:29 color-named',
]);
// A file checked out with CRLF line endings maps the same.
assert.deepEqual(await findings("x();\r\ninjectStylesOnce('a', `.a {\r\n  color: red;\r\n}`);\r\n"), ['3:10 color-named']);
// A property name cannot be checked when it is not in the source.
assert.deepEqual(await findings("injectStylesOnce('a', `.a {\n  ${prop}: 1rem;\n}`);"), ['2:3 property-no-unknown']);

// CSS that cannot be read without running the code is itself refused.
for (const arg of ['css', 'makeCss()', "'.a {' + body + '}'", 'TWICE']) {
  const source = `const TWICE = '.a {}';\nfunction f(css) { if (css) { const TWICE = '.b {}'; return TWICE; } }\ninjectStylesOnce('a', ${arg});`;
  assert.deepEqual(await findings(source), ['3:23 lint-css-in-js'], `unreadable: ${arg}`);
}
assert.deepEqual(await findings("injectStylesOnce('a');"), ['1:1 lint-css-in-js'], 'no CSS argument');

// A disable comment in the CSS is refused, as in a sheet.
const disabled = await lintSource("injectStylesOnce('a', `/* stylelint-disable color-no-hex */\n.a {\n  color: #fff;\n}\n`);", FILE);
assert.deepEqual(disabled.map((f) => f.text), ['Rule "color-no-hex" may not be disabled']);

// The token files' carve-out is for sheets in web/css/tokens/, never a JS file.
assert.deepEqual(await findings("injectStylesOnce('a', `.a { color: #fff; }`);", 'web/css/tokens/x.js'), ['1:36 color-no-hex']);

// The fixer rewrites a block that is its source verbatim, in place, and only it.
// (rule-empty-line-before: a multi-line rule wants an empty line before it.)
/**
 * Two multi-line rules, the second with no empty line before it.
 * @param {string} first - The first rule's declaration.
 * @param {string} [eol] - The line ending.
 * @returns {string} The CSS.
 */
const twoRules = (first, eol = '\n') => ['.a {', `  ${first}`, '}', '.b {', '  color: var(--y);', '}', ''].join(eol);
const UNFIXED = twoRules('color: var(--x);');
const FIXED = UNFIXED.replace('}\n.b', '}\n\n.b');
assert.equal(await fixSource(`f();\ninjectStylesOnce('a', \`${UNFIXED}\`);\nconst S = '.c {}';\ninjectStylesOnce('b', \`${UNFIXED}\`);\n`, FILE),
  `f();\ninjectStylesOnce('a', \`${FIXED}\`);\nconst S = '.c {}';\ninjectStylesOnce('b', \`${FIXED}\`);\n`);
// One with a `${}`, an escape sequence or CRLF line endings is left as it is.
for (const source of [
  `injectStylesOnce('a', \`${twoRules('width: ${w}rem;')}\`);`,
  `injectStylesOnce('a', \`${twoRules("content: '\\\\2014';")}\`);`,
  `injectStylesOnce('a', \`${twoRules('color: var(--x);', '\r\n')}\`);`,
]) {
  assert.equal(await fixSource(source, FILE), source, `not fixed: ${source}`);
}

// Which files the whole-tree run and lint-files hand it: the web code, not vendored code.
assert.ok(inScope('web/sdk/lib/x.js') && inScope('web/js/components/x.js') && inScope('web/extensions/a/b.js'));
assert.ok(!inScope('web/js/vendor/x.js') && !inScope('tooling/x.js') && !inScope('scripts/i18n'));

log('lint-css-in-js: all cases pass');
