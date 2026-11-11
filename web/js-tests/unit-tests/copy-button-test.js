//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the shared copy button's "Copied" bubble.
 *
 * The property under test: ANY button made by `createCopyButton` shows the
 * bubble while it carries `.copied`, whatever class its caller gave it, and the
 * bubble has a positioned anchor. A copy button must not need its class added
 * to a list in some stylesheet to get its confirmation — a button whose class
 * is on no list is exactly the one a new surface would build.
 * @module unit-tests/copy-button-test
 */

import { createCopyButton } from '../../sdk/lib/copy-button.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';

/**
 * @param {boolean} cond
 * @param {string} msg
 * @param {string[]} errors
 * @returns {number} 1 when the assertion passed, 0 when it failed.
 */
function check(cond, msg, errors) {
  if (cond) return 1;
  errors.push(msg);
  return 0;
}

/**
 * Run the copy-button test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  const errors = [];
  let passed = 0;
  let total = 0;

  // The default, the class the transaction view passes, and one no sheet names.
  const classNames = [undefined, 'btn btn-icon btn-secondary transaction-row-copy', 'some-future-copy-button'];

  for (const className of classNames) {
    const label = className ?? '(default class)';
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      const btn = createCopyButton('text', className);
      host.appendChild(btn);
      btn.classList.add('copied');

      // `attr()` may be reported resolved or as written, depending on the engine.
      const content = getComputedStyle(btn, '::after').content;
      total++;
      passed += check(btn.dataset.copiedLabel === 'Copied' && (content === '"Copied"' || content === 'attr(data-copied-label)'),
        `${label}: a .copied copy button shows no "Copied" bubble (::after content is ${content}, label ${btn.dataset.copiedLabel})`, errors);

      total++;
      passed += check(getComputedStyle(btn).position !== 'static',
        `${label}: the button is position: static, so its absolutely placed bubble anchors to some ancestor instead`, errors);
    } finally {
      host.remove();
    }
  }

  // Under en-XA the default label and the bubble are translated. The bubble is
  // CSS generated content, so it reads its text from the button.
  total++;
  try {
    await underPseudoLocale('copy-button-test', () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      try {
        const btn = createCopyButton('text');
        host.appendChild(btn);
        btn.classList.add('copied');
        assertPseudoLocalized(host, { atLeast: 2, where: 'default label' });
        const bubble = btn.dataset.copiedLabel || '';
        assert(isPseudoLocalized(bubble), `bubble text ${JSON.stringify(bubble)}`);
        const shown = getComputedStyle(btn, '::after').content;
        assert(shown === JSON.stringify(bubble) || shown === 'attr(data-copied-label)',
          `the bubble does not show the button's text: ::after content is ${shown}`);
      } finally {
        host.remove();
      }
    });
    passed++;
  } catch (e) {
    errors.push(`en-XA: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed: total - passed, errors };
}
