//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Keyboard focus has two looks, each stated once in tokens/scale.css:
 *
 * - A control (a button, a toggle, a row) gets the ring, `--focus-ring` at
 *   `--focus-ring-offset`, from one base rule on `:focus-visible`.
 * - A text field gets an accent border, `--field-focus-border`, and a soft
 *   halo, `--field-focus-halo`. The field chrome itself (fill, hairline border,
 *   corner) is the shared `.field-input` (patterns/fields.css).
 *
 * A focus rule may suppress a ring (`outline: none`) or place the shared one;
 * it may not draw one of its own, which is how the app came to have green,
 * red, inset, 1px and 2px rings and halos at 10, 20, 25, 30 and 40 percent.
 * @module unit-tests/focus-rings-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** The fields that wear `.field-input`, by the selector of their own base rule. */
const FIELD_MEMBERS = [
  'path-input .path-input-field', '.pinboard-add-picker__filter',
  'settings-panel .model-visibility-filter', 'settings-panel .copilot-host-field input',
  'settings-panel .settings-select', 'settings-panel .chime-select', 'settings-panel .proxy-mode-select',
  'settings-panel .proxy-url-input', 'settings-panel .mcp-input', 'settings-panel .provider-input-wrapper',
  '.model-picker-filter-input', 'modal-dialog .modal-input', '.review-panel__editor-text',
  '.find-bar__input', '.command-editor-input', '.command-editor-textarea', '.command-editor-select'
];

