//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The filter bar the Changes and Refs places show over their lists on `/`: a
 * hidden bar with one text field, styled as History's (pins/git/styles). The
 * list narrows as the text is typed, ignoring case. Esc in the field clears
 * and hides the bar and gives the keys back to the pin; the place's own Esc
 * calls {@link ListFilter.close} for when the field has lost focus.
 * @module pins/git/list-filter
 */

import { createElement } from 'juggler/ui';

/**
 * @typedef {object} ListFilter
 * @property {HTMLElement} element - The bar, hidden until opened.
 * @property {HTMLInputElement} input - Its text field.
 * @property {() => void} open - Show the bar and focus the field.
 * @property {() => boolean} close - Clear and hide it; true when it was open.
 * @property {() => boolean} active - Whether it holds any text.
 * @property {(...texts: (string|undefined)[]) => boolean} matches - Whether any of `texts` holds the filter's text; all do while it is empty.
 */

/**
 * @param {object} options - What the bar is for.
 * @param {string} options.label - The field's accessible name.
 * @param {string} options.placeholder - The field's placeholder.
 * @param {HTMLElement} options.root - Where focus goes when the bar closes.
 * @param {() => void} options.onChange - Called when the text, and so what matches, changes.
 * @returns {ListFilter} The bar.
 */
export function createListFilter({ label, placeholder, root, onChange }) {
  const element = createElement('div', 'git-list-filter');
  element.hidden = true;
  const input = /** @type {HTMLInputElement} */ (createElement('input', 'git-list-filter__input field-input field-input-xs'));
  input.type = 'search';
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', label);
  element.append(input);

  let needle = '';
  const sync = () => {
    const next = input.value.trim().toLowerCase();
    if (next === needle) return;
    needle = next;
    onChange();
  };

  const close = () => {
    const wasOpen = !element.hidden;
    input.value = '';
    element.hidden = true;
    sync();
    return wasOpen;
  };

  input.addEventListener('input', sync);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
    input.blur();
    root.focus({ preventScroll: true });
  });

  return {
    element,
    input,
    open: () => {
      element.hidden = false;
      input.focus();
      input.select();
    },
    close,
    active: () => needle !== '',
    matches: (...texts) => !needle || texts.some((text) => Boolean(text) && /** @type {string} */ (text).toLowerCase().includes(needle)),
  };
}
