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
import { reportFact } from '../../js/services/guidance/facts.js';
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
  }

  // The AGENTS.md tip follows the project's instruction-file fact for the
  // conversation the strip is in: it opens the strip whenever the fact says
  // none, including when the fact arrives after the strip was built, and is
  // out of the rotation when there is one.
  try {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    /**
     * @param {string} conversationId
     * @returns {any} A strip mounted for that conversation.
     */
    const mount = (conversationId) => {
      const strip = /** @type {any} */ (document.createElement('empty-hint-tips'));
      host.appendChild(strip);
      strip.context = { conversationId };
      return strip;
    };
    /**
     * @param {any} strip
     * @returns {string|null} The id of the tip on show.
     */
    const onShow = (strip) => strip.querySelector('.empty-hint-tips__tip:not(.empty-hint-tips__tip--leaving)')?.getAttribute('data-tip-id') ?? null;

    reportFact('instruction-files', `none-${run}`, 0);
    const none = mount(`none-${run}`);
    assert(onShow(none) === 'instruction-file', `no instruction files: the strip should open on the AGENTS.md tip, opened on ${onShow(none)}`);

    const late = mount(`late-${run}`);
    assert(onShow(late) !== 'instruction-file', 'before the fact is known the AGENTS.md tip should not be on show');
    reportFact('instruction-files', `late-${run}`, 0);
    assert(onShow(late) === 'instruction-file', `a fact arriving after the build should open the strip on the AGENTS.md tip, showing ${onShow(late)}`);

    /** @type {any[][]} */
    const sent = [];
    const thread = { threadItemId: null, conversation: { sendMessage: (/** @type {any[]} */ ...args) => { sent.push(args); } } };
    none.context = { conversationId: `none-${run}`, thread };
    const draft = /** @type {HTMLButtonElement|null} */ (none.querySelector('.empty-hint-tips__tip:not(.empty-hint-tips__tip--leaving) .empty-hint-tips__action'));
    if (!draft) throw new Error('the AGENTS.md tip should carry its Draft one button');
    draft.click();
    await Promise.resolve();
    assert(sent.length === 1 && sent[0]?.[0] === '/init' && sent[0]?.[2] === thread,
      `Draft one should send /init to the strip's thread, sent ${JSON.stringify(sent.map((a) => a[0]))}`);
    assert(none.classList.contains('empty-hint-tips--tall'), 'a rotation with a button tip should reserve its height on every tip');

    reportFact('instruction-files', `some-${run}`, 1);
    const some = mount(`some-${run}`);
    assert(!some._tips.some((/** @type {any} */ tip) => tip.id === 'instruction-file'), 'a project with an AGENTS.md should not have the tip in its rotation');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`instruction-file tip: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    host.remove();
  }

  return { passed, failed, errors };
}
