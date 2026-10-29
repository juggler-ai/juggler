//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The small uppercase labels come in two looks, each stated once in
 * patterns/labels.css: the eyebrow over a group of rows, and the heading of a
 * settings, workspace or properties section. The labels used to choose their
 * own size, weight and letter-spacing — 26 combinations across 38 rules, with
 * the spacing in both em and rem.
 * @module unit-tests/label-styles-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** Every eyebrow, by the selector its own sheet styles it under. */
const EYEBROWS = [
  '.pp-recents-label',
  '.model-picker-recent-label', '.model-current-label', '.model-thinking-label', '.model-speed-label',
  '.actions-sheet .actions-sheet-section-header', '.pending-messages-label',
  '.thread-result-final .thread-result-label', '.permissions-popup .plugin-section-heading',
  ':where(.dropdown-menu) .category-header', '.menu-header',
  '.skill-panel-heading', '.skills-section-title',
  '.command-page-group-title', '.workspace-move-now-lead', '.workspace-banner-lead',
  'conversation-bar .info-card__eyebrow', '.pinboard-toolbar__identity', '.app-header__board-kind'
];

/** Every section heading. */
const HEADINGS = [
  '.workspace-panel-eyebrow', '.workspace-panel-heading',
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

  for (const [group, list] of /** @type {const} */ ([['eyebrow', EYEBROWS], ['section heading', HEADINGS]])) {
    check(`every ${group} is named in the one shared ${group} rule`, () => {
      const wanted = list.map(unwrapped);
      const home = shared.find(({ rule }) => wanted.every(s => selectors(rule).includes(s)));
      const missing = wanted.filter(s => !shared.some(({ rule }) => selectors(rule).includes(s)));
      assert(!!home, `one rule in patterns/labels.css names them all; missing: ${missing.join(' | ') || '(split across rules)'}`);
    });
  }

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;';
  document.body.appendChild(host);
  try {
    /**
     * @param {string} token - A font-size token.
     * @returns {string} Its computed size.
     */
    const size = (token) => {
      host.innerHTML = `<span style="font-size: var(${token})"></span>`;
      return getComputedStyle(/** @type {HTMLElement} */ (host.firstElementChild)).fontSize;
    };
    const xs = size('--font-size-xs');
    const sm = size('--font-size-sm');

    check('an eyebrow is --font-size-xs, 600, uppercase and tracked 0.04em', () => {
      host.innerHTML = '<div class="pending-messages-label">x</div>';
      const style = getComputedStyle(/** @type {HTMLElement} */ (host.firstElementChild));
      assert(style.fontSize === xs, `size ${xs}, got ${style.fontSize}`);
      assert(style.fontWeight === '600', `weight 600, got ${style.fontWeight}`);
      assert(style.textTransform === 'uppercase', `uppercase, got ${style.textTransform}`);
      const tracking = (parseFloat(xs) * 0.04).toFixed(2);
      assert(parseFloat(style.letterSpacing).toFixed(2) === tracking, `tracking ${tracking}px, got ${style.letterSpacing}`);
    });

    check('a section heading is --font-size-sm, 600, uppercase and tracked 0.05em', () => {
      host.innerHTML = '<div class="workspace-panel-heading">x</div>';
      const style = getComputedStyle(/** @type {HTMLElement} */ (host.firstElementChild));
      assert(style.fontSize === sm, `size ${sm}, got ${style.fontSize}`);
      assert(style.fontWeight === '600', `weight 600, got ${style.fontWeight}`);
      assert(style.textTransform === 'uppercase', `uppercase, got ${style.textTransform}`);
      const tracking = (parseFloat(sm) * 0.05).toFixed(2);
      assert(parseFloat(style.letterSpacing).toFixed(2) === tracking, `tracking ${tracking}px, got ${style.letterSpacing}`);
    });
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
