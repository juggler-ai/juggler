//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The header's "…" overflow popup.
 *
 * When the header is too narrow for every control, CSS folds some out of the
 * row (see `.header-foldable` in app-header.css) and shows the "…" button
 * instead. This popup gives them back as themselves: the folded controls are
 * moved into a strip at the top of the popup while it is open, and put back
 * where they were when it closes. So they keep their handlers, their state
 * (the theme's glyph, the bell's mute) and their tooltips, and pressing one
 * leaves the popup open — zoom is pressed again and again. The popup hangs off
 * the button at every width, a phone's included, rather than becoming a sheet:
 * it is a handful of buttons, and is about the button it came from.
 *
 * In a Windows or Linux desktop window the button is always there and the
 * popup has the app menu's rows under the strip; what those hold is decided in
 * utils/header-overflow-items.js. Each row runs its command and closes the
 * popup, and names that command's keyboard shortcut.
 * @module utils/header-overflow-menu
 */

import { presentPopup } from './popup-surface.js';
import { applyMenuRoles, attachMenuKeyboard } from './menu-roles.js';
import keyShortcutManager from '../services/key-shortcut-manager.js';
import { t } from '../../sdk/lib/i18n.js';

/** Popup-manager id: at most one overflow popup is ever open. */
const OVERFLOW_MENU_POPUP_ID = 'header-overflow-menu';

/**
 * @typedef {object} HeaderOverflowRow
 * @property {string} label - What the row does: English, marked for translation and translated where the row is drawn.
 * @property {string} [shortcutId] - KeyShortcutManager id whose binding the row shows.
 * @property {() => void} run - The action, shared with the menu command the row stands in for.
 * @property {() => boolean} [omit] - Leaves the row out of a popup opened while it returns true.
 */

/**
 * @typedef {object} HeaderOverflowSeparator
 * @property {true} separator - A divider between groups of rows.
 */

/** @typedef {HeaderOverflowRow|HeaderOverflowSeparator} HeaderOverflowItem */

/**
 * The items a popup opened now shows: the rows not omitted, with a separator
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
 * Move `controls` into `strip`, each leaving a marker where it was.
 * @param {HTMLElement[]} controls - The elements to lend.
 * @param {HTMLElement} strip - Where they go.
 * @returns {() => void} Puts every one back at its marker. Idempotent.
 */
function lend(controls, strip) {
  const markers = controls.map((control) => {
    const marker = document.createComment('header-overflow');
    control.before(marker);
    strip.append(control);
    return /** @type {[Comment, HTMLElement]} */ ([marker, control]);
  });
  return () => {
    for (const [marker, control] of markers.splice(0)) {
      if (marker.isConnected) marker.replaceWith(control);
      else marker.remove();
    }
  };
}

/**
 * Make `button` open and close the overflow popup.
 * @param {HTMLElement} button - The header's "…" button.
 * @param {HeaderOverflowItem[]} items - The menu rows, in order.
 * @param {object} [options]
 * @param {() => HTMLElement[]} [options.controls] - The header controls to show
 *   in the popup's strip, asked each time it opens.
 * @returns {{dispose: () => void}} Closes any open popup and unwires the button.
 */
export function setupHeaderOverflowMenu(button, items, { controls = () => [] } = {}) {
  /** @type {(() => void)|null} */
  let release = null;
  /** @type {(() => void)|null} */
  let giveBack = null;

  const close = () => {
    const r = release;
    release = null;
    r?.();
    // After the surface has gone, so nothing is put back into a row it is
    // still being laid out against.
    giveBack?.();
    giveBack = null;
    button.setAttribute('aria-expanded', 'false');
  };

  const open = () => {
    const surface = document.createElement('nav');
    surface.className = 'dropdown-menu header-overflow-menu is-open';

    const lent = controls();
    if (lent.length) {
      const strip = document.createElement('div');
      strip.className = 'header-overflow-strip';
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', t('More controls'));
      giveBack = lend(lent, strip);
      surface.append(strip);
    }

    /** @type {HTMLElement|null} */
    let list = null;
    const rows = shownItems(items);
    if (rows.length) {
      list = document.createElement('menu');
      for (const item of rows) {
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
      if (lent.length) {
        const divider = document.createElement('div');
        divider.className = 'menu-divider';
        divider.setAttribute('role', 'separator');
        surface.append(divider);
      }
      surface.append(list);
    } else {
      surface.setAttribute('role', 'dialog');
      surface.setAttribute('aria-label', t('More controls'));
    }

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
      asSheet: false,
      // Zoom, pressed in the strip, resizes the row the button sits in.
      followAnchor: true,
    });
    if (list) attachMenuKeyboard(list, { close });
  };

  const onClick = () => { if (release) close(); else open(); };
  // A popup with menu rows is a menu; one that only lends the row's controls
  // is a small non-modal dialog holding them.
  button.setAttribute('aria-haspopup', items.length ? 'menu' : 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', onClick);

  return {
    dispose: () => {
      close();
      button.removeEventListener('click', onClick);
    },
  };
}
