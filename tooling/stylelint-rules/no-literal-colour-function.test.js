//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Cases for juggler/no-literal-colour-function, and for the colour gate as
 * tooling/.stylelintrc.json configures it: the rule beside color-no-hex and
 * color-named, applied to every sheet but those in web/css/tokens/, and with
 * no stylelint-disable honoured. Run by `make lint-css`; throws (exit 1) on the
 * first case that disagrees.
 */

import assert from 'node:assert/strict';
import { log } from 'node:console';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import stylelint from 'stylelint';
import { ruleName } from './no-literal-colour-function.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(here, '..', '.stylelintrc.json');
const repo = path.join(here, '..', '..');

const ruleOnly = {
  plugins: [path.join(here, 'no-literal-colour-function.js')],
  rules: { [ruleName]: true },
};

/**
 * The rule's findings on a declaration block, as the text each one points at.
 * @param {string} block - declarations, linted inside one rule
 * @returns {Promise<string[]>} the source text under each finding
 */
async function findings(block) {
  const code = `.a { ${block} }`;
  const { results: [res] } = await stylelint.lint({ code, config: ruleOnly });
  assert.deepEqual(res.invalidOptionWarnings, [], 'the options are valid');
  return res.warnings.map((w) => code.slice(w.column - 1, w.endColumn - 1));
}

const valid = [
  // Tokens, and the derivations of them the README names.
  'color: var(--text-primary);',
  'background: color-mix(in srgb, var(--accent-blue) 15%, transparent);',
  'background: rgb(from var(--accent-red) r g b / 15%);',
  'background: hsl(from var(--accent-red) h s calc(l + 10));',
  'background: oklch(from color-mix(in srgb, var(--x), var(--y)) l c h / 50%);',
  '--surface: RGB(FROM var(--bg-primary) r g b / 40%);',
  // Keywords that are not a colour of anyone's choosing.
  'color: currentcolor; background: transparent; border-color: inherit;',
  // A colour space named as an argument is not a colour function.
  'background: color-mix(in oklch, var(--a), var(--b));',
  'background: linear-gradient(in oklab, var(--a), var(--b));',
  // Names that merely end like one.
  'background: --my-rgb(1 2 3); animation-name: rgb-pulse;',
  // Strings and url() are not CSS colour.
  'content: "rgb(0 0 0)";',
  "background: url(\"data:image/svg+xml,<svg fill='rgb(0,0,0)'/>\") no-repeat;",
  'mask: url(icons/rgb(1).svg);',
];

const invalid = [
  ['color: rgb(0 0 0 / 50%);', ['rgb']],
  ['color: rgba(0, 0, 0, 0.5);', ['rgba']],
  ['color: hsl(210 10% 20%); background: hsla(0, 0%, 0%, 0.1);', ['hsl', 'hsla']],
  ['color: hwb(0 0% 0%); background: lab(50% 10 10); border-color: lch(50% 10 10);', ['hwb', 'lab', 'lch']],
  ['color: oklab(0.5 0.1 0.1); background: oklch(0.5 0.1 200);', ['oklab', 'oklch']],
  ['color: color(display-p3 1 0 0); background: device-cmyk(0 0 0 1);', ['color', 'device-cmyk']],
  ['color: RGB(0 0 0);', ['RGB']],
  // Inside anything that takes a colour.
  ['box-shadow: 0 0.25rem 1rem rgb(0 0 0 / 15%);', ['rgb']],
  ['background: color-mix(in srgb, var(--a) 50%, rgb(255 255 255));', ['rgb']],
  ['background: linear-gradient(rgb(9 105 218 / 30%), rgb(9 105 218 / 30%));', ['rgb', 'rgb']],
  ['color: var(--x, rgb(0 0 0));', ['rgb']],
  ['--scrim: rgb(0 0 0 / 50%);', ['rgb']],
  // A relative colour whose base is itself a literal is still caught.
  ['color: rgb(from rgb(0 0 0) r g b / 50%);', ['rgb']],
  // A string beside it does not hide it.
  ['font-family: "x(", sans-serif; color: rgb(1 2 3);', ['rgb']],
];

for (const block of valid) {
  assert.deepEqual(await findings(block), [], `valid: ${block}`);
}
for (const [block, expected] of invalid) {
  assert.deepEqual(await findings(block), expected, `invalid: ${block}`);
}

/**
 * The colour rules reported for a sheet at the given repo-relative path, linted
 * with the real config.
 * @param {string} rel - where the sheet is, relative to the repo root
 * @param {string} code - the sheet
 * @returns {Promise<string[]>} the colour rules reported, sorted
 */
async function gate(rel, code) {
  const { results: [res] } = await stylelint.lint({ code, codeFilename: path.join(repo, rel), configFile });
  assert.deepEqual(res.invalidOptionWarnings, [], 'the config\'s options are valid');
  return res.warnings.map((w) => w.rule).filter((r) => /colou?r/.test(r)).sort();
}

const literals = ':root { --a: #fff; --b: white; --c: rgb(0 0 0 / 50%); }\n';
const every = ['color-named', 'color-no-hex', ruleName].sort();

// Every sheet outside the token files, the app's and the session page's alike.
for (const rel of ['web/css/components/x.css', 'web/css/patterns/x.css', 'web/machine/x.css']) {
  assert.deepEqual(await gate(rel, literals), every, `gated: ${rel}`);
}
// The token files, which are where a colour is defined, are the carve-out.
for (const rel of ['web/css/tokens/theme-dark.css', 'web/css/tokens/theme-light.css', 'web/css/tokens/scale.css']) {
  assert.deepEqual(await gate(rel, literals), [], `token file: ${rel}`);
}
// The carve-out is the directory, not a file name: a theme file anywhere else is gated.
assert.deepEqual(await gate('web/css/components/tokens/theme-dark.css', literals), every, 'nested tokens dir');

// A disable comment for any of them is itself an error.
for (const name of every) {
  const code = `/* stylelint-disable ${name} */\n.a { color: #fff; background: white; border-color: rgb(0 0 0); }\n/* stylelint-enable */\n`;
  const { results: [res] } = await stylelint.lint({
    code, codeFilename: path.join(repo, 'web/css/components/x.css'), configFile,
  });
  const refused = res.warnings.filter((w) => w.rule === 'reportDisables').map((w) => w.text);
  assert.deepEqual(refused, [`Rule "${name}" may not be disabled`], `disable refused: ${name}`);
  assert.ok(res.errored, `disable of ${name} fails the lint`);
}

log('no-literal-colour-function: all cases pass');
