//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ARIA semantics of the two autocompletes: the composer's caret completion
 * (`CompletionMenu`, behind `/`, `$` and `@`) and `<path-input>`.
 *
 * Neither is a menu. Focus never leaves the field — typing is what drives them —
 * so the suggestions are a named `listbox` of `option`s the field controls, and
 * the highlighted row is announced through the field's `aria-activedescendant`
 * rather than by moving focus. Closing takes all of that off the field again.
 *
 * The composer's field is a `<textarea>`, which cannot take `role="combobox"`;
 * it says it autocompletes (`aria-autocomplete="list"`) and points at the list.
 * The path field is a one-line `<input>`, so it is a full combobox and also says
 * whether its list is showing.
 * @module unit-tests/autocomplete-aria-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { __resetPopupManagerForTests } from '../../js/utils/popup-manager.js';
import { CompletionMenu } from '../../js/components/completion-menu.js';
import '../../js/components/path-input.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * Assert a field controls an open listbox of options, and return the options.
 * @param {HTMLElement} field - The text field.
 * @param {string} label - Assertion label.
 * @returns {HTMLElement[]} The options.
 */
function assertListbox(field, label) {
  const id = field.getAttribute('aria-controls');
  assert(!!id, `${label}: the field does not point at its suggestions (no aria-controls)`);
  const list = document.getElementById(/** @type {string} */ (id));
  assert(!!list && list.getAttribute('role') === 'listbox', `${label}: aria-controls does not name a listbox`);
  assert(!!list?.getAttribute('aria-label'), `${label}: the listbox has no accessible name`);
  const options = /** @type {HTMLElement[]} */ (Array.from(list?.children ?? []));
  assert(options.length > 0 && options.every((o) => o.getAttribute('role') === 'option' && !!o.id),
    `${label}: every row must be an option with an id`);
  return options;
}

/**
 * Assert which option the field announces as active.
 * @param {HTMLElement} field - The text field.
 * @param {HTMLElement[]} options - The options.
 * @param {number} index - Expected active option, or -1 for none.
 * @param {string} label - Assertion label.
 */
function assertActive(field, options, index, label) {
  const active = field.getAttribute('aria-activedescendant');
  if (index < 0) {
    assert(!active, `${label}: no row is highlighted, yet the field names ${JSON.stringify(active)} active`);
  } else {
    assert(active === options[index].id, `${label}: the field names ${JSON.stringify(active)} active, not row ${index}`);
  }
  const selected = options.map((o) => o.getAttribute('aria-selected'));
  assert(selected.every((s, i) => s === String(i === index)),
    `${label}: aria-selected does not follow the highlight (${JSON.stringify(selected)})`);
}

/**
 * Assert the field no longer refers to a list.
 * @param {HTMLElement} field - The text field.
 * @param {string} label - Assertion label.
 */
function assertClosed(field, label) {
  assert(!field.hasAttribute('aria-controls') && !field.hasAttribute('aria-activedescendant'),
    `${label}: the closed field still points at its list`);
}

/**
 * Run the autocomplete ARIA suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // ── The composer's caret completion ────────────────────────────────────────
  {
    __resetPopupManagerForTests();
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:400px;';
    const textarea = document.createElement('textarea');
    wrapper.appendChild(textarea);
    document.body.appendChild(wrapper);
    const completions = new CompletionMenu({
      textarea,
      getWrapper: () => wrapper,
      onResize: () => {},
      providers: [/** @type {any} */ ({
        detect: (/** @type {string} */ text) => (text.startsWith('/') ? { anchorPos: 0, query: text.slice(1) } : null),
        fetch: async () => ['alpha', 'beta', 'gamma'],
        renderItem: (/** @type {string} */ item) => {
          const li = document.createElement('li');
          li.textContent = item;
          return li;
        },
        insert: (/** @type {string} */ item) => `/${item} `,
      })],
    });
    try {
      assert(textarea.getAttribute('aria-autocomplete') === 'list', 'composer: the field does not say it autocompletes');
      assertClosed(textarea, 'composer before typing');

      textarea.value = '/';
      textarea.selectionStart = textarea.selectionEnd = 1;
      completions.handleInput();
      // The fetch is debounced, so the list opens a few ticks later.
      await waitFor(() => completions.isActive(), 'composer: the completion to open');
      const options = assertListbox(textarea, 'composer');
      assertActive(textarea, options, -1, 'composer opened');
      completions.move(1);
      assertActive(textarea, options, 0, 'composer after ArrowDown');
      completions.move(1);
      assertActive(textarea, options, 1, 'composer after a second ArrowDown');

      completions.close();
      assertClosed(textarea, 'composer after closing');
      passed++;
    } catch (e) {
      failed++;
      errors.push('completion-menu: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      completions.close();
      wrapper.remove();
    }
  }

  // ── <path-input> ───────────────────────────────────────────────────────────
  {
    const host = /** @type {any} */ (document.createElement('path-input'));
    host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;';
    document.body.appendChild(host);
    try {
      const input = /** @type {HTMLInputElement} */ (host.querySelector('input'));
      assert(input.getAttribute('role') === 'combobox', `path-input: the field has role ${JSON.stringify(input.getAttribute('role'))}, not "combobox"`);
      assert(input.getAttribute('aria-autocomplete') === 'list', 'path-input: the field does not say it autocompletes');
      assert(input.getAttribute('aria-expanded') === 'false', 'path-input: the field does not start collapsed');
      assertClosed(input, 'path-input before typing');

      host._openMenu(['/srv/', '/srv/app/', '/srv/notes.md']);
      assert(input.getAttribute('aria-expanded') === 'true', 'path-input: the field does not say its list is showing');
      const options = assertListbox(input, 'path-input');
      assertActive(input, options, -1, 'path-input opened');
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      assertActive(input, options, 0, 'path-input after ArrowDown');
      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      assertActive(input, options, 1, 'path-input after a second ArrowDown');

      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert(input.getAttribute('aria-expanded') === 'false', 'path-input: the field still says its list is showing');
      assertClosed(input, 'path-input after Escape');
      passed++;
    } catch (e) {
      failed++;
      errors.push('path-input: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      host.remove();
    }
  }

  // ── <path-input> under en-XA: the list's accessible name is translated ─────
  {
    const host = /** @type {any} */ (document.createElement('path-input'));
    host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;';
    document.body.appendChild(host);
    try {
      /** @type {string} */
      let name = '';
      await underPseudoLocale('autocomplete-aria-test', () => {
        const input = /** @type {HTMLInputElement} */ (host.querySelector('input'));
        host._openMenu(['/1/', '/1/2/']);
        const list = document.getElementById(/** @type {string} */ (input.getAttribute('aria-controls')));
        assert(!!list, 'path-input under en-XA: the list opened');
        name = list?.getAttribute('aria-label') || '';
        host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      assert(isPseudoLocalized(name), `path-input: plain English under en-XA: ${JSON.stringify(name)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push('path-input en-XA: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      host.remove();
    }
  }

  __resetPopupManagerForTests();
  return { passed, failed, errors };
}
