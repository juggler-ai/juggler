//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Text sizes and corner radii come from the scale in `tokens/scale.css`
 * (`--font-size-*`, `--radius-*`) rather than being written out at each site,
 * so a rule cannot drift a fraction of a pixel off its neighbours. Sizes
 * relative to the parent (`em`, `inherit`) and the geometric radii (`0`,
 * `50%`) are not scale steps and stay as written.
 *
 * Extension and SDK styles injected at runtime are checked from source by
 * `scripts/lint-css-arch`, since they are only in the page once used.
 * @module unit-tests/type-scale-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Declarations allowed a literal, as `[selector ending, value]`:
 * - the network badge and host label, update button and header icon buttons
 *   size their text in px beside px geometry, which deliberately does not
 *   follow the zoom;
 * - the plugin detail title is the one 1.75rem heading;
 * - the user-message bubble and reply-suggestion chips are rounder than
 *   every radius step and short of a pill.
 */
const ALLOWED = [
  ['.network-button__clients', '10px'],
  ['.network-button__host', '10px'],
  ['update-button .update-btn', '13px'],
  ['header-actions .btn-icon-header', '14px'],
  ['.plugin-detail-name', '1.75rem'],
  ['user-message article.user', '1.125rem'],
  ['reply-suggestions .reply-suggestion', '1.25rem'],
];

/** A font-size that is not a scale literal. */
const FONT_SIZE_OK = /^(var\(--font-size-[\w-]+\)|[\d.]+em|inherit|unset)(\s*!important)?$/;

/** One component of a border-radius value that is not a scale literal. */
const RADIUS_PART_OK = /^(0|0px|50%|inherit|unset|var\(--[\w-]*radius[\w-]*(,.*)?\))$/;

/**
 * Split a value on top-level whitespace, keeping a var() and its fallback whole.
 * @param {string} value - The declared value.
 * @returns {string[]} Its components.
 */
function components(value) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let current = '';
  for (const c of value) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (/\s/.test(c) && depth === 0) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Every style rule from the app's own sheets — the linked `css/` sheets other
 * than vendor and token sheets, and any style an extension has injected —
 * layers and media blocks included.
 * @returns {CSSStyleRule[]} The rules.
 */
function appStyleRules() {
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
    const href = sheet.href || '';
    const injected = !href && sheet.ownerNode instanceof HTMLElement && sheet.ownerNode.id !== '';
    const own = href.includes('/css/') && !href.includes('/css/vendor/') && !href.includes('/css/tokens/');
    if (!own && !injected) continue;
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

  /**
   * @param {string} selector - The rule's selector text.
   * @param {string} value - The declared value.
   * @returns {boolean} Whether ALLOWED excuses it.
   */
  const allowed = (selector, value) => ALLOWED.some(([ending, literal]) => value === literal
    && selector.split(',').some(part => part.trim().endsWith(ending)));

  /** @type {string[]} */
  const fontSizes = [];
  /** @type {string[]} */
  const radii = [];
  for (const rule of appStyleRules()) {
    for (const [, property, raw] of rule.style.cssText.matchAll(/(?:^|;)\s*(font-size|border(?:-[a-z]+)*-radius)\s*:\s*([^;]+)/g)) {
      const value = raw.trim();
      if (allowed(rule.selectorText, value)) continue;
      if (property === 'font-size') {
        if (!FONT_SIZE_OK.test(value)) fontSizes.push(`${rule.selectorText} { font-size: ${value} }`);
      } else if (!components(value.replace(/\s*!important$/, '')).every(part => RADIUS_PART_OK.test(part))) {
        radii.push(`${rule.selectorText} { ${property}: ${value} }`);
      }
    }
  }

  check('every font-size is a scale token', () => {
    assert(fontSizes.length === 0, `${fontSizes.length} write a size out: ${fontSizes.join(' | ')}`);
  });

  check('every radius is a scale token', () => {
    assert(radii.length === 0, `${radii.length} write a radius out: ${radii.join(' | ')}`);
  });

  check('the scale tokens resolve on the page', () => {
    const root = getComputedStyle(document.documentElement);
    const missing = [
      '--font-size-2xs', '--font-size-xs', '--font-size-sm', '--font-size-base', '--font-size-md',
      '--font-size-body-lg', '--font-size-lg', '--font-size-xl', '--font-size-2xl', '--font-size-3xl',
      '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-2xl', '--radius-pill',
    ].filter(token => root.getPropertyValue(token).trim() === '');
    assert(missing.length === 0, `unset: ${missing.join(', ')}`);
  });

  return { passed, failed, errors };
}
