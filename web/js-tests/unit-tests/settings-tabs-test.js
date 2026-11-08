//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The settings tabs' shared contract, and how the Providers tab shows and hides
 * its controls.
 *
 * Lifecycle: every tab the panel holds implements dispose(), the panel calls
 * each one when it leaves the document, and a tab that holds something outside
 * its own DOM gives it back — the Logs tab's tail poll, the Defaults tab's model
 * picker (drawn into <body>), the Skills tab's preview (a popup-manager token and
 * a focus trap).
 *
 * Visibility: the Providers tab hides with the `hidden` attribute, never an
 * inline `display`, so the stylesheet keeps deciding how a shown control lays out.
 * @module unit-tests/settings-tabs-test
 */

import { assert } from '../utilities/test-helpers.js';
import { registerOpenPopup } from '../../js/utils/popup-manager.js';
import { ProvidersTab } from '../../js/components/settings/providers-tab.js';
import { DefaultsTab } from '../../js/components/settings/defaults-tab.js';
import { LogsTab } from '../../js/components/settings/logs-tab.js';
import { SkillsTab } from '../../js/components/settings/skills-tab.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Answer every request with an empty success, so a tab under test never
 * reaches the real server.
 * @returns {() => void} Restores the real fetch.
 */
function stubFetchEmpty() {
  const original = window.fetch;
  window.fetch = /** @type {any} */ (async () => ({
    ok: true, status: 200, json: async () => ({ files: [] }), text: async () => '',
  }));
  return () => { window.fetch = original; };
}

/**
 * Draw a Providers tab into a detached-from-the-panel host.
 * @param {any[]} providers - The provider list.
 * @param {object} config - The /api/config payload.
 * @returns {{host: HTMLElement, tab: ProvidersTab, cleanup: () => void}} The drawn tab.
 */
function mountProviders(providers, config) {
  const restoreFetch = stubFetchEmpty();
  const host = /** @type {any} */ (document.createElement('div'));
  host.innerHTML = '<div class="settings-content"><div id="provider-fields-container"></div></div>';
  host.loadConfig = async () => true;
  document.body.appendChild(host);
  const tab = new ProvidersTab(host);
  tab.onConfigLoaded({ config, providers }, true);
  return {
    host,
    tab,
    cleanup: () => {
      tab.dispose();
      host.remove();
      restoreFetch();
    },
  };
}

/**
 * @param {Element|null} el
 * @param {string} what
 * @returns {HTMLElement} The element, asserted present.
 */
