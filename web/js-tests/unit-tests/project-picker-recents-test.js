//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the path picker panel. A single click on a recent entry opens
 * it, through the same confirm action as the primary button.
 * @module unit-tests/project-picker-recents-test
 */

import { assert, settledByNextTask } from '../utilities/test-helpers.js';
import { racePatiently } from '../utilities/test-patience.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { t, isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { buildPickerPanel } from '../../js/components/project-picker.js';

/**
 * Wait for the picker's promise to settle, riding the test's deadline (`ms`
 * is the nominal), or report that it never did.
 * @param {Promise<string|null>} promise
 * @param {number} ms
 * @returns {Promise<string|null|'pending'>} The settled value, or 'pending'
 */
async function settleWithin(promise, ms) {
  const settled = await racePatiently(promise, ms, { what: 'the picker to settle' });
  return settled ? settled.value : 'pending';
}

/**
 * Whether the picker's promise is still pending a task from now. The picker
 * resolves synchronously inside the handler that confirms, so a confirm the
 * case just provoked — or a verdict it has just seen land — would have settled
 * it by then, however slow the core.
 * @param {Promise<string|null>} promise
 * @returns {Promise<string|null|'pending'>} The settled value, or 'pending'
 */
async function pendingNow(promise) {
  const settled = await settledByNextTask(promise);
  return settled ? settled.value : 'pending';
}

/**
 * @param {HTMLElement} panel
 * @param {string} path
 * @returns {void}
 */
function clickRecent(panel, path) {
  const item = [...panel.querySelectorAll('.pp-recent-item')].find((b) => b.textContent === path);
  assert(!!item, `no recent entry for ${path}`);
  /** @type {HTMLElement} */ (item).click();
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
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (error) {
      failed++;
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await run('Enter that takes a completion takes only the completion', async () => {
    // The field consumes an Enter that takes a highlighted path; the panel must
    // not also read that same press as "open". A file taken from the menu
    // closes the menu, so asking whether a menu is still showing gets it wrong.
    const { element, promise, cancel } = buildPickerPanel({ dirsOnly: false });
    document.body.appendChild(element);
    const field = /** @type {any} */ (element.querySelector('path-input'));
    try {
      const input = /** @type {HTMLInputElement} */ (field.querySelector('input'));
      field.value = '/work/a';
      field.dispatchEvent(new CustomEvent('path-change', { detail: { value: '/work/a' } }));
      field._openMenu(['/work/a.txt', '/work/b.txt']);
      field._highlight(0);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      assert(field.value === '/work/a.txt', `the Enter must take the completion, got ${JSON.stringify(field.value)}`);
      // The keydown handler confirms inline, so a confirm this Enter caused
      // has already settled the promise.
      const got = await pendingNow(promise);
      assert(got === 'pending', `the same Enter also opened ${JSON.stringify(got)}`);

      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const opened = await settleWithin(promise, 1000);
      assert(opened === '/work/a.txt', `the next Enter opens what was taken, got ${JSON.stringify(opened)}`);
    } finally {
      field._closeMenu?.();
      cancel();
      element.remove();
    }
  });

  await run('a click on a recent opens it', async () => {
    const { element, promise, cancel } = buildPickerPanel({ recents: ['/work/beta'] });
    document.body.appendChild(element);
    try {
      clickRecent(element, '/work/beta');
      const got = await settleWithin(promise, 1000);
      assert(got === '/work/beta', `picker resolved ${JSON.stringify(got)}, want "/work/beta"`);
    } finally {
      cancel();
      element.remove();
    }
  });

  await run('markup in caller-supplied labels is shown as text', async () => {
    const { element, cancel } = buildPickerPanel({
      title: '<b>1</b>',
      subtitle: '<b>2</b>',
      placeholder: '"><b>3</b>',
      confirmLabel: '<b>4</b>',
    });
    try {
      assert(!element.querySelector('b'), `markup in a label became elements: ${element.innerHTML}`);
      const title = element.querySelector('.pp-title')?.textContent || '';
      assert(title === '<b>1</b>', `title read "${title}", want "<b>1</b>"`);
      const open = element.querySelector('.pp-btn-open')?.textContent || '';
      assert(open === '<b>4</b>', `confirm read "${open}", want "<b>4</b>"`);
      const placeholder = element.querySelector('path-input')?.getAttribute('placeholder');
      assert(placeholder === '"><b>3</b>', `placeholder read ${JSON.stringify(placeholder)}`);
    } finally {
      cancel();
    }
  });

  await run('a pre-filled path is the attribute value exactly, entities and all', async () => {
    const PATH = '/work/&amp;/<b>"x\'';
    const { element, cancel } = buildPickerPanel({ currentPath: PATH });
    try {
      assert(!element.querySelector('b'), `markup in the path became elements: ${element.innerHTML}`);
      const value = element.querySelector('path-input')?.getAttribute('value');
      assert(value === PATH, `value read ${JSON.stringify(value)}, want ${JSON.stringify(PATH)}`);
    } finally {
      cancel();
    }
  });

  await run('under en-XA everything the picker draws is translated', async () => {
    await underPseudoLocale('test-project-picker', async () => {
      const { element, cancel } = buildPickerPanel({ recents: ['/1/2'], subtitle: t('Browse…') });
      document.body.appendChild(element);
      try {
        const raw = shownStrings(element, '.pp-recent-item').filter((s) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
        // The Browse… button draws only under a native host, which this page
        // never has; its label is checked from the catalogue.
        assert(isPseudoLocalized(t('Browse…')), 'Browse… is not translated');
      } finally {
        cancel();
        element.remove();
      }
    });
  });

  return { passed, failed, errors };
}
