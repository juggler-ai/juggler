//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Settings → Language: the tab someone who cannot read the current language
 * has to be able to find, so it is the first in the strip and carries the
 * language icon beside its name.
 *
 * Choosing a language saves it and reloads the window that chose it. The
 * languages it offers are English and the server's list
 * (`GET /api/i18n/locales`), every one named in itself — English too, since a
 * reader of only English must find it in a menu drawn in Chinese. The
 * pseudo-locale is offered in dev mode only.
 *
 * Under the en-XA pseudo-locale, using the generated web/i18n/en-XA.json (read
 * through /api/i18n/catalog, as the engine reads it), every word the tab shows
 * bar the languages' own names must come out accented.
 *
 * Nothing here touches the shared test server's UI language: the save is
 * answered by a fetch stub, because a real one would put every other lane's
 * next page into that language. The language list is stubbed too, since the
 * real one names only the catalogues that happen to be checked in.
 * @module unit-tests/language-tab-test
 */

import { assert } from '../utilities/test-helpers.js';
import { LanguageTab } from '../../js/components/settings/language-tab.js';
import { fetchJson } from '../../js/services/http.js';
import { apiUrl } from '../../js/utils/api-url.js';
import {
  setLocale, registerCatalog, unregisterCatalog, isPseudoLocalized, PSEUDO_LOCALE,
} from '../../sdk/lib/i18n.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed The count of assertions that succeeded.
 * @property {number} failed The count of assertions that threw.
 * @property {string[]} errors The collected failure messages.
 */

/**
 * Render the tab into a fresh host.
 * @returns {{host: HTMLElement, tab: LanguageTab}} The host and the tab.
 */
function mount() {
  const host = document.createElement('div');
  host.innerHTML = '<div id="language-form"></div>';
  document.body.appendChild(host);
  const tab = new LanguageTab(host);
  tab.render();
  return { host, tab };
}

/**
 * Answer `GET /api/i18n/locales` with locales, and a settings PUT with success
 * (recording its body in puts); everything else goes to the server.
 * @param {string[]} locales - The languages the server is to list.
 * @param {any[]} [puts] - Collects each settings PUT body.
 * @returns {() => void} Restores fetch.
 */
function stubServer(locales, puts = []) {
  const originalFetch = window.fetch;
  const json = (/** @type {any} */ body) => new window.Response(JSON.stringify(body),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    if (String(url).includes('/api/i18n/locales')) return json({ locales });
    if (String(url).endsWith('/api/settings') && init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)));
      return json({});
    }
    return originalFetch.call(window, url, init);
  });
  return () => { window.fetch = originalFetch; };
}

/**
 * The language menu's options.
 * @param {HTMLElement} host
 * @returns {{value: string, label: string, lang: string}[]} Each option's value, text and lang.
 */
