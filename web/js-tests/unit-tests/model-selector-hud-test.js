//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Model-selector cycling HUD behavior regressions, plus the list rules the HUD
 * is a view of. The rows live in `<model-picker>`; the freeze/refresh mechanics
 * live in the `<model-selector>` host that presents it.
 *
 * The same picker has two ways in that must not be confused: ⌥⌘M shows it as a
 * HUD for the length of a hold, and ⇧⌥⌘M opens it and leaves it open. One Shift
 * apart, so the last case here presses the second chord with the first one's
 * cycler live.
 * @module unit-tests/model-selector-hud-test
 */

import { assert } from '../utilities/test-helpers.js';
import { assertDialogPopover } from '../utilities/menu-assertions.js';
import recentModels from '../../js/services/recent-models.js';
import keyShortcutManager from '../../js/services/key-shortcut-manager.js';
import { registerConversationShortcuts } from '../../js/components/shortcut-bindings.js';
import { ModelCycler } from '../../js/services/model-cycler.js';
import providersCache from '../../js/services/providers-cache.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import '../../js/components/model-selector.js';
import '../../js/components/model-picker/model-picker.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Failure messages.
 */

/**
 * The provider list both the selector and the standalone pickers are given.
 * @returns {any[]} A fresh provider list.
 */
const PROVIDERS = () => [{
  name: 'p',
  displayName: 'Provider',
  available: true,
  modelsWithContext: [
    { id: 'm', displayName: 'Model', contextWindow: 1000, thinkingLevels: ['low', 'high'] },
    { id: 'other', displayName: 'Other', contextWindow: 1000 },
  ],
}];

/**
 * Seed the recent-model cache without depending on the server.
 * @param {any[]} models
 * @returns {Promise<void>}
 */
async function seedRecents(models) {
  const originalFetch = window.fetch;
  window.fetch = /** @type {any} */ (async () => ({ ok: true, json: async () => ({ models }) }));
  try {
    await recentModels.refresh();
  } finally {
    window.fetch = originalFetch;
  }
}

/**
 * Create a connected selector with network/background refresh work disabled.
 * @returns {any} Connected model selector.
 */
function makeSelector() {
  const el = /** @type {any} */ (document.createElement('model-selector'));
  el.fetchProviders = async () => {};
  el._refreshProvidersInBackground = () => {};
  el.providers = PROVIDERS();
  document.body.appendChild(el);
  return el;
}

/**
 * Build a detached, rendered `<model-picker>` — the same element the selector
 * presents, driven directly so the list rules can be asserted without a popup.
 * @param {object} opts - Scenario knobs.
 * @param {any[]} [opts.providers] - Provider list; defaults to the shared one.
 * @param {any} [opts.value] - The config in effect.
 * @param {string} [opts.noneLabel] - Label for the bottom row.
 * @returns {any} The rendered picker.
 */
function makePicker({ providers, value, noneLabel } = {}) {
  const el = /** @type {any} */ (document.createElement('model-picker'));
  el.providers = providers || PROVIDERS();
  el.value = value || null;
  if (noneLabel) el.noneLabel = noneLabel;
  el.render();
  return el;
}