/** The properties that draw the field chrome or its focus look. */
const FIELD_PROPERTIES = [
  'background', 'background-color', 'border', 'border-color', 'border-radius', 'box-shadow', 'outline'
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
 * The computed value a probe gets for one declaration.
 * @param {string} property - A CSS property.
 * @param {string} value - Its declared value.
 * @returns {string} As the engine computes it.
 */
function computed(property, value) {
  const probe = document.createElement('div');
  probe.style.setProperty(property, value);
  document.body.appendChild(probe);
  const result = getComputedStyle(probe).getPropertyValue(property);
  probe.remove();
  return result;
}

/**
 * The computed width of the shared hairline (0.0625rem, solid). The engine
 * snaps a border to whole device pixels, so this is 1px at a device pixel
 * ratio of 1 or 2 but 0.666667px at 1.5; the probe reads what this display
 * makes of it. A width only computes with a style beside it — none is 0px.
 * @returns {string} As the engine computes it.
 */
function hairline() {
  const probe = document.createElement('div');
  probe.style.borderTop = '0.0625rem solid';
  document.body.appendChild(probe);
  const result = getComputedStyle(probe).borderTopWidth;
  probe.remove();
  return result;
}

/**
 * Whether a declared value is empty, a suppression, or one of the allowed tokens.
 * @param {string} value - The declared value, as the rule serialises it.
 * @param {string[]} tokens - The custom properties it may reference.
 * @returns {boolean} True when the value draws nothing of its own.
 */
function sharedOrNone(value, tokens) {
  if (value === '' || value === 'none' || /^(medium )?none( medium)?$|^currentcolor none medium$/.test(value)) return true;
  return tokens.some(token => value.includes(`var(${token})`));
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

  check('one base rule rings every control on :focus-visible', () => {
    const base = rules.filter(rule => rule.selectorText === ':where(:focus-visible)');
    assert(base.length === 1, `expected one :where(:focus-visible) rule, found ${base.length}`);
    assert(base[0].style.getPropertyValue('outline') === 'var(--focus-ring)',
      `outline is "${base[0].style.getPropertyValue('outline')}"`);
    assert(base[0].style.getPropertyValue('outline-offset') === 'var(--focus-ring-offset)',
      `outline-offset is "${base[0].style.getPropertyValue('outline-offset')}"`);
  });

  check('no focus rule draws a ring or halo of its own', () => {
    const own = [];
    for (const rule of rules) {
      // A state shared with :hover is a fill change, not a focus indicator.
      const parts = rule.selectorText.split(/,\s*/)
        .filter(part => /:focus|\.focused\b/.test(part) && !/:hover/.test(part));
      if (parts.length === 0) continue;
      const style = rule.style;
      // `outline: none` serialises its shorthand as "medium" in WebKit; the
      // longhand style is what says it suppresses.
      const suppressed = style.getPropertyValue('outline-style') === 'none';
      const outline = style.getPropertyValue('outline');
      const bad = [
        !suppressed && !sharedOrNone(outline, ['--focus-ring']) && `outline: ${outline}`,
        !suppressed && !outline.includes('var(') && style.getPropertyValue('outline-color') !== ''
          && `outline-color: ${style.getPropertyValue('outline-color')}`,
        !sharedOrNone(style.getPropertyValue('outline-offset'), ['--focus-ring-offset', '--focus-ring-width'])
          && `outline-offset: ${style.getPropertyValue('outline-offset')}`,
        !sharedOrNone(style.getPropertyValue('box-shadow'), ['--field-focus-halo'])
          && `box-shadow: ${style.getPropertyValue('box-shadow')}`,
        style.getPropertyValue('border-color') !== 'transparent'
          && !sharedOrNone(style.getPropertyValue('border-color'), ['--field-focus-border'])
          && `border-color: ${style.getPropertyValue('border-color')}`
      ].filter(Boolean);
      if (bad.length) own.push(`${rule.selectorText} { ${bad.join('; ')} }`);
    }
    assert(own.length === 0, `these draw their own focus look:\n  ${own.join('\n  ')}`);
  });

  // Suppressing the ring outside a focus state switches it off for good: the
  // base rule is at zero specificity, so it never comes back on :focus-visible.
  // That is right for a text field, which shows focus through the field look,
  // and for nothing else.
  check('only a text field suppresses the ring outside a focus state', () => {
    const field = /(^|[\s>])(input|textarea)$|-(input|field|textarea)$/;
    const offenders = rules
      .filter(rule => rule.style.getPropertyValue('outline-style') === 'none')
      .flatMap(rule => rule.selectorText.split(/,\s*/))
      .filter(part => !/:focus|:has\(|\.focused\b/.test(part) && !field.test(part));
    assert(offenders.length === 0, `these switch the ring off for good: ${offenders.join(' | ')}`);
  });

  // The rotary's focus target is a hidden range input, so the ring it would get
  // is invisible: the knob has to wear it instead.
  check('the chime rotary rings its knob while its hidden input has keyboard focus', () => {
    const ring = rules.filter(rule => /\.chime-rotary-input:focus-visible\).*\.chime-rotary-knob$/.test(rule.selectorText));
    assert(ring.length === 1, `expected one rule ringing the knob, found ${ring.length}`);
    assert(ring[0].style.getPropertyValue('outline') === 'var(--focus-ring)',
      `outline is "${ring[0].style.getPropertyValue('outline')}"`);
  });

  check('no field draws its own chrome or focus look', () => {
    const own = rules
      .filter(rule => rule.selectorText.split(/,\s*/).some(part =>
        FIELD_MEMBERS.includes(part.replace(/:focus(-visible|-within)?$/, ''))))
      .filter(rule => FIELD_PROPERTIES.some(property => rule.style.getPropertyValue(property) !== ''))
      .map(rule => rule.selectorText);
    assert(own.length === 0, `these still draw a field of their own: ${own.join(' | ')}`);
  });

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;';
  document.body.appendChild(host);
  try {
    const wantFill = computed('background-color', 'var(--bg-primary)');
    const wantRadius = computed('border-top-left-radius', 'var(--radius-lg)');
    const wantBorder = computed('border-top-color', 'var(--border-color)');
    const wantWidth = hairline();
    const wantFocusBorder = computed('border-top-color', 'var(--accent-blue)');
    const wantHalo = computed('box-shadow', '0 0 0 0.1875rem color-mix(in srgb, var(--accent-blue) 10%, transparent)');

    check('.field-input is --bg-primary with a hairline border and --radius-lg corners', () => {
      host.innerHTML = '<input class="field-input">';
      const style = getComputedStyle(/** @type {HTMLElement} */ (host.firstElementChild));
      assert(style.backgroundColor === wantFill, `fill ${wantFill}, got ${style.backgroundColor}`);
      assert(style.borderTopLeftRadius === wantRadius, `corner ${wantRadius}, got ${style.borderTopLeftRadius}`);
      assert(style.borderTopStyle === 'solid' && style.borderTopWidth === wantWidth,
        `a ${wantWidth} solid hairline, got ${style.borderTopWidth} ${style.borderTopStyle}`);
      assert(style.borderTopColor === wantBorder, `border ${wantBorder}, got ${style.borderTopColor}`);
    });

    // The suite's document never holds window focus (document.hasFocus() is
    // false), so :focus matches nothing here and a focused field cannot be
    // measured. The rule that would apply is checked instead, and the tokens
    // it names are resolved against the look they stand for.
    check('the focus tokens resolve to the accent ring, border and halo', () => {
      assert(computed('border-top-color', 'var(--field-focus-border)') === wantFocusBorder,
        `--field-focus-border is ${computed('border-top-color', 'var(--field-focus-border)')}`);
      assert(computed('box-shadow', 'var(--field-focus-halo)') === wantHalo,
        `--field-focus-halo is ${computed('box-shadow', 'var(--field-focus-halo)')}`);
      const ring = computed('outline', 'var(--focus-ring)');
      const wantRing = computed('outline', '0.125rem solid var(--accent-blue)');
      assert(ring === wantRing, `--focus-ring is ${ring}, want ${wantRing}`);
    });

    check('.field-input on :focus-within takes the field focus look, with no outline', () => {
      const focus = rules.filter(rule => /^\.field-input(:where\()?:focus-within\)?$/.test(rule.selectorText));
      assert(focus.length === 1, `expected one .field-input focus rule, found ${focus.length}`);
      const style = focus[0].style;
      assert(style.getPropertyValue('outline-style') === 'none', `outline-style "${style.getPropertyValue('outline-style')}"`);
      assert(style.getPropertyValue('border-color') === 'var(--field-focus-border)',
        `border-color "${style.getPropertyValue('border-color')}"`);
      assert(style.getPropertyValue('box-shadow') === 'var(--field-focus-halo)',
        `box-shadow "${style.getPropertyValue('box-shadow')}"`);
    });
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