function languageOptions(host) {
  const select = /** @type {HTMLSelectElement} */ (host.querySelector('#language-select'));
  return [...select.options].map((o) => ({ value: o.value, label: o.textContent || '', lang: o.lang }));
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

  const w = /** @type {any} */ (window);
  const savedDevMode = w.JUGGLER_DEV_MODE;
  w.JUGGLER_DEV_MODE = false;
  try {
    await run('the Settings strip opens with a Language tab marked by the language icon', async () => {
      const restore = stubServer(['fr']);
      const panel = /** @type {any} */ (document.createElement('settings-panel'));
      document.body.appendChild(panel);
      try {
        const tabs = [...panel.querySelectorAll('.settings-tabs .settings-tab')];
        const button = /** @type {HTMLElement|undefined} */ (tabs[0]);
        assert(button?.dataset.tab === 'language',
          `the first tab is ${JSON.stringify(button?.dataset.tab)}, not language`);
        assert(button.querySelector('.icon-language'), 'the Language tab carries the language icon');
        assert(tabs.find((b) => b.classList.contains('is-active'))?.dataset.tab === 'providers',
          'Providers is still the tab the panel opens on');
        panel.switchTab('language');
        const section = /** @type {HTMLElement|null} */ (panel.querySelector('#tab-language'));
        assert(section?.classList.contains('is-active'), 'switching to it shows its section');
        assert(section.querySelector('#language-select'), 'and the section holds the language menu');
        assert(!panel.querySelector('#tab-appearance #language-select'), 'Appearance no longer holds it');
      } finally {
        panel.remove();
        restore();
      }
    });

    await run('it offers every language by its own name, English included', async () => {
      const restore = stubServer(['de', 'fr', 'zz']);
      const { host, tab } = mount();
      try {
        await tab.languagesSettled;
        const options = languageOptions(host);
        const named = options.map((o) => [o.value, o.label, o.lang]);
        assert(JSON.stringify(named) === JSON.stringify([
          ['en', 'English', 'en'], ['de', 'Deutsch', 'de'], ['fr', 'Français', 'fr'], ['zz', 'zz', 'zz'],
        ]), `each language is named in itself, an unnamed one by its tag, no pseudo-locale outside dev mode: ${JSON.stringify(named)}`);
        const select = /** @type {HTMLSelectElement} */ (host.querySelector('#language-select'));
        assert(select.value === 'en', `a page served with no language shows English, got ${JSON.stringify(select.value)}`);
      } finally {
        restore();
        tab.dispose();
        host.remove();
      }
    });

    await run('the page\'s language is selected even when the list lacks it', async () => {
      const restore = stubServer(['fr']);
      const root = document.documentElement;
      const savedLocale = root.getAttribute('data-ui-locale');
      root.setAttribute('data-ui-locale', 'en-XA');
      const { host, tab } = mount();
      try {
        await tab.languagesSettled;
        const values = languageOptions(host).map((o) => o.value);
        assert(JSON.stringify(values) === JSON.stringify(['en', 'fr', 'en-XA']), `options were ${JSON.stringify(values)}`);
        const select = /** @type {HTMLSelectElement} */ (host.querySelector('#language-select'));
        assert(select.value === 'en-XA', `selected ${JSON.stringify(select.value)}`);
      } finally {
        if (savedLocale === null) root.removeAttribute('data-ui-locale');
        else root.setAttribute('data-ui-locale', savedLocale);
        restore();
        tab.dispose();
        host.remove();
      }
    });

    await run('dev mode also offers the pseudo-locale', async () => {
      w.JUGGLER_DEV_MODE = true;
      const restore = stubServer(['fr']);
      const { host, tab } = mount();
      try {
        await tab.languagesSettled;
        const values = languageOptions(host).map((o) => o.value);
        assert(JSON.stringify(values) === JSON.stringify(['en', 'fr', 'en-XA']),
          `dev mode adds the pseudo-locale last: ${JSON.stringify(values)}`);
      } finally {
        restore();
        w.JUGGLER_DEV_MODE = false;
        tab.dispose();
        host.remove();
      }
    });

    await run('choosing a language saves it and reloads this window', async () => {
      /** @type {any[]} */
      const puts = [];
      const restore = stubServer(['fr'], puts);
      const { host, tab } = mount();
      let reloads = 0;
      tab.reload = () => { reloads++; };
      try {
        await tab.languagesSettled;
        const select = /** @type {HTMLSelectElement} */ (host.querySelector('#language-select'));
        select.value = 'fr';
        assert(select.value === 'fr', 'the listed language is on offer');
        select.dispatchEvent(new Event('change'));
        await tab.languageSaved;
        assert(puts.length === 1 && puts[0].uiLocale === 'fr', `PUT bodies: ${JSON.stringify(puts)}`);
        assert(reloads === 1, `reloads: ${reloads}`);
      } finally {
        restore();
        tab.dispose();
        host.remove();
      }
    });

    await run('under en-XA every visible string is pseudo-localised, bar the languages\' own names', async () => {
      const body = await fetchJson(apiUrl(`/i18n/catalog?locale=${PSEUDO_LOCALE}`));
      assert(body && Object.keys(body.messages || {}).length > 0, 'the en-XA catalogue is empty');
      registerCatalog('language-tab-test', PSEUDO_LOCALE, body.messages);
      const previous = setLocale(PSEUDO_LOCALE);
      w.JUGGLER_DEV_MODE = true;
      const restore = stubServer(['fr']);
      const { host, tab } = mount();
      try {
        await tab.languagesSettled;
        /** @type {string[]} */
        const shown = [];
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = (n.textContent || '').trim();
          // A language's name in that language is not English to translate.
          if (text && !n.parentElement?.closest('option[lang]')) shown.push(text);
        }
        const options = languageOptions(host);
        assert(options.some((o) => o.lang === 'fr'), 'the listed language is in the menu');
        assert(options[0].label === 'English' && options[0].lang === 'en',
          `English is still named in English under another language: ${JSON.stringify(options[0])}`);
        for (const el of host.querySelectorAll('[aria-label], [title], [placeholder]')) {
          for (const attr of ['aria-label', 'title', 'placeholder']) {
            const v = el.getAttribute(attr);
            if (v) shown.push(v);
          }
        }
        assert(shown.length >= 4, `expected the tab's text, found ${shown.length} strings`);
        const raw = shown.filter((s) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      } finally {
        restore();
        w.JUGGLER_DEV_MODE = false;
        setLocale(previous);
        unregisterCatalog('language-tab-test');
        tab.dispose();
        host.remove();
      }
    });
  } finally {
    w.JUGGLER_DEV_MODE = savedDevMode;
  }

  return { passed, failed, errors };
}
