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

import { attachMenuKeyboard, attachMenuTrigger, createElement, focusMenuChoice, presentPopup } from 'juggler/ui';
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
  button.append(text, icon('chev'));

  /** @type {MenuChoice[]} */
  let choices = [];
  let chosen = '';
  /** @type {(() => void)|null} */
  let release = null;

  const draw = () => {
    const choice = choices.find((c) => c.value === chosen);
    text.textContent = choice ? (choice.buttonLabel || choice.label) : chosen;
    button.title = choice?.title || label;
    button.dataset.value = chosen;
  };

  const close = () => {
    const was = release;
    release = null;
    button.setAttribute('aria-expanded', 'false');
    was?.();
  };

  const open = () => {
    if (release) {
      close();
      return;
    }
    const surface = createElement('menu', 'dropdown-menu is-open git-select-menu');
    surface.setAttribute('role', 'menu');
    surface.setAttribute('aria-label', label);
    /** @type {HTMLElement|null} */
    let current = null;
    let group = '';
    const listed = expand ? expand() : choices;
    for (const choice of listed) {
      if (choice.group && choice.group !== group) {
        const header = createElement('li', 'menu-header menu-header-plain caps-label', choice.group);
        header.setAttribute('role', 'none');
        surface.append(header);
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
      surface.append(row);
    }
    release = presentPopup({
      surface,
      anchor: button,
      id: 'git-select',
      gap: 4,
      onClose: () => {
        if (release) close();
      },
      insideSelectors: [surface],
    });
    button.setAttribute('aria-expanded', 'true');
    attachMenuKeyboard(surface, { close, autoFocus: !current });
    if (current) focusMenuChoice(surface);
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
    },
    setValue: (value) => {
      chosen = value;
      draw();
    },
    value: () => chosen,
    open,
    close,
  };
}
