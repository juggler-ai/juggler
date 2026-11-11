//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ARIA roles and keyboard behaviour for menus: `applyMenuRoles` for a
 * button-opened menu built from the shared `.menu-item` rows, and
 * `attachMenuKeyboard` for any element carrying `role="menu"`.
 *
 * The roles are applied to the finished surface rather than by the row builders
 * because the `/` and `$` autocomplete renders the same rows, and that is a list
 * attached to the textarea, not a menu.
 * @module utils/menu-roles
 */

import { whenRevealed } from './popup-surface.js';

/**
 * Give a fully built menu its ARIA. The element is a named `menu`; each
 * `.menu-item` row a `menuitem`, unless it already carries an item role of its
 * own (a checkbox or radio item); a row that does nothing when chosen (the
 * empty-state hint, a `.menu-item-unavailable` row) a disabled one; each divider a
 * `separator`; each `.menu-header` caption no role at all —
 * a menu owns only items, groups and separators, and the rows under a caption
 * name themselves. Each collapsible sheet section is a group named by its
 * header, and the header an item that says whether it is expanded: a collapsed
 * section's rows are not rendered, so the header is the keyboard's only way in.
 * @param {HTMLElement} menu - The element that directly holds the rows
 * @param {string} label - Its accessible name
 */
export function applyMenuRoles(menu, label) {
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  menu.querySelectorAll('.menu-item').forEach((row) => {
    if (!row.matches(ITEM_SELECTOR)) row.setAttribute('role', 'menuitem');
    if (row.classList.contains('menu-item-hint') || row.classList.contains('menu-item-unavailable')) {
      row.setAttribute('aria-disabled', 'true');
    }
  });
  menu.querySelectorAll('.menu-divider').forEach((divider) => divider.setAttribute('role', 'separator'));
  menu.querySelectorAll('.menu-header').forEach((caption) => caption.setAttribute('role', 'none'));
  menu.querySelectorAll('details').forEach((section) => {
    const details = /** @type {HTMLDetailsElement} */ (section);
    const summary = details.querySelector('summary');
    details.setAttribute('role', 'group');
    details.setAttribute('aria-label', summary?.textContent || '');
    if (!summary) return;
    summary.setAttribute('role', 'menuitem');
    const sync = () => summary.setAttribute('aria-expanded', String(details.open));
    sync();
    details.addEventListener('toggle', sync);
  });
}

/** Roles that make an element one of a menu's items. */
const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/**
 * Whether the most recent input was a key rather than a pointer. A menu takes
 * focus only when it was opened from the keyboard: moving focus on a click
 * would put a stray focus ring on its first row.
 */
let lastInputWasKey = false;
// Viewer-only: an extension's context item can reach this module from the
// engine too, which has no document — guarded so loading it there binds nothing.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => { lastInputWasKey = true; }, true);
  document.addEventListener('pointerdown', () => { lastInputWasKey = false; }, true);
}

/**
 * The menu's items that can take focus: not disabled, not hidden, and not a row
 * of a collapsed section (whose header is the way in).
 * @param {HTMLElement} menu - The `role="menu"` element.
 * @returns {HTMLElement[]} The items, in document order.
 */
function focusableItems(menu) {
  return /** @type {HTMLElement[]} */ (Array.from(menu.querySelectorAll(ITEM_SELECTOR)))
    .filter((item) => item.getAttribute('aria-disabled') !== 'true'
      && !item.closest('[hidden]')
      && (item.localName === 'summary' || !item.closest('details:not([open])')));
}

/**
 * Keep exactly one item in the tab order: the one that already is, while it can
 * still take focus, otherwise the first that can.
 * @param {HTMLElement} menu - The `role="menu"` element.
 */
function syncTabStop(menu) {
  const focusable = focusableItems(menu);
  const kept = focusable.find((item) => item.getAttribute('tabindex') === '0') ?? focusable[0];
  menu.querySelectorAll(ITEM_SELECTOR).forEach((el) => {
    const item = /** @type {HTMLElement} */ (el);
    const index = item === kept ? 0 : -1;
    if (item.tabIndex !== index || !item.hasAttribute('tabindex')) item.tabIndex = index;
  });
}

/**
 * Make `item` its menu's single tab stop and focus it — for a menu that has
 * re-rendered its rows and puts the keyboard user back where they were.
 * @param {HTMLElement} menu - The `role="menu"` element.
 * @param {HTMLElement} item - The item to move to.
 */
export function focusMenuItem(menu, item) {
  menu.querySelectorAll(ITEM_SELECTOR).forEach((el) => { /** @type {HTMLElement} */ (el).tabIndex = -1; });
  item.tabIndex = 0;
  item.focus({ preventScroll: false });
}

/**
 * Give a menu the keyboard behaviour of the ARIA menu pattern. Call it once the
 * menu has its roles, before or after it is presented.
 *
 * Items rove: one is in the tab order at a time, kept so as rows are re-rendered
 * in place. ArrowUp/ArrowDown move between the enabled items and wrap, Home/End
 * jump to the ends, Enter and Space activate the focused item, and Tab closes
 * the menu. Escape is not handled here — the popup manager closes every popup
 * on it.
 *
 * Opened from the keyboard, focus moves to the first enabled item as soon as
 * the surface is revealed (`presentPopup` places it a frame later). Returning
 * focus on close is the presenter's job.
 * @param {HTMLElement} menu - The element carrying `role="menu"`.
 * @param {object} opts
 * @param {() => void} opts.close - Closes the menu (Tab).
 * @param {boolean} [opts.autoFocus=true] - Whether a keyboard open moves focus
 *   in; off for a menu whose own control takes it (a filter field), or for a
 *   re-render that restores focus itself.
 */
export function attachMenuKeyboard(menu, { close, autoFocus = true }) {
  syncTabStop(menu);
  new MutationObserver(() => syncTabStop(menu)).observe(menu, { childList: true, subtree: true });

  menu.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const current = target.closest?.(ITEM_SELECTOR);
    const list = focusableItems(menu);
    const at = current ? list.indexOf(/** @type {HTMLElement} */ (current)) : -1;
    /** @type {HTMLElement|undefined} */
    let next;
    switch (e.key) {
      case 'ArrowDown': next = list[(at + 1) % list.length]; break;
      case 'ArrowUp': next = list[at <= 0 ? list.length - 1 : at - 1]; break;
      case 'Home': next = list[0]; break;
      case 'End': next = list[list.length - 1]; break;
      case 'Enter':
      case ' ':
        if (current !== target) return;
        e.preventDefault();
        target.click();
        return;
      case 'Tab':
        e.preventDefault();
        close();
        return;
      default:
        return;
    }
    e.preventDefault();
    if (next) focusMenuItem(menu, next);
  });

  if (!autoFocus || !lastInputWasKey) return;
  whenRevealed(menu, () => {
    const first = focusableItems(menu)[0];
    if (first) focusMenuItem(menu, first);
  });
}

/**
 * Give an open menu the keyboard on its checked item — the value it holds —
 * or else its first, as soon as it is on screen: for a menu shown without
 * focus that becomes an ordinary one (a hold-to-cycle HUD left up when the
 * gesture took no hop).
 * @param {HTMLElement} menu - The `role="menu"` element, keyboard attached.
 */
export function focusMenuChoice(menu) {
  whenRevealed(menu, () => {
    const items = focusableItems(menu);
    const item = items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0];
    if (item) focusMenuItem(menu, item);
  });
}
