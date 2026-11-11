//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The persistent modals share one host shell, `.modal-shell`: a fixed,
 * full-viewport, centring box at the modal stacking layer, hidden until its
 * own open state shows it. Each host wears the class and states only how it
 * opens, rather than typing the shell out under its own name, where the
 * copies can only drift apart.
 * @module unit-tests/modal-shell-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/modal-dialog.js';
import '../../js/components/about-modal.js';
import '../../js/components/update-notice.js';
import '../../js/components/bin-modal.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Each host, and how its stylesheet is told it is open — set by hand here so
 * the shell can be read without running a real open flow.
 * @type {Array<{tag: string, open: (el: HTMLElement) => void}>}
 */
const HOSTS = [
  { tag: 'modal-dialog', open: el => el.classList.add('is-open') },
  { tag: 'about-modal', open: el => { el.replaceChildren(Object.assign(document.createElement('div'), { className: 'about-backdrop' })); } },
  { tag: 'update-notice', open: el => { el.replaceChildren(Object.assign(document.createElement('div'), { className: 'update-notice__backdrop' })); } },
  { tag: 'bin-modal', open: el => el.classList.add('is-open') }
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

  const rules = styleRules();

  for (const { tag, open } of HOSTS) {
    const el = document.createElement(tag);
    document.body.appendChild(el);
    try {
      check(`<${tag}> wears the shared modal shell`, () => {
        assert(el.classList.contains('modal-shell'), `<${tag}> carries modal-shell, got class="${el.className}"`);
      });

      check(`<${tag}> is a hidden, fixed, full-viewport box at the modal layer while closed`, () => {
        const style = getComputedStyle(el);
        assert(style.display === 'none', `closed, it is display:none, got ${style.display}`);
        assert(style.position === 'fixed', `it is position:fixed, got ${style.position}`);
        const zModal = getComputedStyle(document.documentElement).getPropertyValue('--z-modal').trim();
        assert(style.zIndex === zModal, `it stacks at --z-modal (${zModal}), got ${style.zIndex}`);
      });

      check(`<${tag}> opens as a centring flex box covering the viewport`, () => {
        open(el);
        const style = getComputedStyle(el);
        assert(style.display === 'flex', `open, it is display:flex, got ${style.display}`);
        assert(style.alignItems === 'center' && style.justifyContent === 'center',
          `it centres its panel, got align-items ${style.alignItems}, justify-content ${style.justifyContent}`);
        const box = el.getBoundingClientRect();
        assert(box.left === 0 && box.top === 0 && box.width === window.innerWidth && box.height === window.innerHeight,
          `it covers the viewport, got ${box.left},${box.top} ${box.width}x${box.height} in ${window.innerWidth}x${window.innerHeight}`);
      });

      check(`<${tag}> keeps no copy of the shell under its own name`, () => {
        const own = rules
          .filter(rule => rule.selectorText === tag && rule.style.getPropertyValue('position') !== '')
          .map(rule => rule.cssText);
        assert(own.length === 0, `the shell is stated once, in .modal-shell, but ${tag} repeats it: ${own.join(' | ')}`);
      });
    } finally {
      el.remove();
    }
  }

  return { passed, failed, errors };
}
