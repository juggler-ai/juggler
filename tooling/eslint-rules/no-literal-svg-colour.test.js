//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Cases for juggler/no-literal-svg-colour. Run by `make lint-js`; throws
 * (exit 1) on the first case that disagrees. Which files the rule applies to is
 * the config's business (tooling/eslint.config.js); every case here is a file
 * it applies to.
 */

import { log } from 'node:console';
import { RuleTester } from 'eslint';
import rule from './no-literal-svg-colour.js';

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

/**
 * An expected finding.
 * @param {string} attr - The paint attribute or property.
 * @param {string} value - Its literal value.
 * @param {number} [line] - The line it is on.
 * @param {number} [column] - The column its value starts at.
 * @returns {object} The RuleTester error.
 */
const literal = (attr, value, line, column) => ({
  messageId: 'literal', data: { attr, value }, ...(line ? { line, column } : {}),
});

const ICON = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"';

tester.run('no-literal-svg-colour', rule, {
  valid: [
    // The colour comes from CSS.
    `const A = '<svg ${ICON} fill="currentColor"><path d="M0 0"/></svg>';`,
    `const A = '<svg ${ICON} fill="none" stroke="currentcolor" stroke-width="2"></svg>';`,
    `const A = \`<svg ${ICON}><path fill="var(--accent-blue)" stroke="var( --border-color )"/></svg>\`;`,
    // Paint servers defined in the markup, and the keywords that pick no colour.
    "const A = '<svg><defs><linearGradient id=\"g\"><stop stop-color=\"currentColor\"/></linearGradient></defs><rect fill=\"url(#g)\"/></svg>';",
    "const A = '<svg fill=\"transparent\" stroke=\"inherit\"><use fill=\"context-fill\" stroke=\"context-stroke\"/></svg>';",
    // A style attribute whose paints pass, and its other properties.
    "const A = '<svg style=\"fill: currentColor; stroke-width: 2; opacity: 0.5\"></svg>';",
    // A value a `${}` builds is not written in the markup.
    'const A = `<svg fill="${colour}"><path stroke="${a}-${b}"/></svg>`;',
    // Not SVG: an HTML attribute that happens to share a name, and prose.
    "const A = '<font color=\"red\">x</font>'; const B = 'fill=\"white\" is not markup';",
    // Lookalike attribute names.
    "const A = '<svg data-fill=\"white\" fill-opacity=\"0.5\" stroke-width=\"2\" x:color=\"red\"></svg>';",
    // A string split across a `+` whose SVG half is clean.
    "const A = '<svg fill=\"currentColor\">' + '<path d=\"M0 0\"/></svg>';",
  ],
  invalid: [
    { code: `const A = '<svg ${ICON} fill="white"><path d="M0 0"/></svg>';`, errors: [literal('fill', 'white', 1, 83)] },
    {
      code: "const A = '<svg><path fill=\"#fff\" stroke=\"rgb(0 0 0)\"/><stop stop-color=\\'#1a2a6c\\'/><circle color=black /></svg>';",
      errors: [literal('fill', '#fff'), literal('stroke', 'rgb(0 0 0)'), literal('stop-color', '#1a2a6c'), literal('color', 'black')],
    },
    // A fallback is a literal colour too.
    { code: "const A = '<svg fill=\"var(--accent-red, #f00)\"></svg>';", errors: [literal('fill', 'var(--accent-red, #f00)')] },
    // An element tag alone, without its <svg>, is markup too.
    { code: "const A = '<path fill=\"white\" d=\"M0 0\"/>';", errors: [literal('fill', 'white')] },
    // In a style attribute.
    { code: "const A = '<svg style=\"opacity: 1; fill:#fff\"></svg>';", errors: [literal('fill', '#fff', 1, 41)] },
    // In a template, beside a `${}`, on a later line.
    {
      code: 'const A = `<svg width="${w}">\n  <path fill="white" d="${d}"/>\n</svg>`;',
      errors: [literal('fill', 'white', 2, 15)],
    },
    // A CRLF checkout reports the same place.
    {
      code: 'const A = `<svg width="${w}">\r\n\r\n  <path fill="white"/>\r\n</svg>`;',
      errors: [literal('fill', 'white', 3, 15)],
    },
  ],
});

log('no-literal-svg-colour: all cases pass');