function present(el, what) {
  assert(el, `${what} is missing`);
  return /** @type {HTMLElement} */ (el);
}

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
   * @param {() => Promise<void>} fn
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

  await run('every tab implements dispose() and the panel calls each on removal', async () => {
    const panel = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(panel);
    /** @type {string[]} */
    const disposed = [];
    try {
      const entries = Object.entries(panel._tabs);
      assert(entries.length >= 11, `expected the whole registry, found ${entries.length} tabs`);
      const missing = entries.filter(([, tab]) => typeof (/** @type {any} */ (tab)).dispose !== 'function')
        .map(([name]) => name);
      assert(missing.length === 0, `tabs without dispose(): ${missing.join(', ')}`);
      for (const [name, tab] of entries) {
        const own = /** @type {any} */ (tab).dispose.bind(tab);
        /** @type {any} */ (tab).dispose = () => { disposed.push(name); own(); };
      }
      panel.remove();
      const notCalled = entries.map(([name]) => name).filter((name) => !disposed.includes(name));
      assert(notCalled.length === 0, `removal did not dispose: ${notCalled.join(', ')}`);
    } finally {
      panel.remove();
    }
  });

  await run('the Logs tab’s dispose stops its tail poll', async () => {
    const restoreFetch = stubFetchEmpty();
    const host = document.createElement('div');
    host.innerHTML = '<div id="logs-empty"></div><div id="logs-controls" hidden><select id="logs-picker"></select></div>'
      + '<div id="logs-filepath"></div><pre id="logs-viewer" hidden></pre>';
    const realSet = window.setInterval;
    const realClear = window.clearInterval;
    /** @type {any[]} */
    const armed = [];
    /** @type {any[]} */
    const cleared = [];
    window.setInterval = /** @type {any} */ ((/** @type {any} */ fn, /** @type {any} */ ms) => {
      const id = realSet(fn, ms);
      armed.push(id);
      return id;
    });
    window.clearInterval = /** @type {any} */ ((/** @type {any} */ id) => { cleared.push(id); realClear(id); });
    const tab = new LogsTab(host);
    try {
      tab.render();
      tab.show();
      assert(armed.length === 1, `show() armed ${armed.length} polls`);
      tab.dispose();
      assert(cleared.includes(armed[0]), 'dispose() left the tail poll running');
    } finally {
      window.setInterval = realSet;
      window.clearInterval = realClear;
      for (const id of armed) realClear(id);
      restoreFetch();
    }
  });

  await run('the Defaults tab’s dispose closes its open model picker', async () => {
    let closed = 0;
    const release = registerOpenPopup({ id: 'settings-model-picker', onClose: () => { closed++; } });
    try {
      new DefaultsTab(document.createElement('div')).dispose();
      assert(closed === 1, `the picker drawn into <body> was closed ${closed} times`);
    } finally {
      release();
    }
  });

  await run('the Skills tab’s dispose releases an open preview', async () => {
    const tab = /** @type {any} */ (new SkillsTab(document.createElement('div')));
    let released = 0;
    tab._releasePreviewPopup = () => { released++; };
    tab.dispose();
    assert(released === 1, `the preview's popup token and focus trap were released ${released} times`);
    assert(tab._releasePreviewPopup === null, 'the released token was kept');
  });

  await run('key controls hide with the hidden attribute, never an inline display', async () => {
    const { host, tab, cleanup } = mountProviders([
      { name: 'p1', displayName: 'One', configKeyName: 'p1_key', keySource: 'credentials', modelsWithContext: [] },
      { name: 'p2', displayName: 'Two', configKeyName: 'p2_key', keySource: 'env', envVarName: 'P2_KEY', modelsWithContext: [] },
    ], { keys: { p1: true, p2: true } });
    try {
      tab.updateAllButtons();
      const save = present(host.querySelector('#p1-save'), 'the save button');
      const del = present(host.querySelector('#p1-delete'), 'the delete button');
      const badge = present(host.querySelector('#p1-active-badge'), 'the active badge');
      const source = present(host.querySelector('#p1-source'), 'the source hint');
      const envSource = present(host.querySelector('#p2-source'), 'the env source hint');
      for (const el of [save, del, badge, source, envSource]) {
        assert(el.style.display === '', `#${el.id} carries an inline display: ${el.style.display}`);
      }
      assert(save.hidden, 'an empty key field offers Save');
      assert(getComputedStyle(save).display === 'none', '[hidden] lost to a display rule on the save button');
      assert(!del.hidden, 'a stored key offers no Delete');
      assert(!badge.hidden, 'a stored key is not reported as active');
      assert(source.hidden, 'a credentials key shows the env-var hint');
      assert(!envSource.hidden, 'an env key does not say where it comes from');

      const input = /** @type {HTMLInputElement} */ (present(host.querySelector('#p1-key'), 'the key input'));
      input.value = 'sk-typed';
      input.dispatchEvent(new Event('input'));
      assert(!save.hidden, 'a typed key offers no Save');
      assert(badge.hidden, 'the active badge stays up over a replacement being typed');
      assert(save.style.display === '' && badge.style.display === '', 'typing wrote an inline display');
    } finally {
      cleanup();
    }
  });

  await run('the model filter hides rows and shows the empty line with the hidden attribute', async () => {
    const { host, cleanup } = mountProviders([
      {
        name: 'p1', displayName: 'One', configKeyName: 'p1_key', keySource: 'credentials',
        modelsWithContext: [{ id: 'alpha', contextWindow: 1000 }, { id: 'beta', contextWindow: 1000 }],
      },
    ], { keys: { p1: true } });
    try {
      const filter = /** @type {HTMLInputElement} */ (present(host.querySelector('.model-visibility-filter'), 'the filter'));
      const empty = present(host.querySelector('.model-visibility-empty'), 'the empty line');
      const status = present(host.querySelector('.model-visibility-status'), 'the status line');
      const alpha = present(host.querySelector('.model-visibility-row[data-model="alpha"]'), 'the alpha row');
      const beta = present(host.querySelector('.model-visibility-row[data-model="beta"]'), 'the beta row');
      assert(empty.hidden && status.hidden, 'the empty and status lines start shown');

      filter.value = 'alp';
      filter.dispatchEvent(new Event('input'));
      assert(!alpha.hidden && beta.hidden, `filtering kept alpha=${!alpha.hidden} beta=${!beta.hidden}`);
      assert(empty.hidden, 'a filter with a match shows the empty line');

      filter.value = 'zzz';
      filter.dispatchEvent(new Event('input'));
      assert(alpha.hidden && beta.hidden && !empty.hidden, 'a filter matching nothing does not say so');

      filter.value = '';
      filter.dispatchEvent(new Event('input'));
      assert(!alpha.hidden && !beta.hidden && empty.hidden, 'clearing the filter did not bring the rows back');
      for (const el of [alpha, beta, empty, status]) {
        assert(el.style.display === '', `an inline display was written: ${el.style.display}`);
      }
    } finally {
      cleanup();
    }
  });

  return { passed, failed, errors };
}
