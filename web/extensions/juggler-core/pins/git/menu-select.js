//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The Git pin's picker: a button naming the current choice, which opens the
 * app's own menu of the choices — the chosen one filled, as every picker in
 * the app shows it — rather than the platform's `<select>` menu. Choices may
 * fall in groups, each under a plain header. As a platform menu button, it
 * opens on the press, and a drag released on a choice picks it.
 *
 * Like a `<select>`, `value` is what is chosen and `set` changes the choices
 * without telling anyone; only a pick by the user calls `onChoose`.
 * @module pins/git/menu-select
 */

import { attachMenuKeyboard, attachMenuTrigger, createElement, focusMenuChoice, focusMenuItem, presentPopup } from 'juggler/ui';
import { icon } from './icons.js';

/**
 * @typedef {object} MenuChoice
 * @property {string} value - What it is.
 * @property {string} label - What it says.
 * @property {string} [title] - A tooltip, saying more.
 * @property {string} [group] - The header it falls under; choices of one group are consecutive.
 * @property {string} [buttonLabel] - What the button says while it is chosen, when not `label`.
 */

/**
 * @typedef {object} MenuSelect
 * @property {HTMLButtonElement} element - The button.
 * @property {(choices: MenuChoice[], value: string) => void} set - The choices, and which is chosen.
 * @property {(value: string) => void} setValue - Choose one, quietly.
 * @property {(words: string) => void} setPending - More choices are still being
 *   found, and these words say so ('' once they all are): the chevron turns, and
 *   the menu ends with a row saying it — open or not, as the choices are.
 * @property {() => string} value - The chosen value.
 * @property {() => void} open - Open the menu, as a click would; toggles it closed when open.
 * @property {() => void} close - Close it, if open.
 */

/**
 * @param {{className: string, label: string, onChoose: (value: string) => void,
 *   expand?: () => MenuChoice[], bare?: boolean}} options - The button's class, its accessible
 *   name, and what a pick does; with `expand`, the choices to list, asked each
 *   time the menu opens — for a list that may run to thousands, built only when
 *   someone looks. `set`'s choices then only name the chosen one on the button.
 *   A `bare` button is not drawn as a field: `className` alone styles it.
 * @returns {MenuSelect} The picker.
 */
export function createMenuSelect({ className, label, onChoose, expand, bare = false }) {
  const button = /** @type {HTMLButtonElement} */ (createElement('button', bare ? className : `git-select field-input field-input-xs ${className}`));
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', label);
  const text = createElement('span', 'git-select__text text-truncate');
  const chevron = icon('chev');
  const spinner = icon('sync');
  spinner.classList.add('git-select__spin');
  button.append(text, chevron);

  /** @type {MenuChoice[]} */
  let choices = [];
  let chosen = '';
  /** What says more choices are still being found; '' when none are. */
  let pending = '';
  /** @type {(() => void)|null} */
  let release = null;
  /** @type {HTMLElement|null} The open menu. */
  let surface = null;

  const draw = () => {
    const choice = choices.find((c) => c.value === chosen);
    text.textContent = choice ? (choice.buttonLabel || choice.label) : chosen;
    button.title = choice?.title || label;
    button.dataset.value = chosen;
    if (pending) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
    const glyph = pending ? spinner : chevron;
    if (!glyph.isConnected) (pending ? chevron : spinner).replaceWith(glyph);
  };

  const close = () => {
    const was = release;
    release = null;
    surface = null;
    button.setAttribute('aria-expanded', 'false');
    was?.();
  };

  /**
   * Lay the menu's rows: the choices, then the pending row while there is one.
   * @param {HTMLElement} menu - The menu.
   * @returns {HTMLElement|null} The chosen row, if it is listed.
   */
  const fill = (menu) => {
    /** @type {HTMLElement|null} */
    let current = null;
    let group = '';
    const listed = expand ? expand() : choices;
    /** @type {HTMLElement[]} */
    const rows = [];
    for (const choice of listed) {
      if (choice.group && choice.group !== group) {
        const header = createElement('li', 'menu-header menu-header-plain caps-label', choice.group);
        header.setAttribute('role', 'none');
        rows.push(header);
      }
      group = choice.group || '';
      const row = createElement('li', `menu-item${choice.value === chosen ? ' menu-item-selected' : ''}`);
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', String(choice.value === chosen));
      row.dataset.value = choice.value;
      row.tabIndex = -1;
      row.append(createElement('span', 'text-truncate', choice.label));
      if (choice.title) row.title = choice.title;
      row.addEventListener('click', () => {
        close();
        if (choice.value === chosen) return;
        chosen = choice.value;
        draw();
        onChoose(choice.value);
      });
      if (choice.value === chosen) current = row;
      rows.push(row);
    }
    if (pending) {
      const row = createElement('li', 'menu-item git-select-menu__pending');
      row.setAttribute('role', 'none');
      row.setAttribute('aria-busy', 'true');
      const glyph = icon('sync');
      glyph.classList.add('git-select__spin');
      row.append(glyph, createElement('span', 'text-truncate', pending));
      rows.push(row);
    }
    menu.replaceChildren(...rows);
    return current;
  };

  const open = () => {
    if (release) {
      close();
      return;
    }
    const menu = createElement('menu', 'dropdown-menu is-open git-select-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);
    const current = fill(menu);
    surface = menu;
    release = presentPopup({
      surface: menu,
      anchor: button,
      id: 'git-select',
      gap: 4,
      onClose: () => {
        if (release) close();
      },
      insideSelectors: [menu],
    });
    button.setAttribute('aria-expanded', 'true');
    attachMenuKeyboard(menu, { close, autoFocus: !current });
    if (current) focusMenuChoice(menu);
  };

  /** The choices changed: lay an open menu's rows again, the keyboard where it was. */
  const refill = () => {
    if (!surface) return;
    const focused = /** @type {HTMLElement|null} */ (surface.querySelector(':focus'));
    const at = focused?.dataset.value;
    fill(surface);
    const back = at === undefined ? null
      : [...surface.querySelectorAll('[data-value]')].find((row) => /** @type {HTMLElement} */ (row).dataset.value === at);
    if (back) focusMenuItem(surface, /** @type {HTMLElement} */ (back));
  };

  attachMenuTrigger(button, open);
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!release) open();
    }
  });

  return {
    element: button,
    set: (next, value) => {
      choices = next;
      chosen = value;
      draw();
      // An expanded list is built when the menu opens, and may run to thousands.
      if (!expand) refill();
    },
    setValue: (value) => {
      chosen = value;
      draw();
    },
    setPending: (words) => {
      if (words === pending) return;
      pending = words;
      draw();
      refill();
    },
    value: () => chosen,
    open,
    close,
  };
}
