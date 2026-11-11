//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The header's "…" overflow menu.
 *
 * When the header is too narrow for every control, CSS folds the rarely-used
 * ones out of the row (see `.header-overflow-button` in app-header.css) and
 * shows the "…" button instead. This menu offers them back — each row runs the
 * same action as the button it stands in for, and names that action's
 * keyboard shortcut, since a shortcut is the other way to reach it. In a
 * Windows or Linux desktop window the button is always there and the menu is
 * the app menu too; what it holds is decided in utils/header-overflow-items.js.
 * @module utils/header-overflow-menu
 */

import { presentPopup } from './popup-surface.js';
import { applyMenuRoles, attachMenuKeyboard } from './menu-roles.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import { t } from '../../sdk/lib/i18n.js';

/** Popup-manager id: at most one overflow menu is ever open. */
const OVERFLOW_MENU_POPUP_ID = 'header-overflow-menu';

/**
 * @typedef {object} HeaderOverflowRow
 * @property {string} label - What the row does: English, marked for translation and translated where the row is drawn.
 * @property {string} [shortcutId] - KeyShortcutManager id whose binding the row shows.
 * @property {() => void} run - The action, shared with the button or menu command the row stands in for.
 * @property {() => boolean} [omit] - Leaves the row out of a menu opened while it returns true.
 */

/**
 * @typedef {object} HeaderOverflowSeparator
 * @property {true} separator - A divider between groups of rows.
 */

/** @typedef {HeaderOverflowRow|HeaderOverflowSeparator} HeaderOverflowItem */

/**
 * The items a menu opened now shows: the rows not omitted, with a separator
 * only where it falls between two of them.
 * @param {HeaderOverflowItem[]} items - Every item, in order.
 * @returns {HeaderOverflowItem[]} The ones to draw.
 */
function shownItems(items) {
  /** @type {HeaderOverflowItem[]} */
  const shown = [];
  let pendingSeparator = false;
  for (const item of items) {
    if ('separator' in item) {
      pendingSeparator = shown.length > 0;
      continue;
    }
    if (item.omit?.()) continue;
    if (pendingSeparator) shown.push({ separator: true });
    pendingSeparator = false;
    shown.push(item);
  }
  return shown;
}

/**
 * Make `button` open and close the overflow menu.
 * @param {HTMLElement} button - The header's "…" button.
 * @param {HeaderOverflowItem[]} items - The rows, in order.
 * @returns {{dispose: () => void}} Closes any open menu and unwires the button.
 */
export function setupHeaderOverflowMenu(button, items) {
  /** @type {(() => void)|null} */
  let release = null;

  const close = () => {
    const r = release;
    release = null;
    r?.();
    button.setAttribute('aria-expanded', 'false');
  };

  const open = () => {
    const surface = document.createElement('nav');
    surface.className = 'dropdown-menu header-overflow-menu is-open';
    const list = document.createElement('menu');
    for (const item of shownItems(items)) {
      if ('separator' in item) {
        const divider = document.createElement('li');
        divider.className = 'menu-divider';
        list.append(divider);
        continue;
      }
      const row = document.createElement('li');
      row.className = 'menu-item';
      const name = document.createElement('span');
      name.className = 'menu-item-name';
      name.textContent = t(item.label);
      row.append(name);
      const keys = item.shortcutId ? keyShortcutManager.formatBinding(item.shortcutId) : '';
      if (keys) {
        const hint = document.createElement('span');
        hint.className = 'menu-item-shortcut';
        hint.textContent = keys;
        row.append(hint);
      }
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        item.run();
      });
      list.append(row);
    }
    applyMenuRoles(list, t('More controls'));
    surface.append(list);
    button.setAttribute('aria-expanded', 'true');
    release = presentPopup({
      surface,
      anchor: button,
      id: OVERFLOW_MENU_POPUP_ID,
      onClose: close,
      // The button sits at the right end of the header, so pin the right edges.
      align: 'right',
      gap: 6,
      insideSelectors: ['.header-overflow-menu', '#header-overflow-button'],
    });
    attachMenuKeyboard(list, { close });
  };

  const onClick = () => { if (release) close(); else open(); };
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', onClick);

  return {
    dispose: () => {
      close();
      button.removeEventListener('click', onClick);
    },
  };
}
