//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The app has one primary, one secondary and one danger button fill —
 * `.btn-primary` (blue), `.btn-secondary` (outlined) and `.btn-danger`
 * (red) — worn by every dialog and panel button that wants one, over whatever
 * sizing that component gives its buttons. Each component typing its own copy
 * is how the app came to have a green primary beside a blue one, and a danger
 * red hard-coded in one place and tokenised in another.
 * @module unit-tests/button-variants-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/modal-dialog.js';
import '../../js/components/update-notice.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** Per-component copies of a variant fill, none of which may come back. */
const RETIRED = [
  'button.btn-primary', 'button.btn-secondary',
  '.modal-button.primary', '.modal-button.secondary', '.modal-button.danger',
  '.about-button.primary', '.update-notice__button.primary',
  '.settings-btn.primary', '.settings-btn.danger',
  '.np-action--primary', '.onboarding-wizard-action--primary', '.skills-btn.install.primary'
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

  check('no component keeps a variant fill of its own', () => {
    const own = styleRules()
      .map(rule => rule.selectorText)
      .filter(selector => RETIRED.some(retired => selector.includes(retired)));
    assert(own.length === 0, `these still style a variant themselves: ${own.join(' | ')}`);
  });

  check('a modal-dialog button wears the shared variant for its role', () => {
    const modal = /** @type {any} */ (document.createElement('modal-dialog'));
    for (const variant of ['primary', 'secondary', 'danger']) {
      const button = modal.createButton('x', variant, () => {});
      assert(button.classList.contains(`btn-${variant}`),
        `a ${variant} button carries btn-${variant}, got class="${button.className}"`);
    }
  });

  return { passed, failed, errors };
}
