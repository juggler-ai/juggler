//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Strategy-menu live-refresh test.
 *
 * The strategy selector caches the registry's strategy list at mount. When the
 * Extensions catalog enables/disables a strategy (or a plugin hot-reloads), the
 * registries are rebuilt and `REGISTRIES_RELOADED` is dispatched on `document`.
 * The selector must reload from the registry and re-render so its dropdown
 * reflects the new set — it must not show a stale list.
 *
 * Verified without touching server config (which the iframe pool shares): we
 * mutate the per-iframe strategy registry's in-memory `items` map directly and
 * restore it synchronously in a finally block.
 * @module unit-tests/strategy-menu-refresh-test
 */

import { assert, nextTask } from '../utilities/test-helpers.js';
import { isolateFocus } from '../utilities/isolate-focus.js';
import { assertMenuShape } from '../utilities/menu-assertions.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import { REGISTRIES_RELOADED } from '../../js/registries/reload-registries.js';
import { registerSettingsOpener } from '../../js/services/settings-launcher.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import StrategySwitcher from '../../js/services/strategy-switcher.js';
import '../../js/components/strategy-selector.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Resolves with the aggregated test result.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('open dropdown survives a re-render (thread change) without recreating its anchor button', async () => {
    if (!strategyRegistry.isInitialized()) await strategyRegistry.init();

    const manifests = strategyRegistry.getAllManifests();
    assert(manifests.length > 0, 'registry has at least one strategy');
    const idA = manifests[0].id;
    const idB = manifests[manifests.length > 1 ? 1 : 0].id;

    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    document.body.appendChild(selector);

    try {
      // Bind to thread A and render the open state. presentInlineMenu's rAF
      // would relocate the menu to <body>, mark it, and hand back a handle whose
      // `surface` is this instance's live dropdown; rAF is unreliable in the
      // hidden test window, so reproduce that end-state deterministically:
      // open → render the inner <nav> → move it to <body> with the marker
      // attribute → stand in for the handle, exactly as the production rAF does.
      selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: idA }));
      selector._dropdownOpen = true;
      selector.render();
      const innerNav = selector.querySelector('.strategy-dropdown');
      assert(!!innerNav, 'inner <nav> is rendered when opening');
      innerNav.setAttribute('data-strategy-selector', 'true');
      document.body.appendChild(innerNav);
      selector._menu = { surface: innerNav, close() {} };

      const buttonBefore = selector.querySelector('.strategy-selector-button');
      assert(!!buttonBefore, 'selector has an anchor button while open');

      // Conversation change: composer-box re-binds the selector to a new thread,
      // which re-renders WHILE the dropdown is open. This must NOT destroy the
      // anchor button — recreating it detaches the menu's positioning target,
      // sending the next reposition to the top-left corner (the "jumps to the
      // corner" symptom) and flashing the button — nor remove the menu.
      selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: idB }));

      const dropdownAfter = document.querySelector('.strategy-dropdown[data-strategy-selector="true"]');
      assert(!!dropdownAfter, 'menu is still present after the re-render (did not disappear)');
      assert(dropdownAfter === innerNav, 'the same menu element is preserved (not torn down and rebuilt)');

      const buttonAfter = selector.querySelector('.strategy-selector-button');
      assert(buttonAfter === buttonBefore,
        'the anchor button is the SAME element after the re-render (not recreated/flashed) so the menu stays anchored');

      assert(document.querySelectorAll('.strategy-dropdown[data-strategy-selector="true"]').length === 1,
        'exactly one menu surface exists (no duplicate inner <nav>)');

      // The in-place button update still reflects the new thread's strategy.
      const nameEl = buttonAfter.querySelector('.strategy-name');
      const expectedName = manifests.find(m => m.id === idB)?.manifest.name;
      assert(nameEl && nameEl.textContent === expectedName,
        `button label updated in place to "${expectedName}", got "${nameEl?.textContent}"`);
    } finally {
      // Remove the relocated menu (it lives on <body>, not under the selector)
      // then the selector itself.
      document.querySelectorAll('.strategy-dropdown[data-strategy-selector="true"]').forEach(el => el.remove());
      selector.remove();
    }
  });

  await run('strategy info opens its extension without selecting the strategy', async () => {
    if (!strategyRegistry.isInitialized()) await strategyRegistry.init();

    const manifest = strategyRegistry.getAllManifests()[0];
    assert(!!manifest, 'registry has at least one strategy');

    let selectionCount = 0;
    /** @type {Array<{tab?: string, options?: any}>} */
    const settingsCalls = [];
    const restoreOpener = registerSettingsOpener((tab, options) => {
      settingsCalls.push({ tab, options });
    });
    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    document.body.appendChild(selector);

    try {
      selector.setMessageThread(/** @type {any} */ ({
        currentStrategyId: manifest.id,
        setStrategy() { selectionCount++; },
      }));
      selector._dropdownOpen = true;
      selector.render();
      const dropdown = selector.querySelector('.strategy-dropdown');
      assert(!!dropdown, 'strategy dropdown is rendered');
      selector._menu = { surface: dropdown, close() { dropdown.remove(); } };

      const rows = dropdown.querySelectorAll('.strategy-item[data-strategy-id]');
      const infoButtons = dropdown.querySelectorAll('.strategy-info-button');
      assert(infoButtons.length === rows.length, 'every strategy has an info button');

      const infoButton = /** @type {HTMLButtonElement|null} */ (
        dropdown.querySelector(`[data-strategy-info-id="${manifest.id}"]`));
      assert(!!infoButton, 'the strategy has an info button');
      assert(!!infoButton.getAttribute('aria-label'), 'the info button has an accessible label');
      infoButton.click();

      assert(settingsCalls.length === 1, 'the info button opens Settings once');
      assert(settingsCalls[0].tab === 'extensions', 'Settings opens on Extensions');
      assert(settingsCalls[0].options?.capability?.itemType === 'strategy',
        'Settings reveals a strategy capability');
      assert(settingsCalls[0].options?.capability?.id === manifest.id,
        'Settings reveals the clicked strategy');
      assert(selectionCount === 0, 'clicking info does not select the strategy');
      assert(selector._dropdownOpen === false, 'clicking info closes the dropdown');
    } finally {
      restoreOpener();
      selector._menu?.surface?.remove();
      selector.remove();
    }
  });

  await run('the open dropdown is a menu of radio items, each with its details item beside it', async () => {
    if (!strategyRegistry.isInitialized()) await strategyRegistry.init();
    const manifests = strategyRegistry.getAllManifests();
    assert(manifests.length > 1, 'registry has at least two strategies');
    const idA = manifests[0].id;
    const idB = manifests[1].id;

    // presentInlineMenu relocates the menu in a frame; the hidden test window
    // may never paint, so frames run on macrotasks here.
    const realRaf = window.requestAnimationFrame;
    const realCancelRaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) =>
      /** @type {any} */ (setTimeout(() => cb(performance.now()), 0));
    window.cancelAnimationFrame = (/** @type {number} */ id) => clearTimeout(id);

    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    document.body.appendChild(selector);
    try {
      selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: idA }));
      const button = () => /** @type {HTMLElement} */ (selector.querySelector('.strategy-selector-button'));
      assert(button().getAttribute('aria-haspopup') === 'menu', 'the strategy button does not announce a menu');
      assert(button().getAttribute('aria-expanded') === 'false', 'the strategy button does not start collapsed');

      selector.toggleDropdown();
      await nextTask();
      await nextTask();
      const surface = selector._menu?.surface;
      const menu = assertMenuShape(surface, 'strategy menu');
      assert(button().getAttribute('aria-expanded') === 'true', 'the strategy button does not say its menu is open');

      /**
       * @param {string} id - A strategy id.
       * @returns {string|null|undefined} Its radio item's aria-checked.
       */
      const checkedOf = (id) => menu.querySelector(`[data-strategy-id="${id}"] [role="menuitemradio"]`)?.getAttribute('aria-checked');
      assert(checkedOf(idA) === 'true' && checkedOf(idB) === 'false',
        `only the current strategy is checked (A ${checkedOf(idA)}, B ${checkedOf(idB)})`);
      const radios = menu.querySelectorAll('[role="menuitemradio"]');
      const infos = menu.querySelectorAll('.strategy-info-button[role="menuitem"]');
      assert(radios.length === manifests.length && infos.length === manifests.length,
        `each strategy is one radio item plus one details item (${radios.length} radios, ${infos.length} details)`);
      assert(radios.length > 0 && Array.from(radios).every((r) => !r.querySelector('button')),
        'a radio item still contains a button');

      // A re-render while open keeps the menu a menu, and moves the check.
      selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: idB }));
      await Promise.resolve(); // the menu keyboard re-picks its tab stop from a MutationObserver
      assertMenuShape(surface, 'strategy menu after refresh');
      assert(checkedOf(idA) === 'false' && checkedOf(idB) === 'true', 'the check did not follow the thread change');

      selector.closeDropdown();
      assert(button().getAttribute('aria-expanded') === 'false', 'the strategy button still says open after closing');
    } finally {
      selector.closeDropdown();
      selector.remove();
      window.requestAnimationFrame = realRaf;
      window.cancelAnimationFrame = realCancelRaf;
    }
  });

  await run('a Shift+Tab gesture leaves focus in the composer, during and after', async () => {
    if (!strategyRegistry.isInitialized()) await strategyRegistry.init();
    assert(strategyRegistry.getAllManifests().length > 1, 'registry has at least two strategies');

    const realRaf = window.requestAnimationFrame;
    const realCancelRaf = window.cancelAnimationFrame;
    window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) =>
      /** @type {any} */ (setTimeout(() => cb(performance.now()), 0));
    window.cancelAnimationFrame = (/** @type {number} */ id) => clearTimeout(id);

    const textarea = document.createElement('textarea');
    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    document.body.append(selector, textarea);
    const switcher = new StrategySwitcher();
    // Resolution is covered elsewhere; this is about where focus goes.
    /** @type {any} */ (switcher)._resolveActiveSelector = () => selector;
    switcher.init();
    // Focus is window-wide: every lane is a frame of one window, so a sibling
    // lane's focus() during the frames below blurs this frame's element to
    // <body> — and the HUD reads document.activeElement when it opens and when
    // it closes, so a steal changes what the code under test does, not just
    // what an assertion sees. The case therefore keeps focus lane-local
    // (isolateFocus), starting in the composer.
    const focus = isolateFocus({ activeElement: textarea });
    /**
     * @param {string} type - 'keydown' or 'keyup'
     * @param {KeyboardEventInit} init - The key
     * @returns {boolean} False when the event was preventDefault-ed
     */
    const key = (type, init) => /** @type {Element} */ (document.activeElement)
      .dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
    /**
     * @returns {string} The focus() requests aimed anywhere but the composer.
     */
    const strayFocus = () => focus.requests.map((r) => r.element).filter((el) => el !== textarea)
      .map((el) => `${el.localName}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}`).join(', ');
    try {
      selector.setMessageThread(/** @type {any} */ ({
        currentStrategyId: strategyRegistry.getAllManifests()[0].id,
        setStrategy() {},
      }));

      key('keydown', { key: 'Tab', shiftKey: true });
      // What a sibling lane's focus() does to this frame — the composer's blur
      // included — taken on every run so the case is proven not to depend on
      // the window's real focus.
      focus.steal({ blurring: true });
      await nextTask();
      await nextTask();
      assert(!!selector._menu?.surface, 'the gesture did not open the strategy HUD');
      assert(strayFocus() === '', `the HUD took focus from the composer (focus() on ${strayFocus()})`);

      key('keydown', { key: 'Tab', shiftKey: true });
      key('keyup', { key: 'Shift' });
      assert(!selector._menu, 'releasing Shift did not close the HUD');
      assert(strayFocus() === '' && document.activeElement === textarea,
        `focus did not stay in the composer (focus() on ${strayFocus() || document.activeElement?.localName})`);
    } finally {
      focus.restore();
      switcher.destroy();
      selector.closeDropdown();
      selector.remove();
      textarea.remove();
      window.requestAnimationFrame = realRaf;
      window.cancelAnimationFrame = realCancelRaf;
    }
  });

  await run('strategy selector reloads its menu on REGISTRIES_RELOADED', async () => {
    if (!strategyRegistry.isInitialized()) await strategyRegistry.init();

    const selector = /** @type {any} */ (document.createElement('strategy-selector'));
    document.body.appendChild(selector); // connectedCallback → loadStrategies + listener

    // Snapshot the registry so we can restore it no matter what.
    const snapshot = new Map(strategyRegistry.items);
    try {
      const initialCount = selector._strategies.length;
      assert(initialCount > 0, 'selector loaded at least one strategy at mount');

      // Disable a strategy at the registry level (what a catalog toggle does).
      const removedId = [...strategyRegistry.items.keys()][0];
      strategyRegistry.items.delete(removedId);

      // Stale until notified.
      assert(selector._strategies.length === initialCount,
        'selector keeps its cached list until the reload event fires');

      document.dispatchEvent(new CustomEvent(REGISTRIES_RELOADED));

      assert(selector._strategies.length === initialCount - 1,
        'selector reloaded its menu after REGISTRIES_RELOADED');
      assert(!selector._strategies.some((/** @type {any} */ s) => s.id === removedId),
        'the disabled strategy is gone from the reloaded menu');
    } finally {
      strategyRegistry.items.clear();
      for (const [k, v] of snapshot) strategyRegistry.items.set(k, v);
      selector.remove(); // disconnectedCallback → removes the listener
    }
  });

  await run('a strategy\'s id, colour and icon cannot break out of the attributes they are drawn into', async () => {
    const realManifests = strategyRegistry.getAllManifests;
    const ID = 'test-esc-"><b class="esc-id-leak">1</b>';
    const COLOR = 'red" data-esc-color-leak="1';
    const ICON = 'esc-icon" data-esc-icon-leak="1';
    let selector = /** @type {any} */ (null);
    try {
      strategyRegistry.getAllManifests = /** @type {any} */ (() => [{
        id: ID,
        manifest: { name: 'N', description: 'D', color: COLOR, icon: ICON },
        modulePath: '(test)',
      }]);
      selector = /** @type {any} */ (document.createElement('strategy-selector'));
      document.body.appendChild(selector);
      selector.loadStrategies();
      selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: ID }));
      selector._dropdownOpen = true;
      selector.render();
      const leaks = ['.esc-id-leak', '[data-esc-color-leak]', '[data-esc-icon-leak]']
        .filter((sel) => selector.querySelector(sel));
      assert(leaks.length === 0, `manifest data became markup: ${JSON.stringify(leaks)}`);
      const row = /** @type {HTMLElement|null} */ (selector.querySelector('.strategy-item[data-strategy-id]'));
      assert(row?.dataset.strategyId === ID, `the row's id did not survive intact: ${JSON.stringify(row?.dataset.strategyId)}`);
      const info = /** @type {HTMLElement|null} */ (selector.querySelector('.strategy-info-button'));
      assert(info?.dataset.strategyInfoId === ID, `the info button's id did not survive intact: ${JSON.stringify(info?.dataset.strategyInfoId)}`);
      const iconClass = selector.querySelector('.strategy-item-icon')?.getAttribute('class');
      assert(iconClass === `strategy-item-icon ${ICON}`, `the icon class read ${JSON.stringify(iconClass)}`);
    } finally {
      strategyRegistry.getAllManifests = realManifests;
      selector?.remove();
    }
  });

  await run('every state the selector draws is translated under en-XA', async () => {
    const STRATEGY_EXT = 'test-i18n-strategies';
    const NAME = 'Careful Planner';
    const DESCRIPTION = 'Plans before it acts.';
    const realManifests = strategyRegistry.getAllManifests;
    const realExtensionId = strategyRegistry.getExtensionId;
    /** @type {any[]} */
    let stand = [];
    /** @type {Array<{where: string, text: string}>} */
    const said = [];
    /**
     * @param {string} where
     * @param {Element} root
     */
    const collect = (where, root) => {
      for (const text of shownStrings(root)) said.push({ where, text });
    };
    let selector = /** @type {any} */ (null);
    try {
      await underPseudoLocale('strategy-menu-refresh-test', async () => {
        strategyRegistry.getAllManifests = /** @type {any} */ (() => stand);
        strategyRegistry.getExtensionId = (id) => (id.startsWith('test-i18n-') ? STRATEGY_EXT : null);

        // ── no strategies: the chip has nothing to name, the menu is empty ──
        stand = [];
        selector = /** @type {any} */ (document.createElement('strategy-selector'));
        document.body.appendChild(selector);
        selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: 'test-i18n-gone' }));
        selector._dropdownOpen = true;
        selector.render();
        assert(!!selector.querySelector('.strategy-dropdown'), 'the empty menu must render');
        collect('empty', selector);
        selector._dropdownOpen = false;

        // ── two strategies, one selected, menu open ──
        stand = [1, 2].map((n) => ({
          id: `test-i18n-${n}`,
          manifest: { name: NAME, description: DESCRIPTION },
          modulePath: '(test)',
          extensionId: STRATEGY_EXT,
        }));
        selector.loadStrategies();
        selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: 'test-i18n-1' }));
        selector._dropdownOpen = true;
        selector.render();
        assert(selector.querySelectorAll('.strategy-item[data-strategy-id]').length === 2, 'both stand-ins must be listed');
        collect('open', selector);

        // ── the selected strategy is no longer registered ──
        selector._dropdownOpen = false;
        selector.setMessageThread(/** @type {any} */ ({ currentStrategyId: 'test-i18n-gone' }));
        selector.render();
        collect('missing', selector);
      }, { [STRATEGY_EXT]: [NAME, DESCRIPTION] });
    } finally {
      strategyRegistry.getAllManifests = realManifests;
      strategyRegistry.getExtensionId = realExtensionId;
      selector?.remove();
    }

    assert(said.length >= 10, `the selector drew too little: ${JSON.stringify(said)}`);
    const raw = said.filter(({ text }) => !isPseudoLocalized(text));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
  });

  return { passed, failed, errors };
}
