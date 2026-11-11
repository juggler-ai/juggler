//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A boxed region inside a panel is one of two shared surfaces
 * (patterns/surfaces.css): a `.surface-card`, an item raised off the panel, or
 * a `.surface-well`, a sunken box holding a list, a log or raw text. The
 * settings, catalog, skills, workspace and command-editor boxes wear one of
 * them rather than each choosing a fill and a corner of its own — which is how
 * three cards on the same settings panel came to be lighter, darker and level
 * with it, at three different radii.
 * @module unit-tests/surfaces-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** The boxes that wear a shared surface, by the selector of their own base rule. */
const MEMBERS = [
  '.ext-cap', '.tool-item', '.extension-setting-field',
  '.skills-card', '.skills-manage-row', '.skills-section',
  'settings-panel .settings-model-visibility-list', 'settings-panel .logs-viewer',
  '.skill-load-raw', '.workspace-finish-work-list', '.command-editor-preview',
  '.strategy-guidance-text'
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

  check('no boxed region chooses its own fill, border or corner', () => {
    const own = styleRules()
      .filter(rule => MEMBERS.includes(rule.selectorText))
      .filter(rule => ['background', 'background-color', 'border', 'border-radius']
        .some(property => rule.style.getPropertyValue(property) !== ''))
      .map(rule => rule.selectorText);
    assert(own.length === 0, `these still draw a surface of their own: ${own.join(' | ')}`);
  });

  return { passed, failed, errors };
}
