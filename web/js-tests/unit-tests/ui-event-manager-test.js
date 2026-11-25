//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for the text `UIEventManager` (`js/services/ui-event-manager.js`)
 * puts on screen: the header theme, bell and tool-grouping buttons' tooltips,
 * the "…" overflow menu's rows, the add-context-item menu (its `AI assistant
 * files` row, a capability's manifest name, the menu's own name) and the
 * notice adding the assistant files raises — all in the UI language.
 *
 * The header buttons are stand-ins wearing the real ids; the session, the
 * context-item registry and the shortcut formatter are stubbed, so no pref,
 * server state or conversation is touched.
 * @module unit-tests/ui-event-manager-test
 */

import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import * as uiEventManagerModule from '../../js/services/ui-event-manager.js';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import keyShortcutManager from '../../js/services/key-shortcut-manager.js';
import { isToolGroupingEnabled } from '../../js/utils/tool-grouping-pref.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

const UIEventManager = uiEventManagerModule.default;

const EXT = '@test/ui-event-manager';
const NAME = 'Stand In Addable';
const ID = 'stand-in-addable';

/**
 * Run the ui-event-manager test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('header tooltips, menus and notices follow the UI language under en-XA', async () => {
    const root = document.documentElement;
    const theme = root.getAttribute('data-theme');
    const original = {
      getIds: contextItemRegistry.getIds,
      get: contextItemRegistry.get,
      getExtensionId: contextItemRegistry.getExtensionId,
      formatBinding: keyShortcutManager.formatBinding,
    };
    class Addable {
      static MANIFEST = { id: ID, name: NAME, version: '1.0.0', userAddable: true };
    }
    contextItemRegistry.getIds = () => [ID];
    contextItemRegistry.get = /** @type {any} */ ((/** @type {string} */ id) => (id === ID ? Addable : original.get.call(contextItemRegistry, id)));
    contextItemRegistry.getExtensionId = (id) => (id === ID ? EXT : original.getExtensionId.call(contextItemRegistry, id));
    // A key cap is ASCII letters; with no binding the row draws only its label.
    keyShortcutManager.formatBinding = () => '';

    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-9999px;top:0;';
    host.innerHTML = `
      <button id="theme-button"><svg viewBox="0 -960 960 960"><path></path></svg></button>
      <button id="bell-button"></button>
      <button id="tool-grouping-button"></button>
      <button id="header-overflow-button"></button>
      <button class="stand-in-add" style="width:20px;height:20px"></button>`;
    document.body.appendChild(host);
    const manager = /** @type {any} */ (
      new UIEventManager({ onSendMessage: () => {}, onContextItemAction: async () => {} })
    );
    let assistantFiles = 0;
    manager.setSession({
      getVisibleConversation: () => ({ awaitingSetup: false, rootMessageThread: {} }),
      seedConversationAutoItems: async () => ({ assistantFiles }),
    });

    /** @type {Array<[string, string]>} */
    const shown = [];
    /**
     * @param {string} where
     * @param {string[]} strings
     */
    const collect = (where, strings) => {
      assert(strings.length > 0, `${where}: drew nothing`);
      for (const s of strings) shown.push([where, s]);
    };

    try {
      await underPseudoLocale('ui-event-manager-test', async () => {
        // The theme button, in each painted theme.
        manager._setupThemeButton();
        const themeButton = /** @type {HTMLElement} */ (host.querySelector('#theme-button'));
        for (const painted of ['light', 'dark']) {
          root.setAttribute('data-theme', painted);
          manager._renderThemeButton(themeButton);
          collect(`theme button, ${painted}`, [themeButton.title, themeButton.getAttribute('aria-label') || '']);
        }

        // The bell and tool-grouping buttons, in the state the pref holds.
        manager._setupBellButton();
        manager._setupToolGroupingButton();
        collect('bell button', [host.querySelector('#bell-button')?.getAttribute('title') || '']);
        collect(`tool-grouping button, ${isToolGroupingEnabled() ? 'on' : 'off'}`,
          [host.querySelector('#tool-grouping-button')?.getAttribute('title') || '']);
        // Both of its tooltips, without flipping the real pref.
        const groupingTitle = /** @type {any} */ (uiEventManagerModule).toolGroupingTitle;
        if (typeof groupingTitle === 'function') {
          collect('tool-grouping title, on', [groupingTitle(true)]);
          collect('tool-grouping title, off', [groupingTitle(false)]);
        } else {
          shown.push(['tool-grouping title', 'toolGroupingTitle is not exported']);
        }

        // The "…" overflow menu, which has rows of its own only where it is
        // the app menu: in a Windows or Linux desktop window.
        const { windowMode, windowPlatform } = root.dataset;
        root.dataset.windowMode = '1';
        root.dataset.windowPlatform = 'windows';
        try {
          manager._setupOverflowButton();
        } finally {
          if (windowMode === undefined) delete root.dataset.windowMode; else root.dataset.windowMode = windowMode;
          if (windowPlatform === undefined) delete root.dataset.windowPlatform; else root.dataset.windowPlatform = windowPlatform;
        }
        const overflowButton = /** @type {HTMLElement} */ (host.querySelector('#header-overflow-button'));
        overflowButton.click();
        const overflow = /** @type {HTMLElement} */ (document.querySelector('.header-overflow-menu'));
        assert(!!overflow, 'the overflow menu did not open');
        collect('overflow menu', shownStrings(overflow));
        overflowButton.click();

        // The add-context-item menu.
        const addButton = /** @type {HTMLElement} */ (host.querySelector('.stand-in-add'));
        await manager._handleContextItemAddRequested({ button: addButton, threadItemId: null });
        const dropdown = /** @type {HTMLElement} */ (document.querySelector('.context-item-add-dropdown'));
        assert(!!dropdown, 'the add-context-item menu did not open');
        assert(dropdown.querySelectorAll('.menu-item').length === 2, 'expected the AI-files row and one capability row');
        collect('add-context-item menu', shownStrings(dropdown));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.querySelector('.context-item-add-dropdown')?.remove();

        // The notice adding the assistant files raises: none, and several.
        for (const count of [0, 3]) {
          assistantFiles = count;
          await manager._addAIAssistantFiles(null);
          const notices = document.querySelectorAll('modal-dialog.is-notice');
          const notice = /** @type {any} */ (notices[notices.length - 1]);
          assert(!!notice, `no notice for ${count} files`);
          collect(`notice, ${count} files`, [notice.querySelector('.modal-message')?.textContent || '']);
          notice.close(null);
        }
      }, { [EXT]: [NAME] });
    } finally {
      manager.destroy();
      host.remove();
      if (theme === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
      contextItemRegistry.getIds = original.getIds;
      contextItemRegistry.get = original.get;
      contextItemRegistry.getExtensionId = original.getExtensionId;
      keyShortcutManager.formatBinding = original.formatBinding;
    }

    const raw = shown.filter(([, s]) => !isPseudoLocalized(s));
    assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    const added = shown.find(([where]) => where === 'notice, 3 files');
    assert(!!added && added[1].includes('3'), `the added count must be in the notice, got ${JSON.stringify(added)}`);
  });

  return { passed, failed, errors };
}
