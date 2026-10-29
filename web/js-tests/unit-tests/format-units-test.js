//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Units and lists in UI text: `formatTokens` and `formatBytes`
 * (web/js/utils/format.js), the two file-size formatters in
 * web/sdk/lib/context-item-utils.js, and `formatList` (web/sdk/lib/i18n.js).
 *
 * In English each reads exactly as a hand-written suffix or `', '` join would.
 * Under another language the suffixes are messages a catalogue translates —
 * except `formatFileSize`, whose output the model reads and which therefore
 * stays English whatever the UI language.
 * @module unit-tests/format-units-test
 */

import { assert } from '../utilities/test-helpers.js';
import { formatTokens, formatBytes } from '../../js/utils/format.js';
import { formatFileSize, formatFileSizeForDisplay } from '../../sdk/lib/context-item-utils.js';
import {
  setLocale, registerCatalog, unregisterCatalog, messageKey, pseudoLocalize, isPseudoLocalized,
  formatList, formatDate, formatRelativeTime, PSEUDO_LOCALE,
} from '../../sdk/lib/i18n.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * @param {string} got
   * @param {string} want
   * @param {string} what
   * @returns {void}
   */
  const same = (got, want, what) => assert(got === want, `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

  for (const locale of ['', 'en']) {
    run(`English output (${locale || 'no locale'})`, () => {
      const previous = setLocale(locale);
      try {
        same(formatTokens(1000000), '1M', 'a round million');
        same(formatTokens(1500000), '1.5M', 'a part million');
        same(formatTokens(999999), '999k', 'the thousand tier floors');
        same(formatTokens(2000), '2k', 'the thousand tier starts at 2000');
        // Grouping is the locale's: with no UI language the runtime's default
        // decides it (a POSIX default has none), so `1,500` is pinned for `en`.
        same(formatTokens(1500), locale === 'en' ? '1,500' : new Intl.NumberFormat().format(1500),
          'below 2000 the exact count, grouped');
        same(formatBytes(0), '0 B', 'no bytes');
        same(formatBytes(1023), '1023 B', 'bytes, ungrouped');
        same(formatBytes(1536), '1.5 KB', 'kilobytes under ten keep a decimal');
        same(formatBytes(12 * 1024 * 1024), '12 MB', 'megabytes past ten round');
        same(formatBytes(3.2 * 1024 ** 3), '3.2 GB', 'gigabytes');
        same(formatBytes(-1), '', 'an invalid size');
        for (const fmt of [formatFileSize, formatFileSizeForDisplay]) {
          same(fmt(0), '0 B', `${fmt.name}(0)`);
          same(fmt(1023), '1023 B', `${fmt.name}(1023)`);
          same(fmt(1536), '1.5 KB', `${fmt.name}(1536)`);
          same(fmt(20 * 1024 * 1024), '20.0 MB', `${fmt.name}(20 MB)`);
          same(fmt(/** @type {any} */ (null)), '—', `${fmt.name}(null)`);
        }
        same(formatList(['a', 'b', 'c']), 'a, b, c', 'a plain list is a comma join');
        same(formatList(['a']), 'a', 'one item');
        same(formatList([]), '', 'no items');
        same(formatList(['a', 'b'], { type: 'disjunction' }), 'a or b', 'two alternatives');
        // The serial comma is a regional convention: with no UI language the
        // runtime's own default decides it, so it is pinned for `en` alone.
        if (locale === 'en') {
          same(formatList(['a', 'b', 'c'], { type: 'disjunction' }), 'a, b, or c', 'three alternatives');
          same(formatList(['a', 'b', 'c'], { type: 'conjunction' }), 'a, b, and c', 'a conjunction');
        }
      } finally {
        setLocale(previous);
      }
    });
  }

  run('en-XA: the suffixes are messages, and the model-facing size is not', () => {
    const NS = 'format-units-test';
    const sources = [
      ['{n}k', 'thousands, in a compact count'],
      ['{n}M', 'millions, in a compact count'],
      ['{n} B'], ['{n} KB'], ['{n} MB'], ['{n} GB'], ['{n} TB'],
    ];
    registerCatalog(NS, PSEUDO_LOCALE,
      Object.fromEntries(sources.map(([s, c]) => [messageKey(s, c), pseudoLocalize(s)])));
    const previous = setLocale(PSEUDO_LOCALE);
    try {
      for (const [what, got] of [
        ['thousands', formatTokens(5000)],
        ['millions', formatTokens(2500000)],
        ['bytes', formatBytes(12)],
        ['kilobytes', formatBytes(1536)],
        ['megabytes', formatBytes(12 * 1024 * 1024)],
        ['display size', formatFileSizeForDisplay(1536)],
        ['display bytes', formatFileSizeForDisplay(12)],
      ]) {
        assert(/\d/.test(got) && isPseudoLocalized(got), `${what} should be pseudo-localised, got ${JSON.stringify(got)}`);
      }
      same(formatFileSize(1536), '1.5 KB', 'formatFileSize is read by the model and stays English');
      // The list's own words come from Intl, not a catalogue; the pseudo-locale
      // accents them so a screen of translated text has no English left in it.
      for (const type of /** @type {const} */ (['disjunction', 'conjunction'])) {
        const got = formatList(['1', '2', '3'], { type });
        assert(/^1\D+2\D+3$/.test(got) && !/[A-Za-z]/.test(got), `a ${type} under en-XA: ${JSON.stringify(got)}`);
      }
      same(formatList(['ab', 'cd']), 'ab, cd', 'the items themselves are left as given');
      // A date's and a relative time's words come from Intl too: a month name,
      // a day period, "in … hours". Accented, they read as translated inside a
      // translated message, whatever day the date falls on.
      const at = new Date(2026, 9, 29, 0, 16).getTime();
      for (const [what, got] of [
        ['a date with its month', formatDate(at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })],
        ['a 12-hour time', formatDate(at, { hour: 'numeric', minute: '2-digit', hour12: true })],
        ['a relative time', formatRelativeTime(2, 'hour')],
      ]) {
        assert(/\d/.test(got) && !/[A-Za-z]/.test(got), `${what} under en-XA: ${JSON.stringify(got)}`);
      }
    } finally {
      setLocale(previous);
      unregisterCatalog(NS);
    }
  });

  run('a language with other digits formats the figures in them', () => {
    const previous = setLocale('ar-EG');
    try {
      const got = formatFileSizeForDisplay(1536);
      assert(!/[0-9]/.test(got), `expected Arabic-Indic digits, got ${JSON.stringify(got)}`);
    } finally {
      setLocale(previous);
    }
  });

  return { passed, failed, errors };
}