/**
 * @param {object} _ctx
 * @returns {Promise<TestResult>} Aggregated test results.
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

  await run('Recent highlights the exact current model-and-thinking pair', async () => {
    await seedRecents([
      { provider: 'p', model: 'm' },
      { provider: 'p', model: 'm', thinking: 'high' },
      { provider: 'p', model: 'other' },
    ]);
    const picker = makePicker({ value: { provider: 'p', model: 'm', thinking: 'high' } });
    const rows = picker.querySelectorAll('.recent-model');
    assert(rows.length === 3, `expected three Recent rows, got ${rows.length}`);
    assert(!rows[0].classList.contains('active'), 'same model at Default must not highlight');
    assert(rows[1].classList.contains('active'), 'the exact high-thinking pair must highlight');
    assert(!rows[2].classList.contains('active'), 'a different model must not highlight');
  });

  await run('Recent hides entries that are not selectable', async () => {
    await seedRecents([
      { provider: 'missing', model: 'ghost' },
      { provider: 'p', model: 'removed' },
      { provider: 'p', model: 'm' },
    ]);
    const picker = makePicker();
    const rows = picker.querySelectorAll('.recent-model');
    assert(rows.length === 1, `expected one selectable Recent row, got ${rows.length}`);
    assert(rows[0].getAttribute('data-provider') === 'p'
      && rows[0].getAttribute('data-model') === 'm',
    'Recent must contain only a model present on an available provider');
  });

  await run('synchronous model observers preserve the open HUD and anchor', async () => {
    await seedRecents([]);
    const el = makeSelector();
    try {
      el._currentConfig = { provider: 'p', model: 'm' };
      el.provider = 'p';
      el.model = 'm';
      const thread = {
        _modelConfig: el._currentConfig,
        get modelConfig() { return this._modelConfig; },
        set modelConfig(next) {
          this._modelConfig = next;
          // Reproduce the real reactive delivery: the model-config observer
          // synchronously re-syncs the selector during applyConfigPair's write.
          el._syncModelDisplay();
        },
      };
      el._messageThread = thread;
      el.render();
      el.open();

      const surface = el._picker;
      const anchor = el.querySelector('.model-selector-button');
      assert(!!surface, 'opening creates a live model picker');
      assert(!!anchor && anchor.isConnected, 'the picker anchor starts connected');
      assert(surface.parentElement === document.body, 'the live picker is hosted by document.body');
      assertDialogPopover(surface, anchor, 'model picker');

      assert(el.applyConfigPair({ provider: 'p', model: 'other' }), 'the next model applies');

      const surfaces = document.querySelectorAll('.model-picker');
      assert(surfaces.length === 1, `exactly one model picker remains, got ${surfaces.length}`);
      assert(surfaces[0] === surface && el._picker === surface,
        'the original live picker remains the presented surface');
      assert(anchor.isConnected && el.querySelector('.model-selector-button') === anchor,
        'the original anchor remains connected');
      assert(!el.querySelector('.model-picker'), 'no duplicate picker is left inside the selector');
      assert(!!surface.querySelector('.model-selection-item.active[data-model="other"]'),
        'the live picker highlights the newly selected model');
      assert(anchor.textContent.includes('Other'), 'the anchor label updates in place');
      el.close();
      assert(anchor.getAttribute('aria-expanded') === 'false', 'the model button still says open after closing');
    } finally {
      el.close();
      el.remove();
    }
  });

  await run('reopening never leaves a second picker behind', async () => {
    await seedRecents([]);
    const el = makeSelector();
    try {
      el.open();
      el.close();
      el.open();
      const surfaces = document.querySelectorAll('.model-picker');
      assert(surfaces.length === 1, `exactly one model picker may exist, got ${surfaces.length}`);
      assert(el._picker === surfaces[0], 'the live surface belongs to the current opening');
    } finally {
      el.close();
      el.remove();
      document.querySelectorAll('.model-picker').forEach(node => node.remove());
    }
  });

  await run('the open picker says a change reaches the turn already running', async () => {
    await seedRecents([]);
    const el = makeSelector();
    try {
      el.conversation = { isTurnActive: () => true, setModelConfig: () => {} };
      el.open();
      const note = el._picker?.querySelector('.model-picker-note');
      assert(!!note && !note.hidden, 'a running turn must be acknowledged in the picker');
      assert((note.textContent || '').includes('next request'),
        `the note must say when the change takes effect, got ${JSON.stringify(note.textContent)}`);
    } finally {
      el.close();
      el.remove();
    }
  });

  await run('an idle conversation gets no note', async () => {
    await seedRecents([]);
    const el = makeSelector();
    try {
      el.conversation = { isTurnActive: () => false, setModelConfig: () => {} };
      el.open();
      const note = el._picker?.querySelector('.model-picker-note');
      assert(!note || note.hidden, 'an idle picker must not carry a turn note');
    } finally {
      el.close();
      el.remove();
    }
  });

  await run('a busy sub-thread is judged on its own turn, not the conversation', async () => {
    await seedRecents([]);
    const el = makeSelector();
    try {
      el.conversation = { isTurnActive: () => false, setModelConfig: () => {} };
      el._messageThread = { isProcessing: true, modelConfig: null };
      el.open();
      const note = el._picker?.querySelector('.model-picker-note');
      assert(!!note && !note.hidden, 'the bound thread is the scope the write lands in');
    } finally {
      el.close();
      el.remove();
    }
  });

  await run('hidden models are kept out of the model list', async () => {
    await seedRecents([]);
    const providers = PROVIDERS();
    providers[0].modelsWithContext[1].hidden = true;
    const picker = makePicker({ providers, value: { provider: 'p', model: 'm' } });
    const rows = [...picker.querySelectorAll('.model-selection-item')]
      .map(r => (r.textContent || '').trim());
    assert(rows.some(t => t.includes('Model')), 'the visible model is still offered');
    assert(!rows.some(t => t.includes('Other')), 'the hidden model must not be offered');
  });

  await run('the model in use stays listed even when hidden, and says so', async () => {
    // Hiding the model a conversation is already on must not strip its label:
    // the picker would then read "No model" for something plainly running.
    await seedRecents([]);
    const providers = PROVIDERS();
    providers[0].modelsWithContext[0].hidden = true;
    const picker = makePicker({ providers, value: { provider: 'p', model: 'm' } });
    const current = [...picker.querySelectorAll('.model-selection-item')]
      .find(r => (r.textContent || '').includes('Model'));
    assert(!!current, 'the in-use model must still be listed');
    const note = current?.querySelector('.menu-item-note');
    assert((note?.textContent || '') === 'hidden', 'it is marked "hidden"');
  });

  await run('a provider whose every model is hidden drops out of the menu', async () => {
    await seedRecents([]);
    const providers = PROVIDERS();
    for (const m of providers[0].modelsWithContext) m.hidden = true;
    const picker = makePicker({ providers });
    assert(!picker.querySelector('.provider-menu-header'),
      'a provider with nothing left to offer must not render a header');
  });

  await run('⇧⌥⌘M opens the picker from a text field and leaves it open', async () => {
    await seedRecents([]);
    // A bare textarea, not a real `composer-box`: that element is defined by the
    // time this suite runs and would render its own contents over the fixture.
    // What is being asserted here is the press, so the field only has to be a
    // field — the shortcut resolves the one selector in the document.
    const box = document.createElement('div');
    const area = document.createElement('textarea');
    box.appendChild(area);
    document.body.appendChild(box);
    const el = makeSelector();
    box.appendChild(el);
    assert(document.querySelectorAll('model-selector').length === 1,
      'exactly one selector, so there is no doubt which one the chord acted on');
    // The model cycler owns the un-Shifted twin of this chord, on a capture
    // listener of its own that runs ahead of the command table — so it has to be
    // live for the press to prove the two chords are actually apart.
    const cycler = new ModelCycler();
    cycler.init();
    // The manager is a singleton that outlives this suite in the lane's realm,
    // so put back exactly the handlers that were there before.
    const before = new Set(keyShortcutManager._handlers.keys());
    registerConversationShortcuts(/** @type {any} */ ({}));
    try {
      area.focus();
      assert(document.activeElement === area,
        'a text field holds focus for the press — the shortcut is allowInInput'
        + ` — active is <${document.activeElement?.nodeName.toLowerCase()}>`);
      area.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'm', code: 'KeyM', metaKey: true, ctrlKey: true, altKey: true, shiftKey: true,
        bubbles: true, cancelable: true,
      }));
      assert(el.dropdownOpen === true, 'the chord opens the picker from inside a text field');
      assert(!!el._picker, 'a live picker is presented');
      // Releasing the modifiers is what dismisses the CYCLING HUD. This is the
      // other door: nothing about letting go of the keys closes it.
      for (const key of ['Shift', 'Alt', 'Meta', 'Control']) {
        document.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
      }
      assert(el.dropdownOpen === true, 'letting go of the keys must leave it open');
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }));
      assert(el.dropdownOpen === false, 'Escape is the way out');
    } finally {
      for (const id of [...keyShortcutManager._handlers.keys()]) {
        if (!before.has(id)) keyShortcutManager._handlers.delete(id);
      }
      cycler.destroy();
      el.close();
      box.remove();
      document.querySelectorAll('.model-picker').forEach(node => node.remove());
    }
  });

  // Every word the selector itself hands to the chip, the picker and the
  // selection dialogs, under en-XA. The chip and picker draw host text as given,
  // so the host must pass it translated. Model, provider and hint values are
  // data (digits here); the cycle key is stubbed to a digit — a real key cap
  // carries ASCII letters. The picker's own chrome belongs to its own slice, so
  // its inputs are read from the properties the selector set.
  await run('en-XA: every string the selector hands on is translated', async () => {
    /**
     * Put a stubbed method back exactly as it was: an own property restored, an
     * inherited one uncovered.
     * @param {any} obj - The singleton.
     * @param {string} key - The method's name.
     * @returns {() => void} The restorer.
     */
    const saveMethod = (obj, key) => {
      const own = Object.prototype.hasOwnProperty.call(obj, key);
      const original = obj[key];
      return () => {
        if (own) obj[key] = original;
        else delete obj[key];
      };
    };
    const restorers = [
      saveMethod(keyShortcutManager, 'formatBinding'),
      saveMethod(providersCache, 'refresh'),
      saveMethod(recentModels, 'refresh'),
    ];
    const originalShowModal = /** @type {any} */ (window).showModal;
    /** @type {any} */
    let el = null;
    try {
      // Opening the picker asks the server to re-check providers and reloads
      // recents; neither belongs in this case.
      /** @type {any} */ (providersCache).refresh = async () => {};
      /** @type {any} */ (recentModels).refresh = async () => {};
      await underPseudoLocale('model-selector-hud-test', async () => {
        /** @type {string[]} */
        const shown = [];
        /**
         * @param {string} where - The state being drawn.
         * @param {string|null|undefined} s - What it showed.
         */
        const see = (where, s) => {
          assert(!!s, `${where}: nothing drawn`);
          shown.push(/** @type {string} */ (s));
        };
        /** @type {any[]} */
        const asked = [];
        /** @type {any} */ (window).showModal = async (/** @type {any} */ opts) => {
          asked.push(opts);
          return false;
        };

        /** @type {any} */
        const entry = { id: '7', displayName: '7', contextWindow: 1000 };
        el = makeSelector();
        el.providers = [{ name: '4', displayName: '4', available: true, spawnsLocalProcess: true,
          modelsWithContext: [entry] }];

        // Nothing selected: the placeholder, and the button title with and
        // without a cycle key.
        keyShortcutManager.formatBinding = () => '9';
        el.render();
        see('placeholder', el._chip?.querySelector('.model-name')?.textContent);
        const keyed = el._chip?.button?.getAttribute('title');
        see('button title, key', keyed);
        assert(String(keyed).includes('9'), `the key cap must be in the title — got "${keyed}"`);
        keyShortcutManager.formatBinding = () => '';
        el.render();
        see('button title, no key', el._chip?.button?.getAttribute('title'));

        // The picker at the root, mid-turn, in a workspace that cannot host a
        // local provider: none row, note, footer actions, the refusal hint.
        el.conversation = { workspaceHostsLocalProviders: false, isTurnActive: () => true };
        el.toggleDropdown();
        const picker = el._picker;
        assert(!!picker, 'the picker opens');
        see('none row, root', picker.noneLabel);
        see('turn note', picker.note);
        const footerRows = [...picker.querySelectorAll('.model-picker-footer .menu-item')];
        assert(footerRows.length === 2, `two footer actions expected — got ${footerRows.length}`);
        for (const row of footerRows) see(`footer ${row.dataset.action}`, row.textContent?.trim());
        see('workspace-elsewhere hint', picker.providers[0]?.authHint);
        el.closeDropdown();

        // A sub-thread's none row.
        el._messageThread = { threadItemId: '1', isProcessing: true };
        see('none row, sub-thread', el._noneLabel());
        el._messageThread = null;

        // The three selection problems and their dialog.
        await el._showSelectionProblem({ ...el.providers[0], authHint: '3' }, '7');
        await el._showSelectionProblem({ ...el.providers[0], authHint: '' }, '7');
        await el.selectProviderAndModel('5', '7');
        assert(asked.length === 3, `three dialogs expected — got ${asked.length}`);
        for (const [i, opts] of asked.entries()) {
          see(`dialog ${i} message`, opts.message);
          see(`dialog ${i} title`, opts.title);
          see(`dialog ${i} confirm`, opts.confirmText);
          see(`dialog ${i} cancel`, opts.cancelText);
        }
        assert(String(asked[0].message).includes('3'), `the hint is kept — got "${asked[0].message}"`);
        assert(String(asked[2].message).includes('5'), `the provider is named — got "${asked[2].message}"`);

        const raw = shown.filter((s) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      });
    } finally {
      for (const restore of restorers) restore();
      /** @type {any} */ (window).showModal = originalShowModal;
      if (el) {
        el.conversation = null;
        el._messageThread = null;
        el.remove();
      }
      document.querySelectorAll('.model-picker').forEach(node => node.remove());
    }
  });

  return { passed, failed, errors };
}
