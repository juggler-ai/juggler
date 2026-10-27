//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The rolling tip strip (`components/empty-hint-tips.js`) follows the UI
 * language: every tip in the rotation — shortcut tips (title from the shortcut
 * table, body from the nudge catalogue) and feature tips alike — and the strip's own
 * ‹ › buttons.
 *
 * The strip only reads the "seen" pref, so no user pref is written here. Key
 * caps are skipped (a letter key is data); their names are proved by
 * `key-shortcut-manager-test.js`.
 * @module unit-tests/empty-hint-tips-test
 */

import '../../js/components/empty-hint-tips.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../utilities/pseudo-locale.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:800px;';
  document.body.appendChild(host);

  try {
    await underPseudoLocale('empty-hint-tips-test', async () => {
      const strip = /** @type {any} */ (document.createElement('empty-hint-tips'));
      host.appendChild(strip);
      const count = strip._tips.length;
      assert(count > 1, `the strip should rotate through several tips, but holds ${count}`);

      /** @type {Map<string, string>} */
      const raw = new Map();
      /** @type {Set<string>} */
      const seenIds = new Set();
      for (let i = 0; i < count; i++) {
        const slot = strip.querySelector('.empty-hint-tips__tip:not(.empty-hint-tips__tip--leaving)');
        const id = slot?.getAttribute('data-tip-id') ?? '?';
        seenIds.add(id);
        assert(!!slot?.querySelector('.empty-hint-tips__title')?.textContent?.trim()
          && !!slot?.querySelector('.empty-hint-tips__body')?.textContent?.trim(),
        `tip "${id}" drew an empty title or body`);
        // The tip still sliding out was checked on its own turn.
        for (const s of shownStrings(strip, '.empty-hint-tips__key, .empty-hint-tips__tip--leaving')) {
          if (!isPseudoLocalized(s)) raw.set(s, id);
        }
        strip.step(1);
      }
      assert(seenIds.size === count, `stepping should visit all ${count} tips, but visited ${seenIds.size}`);
      assert(raw.size === 0, `plain English under en-XA: ${JSON.stringify([...raw].map(([s, id]) => `${id}: ${s}`))}`);
    });
    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(`en-XA: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
