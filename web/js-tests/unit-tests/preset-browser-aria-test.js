//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * ARIA semantics of the system-prompt item's preset browser.
 *
 *   1. The preset dropdown is a named menu. Each preset is a radio item, checked
 *      when it is the one this conversation is on; its "Set default" control is
 *      an item of its own beside it, never nested inside it; the category
 *      captions carry no role, the separator is a separator, and the footer
 *      actions are plain items.
 *   2. The trigger announces the menu and says whether it is open.
 *   3. The manage-presets popup, opened from the menu, is a named dialog: its
 *      rows hold Edit and Delete buttons, which a menu could not.
 *   4. Under en-XA, everything the browser shows — menu, dialogs, notices — is
 *      translated; preset names are data.
 * @module unit-tests/preset-browser-aria-test
 */

import { assert, waitFor, withTimeout } from '../utilities/test-helpers.js';
import { assertMenuShape } from '../utilities/menu-assertions.js';
import { closeAllPopups, __resetPopupManagerForTests } from '../../js/utils/popup-manager.js';
import { systemPromptRegistry } from '../../sdk/lib/system-prompt-registry.js';
import { showPresetBrowser } from '../../extensions/juggler-core/context-items/system-prompt/preset-browser.js';
import { ensureUserPresetsLoaded, getDefaultPresetId } from '../../js/services/system-prompt-presets.js';
import apiService from '../../js/services/api.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * A stand-in for the system-prompt context item: the fields the browser reads.
 * @param {string} selectedPresetId - The preset this conversation is on.
 * @returns {any} The stub item.
 */
function stubItem(selectedPresetId) {
  return {
    data: { text: '', selectedPresetId, isModified: false },
    _dropdownRelease: null,
    _persistData() {},
    _getEffectiveText() { return this.data.text; },
  };
}

/**
 * Run the preset browser ARIA suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  __resetPopupManagerForTests();
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:400px;';
  container.innerHTML = '<button class="system-prompt-preset-btn" aria-haspopup="menu" aria-expanded="false">Select a preset</button>';
  document.body.appendChild(container);
  const button = /** @type {HTMLElement} */ (container.querySelector('.system-prompt-preset-btn'));

  const presets = systemPromptRegistry.getCategories().flatMap((c) => systemPromptRegistry.getPresetsByCategory(c));
  const selected = presets[0];
  const item = stubItem(selected?.id ?? '');

  try {
    assert(presets.length > 1, `expected several built-in presets, got ${presets.length}`);
    await showPresetBrowser(item, button, container);
    const surface = document.querySelector('.system-prompt-preset-dropdown');
    const menu = assertMenuShape(surface, 'preset dropdown');
    assert(button.getAttribute('aria-expanded') === 'true', 'the preset button does not say its menu is open');

    const radios = /** @type {HTMLElement[]} */ (Array.from(menu.querySelectorAll('[role="menuitemradio"]')));
    assert(radios.length === presets.length, `expected a radio item per preset (${presets.length}), got ${radios.length}`);
    const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true');
    assert(checked.length === 1 && (checked[0].getAttribute('aria-label') || checked[0].textContent || '').includes(selected.name),
      `exactly the conversation's preset is checked, got ${JSON.stringify(checked.map((r) => r.textContent))}`);
    assert(radios.every((r) => !r.querySelector('button')), 'a radio item contains a button');
    const setDefault = menu.querySelectorAll('.sp-preset-setdefault-btn');
    assert(setDefault.length > 0 && Array.from(setDefault).every((b) => b.getAttribute('role') === 'menuitem' && !!b.getAttribute('aria-label')),
      'a "Set default" control is not a labelled item of its own');
    const actions = menu.querySelectorAll('.sp-preset-action');
    assert(actions.length === 2 && Array.from(actions).every((a) => a.getAttribute('role') === 'menuitem'),
      'the footer actions are not items');

    // The manage popup is reached from the menu and replaces it.
    const manage = /** @type {HTMLElement} */ (Array.from(actions).find((a) => (a.textContent || '').includes('Manage')));
    manage.click();
    const dialog = document.querySelector('.system-prompt-manage-dropdown');
    assert(!!dialog && dialog.getAttribute('role') === 'dialog' && !!dialog.getAttribute('aria-label'),
      `the manage popup is not a named dialog (role ${JSON.stringify(dialog?.getAttribute('role'))})`);
    closeAllPopups();
    assert(!document.querySelector('.system-prompt-manage-dropdown'), 'the manage popup did not close');
    assert(button.getAttribute('aria-expanded') === 'false', 'the preset button still says open after closing');
    passed++;
  } catch (e) {
    failed++;
    errors.push('preset-browser: ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    closeAllPopups();
    container.remove();
    __resetPopupManagerForTests();
  }

  try {
    await enXACase();
    passed++;
  } catch (e) {
    failed++;
    errors.push('en-XA: ' + (e instanceof Error ? e.message : String(e)));
  }

  return { passed, failed, errors };
}

