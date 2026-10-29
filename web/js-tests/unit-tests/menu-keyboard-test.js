//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Keyboard behaviour shared by every button-opened menu (`attachMenuKeyboard`).
 *
 *   1. Opened from the keyboard, focus lands on the first enabled item once the
 *      surface is revealed; opened with a pointer, focus stays where it was.
 *   2. Items rove: exactly one is in the tab order, and ArrowUp/ArrowDown wrap,
 *      Home/End jump, and disabled items are skipped.
 *   3. Enter and Space activate the focused item; Tab closes the menu, and focus
 *      goes back to the trigger.
 *   4. A surface that is already visible when the keyboard is attached (the
 *      context menu's own placement) is focused at once.
 *
 * `requestAnimationFrame` is shimmed onto macrotasks: the test window is hidden
 * and may never paint, and `presentPopup` reveals a surface in a frame.
 * `document.activeElement` still follows `.focus()` there, though `:focus`
 * never matches.
 * @module unit-tests/menu-keyboard-test
 */

import { assert, nextTask } from '../utilities/test-helpers.js';
import { presentPopup } from '../../js/utils/popup-surface.js';
import { __resetPopupManagerForTests } from '../../js/utils/popup-manager.js';
import { applyMenuRoles, attachMenuKeyboard } from '../../js/utils/menu-roles.js';
import { assertMenuShape } from '../utilities/menu-assertions.js';
import { openAddPicker } from '../../js/components/pinboard-add-picker.js';
import pinboardItemRegistry from '../../js/registries/pinboard-item-registry.js';
import infoCardRegistry from '../../js/registries/info-card-registry.js';
import { openMenuAt } from '../../js/services/context-menu-service.js';
import '../../js/components/info-cards-button.js';

/**
 * Send one key to an element, the way a user's keypress arrives.
 * @param {Element} el - Target.
 * @param {string} key - `KeyboardEvent.key`.
 */
function press(el, key) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

/**
 * Build a menu of four items, the third disabled, and a trigger to open it from.
 * @returns {{trigger: HTMLButtonElement, surface: HTMLElement, menu: HTMLElement, rows: HTMLElement[], clicks: string[]}} The parts.
 */
function build() {
  const trigger = document.createElement('button');
  trigger.textContent = 'open';
  trigger.style.cssText = 'position:fixed;left:10px;top:10px;';
  document.body.appendChild(trigger);
  const surface = document.createElement('nav');
  surface.className = 'dropdown-menu show';
  const menu = document.createElement('menu');
  /** @type {string[]} */
  const clicks = [];
  const rows = ['alpha', 'beta', 'gamma', 'delta'].map((label, i) => {
    const li = document.createElement('li');
    li.className = i === 2 ? 'menu-item menu-item-hint' : 'menu-item';
    li.textContent = label;
    li.addEventListener('click', () => clicks.push(label));
    menu.appendChild(li);
    return li;
  });
  surface.appendChild(menu);
  applyMenuRoles(menu, 'Test');
  return { trigger, surface, menu, rows, clicks };
}

/**
 * Run the menu keyboard suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const realRaf = window.requestAnimationFrame;
  const realCancelRaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) =>
    /** @type {any} */ (setTimeout(() => cb(performance.now()), 0));
  window.cancelAnimationFrame = (/** @type {number} */ id) => clearTimeout(id);

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
   */
  const run = async (label, fn) => {
    __resetPopupManagerForTests();
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * Open the built menu through presentPopup with the keyboard attached.
   * @param {ReturnType<typeof build>} parts
   * @returns {{closed: () => boolean}} Whether close has run.
   */
  const open = (parts) => {
    let closed = false;
    /** @type {(() => void)|null} */
    let release = null;
    const close = () => {
      closed = true;
      if (release) {
        const r = release;
        release = null;
        r();
      }
    };
    release = presentPopup({ surface: parts.surface, anchor: parts.trigger, id: 'menu-keyboard-test', onClose: close });
    attachMenuKeyboard(parts.menu, { close });
    return { closed: () => closed };
  };

  try {
    await run('a keyboard-opened menu focuses its first item and roves', async () => {
      const parts = build();
      const { trigger, rows, clicks } = parts;
      try {
        trigger.focus();
        press(trigger, 'Enter');
        const state = open(parts);
        assert(document.activeElement === trigger, 'focus moved before the surface was revealed');
        await nextTask();
        assert(document.activeElement === rows[0], `focus did not land on the first item (on ${document.activeElement?.textContent})`);
        assert(rows.filter((r) => r.tabIndex === 0).length === 1 && rows[0].tabIndex === 0,
          'exactly the focused item should be in the tab order');

        press(rows[0], 'ArrowDown');
        assert(document.activeElement === rows[1], 'ArrowDown did not move to the next item');
        assert(rows[1].tabIndex === 0 && rows[0].tabIndex === -1, 'the tab stop did not follow focus');
        press(rows[1], 'ArrowDown');
        assert(document.activeElement === rows[3], 'ArrowDown did not skip the disabled item');
        press(rows[3], 'ArrowDown');
        assert(document.activeElement === rows[0], 'ArrowDown did not wrap to the first item');
        press(rows[0], 'ArrowUp');
        assert(document.activeElement === rows[3], 'ArrowUp did not wrap to the last item');
        press(rows[3], 'Home');
        assert(document.activeElement === rows[0], 'Home did not jump to the first item');
        press(rows[0], 'End');
        assert(document.activeElement === rows[3], 'End did not jump to the last item');

        press(rows[3], 'Enter');
        press(rows[3], ' ');
        assert(clicks.join() === 'delta,delta', `Enter and Space should each activate the item, got ${JSON.stringify(clicks)}`);

        press(rows[3], 'Tab');
        assert(state.closed(), 'Tab did not close the menu');
        assert(!parts.surface.isConnected, 'the closed menu is still in the page');
        assert(document.activeElement === trigger, 'focus did not return to the trigger');
      } finally {
        parts.surface.remove();
        trigger.remove();
      }
    });

    await run('a pointer-opened menu leaves focus alone', async () => {
      const parts = build();
      try {
        parts.trigger.focus();
        parts.trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        open(parts);
        await nextTask();
        assert(document.activeElement === parts.trigger,
          `a pointer open moved focus to ${document.activeElement?.textContent}`);
        assert(parts.rows[0].tabIndex === 0, 'the first item should still be the tab stop');
      } finally {
        parts.surface.remove();
        parts.trigger.remove();
      }
    });

    await run('the info-cards menu keeps focus on its row when it re-renders', async () => {
      const realGetCards = infoCardRegistry.getEnabledCards;
      infoCardRegistry.getEnabledCards = /** @type {any} */ (() => [
        { id: 'fake-a', name: 'Card A' }, { id: 'fake-b', name: 'Card B' }, { id: 'fake-c', name: 'Card C' },
      ]);
      const host = /** @type {any} */ (document.createElement('info-cards-button'));
      document.body.appendChild(host);
      try {
        host._button.focus();
        press(host._button, 'Enter');
        host._openMenu();
        await nextTask();
        const menu = assertMenuShape(document.querySelector('.info-cards-menu'), 'info-cards menu');
        const items = () => /** @type {HTMLElement[]} */ (Array.from(menu.isConnected
          ? menu.querySelectorAll('[role^="menuitem"]')
          : document.querySelectorAll('.info-cards-menu [role^="menuitem"]')));
        const enabled = items().filter((i) => i.getAttribute('aria-disabled') !== 'true');
        assert(enabled.length === 3, `expected the three stub cards, got ${enabled.length}`);
        assert(document.activeElement === enabled[0], 'a keyboard open did not focus the first card');
        press(enabled[0], 'ArrowDown');
        assert(document.activeElement === enabled[1], 'ArrowDown did not reach the second card');
        // A toggle re-renders the rows; the keyboard user must stay where they were.
        host._renderMenu();
        const after = items().filter((i) => i.getAttribute('aria-disabled') !== 'true');
        assert(document.activeElement === after[1],
          `focus left the toggled row on re-render (now on ${document.activeElement?.textContent})`);
        assert(after[1].tabIndex === 0, 'the re-rendered row is not the tab stop');
      } finally {
        host._closeMenu();
        host.remove();
        infoCardRegistry.getEnabledCards = realGetCards;
      }
    });

    await run('the add picker focuses its filter, and ArrowDown enters the list', async () => {
      const realGetEnabled = pinboardItemRegistry.getEnabledTypes;
      const fakes = Array.from({ length: 10 }, (_, i) => ({
        id: `fake-${i}`,
        name: `Fake ${i}`,
        allowsMultiple: true,
        getManifest: () => ({ order: i }),
        canAdd: () => true,
      }));
      pinboardItemRegistry.getEnabledTypes = /** @type {any} */ (() => fakes);
      const anchor = document.createElement('button');
      anchor.style.cssText = 'position:fixed;right:10px;top:10px;';
      document.body.appendChild(anchor);
      /** @type {(() => void)|null} */
      let close = null;
      try {
        anchor.focus();
        press(anchor, 'Enter');
        close = openAddPicker({ anchor, active: /** @type {any} */ ({}), onPick: () => {} });
        await nextTask();
        const picker = document.querySelector('.pinboard-add-picker');
        const menu = assertMenuShape(picker, 'add picker');
        const filter = /** @type {HTMLInputElement|null} */ (picker?.querySelector('.pinboard-add-picker__filter') ?? null);
        assert(!!filter && !menu.contains(filter), 'the filter must sit outside the role="menu" list');
        assert(document.activeElement === filter, `the filter did not take focus once shown (on ${document.activeElement?.localName})`);
        press(/** @type {HTMLElement} */ (filter), 'ArrowDown');
        const first = menu.querySelector('[role="menuitem"]');
        assert(document.activeElement === first, 'ArrowDown in the filter did not move to the first row');
      } finally {
        close?.();
        anchor.remove();
        pinboardItemRegistry.getEnabledTypes = realGetEnabled;
      }
    });

    await run('a context menu opened from the keyboard takes focus, and gives it back', async () => {
      const origin = document.createElement('button');
      origin.textContent = 'origin';
      document.body.appendChild(origin);
      try {
        origin.focus();
        press(origin, 'ContextMenu');
        openMenuAt([
          { label: 'One', onClick: () => {} },
          { label: 'Two', disabled: true },
          { label: 'Three', onClick: () => {} },
        ], 10, 10, origin);
        const menu = assertMenuShape(document.querySelector('.juggler-context-menu'), 'context menu');
        const items = /** @type {HTMLElement[]} */ (Array.from(menu.querySelectorAll('[role="menuitem"]')));
        assert(document.activeElement === items[0], `the context menu did not take focus (on ${document.activeElement?.textContent})`);
        press(items[0], 'ArrowDown');
        assert(document.activeElement === items[2], 'ArrowDown did not skip the disabled row');
        press(items[2], 'Tab');
        assert(!document.querySelector('.juggler-context-menu'), 'Tab did not close the context menu');
        assert(document.activeElement === origin, 'focus did not go back to where it was');
      } finally {
        document.querySelector('.juggler-context-menu')?.remove();
        press(document.body, 'Escape');
        origin.remove();
      }
    });

    await run('an already visible surface is focused at once', async () => {
      const parts = build();
      try {
        press(document.body, 'ContextMenu');
        document.body.appendChild(parts.surface);
        attachMenuKeyboard(parts.menu, { close: () => parts.surface.remove() });
        assert(document.activeElement === parts.rows[0], 'a visible menu was not focused when attached');
      } finally {
        parts.surface.remove();
        parts.trigger.remove();
      }
    });
  } finally {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancelRaf;
    __resetPopupManagerForTests();
  }

  return { passed, failed, errors };
}
