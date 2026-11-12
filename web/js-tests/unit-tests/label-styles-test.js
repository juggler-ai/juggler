//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The small uppercase labels come in two looks, each stated once in
 * patterns/labels.css and carried as a class: `.caps-label`, the eyebrow over a
 * group of rows, and `.caps-label-lg`, the heading of a settings, workspace or
 * properties section. A label's own rule chooses none of its type, and every
 * run of capitals anywhere — label, chip, badge or toggle — is spaced by
 * --tracking-caps, so the spacing cannot drift back into a dozen values.
 * @module unit-tests/label-styles-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** Every eyebrow (`.caps-label`), by the selector its own sheet styles it under. */
const EYEBROWS = [
  '.project-picker-recents-label',
  '.model-picker-recent-label', '.model-current-label', '.model-thinking-label', '.model-speed-label',
  '.pending-messages-label',
  '.thread-result-final .thread-result-label', '.permissions-popup .plugin-section-heading',
  '.menu-header',
  '.skill-panel-heading', '.skills-section-title',
  '.command-page-group-title', '.workspace-move-now-lead', '.workspace-banner-lead',
  'conversation-bar .info-card__eyebrow', '.pinboard-toolbar__identity', '.app-header__board-kind',
  '.session-switcher-heading', '.plugin-tree-section', '.connectivity-address-label', '.question-custom-option .option-btn-label'
];

/** Every section heading (`.caps-label-lg`). */
const HEADINGS = [
  'settings-panel .settings-section-heading', '.properties-panel-subtitle'
];

/** What the shared sheet decides, and nothing else may. */
const TYPOGRAPHY = ['font-size', 'font-weight', 'letter-spacing', 'text-transform'];

/**
 * Every style rule the page carries, with the sheet it came from.
 * @returns {Array<{rule: CSSStyleRule, href: string}>} The rules, in declaration order.
 */
function styleRules() {
  /** @type {Array<{rule: CSSStyleRule, href: string}>} */
  const found = [];
  /**
   * @param {CSSRuleList} rules
   * @param {string} href
   */
  const walk = (rules, href) => {
    for (const rule of rules) {
      const grouped = /** @type {CSSGroupingRule} */ (rule).cssRules;
      if (grouped) walk(grouped, href);
      if (/** @type {CSSStyleRule} */ (rule).selectorText) found.push({ rule: /** @type {CSSStyleRule} */ (rule), href });
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules, sheet.href ?? '');
    } catch {
      // A sheet from another origin refuses to be read; the app's own are same-origin.
    }
  }
  return found;
}

/**
 * A selector with any `:where()` unwrapped, so the shared sheet's
 * specificity-free spelling and a component's own spelling compare equal.
 * @param {string} selector - One selector.
 * @returns {string} It, unwrapped.
 */
function unwrapped(selector) {
  return selector.replace(/:where\(([^()]*)\)/g, '$1').trim();
}

/**
 * @param {CSSStyleRule} rule - A rule.
 * @returns {string[]} Its selector list, one selector per entry, unwrapped.
 */
function selectors(rule) {
  return rule.selectorText.split(',').map(unwrapped);
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

  const rules = styleRules();
  const shared = rules.filter(({ href }) => href.endsWith('/patterns/labels.css'));
  const members = [...EYEBROWS, ...HEADINGS].map(unwrapped);

  check('no label sets its own size, weight, spacing or case', () => {
    const own = rules
      .filter(({ href }) => !href.endsWith('/patterns/labels.css'))
      .filter(({ rule }) => selectors(rule).some(s => members.includes(s)))
      .filter(({ rule }) => TYPOGRAPHY.some(property => rule.style.getPropertyValue(property) !== ''))
      .map(({ rule }) => rule.selectorText);
    assert(own.length === 0, `these still choose their own typography: ${own.join(' | ')}`);
  });

  check('the two looks are stated once, in patterns/labels.css', () => {
    for (const label of ['.caps-label', '.caps-label-lg']) {
      const home = shared.find(({ rule }) => selectors(rule).includes(label)
        && rule.style.getPropertyValue('text-transform') === 'uppercase');
      assert(!!home, `${label} is uppercase in patterns/labels.css`);
    }
  });

  check('every run of capitals is spaced by --tracking-caps', () => {
    const drifted = rules
      .filter(({ rule }) => rule.style.getPropertyValue('text-transform') === 'uppercase')
      .filter(({ rule }) => rule.style.getPropertyValue('letter-spacing').trim() !== 'var(--tracking-caps)')
      .map(({ rule }) => `${rule.selectorText} (${rule.style.getPropertyValue('letter-spacing') || 'none'})`);
    assert(drifted.length === 0, `these space their capitals otherwise: ${drifted.join(' | ')}`);
  });

  return { passed, failed, errors };
}