/** juggler-core's English for the preset browser, standing in for its catalogue. */
const CORE_TEXT = [
  'System prompt presets', 'General', 'Specialized', 'User',
  'Save current text as preset…', 'Manage presets…',
  '{name} (default)', 'default', 'Set {name} as the default', 'Set default',
  'Make "{name}" the default for new conversations',
  '"{name}" is already a preset.', 'Update', 'Save as new…', 'Cancel', 'Save preset',
  'Name this preset:', 'Save system prompt preset',
  "{verb, select, update {Couldn't update preset} other {Couldn't save preset}}", 'OK',
  "Couldn't delete preset", "Couldn't set default preset",
  'Manage presets', 'Your presets', 'No saved presets yet.', 'Edit', 'Delete',
  'Delete preset "{name}"? This cannot be undone.', 'Delete preset',
];

/**
 * Every state the browser draws, under en-XA: the menu (category captions, the
 * default row's name and badge, "Set default", the footer actions), the
 * save-current dialogs down both the update and save-as-new paths with their
 * failure notices, the manage dialog with a preset and empty, and the delete
 * confirmation. Preset names are digits (data); the registry and the preset
 * writes are stubbed, and the dialogs captured rather than shown.
 * @returns {Promise<void>}
 */
async function enXACase() {
  await ensureUserPresetsLoaded();
  const defaultId = getDefaultPresetId();
  /** @type {any[]} */
  let presets = [
    { id: defaultId, name: '1', content: '1', category: 'general' },
    { id: 'x-2', name: '2', content: '2', category: 'specialized' },
    { id: 'user-3', name: '3', content: '3', category: 'user' },
  ];
  const reg = /** @type {any} */ (systemPromptRegistry);
  const savedReg = { getCategories: reg.getCategories, getPresetsByCategory: reg.getPresetsByCategory, getPreset: reg.getPreset };
  reg.getCategories = () => ['general', 'specialized', 'user'];
  reg.getPresetsByCategory = (/** @type {string} */ c) => presets.filter((p) => p.category === c);
  reg.getPreset = (/** @type {string} */ id) => presets.find((p) => p.id === id);
  const api = /** @type {any} */ (apiService);
  const savedApi = {
    update: api.updateSystemPromptPreset, save: api.saveSystemPromptPreset,
    remove: api.deleteSystemPromptPreset, setDefault: api.setDefaultSystemPromptPreset,
  };
  api.updateSystemPromptPreset = async () => ({ success: false, error: '9' });
  api.saveSystemPromptPreset = async () => ({ success: false, error: '9' });
  api.deleteSystemPromptPreset = async () => ({ success: false, error: '9' });
  api.setDefaultSystemPromptPreset = async () => ({ success: false, error: '9' });
  const w = /** @type {any} */ (window);
  const savedDialogs = { showChoice: w.showChoice, showPrompt: w.showPrompt, showConfirm: w.showConfirm };
  /** @type {(kind: string, args: any[]) => any} */
  let reply = () => null;
  /** @type {(kind: string) => void} */
  let notify = () => {};
  /** @type {Array<{kind: string, args: any[]}>} */
  const dialogs = [];
  for (const kind of Object.keys(savedDialogs)) {
    w[kind] = async (/** @type {any[]} */ ...args) => {
      dialogs.push({ kind, args });
      const r = reply(kind, args);
      notify(kind);
      return r;
    };
  }
  /**
   * Resolve once the named dialog is next asked for; fail if it never is.
   * @param {string} kind
   * @returns {Promise<void>}
   */
  const nextShown = (kind) => withTimeout(new Promise((resolve) => {
    notify = (k) => { if (k === kind) resolve(undefined); };
  }), 10000, `${kind} was never shown`);

  __resetPopupManagerForTests();
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:400px;';
  container.innerHTML = '<button class="system-prompt-preset-btn" aria-haspopup="menu" aria-expanded="false">1</button>';
  document.body.appendChild(container);
  const button = /** @type {HTMLElement} */ (container.querySelector('.system-prompt-preset-btn'));

  try {
    await underPseudoLocale('preset-browser-aria-test', async () => {
      /** @type {string[]} */
      const shown = [];
      const radios = '[role="menuitemradio"]';
      const names = '.sp-preset-static .sp-preset-row-name';

      // The menu, on a user preset so the save flow offers "Update".
      const item = stubItem('user-3');
      item.data.text = '4';
      await showPresetBrowser(item, button, container);
      const dropdown = /** @type {HTMLElement} */ (document.querySelector('.system-prompt-preset-dropdown'));
      assert(!!dropdown, 'the preset dropdown did not open');
      shown.push(...shownStrings(dropdown, radios));
      const defaultRow = dropdown.querySelector(`${radios}[aria-label]`);
      assert(!!defaultRow, 'the default preset row has no aria-label');
      shown.push(String(defaultRow?.getAttribute('aria-label')));
      assert(!!dropdown.querySelector('.sp-preset-default-badge'), 'no default badge drawn');
      assert(!!dropdown.querySelector('.sp-preset-setdefault-btn'), 'no "Set default" button drawn');
      const actions = /** @type {HTMLElement[]} */ (Array.from(dropdown.querySelectorAll('.sp-preset-action')));
      assert(actions.length === 2, `expected two footer actions, got ${actions.length}`);

      // Set default → it fails, and says so.
      reply = () => true;
      let seen = nextShown('showConfirm');
      /** @type {HTMLElement} */ (dropdown.querySelector('.sp-preset-setdefault-btn')).click();
      await seen;

      // Save → Update → the update fails.
      reply = (kind, args) => (kind === 'showChoice' ? args[1][0] : true);
      seen = nextShown('showConfirm');
      actions[0].click();
      await seen;
      // Save → Save as new → named → the save fails.
      reply = (kind, args) => (kind === 'showChoice' ? args[1][1] : kind === 'showPrompt' ? '5' : true);
      seen = nextShown('showConfirm');
      /** @type {HTMLElement} */ (document.querySelectorAll('.system-prompt-preset-dropdown .sp-preset-action')[0]).click();
      await seen;

      // Manage, with a preset, then its delete confirmation (declined).
      /** @type {HTMLElement} */ (document.querySelectorAll('.system-prompt-preset-dropdown .sp-preset-action')[1]).click();
      const manage = /** @type {HTMLElement} */ (document.querySelector('.system-prompt-manage-dropdown'));
      assert(!!manage, 'the manage dialog did not open');
      shown.push(...shownStrings(manage, names));
      assert(!!manage.querySelector(names), 'the manage dialog lists no preset');
      reply = () => false;
      seen = nextShown('showConfirm');
      /** @type {HTMLElement} */ (manage.querySelector('.sp-preset-delete-btn')).click();
      await seen;
      // The delete confirmed → it fails, and says so: a second notice after the confirmation.
      reply = () => true;
      const before = dialogs.length;
      /** @type {HTMLElement} */ (manage.querySelector('.sp-preset-delete-btn')).click();
      await waitFor(() => dialogs.length >= before + 2,
        () => `a second notice after the delete confirmation (${dialogs.slice(before).map((d) => d.kind).join(',')})`, 3000);
      assert(dialogs.length === before + 2 && dialogs[before + 1].args[0] === '9',
        `a failed delete said nothing (${dialogs.slice(before).map((d) => d.kind).join(',')})`);
      closeAllPopups();

      // Manage, empty.
      presets = presets.filter((p) => p.category !== 'user');
      const empty = stubItem('x-2');
      await showPresetBrowser(empty, button, container);
      /** @type {HTMLElement} */ (document.querySelectorAll('.system-prompt-preset-dropdown .sp-preset-action')[1]).click();
      const emptyManage = /** @type {HTMLElement} */ (document.querySelector('.system-prompt-manage-dropdown'));
      assert(!!emptyManage?.querySelector('.sp-preset-empty'), 'the empty manage dialog shows no empty state');
      shown.push(...shownStrings(emptyManage));
      closeAllPopups();

      const kinds = dialogs.map((d) => d.kind).join(',');
      assert(kinds === 'showConfirm,showChoice,showConfirm,showChoice,showPrompt,showConfirm,showConfirm,showConfirm,showConfirm',
        `unexpected dialog sequence: ${kinds}`);
      for (const { kind, args } of dialogs) {
        if (kind === 'showChoice') shown.push(args[0], ...args[1], args[2]);
        if (kind === 'showPrompt') shown.push(args[0], args[2]);
        if (kind === 'showConfirm') {
          // A failure notice's body is the provider's error (data, '9').
          if (args[0] !== '9') shown.push(args[0]);
          shown.push(args[1], ...Object.values(args[2] || {}).filter((v) => typeof v === 'string'));
        }
      }

      const raw = shown.filter((s) => !isPseudoLocalized(String(s)));
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
    }, { '@juggler/core': CORE_TEXT });
  } finally {
    closeAllPopups();
    container.remove();
    __resetPopupManagerForTests();
    Object.assign(reg, savedReg);
    api.updateSystemPromptPreset = savedApi.update;
    api.saveSystemPromptPreset = savedApi.save;
    api.deleteSystemPromptPreset = savedApi.remove;
    api.setDefaultSystemPromptPreset = savedApi.setDefault;
    Object.assign(w, savedDialogs);
  }
}
