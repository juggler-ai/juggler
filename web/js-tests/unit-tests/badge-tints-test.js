//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A tinted badge — a pale wash of a colour behind text in that colour — is one
 * of six shared tints, `.tint-{blue,green,red,orange,purple,neutral}`
 * (patterns/tints.css), each a `color-mix()` of a theme token so it follows the
 * theme. The plugin catalog and the skills marketplace badges wear them,
 * rather than each spelling out a tint of its own: several were the dark
 * theme's colour written as a literal, so the light theme drew the dark one.
 * @module unit-tests/badge-tints-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** The badge rules that once carried a tone of their own, and must not again. */
const BADGES = [
  '.tool-category-read', '.tool-category-write',
  '.ext-source-builtin', '.ext-source-user',
  '.ext-cap-type-context-item', '.ext-cap-type-strategy', '.ext-cap-type-command',
  '.ext-cap-status-disabled', '.ext-cap-status-failed',
  '.plugin-author', '.permission-badge', '.tool-param-optional',
  '.skills-badge.scripts', '.skills-badge.loaded', '.skills-badge.error', '.skills-badge.shadow'
];

/**
 * Every style rule the page carries, from every stylesheet it loaded, layers
 * and media blocks included.
 * @returns {CSSStyleRule[]} The rules, in the order the sheets declare them.
 */
function styleRules() {
  /** @type {CSSStyleRule[]} */
  const found = [];
  /** @param {CSSRuleList} rules */
  const walk = (rules) => {
    for (const rule of rules) {
      const grouped = /** @type {CSSGroupingRule} */ (rule).cssRules;
      if (grouped) walk(grouped);
      if (/** @type {CSSStyleRule} */ (rule).selectorText) found.push(/** @type {CSSStyleRule} */ (rule));
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // A sheet from another origin refuses to be read; the app's own are same-origin.
    }
  }
  return found;
}

/**
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - What is being checked.
   * @param {() => void} body - The check.
   */
  const check = (name, body) => {
    try { body(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  check('no badge paints a tone of its own', () => {
    const own = styleRules()
      .filter(rule => BADGES.some(badge => rule.selectorText.split(',').some(part => part.trim().endsWith(badge))))
      .filter(rule => rule.style.getPropertyValue('background') !== ''
        || rule.style.getPropertyValue('background-color') !== ''
        || rule.style.getPropertyValue('color') !== '')
      .map(rule => rule.selectorText);
    assert(own.length === 0, `these still paint a tone themselves: ${own.join(' | ')}`);
  });

  return { passed, failed, errors };
}
