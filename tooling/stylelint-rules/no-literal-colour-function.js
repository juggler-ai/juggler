//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * juggler/no-literal-colour-function — a colour spelled out as a function:
 * `rgb(0 0 0 / 50%)`, `hsl(…)`, `oklch(…)`, `color(display-p3 …)` and the rest.
 *
 * The third of the three ways to hardcode a colour, beside the hex and named
 * colours the built-in `color-no-hex` and `color-named` catch. Together they
 * hold every sheet outside web/css/tokens/ to web/css/README.md ▸ Tokens:
 * never hardcode a colour.
 *
 * What a colour function may still do is derive from a token. A relative
 * colour — `rgb(from var(--accent-red) r g b / 15%)` — starts from whatever
 * its base resolves to, so it passes; a literal base inside it is a hex or a
 * name and is caught by those rules. `color-mix()` is not a colour function
 * here at all: it mixes its arguments, and a literal among them is reported in
 * its own right. Text inside strings and `url()` is not CSS colour and is not
 * read.
 */

import stylelint from 'stylelint';

const { createPlugin, utils: { report, ruleMessages, validateOptions } } = stylelint;

export const ruleName = 'juggler/no-literal-colour-function';

export const messages = ruleMessages(ruleName, {
  rejected: (fn) =>
    `Literal colour "${fn}()" — use a token from web/css/tokens/, a color-mix() of tokens, or a relative colour from one (web/css/README.md ▸ Tokens)`,
});

const COLOUR_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'device-cmyk',
]);

/**
 * The value with the contents of every string and url() blanked to spaces, so
 * offsets still line up with the original and nothing inside them is read.
 * @param {string} value - a declaration value
 * @returns {string} the value, the same length, with those contents blanked
 */
function blankOpaque(value) {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < value.length && value[j] !== ch) j += value[j] === '\\' ? 2 : 1;
      out += ch + ' '.repeat(Math.max(0, Math.min(j, value.length) - i - 1));
      if (j < value.length) out += ch;
      i = j + 1;
      continue;
    }
    const url = /^url\(/i.exec(value.slice(i, i + 4));
    if (url && !/[\w-]/.test(value[i - 1] ?? '')) {
      let depth = 0;
      let j = i + 3;
      for (; j < value.length; j++) {
        if (value[j] === '(') depth++;
        else if (value[j] === ')' && --depth === 0) break;
      }
      out += 'url(' + ' '.repeat(Math.max(0, Math.min(j, value.length) - i - 4));
      if (j < value.length) out += ')';
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const FUNCTION_CALL = /(?<![\w-])([a-z][\w-]*)\(/gi;

/**
 * Every literal colour function in a declaration value: its name and offset.
 * @param {string} value - a declaration value
 * @returns {{ name: string, index: number }[]} each one, lower-cased, with its offset in the value
 */
export function literalColourFunctions(value) {
  const text = blankOpaque(value);
  const found = [];
  for (const m of text.matchAll(FUNCTION_CALL)) {
    const name = m[1].toLowerCase();
    if (!COLOUR_FUNCTIONS.has(name)) continue;
    const args = text.slice(m.index + m[0].length);
    if (/^\s*from\s/i.test(args)) continue;
    found.push({ name, index: m.index });
  }
  return found;
}

/** @type {import('stylelint').Rule} */
const rule = (primary) => (root, result) => {
  if (!validateOptions(result, ruleName, { actual: primary, possible: [true] })) return;
  root.walkDecls((decl) => {
    const valueIndex = decl.prop.length + (decl.raws.between ?? ':').length;
    for (const { name, index } of literalColourFunctions(decl.value)) {
      report({
        result,
        ruleName,
        node: decl,
        message: messages.rejected(name),
        index: valueIndex + index,
        endIndex: valueIndex + index + name.length,
      });
    }
  });
};

rule.ruleName = ruleName;
rule.messages = messages;

export default createPlugin(ruleName, rule);
