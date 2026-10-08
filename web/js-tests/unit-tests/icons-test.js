//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Shared icons drawn at another size or colour.
 *
 * A site that needs an icon from `utils/icons.js` at its own size takes it
 * through `withAttrs` rather than restating the outline (the Go test
 * `TestAppIconsAreShared` fails on a restated one). That only works if
 * `withAttrs` changes the root `<svg>` and nothing else: an attribute the icon
 * carries is replaced rather than doubled, a missing one is added, and the
 * outline is left exactly as it was.
 * @module unit-tests/icons-test
 */

import { assert } from '../utilities/test-helpers.js';
import { ADD_SVG, CHECK_SVG, withAttrs, withClass } from '../../js/utils/icons.js';

/**
 * Parse icon markup into its root element.
 * @param {string} markup - SVG markup.
 * @returns {Element} The root `<svg>`.
 */
function parse(markup) {
  const host = document.createElement('div');
  host.innerHTML = markup;
  assert(host.childElementCount === 1, `expected one root element, got ${host.childElementCount}`);
  return /** @type {Element} */ (host.firstElementChild);
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Case under test, used to label a failure.
   * @param {() => void} fn - Assertions; throws to fail.
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  run('an attribute the icon carries is replaced, not doubled', () => {
    const out = withAttrs(ADD_SVG, { width: '1rem', height: '1rem' });
    assert((out.match(/\swidth="/g) || []).length === 1, `width appears more than once: ${out}`);
    const svg = parse(out);
    assert(svg.getAttribute('width') === '1rem', `width is ${svg.getAttribute('width')}`);
    assert(svg.getAttribute('height') === '1rem', `height is ${svg.getAttribute('height')}`);
    assert(svg.getAttribute('viewBox') === '0 -960 960 960', `viewBox was disturbed: ${svg.getAttribute('viewBox')}`);
  });

  run('a missing attribute is added', () => {
    const svg = parse(withAttrs(CHECK_SVG, { 'data-role': 'tick' }));
    assert(svg.getAttribute('data-role') === 'tick', 'data-role was not added');
    assert(svg.getAttribute('fill') === 'currentColor', 'the icon lost its own fill');
  });

  run('the outline is untouched', () => {
    const before = parse(ADD_SVG).querySelector('path')?.getAttribute('d');
    const after = parse(withAttrs(ADD_SVG, { fill: 'white', width: '14', height: '14' })).querySelector('path')?.getAttribute('d');
    assert(Boolean(before) && before === after, 'the path data changed');
  });

  run('a name is matched whole, so width never rewrites stroke-width', () => {
    const svg = parse(withAttrs('<svg stroke-width="2" width="3"><path d="M0 0"/></svg>', { width: '4' }));
    assert(svg.getAttribute('stroke-width') === '2', `stroke-width became ${svg.getAttribute('stroke-width')}`);
    assert(svg.getAttribute('width') === '4', `width is ${svg.getAttribute('width')}`);
  });

  run('withClass puts the class on the root', () => {
    const svg = parse(withClass(CHECK_SVG, 'shell-lock-icon'));
    assert(svg.classList.contains('shell-lock-icon'), 'class missing from the root');
  });

  return { passed, failed, errors };
}
