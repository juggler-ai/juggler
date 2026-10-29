//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A warning line reads as a warning: it is drawn in `--accent-yellow`, the
 * house warning-text colour, not in the dim text of the lines around it. No
 * theme defines a `--warning` token, so a rule reading one falls back to its
 * fallback every time.
 * @module unit-tests/warning-text-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** The warning lines, by class. */
const WARNINGS = ['system-prompt-tools-drift', 'system-prompt-tools-notice', 'system-prompt-tools-silent'];

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

  check('no rule reads the undefined --warning token', () => {
    const readers = styleRules()
      .filter(rule => /var\(\s*--warning(?![\w-])/.test(rule.style.cssText))
      .map(rule => rule.selectorText);
    assert(readers.length === 0, `these read --warning: ${readers.join(' | ')}`);
  });

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;';
  document.body.appendChild(host);
  try {
    const reference = document.createElement('span');
    reference.style.color = 'var(--accent-yellow)';
    host.appendChild(reference);
    const want = getComputedStyle(reference).color;
    for (const cls of WARNINGS) {
      check(`.${cls} is drawn in --accent-yellow`, () => {
        const line = document.createElement('div');
        line.className = cls;
        host.appendChild(line);
        const got = getComputedStyle(line).color;
        assert(got === want, `colour ${want}, got ${got}`);
      });
    }
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
