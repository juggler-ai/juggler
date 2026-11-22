//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Helpers for the en-XA case a migrated UI file's test ends with: switch the
 * page to the pseudo-locale, render, and check that nothing it shows is plain
 * English.
 */

import { assert } from './test-helpers.js';
import { fetchJson } from '../../js/services/http.js';
import { apiUrl } from '../../js/utils/api-url.js';
import { fetchExtensions } from '../../js/services/extensions.js';
import {
  setLocale, registerCatalog, unregisterCatalog, isPseudoLocalized, pseudoLocalize, PSEUDO_LOCALE,
} from '../../sdk/lib/i18n.js';

/**
 * Run `fn` under en-XA with the core catalogue registered (plus, optionally,
 * catalogues standing in for extensions'), then put the locale back. The core
 * catalogue is fetched through `window.fetch` before `fn` runs, so a test that
 * stubs `fetch` installs the stub inside `fn`. The extension list is fetched
 * first too, in the current locale: its first fetch registers the extensions'
 * catalogues, which made under en-XA would replace the stand-ins in
 * `extensionText`.
 * @param {string} namespace - A namespace of the test's own for the core catalogue.
 * @param {() => Promise<void>|void} fn
 * @param {Record<string, string[]>} [extensionText] - Extension id → English
 *   messages to register pseudo-localised under that id.
 * @returns {Promise<void>}
 */
export async function underPseudoLocale(namespace, fn, extensionText = {}) {
  await fetchExtensions();
  const body = await fetchJson(apiUrl(`/i18n/catalog?locale=${PSEUDO_LOCALE}`));
  assert(body && Object.keys(body.messages || {}).length > 0, 'the en-XA catalogue is empty');
  registerCatalog(namespace, PSEUDO_LOCALE, body.messages);
  for (const [id, messages] of Object.entries(extensionText)) {
    registerCatalog(id, PSEUDO_LOCALE, Object.fromEntries(messages.map((s) => [s, pseudoLocalize(s)])));
  }
  const previous = setLocale(PSEUDO_LOCALE);
  try {
    await fn();
  } finally {
    setLocale(previous);
    unregisterCatalog(namespace);
    for (const id of Object.keys(extensionText)) unregisterCatalog(id);
  }
}

/**
 * The text a status row's summary shows, whether `getStatusUI` gave a string or
 * an element (a row with a linked filename is one).
 * @param {unknown} summary - The `summary` of a ResultStatusMessage.
 * @returns {string} Its visible text.
 */
export function summaryText(summary) {
  if (typeof summary === 'string') return summary;
  if (typeof Node !== 'undefined' && summary instanceof Node) return summary.textContent || '';
  return String(summary);
}

/**
 * Every block of text and aria-label/title/placeholder under `root`, minus the
 * elements `skip` matches (data the fixture cannot make letter-free). Text
 * split by inline markup (`<code>`, `<a>`, `<strong>`, `<em>`, `<b>`, `<i>`) is one message,
 * so it is judged joined up, as its block element shows it.
 * @param {Element} root
 * @param {string} [skip] - Selector for elements whose text is data.
 * @returns {string[]} The strings shown.
 */
export function shownStrings(root, skip) {
  /** @type {Map<Element, string>} */
  const blocks = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (skip && n.parentElement?.closest(skip)) continue;
    let block = /** @type {Element} */ (n.parentElement);
    while (block !== root && block.matches('code, a, strong, em, b, i')) block = /** @type {Element} */ (block.parentElement);
    blocks.set(block, (blocks.get(block) || '') + (n.textContent || ''));
  }
  const shown = [...blocks.values()].map((s) => s.trim()).filter(Boolean);
  for (const node of root.querySelectorAll('[aria-label], [title], [placeholder]')) {
    if (skip && node.closest(skip)) continue;
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const v = node.getAttribute(attr);
      if (v) shown.push(v);
    }
  }
  return shown;
}

/**
 * Assert that everything `root` shows is pseudo-localised.
 * @param {Element} root
 * @param {{skip?: string, atLeast?: number, where?: string}} [options] -
 *   `skip` as for {@link shownStrings}; `atLeast` guards against a render that
 *   drew nothing; `where` names the state in the failure.
 * @returns {string[]} The strings checked.
 */
export function assertPseudoLocalized(root, { skip, atLeast = 1, where = '' } = {}) {
  const shown = shownStrings(root, skip);
  const label = where ? ` (${where})` : '';
  assert(shown.length >= atLeast, `expected at least ${atLeast} strings${label}, found ${shown.length}`);
  const raw = shown.filter((s) => !isPseudoLocalized(s));
  assert(raw.length === 0, `plain English under en-XA${label}: ${JSON.stringify(raw)}`);
  return shown;
}
